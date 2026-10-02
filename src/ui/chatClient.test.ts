import { describe, expect, it } from "vitest";
import { MAX_HISTORY_MESSAGES, type ActivityStep, type ChatStreamEvent } from "../api/api.ts";
import { buildHistory, ChatError, streamChat, upsertStep, type TranscriptEntry } from "./chatClient.ts";

const request = { message: "What about its margins?", history: [] };

function sse(events: (ChatStreamEvent | string)[]) {
  const body = events
    .map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`)
    .join("");
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

const respondWith = (response: Response) => async () => response;

async function failureOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("Expected the request to fail");
}

describe("streamChat", () => {
  it("reports activity steps and resolves with the answer", async () => {
    const steps: ActivityStep[] = [];
    const step: ActivityStep = { id: "1", label: "Checking financials", status: "done" };

    const answer = await streamChat(
      request,
      (s) => steps.push(s),
      new AbortController().signal,
      respondWith(sse([{ type: "activity", step }, { type: "answer", answer: "9.6%" }])),
    );

    expect(answer).toBe("9.6%");
    expect(steps).toEqual([step]);
  });

  it("shows the server's message for a non-2xx JSON error", async () => {
    const response = Response.json({ error: "message must not be empty." }, { status: 400 });
    const err = await failureOf(streamChat(request, () => {}, new AbortController().signal, respondWith(response)));

    expect(err).toBeInstanceOf(ChatError);
    expect((err as ChatError).message).toBe("message must not be empty.");
  });

  it("falls back to a status message for a non-2xx response without a JSON body", async () => {
    const response = new Response("<html>Bad gateway</html>", { status: 502 });
    const err = await failureOf(streamChat(request, () => {}, new AbortController().signal, respondWith(response)));

    expect(err).toBeInstanceOf(ChatError);
    expect((err as ChatError).message).toMatch(/error \(502\)/);
  });

  it("reports a network failure as an unreachable server", async () => {
    const err = await failureOf(
      streamChat(request, () => {}, new AbortController().signal, async () => {
        throw new TypeError("Failed to fetch");
      }),
    );

    expect(err).toBeInstanceOf(ChatError);
    expect((err as ChatError).message).toMatch(/Couldn't reach/);
  });

  it("rejects with the stream's error event", async () => {
    const response = sse([{ type: "error", message: "Something went wrong while researching. Please try again." }]);
    const err = await failureOf(streamChat(request, () => {}, new AbortController().signal, respondWith(response)));

    expect((err as ChatError).message).toBe("Something went wrong while researching. Please try again.");
  });

  it("rejects malformed events and streams that end without an answer", async () => {
    const malformed = await failureOf(
      streamChat(request, () => {}, new AbortController().signal, respondWith(sse(["{not json"]))),
    );
    expect(malformed).toBeInstanceOf(ChatError);

    const unknownShape = await failureOf(
      streamChat(request, () => {}, new AbortController().signal, respondWith(sse(['{"type":"answer"}']))),
    );
    expect(unknownShape).toBeInstanceOf(ChatError);

    const truncated = await failureOf(
      streamChat(
        request,
        () => {},
        new AbortController().signal,
        respondWith(sse([{ type: "activity", step: { id: "1", label: "x", status: "running" } }])),
      ),
    );
    expect((truncated as ChatError).message).toMatch(/stopped before sending an answer/);
  });

  it("rejects with the abort reason, not a ChatError, when cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const err = await failureOf(
      streamChat(request, () => {}, controller.signal, async (_url, init) => {
        init.signal?.throwIfAborted();
        return sse([]);
      }),
    );

    expect(err).not.toBeInstanceOf(ChatError);
    expect((err as Error).name).toBe("AbortError");
  });
});

describe("buildHistory", () => {
  it("sends only answered turns, skipping failed and stopped ones", () => {
    const transcript: TranscriptEntry[] = [
      { role: "user", text: "Tell me about Globex." },
      { role: "assistant", text: "Globex is a distributor.", status: "answered" },
      { role: "user", text: "Bad request" },
      { role: "assistant", text: "Couldn't reach the server.", status: "error" },
      { role: "user", text: "Long one" },
      { role: "assistant", text: "Stopped.", status: "stopped" },
    ];

    expect(buildHistory(transcript)).toEqual([
      { role: "user", content: "Tell me about Globex." },
      { role: "assistant", content: "Globex is a distributor." },
    ]);
  });

  it("keeps only the most recent pairs within the limit", () => {
    const transcript: TranscriptEntry[] = Array.from({ length: MAX_HISTORY_MESSAGES + 6 }, (_, i) =>
      i % 2 === 0 ? { role: "user", text: `q${i}` } : { role: "assistant", text: `a${i}`, status: "answered" },
    );

    const history = buildHistory(transcript);
    expect(history).toHaveLength(MAX_HISTORY_MESSAGES);
    expect(history[0]).toEqual({ role: "user", content: "q6" });
  });
});

describe("upsertStep", () => {
  it("replaces a step with the same id and appends new ones", () => {
    const running: ActivityStep = { id: "1", label: "Checking financials", status: "running" };
    const steps = upsertStep(upsertStep([], running), { ...running, status: "done" });
    expect(upsertStep(steps, { id: "2", label: "Synthesizing findings", status: "running" })).toEqual([
      { ...running, status: "done" },
      { id: "2", label: "Synthesizing findings", status: "running" },
    ]);
  });
});
