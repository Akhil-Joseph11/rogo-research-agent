import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { runAgent } from "../agent/agent.ts";
import { MAX_MESSAGE_CHARS, isChatStreamEvent, type ChatStreamEvent } from "../api/api.ts";
import { createApp, type RequestLog } from "./app.ts";

let server: Server | undefined;
let log: MockInstance<typeof console.log>;

beforeEach(() => {
  log = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  server?.close();
  server = undefined;
  log.mockRestore();
});

function requestLogs(): RequestLog[] {
  return log.mock.calls.flatMap(([line]) => {
    if (typeof line !== "string" || !line.startsWith("{")) return [];
    const entry: RequestLog = JSON.parse(line);
    return entry.event === "chat_request" ? [entry] : [];
  });
}

async function start(run: typeof runAgent) {
  server = createApp(run).listen(0);
  await new Promise<void>((resolve) => server!.once("listening", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/chat`;
}

function post(url: string, body: string) {
  return fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body });
}

function parseStream(raw: string): ChatStreamEvent[] {
  return raw
    .split("\n\n")
    .filter((frame) => frame.startsWith("data: "))
    .map((frame) => {
      const event: unknown = JSON.parse(frame.slice("data: ".length));
      if (!isChatStreamEvent(event)) throw new Error(`Unexpected event: ${frame}`);
      return event;
    });
}

const neverCalled: typeof runAgent = async () => {
  throw new Error("runAgent should not be called for an invalid request");
};

describe("POST /api/chat", () => {
  it("rejects an empty message with a 400 JSON error and does not start research", async () => {
    const url = await start(neverCalled);
    const res = await post(url, JSON.stringify({ message: "   " }));

    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    expect(await res.json()).toEqual({ error: "message must not be empty." });
  });

  it("rejects a message over the length limit", async () => {
    const url = await start(neverCalled);
    const res = await post(url, JSON.stringify({ message: "x".repeat(MAX_MESSAGE_CHARS + 1) }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: `message must be at most ${MAX_MESSAGE_CHARS} characters.` });
  });

  it("rejects invalid history", async () => {
    const url = await start(neverCalled);
    const res = await post(url, JSON.stringify({ message: "Hi", history: [{ role: "system", content: "x" }] }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "history must contain complete user/assistant pairs." });
  });

  it("answers malformed JSON with a JSON error and no stack trace", async () => {
    const url = await start(neverCalled);
    const res = await post(url, "{ not json");
    const body = await res.text();

    expect(res.status).toBe(400);
    expect(JSON.parse(body)).toEqual({ error: "Request body must be valid JSON." });
    expect(body).not.toMatch(/at .*\.(js|ts):\d+/);
  });

  it("streams activity from real agent events, then the answer, and passes history to the agent", async () => {
    let received: Parameters<typeof runAgent> | undefined;
    const url = await start(async (question, onEvent, options) => {
      received = [question, onEvent, options];
      onEvent({ type: "iteration", n: 1 });
      onEvent({ type: "tool_start", name: "getFinancials", input: { company: "GLBX" } });
      onEvent({ type: "tool_end", name: "getFinancials", ms: 3 });
      onEvent({ type: "iteration", n: 2 });
      return { answer: "Globex's **operating margin** was 9.6%.", iterations: 2, modelCalls: 2, toolCalls: 1, toolFailures: 0, inputTokens: 0, outputTokens: 0 };
    });
    const history = [
      { role: "user", content: "Tell me about Globex." },
      { role: "assistant", content: "Globex Inc is an industrial distributor." },
    ];

    const res = await post(url, JSON.stringify({ message: "What about its margins?", history }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    const events = parseStream(await res.text());

    expect(received?.[0]).toBe("What about its margins?");
    expect(received?.[2]?.history).toEqual(history);
    expect(events).toEqual([
      { type: "activity", step: { id: "1", label: "Understanding your question", status: "running" } },
      { type: "activity", step: { id: "1", label: "Understanding your question", status: "done" } },
      { type: "activity", step: { id: "2", label: "Checking financials", status: "running" } },
      { type: "activity", step: { id: "2", label: "Checking financials", status: "done" } },
      { type: "activity", step: { id: "3", label: "Synthesizing findings", status: "running" } },
      { type: "activity", step: { id: "3", label: "Synthesizing findings", status: "done" } },
      { type: "answer", answer: "Globex's **operating margin** was 9.6%." },
    ]);
    expect(JSON.stringify(events)).not.toContain("GLBX");
  });

  it("reports a failed tool as failed rather than done", async () => {
    const url = await start(async (_question, onEvent) => {
      onEvent({ type: "iteration", n: 1 });
      onEvent({ type: "tool_start", name: "searchDocuments", input: {} });
      onEvent({ type: "tool_failed", name: "searchDocuments", message: "Document search accepts at most 6 keywords" });
      onEvent({ type: "tool_end", name: "searchDocuments", ms: 1 });
      onEvent({ type: "iteration", n: 2 });
      return { answer: "Partial answer.", iterations: 2, modelCalls: 2, toolCalls: 1, toolFailures: 1, inputTokens: 0, outputTokens: 0 };
    });

    const events = parseStream(await (await post(url, JSON.stringify({ message: "Risks?" }))).text());
    const documentSteps = events.flatMap((e) =>
      e.type === "activity" && e.step.label === "Reviewing filings and transcripts" ? [e.step.status] : [],
    );

    expect(documentSteps).toEqual(["running", "failed"]);
    expect(JSON.stringify(events)).not.toContain("6 keywords");
  });

  it("turns an agent crash into a generic error event without internals", async () => {
    const url = await start(async (_question, onEvent) => {
      onEvent({ type: "iteration", n: 1 });
      throw new Error("401 invalid x-api-key at Anthropic.makeRequest (client.ts:42)");
    });
    const originalError = console.error;
    console.error = () => {};
    try {
      const res = await post(url, JSON.stringify({ message: "Hi" }));
      const raw = await res.text();
      const events = parseStream(raw);

      expect(res.status).toBe(200);
      expect(events[events.length - 1]).toEqual({
        type: "error",
        message: "Something went wrong while researching. Please try again.",
      });
      expect(raw).not.toMatch(/api-key|client\.ts/);
      expect(requestLogs()).toEqual([
        expect.objectContaining({ outcome: "failed", iterations: 1, modelCalls: 1, toolCalls: 0 }),
      ]);
    } finally {
      console.error = originalError;
    }
  });

  it("tags each request with an id and logs one structured summary without conversation content", async () => {
    const url = await start(async (_question, onEvent) => {
      onEvent({ type: "iteration", n: 1 });
      return { answer: "Secret answer text", iterations: 1, modelCalls: 1, toolCalls: 3, toolFailures: 1, inputTokens: 1200, outputTokens: 300 };
    });

    const res = await post(url, JSON.stringify({
      message: "Confidential question",
      history: [{ role: "user", content: "Earlier question" }, { role: "assistant", content: "Earlier answer" }],
    }));
    await res.text();

    const requestId = res.headers.get("x-request-id");
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    const [entry] = requestLogs();
    expect(entry).toEqual({
      event: "chat_request",
      requestId,
      outcome: "answered",
      status: 200,
      durationMs: expect.any(Number),
      historyMessages: 2,
      iterations: 1,
      modelCalls: 1,
      toolCalls: 3,
      toolFailures: 1,
      inputTokens: 1200,
      outputTokens: 300,
    });
    expect(JSON.stringify(entry)).not.toMatch(/Confidential|Earlier|Secret/);
  });

  it("logs rejected requests under the same id the client receives", async () => {
    const url = await start(neverCalled);
    const res = await post(url, JSON.stringify({ message: "" }));

    expect(requestLogs()).toEqual([
      expect.objectContaining({ requestId: res.headers.get("x-request-id"), outcome: "rejected", status: 400 }),
    ]);
  });
});
