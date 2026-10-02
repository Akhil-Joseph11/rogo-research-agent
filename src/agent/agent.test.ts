import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { MAX_ITERATIONS, runAgent, type AgentEvent, type CreateMessage } from "./agent.ts";
import { MAX_HISTORY_MESSAGES, type ChatTurn } from "../api/api.ts";
import { executeTool } from "../research/tools.ts";

function reply(content: Anthropic.ContentBlock[]): Anthropic.Message {
  const hasToolUse = content.some((block) => block.type === "tool_use");
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "test-model",
    content,
    stop_reason: hasToolUse ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 20 },
  } as Anthropic.Message;
}

const text = (value: string) => ({ type: "text", text: value, citations: null }) as Anthropic.TextBlock;

const toolUse = (id: string, name: string, input: Record<string, unknown>) =>
  ({ type: "tool_use", id, name, input }) as Anthropic.ToolUseBlock;

function recordingModel(respond: (params: Anthropic.MessageCreateParamsNonStreaming) => Anthropic.Message) {
  const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const createMessage: CreateMessage = async (params) => {
    calls.push(params);
    return respond(params);
  };
  return { calls, createMessage };
}

/** Lets queued promise callbacks run until the condition holds. */
async function until(condition: () => boolean) {
  for (let i = 0; i < 50 && !condition(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function lastToolResults(params: Anthropic.MessageCreateParamsNonStreaming) {
  const content = params.messages[params.messages.length - 1].content;
  if (typeof content === "string") return [];
  return content.filter(
    (block): block is Anthropic.ToolResultBlockParam => block.type === "tool_result",
  );
}

describe("runAgent", () => {
  it("answers in a single model call when no tools are needed", async () => {
    const model = recordingModel(() => reply([text("We cover five companies.")]));
    const result = await runAgent("Who do you cover?", () => {}, model);

    expect(result.answer).toBe("We cover five companies.");
    expect(model.calls).toHaveLength(1);
  });

  it("runs a requested tool, returns its result to the model, and stops once the model answers", async () => {
    const model = recordingModel((params) =>
      params.messages.length === 1
        ? reply([toolUse("t1", "getFinancials", { company: "GLBX" })])
        : reply([text("answer")]),
    );
    const executed: string[] = [];

    const result = await runAgent("Globex revenue?", () => {}, {
      createMessage: model.createMessage,
      executeTool: async (name, input) => {
        executed.push(`${name}:${String(input.company)}`);
        return { company: "Globex Inc", revenue: 8905 };
      },
    });

    expect(executed).toEqual(["getFinancials:GLBX"]);
    expect(lastToolResults(model.calls[1])).toEqual([
      { type: "tool_result", tool_use_id: "t1", content: '{"company":"Globex Inc","revenue":8905}' },
    ]);
    expect(result).toEqual({
      answer: "answer",
      iterations: 2,
      modelCalls: 2,
      toolCalls: 1,
      toolFailures: 0,
      inputTokens: 200,
      outputTokens: 40,
    });
    // Every model call is a research call with the tools attached: no separate editor pass.
    expect(model.calls).toHaveLength(result.modelCalls);
    expect(model.calls.every((call) => call.tools === model.calls[0].tools && call.system === model.calls[0].system)).toBe(true);
  });

  it("marks only the system prompt for caching, identically on every call", async () => {
    const model = recordingModel((params) =>
      params.messages.length === 3
        ? reply([toolUse("t1", "getFinancials", { company: "GLBX" })])
        : reply([text("answer")]),
    );
    await runAgent("Globex revenue?", () => {}, {
      createMessage: model.createMessage,
      executeTool: async () => ({ revenue: 8905 }),
      history: [
        { role: "user", content: "Tell me about Globex." },
        { role: "assistant", content: "Globex is a diversified industrial." },
      ],
    });

    expect(model.calls).toHaveLength(2);
    for (const call of model.calls) {
      expect(Array.isArray(call.system) && call.system.length).toBe(1);
      expect(call.system).toEqual([
        expect.objectContaining({ type: "text", cache_control: { type: "ephemeral" } }),
      ]);
      expect(call.cache_control).toBeUndefined();
      expect(JSON.stringify(call.tools)).not.toContain("cache_control");
      expect(JSON.stringify(call.messages)).not.toContain("cache_control");
    }
    expect(model.calls[1].system).toEqual(model.calls[0].system);
  });

  it("counts cache writes and reads as input tokens", async () => {
    const withCacheUsage = (message: Anthropic.Message, written: number, read: number) => ({
      ...message,
      usage: { ...message.usage, cache_creation_input_tokens: written, cache_read_input_tokens: read },
    });
    const model = recordingModel((params) =>
      params.messages.length === 1
        ? withCacheUsage(reply([toolUse("t1", "getFinancials", { company: "GLBX" })]), 1500, 0)
        : withCacheUsage(reply([text("answer")]), 0, 1500),
    );
    const result = await runAgent("Globex revenue?", () => {}, {
      createMessage: model.createMessage,
      executeTool: async () => ({ revenue: 8905 }),
    });

    expect(result.inputTokens).toBe(100 + 1500 + 100 + 1500);
  });

  it("recovers when the model corrects a failed tool call", async () => {
    const model = recordingModel((params) => {
      if (params.messages.length === 1) {
        return reply([toolUse("t1", "searchDocuments", { query: "initech subscription perpetual license conversion retention discounting" })]);
      }
      const [last] = lastToolResults(params);
      return last.is_error
        ? reply([toolUse("t2", "searchDocuments", { query: "subscription retention", company: "ITCH" })])
        : reply([text("answer")]);
    });

    const result = await runAgent("Initech transition?", () => {}, {
      createMessage: model.createMessage,
      executeTool,
    });

    const [failed] = lastToolResults(model.calls[1]);
    const [retried] = lastToolResults(model.calls[2]);
    expect(failed).toMatchObject({ tool_use_id: "t1", is_error: true });
    expect(failed.content).toMatch(/at most 6 keywords/);
    expect(retried.tool_use_id).toBe("t2");
    expect(retried.is_error).toBeUndefined();
    expect(retried.content).toContain("DOC-ITCH-002");
    expect(result).toMatchObject({ answer: "answer", modelCalls: 3, toolCalls: 2, toolFailures: 1 });
  });

  it("hands an ambiguous company back to the model with both candidates instead of choosing one", async () => {
    const model = recordingModel((params) =>
      params.messages.length === 1
        ? reply([toolUse("t1", "getFinancials", { company: "Acme" })])
        : reply([text("clarifying question")]),
    );

    const result = await runAgent("How is Acme doing?", () => {}, {
      createMessage: model.createMessage,
      executeTool,
    });

    const [ambiguous] = lastToolResults(model.calls[1]);
    expect(ambiguous.is_error).toBe(true);
    expect(ambiguous.content).toMatch(/Acme Corp \(ACME\)/);
    expect(ambiguous.content).toMatch(/Acme Robotics \(ACMR\)/);
    // No figures for either company reached the model, so it has nothing to guess from.
    expect(ambiguous.content).not.toMatch(/revenue|fiscalYear/);
    expect(result).toMatchObject({ answer: "clarifying question", toolCalls: 1, toolFailures: 1 });
  });

  it("keeps a successful result and marks a failed tool as an error in the same turn", async () => {
    const model = recordingModel((params) =>
      params.messages.length === 1
        ? reply([
            toolUse("t1", "getFinancials", { company: "GLBX" }),
            toolUse("t2", "searchDocuments", {
              query: "Globex growth organic acquisitions currency margin outlook",
            }),
          ])
        : reply([text("Globex grew 2.1% in FY2025.")]),
    );
    const events: AgentEvent[] = [];

    const result = await runAgent("How fast is Globex growing?", (e) => events.push(e), {
      createMessage: model.createMessage,
      executeTool,
    });

    // The research call plus one answer call: no separate editor pass.
    expect(model.calls).toHaveLength(2);
    expect(result.modelCalls).toBe(2);
    expect(result.toolCalls).toBe(2);
    expect(result.answer).toBe("Globex grew 2.1% in FY2025.");

    const [financials, documents] = lastToolResults(model.calls[1]);
    expect(financials.tool_use_id).toBe("t1");
    expect(financials.is_error).toBeUndefined();
    expect(financials.content).toContain('"company":"Globex Inc"');

    expect(documents.tool_use_id).toBe("t2");
    expect(documents.is_error).toBe(true);
    expect(documents.content).toMatch(/at most 6 keywords/);

    expect(events).toContainEqual(expect.objectContaining({ type: "tool_failed", name: "searchDocuments" }));
  });

  it("reports unexpected tool crashes as error results instead of failing the run", async () => {
    const model = recordingModel((params) =>
      params.messages.length === 1
        ? reply([toolUse("t1", "getFinancials", { company: "Initech" })])
        : reply([text("I couldn't retrieve Initech's financials.")]),
    );

    const events: AgentEvent[] = [];
    const result = await runAgent("Initech revenue?", (e) => events.push(e), {
      createMessage: model.createMessage,
      executeTool: async () => {
        throw new Error("connection reset");
      },
    });

    const [failed] = lastToolResults(model.calls[1]);
    expect(failed.is_error).toBe(true);
    expect(failed.content).toBe("getFinancials failed unexpectedly. Continue without this result.");
    expect(events).toContainEqual(
      expect.objectContaining({ type: "tool_failed", message: expect.stringMatching(/connection reset/) }),
    );
    expect(result.answer).toBe("I couldn't retrieve Initech's financials.");
  });

  it("disables tools on the final iteration and answers from gathered evidence", async () => {
    const model = recordingModel((params) =>
      params.tool_choice?.type === "none"
        ? reply([text("Based on what I found so far, Acme Corp grew 5.5%.")])
        : reply([toolUse(`t${params.messages.length}`, "searchCompanies", { query: "Acme Corp" })]),
    );
    let executed = 0;

    const result = await runAgent("Keep researching", () => {}, {
      createMessage: model.createMessage,
      executeTool: async () => {
        executed++;
        return { matches: [] };
      },
    });

    expect(result.iterations).toBe(MAX_ITERATIONS);
    expect(model.calls).toHaveLength(MAX_ITERATIONS);
    expect(executed).toBe(MAX_ITERATIONS - 1);
    expect(result.answer).toBe("Based on what I found so far, Acme Corp grew 5.5%.");

    const finalCall = model.calls[MAX_ITERATIONS - 1];
    expect(finalCall.tool_choice).toEqual({ type: "none" });
    expect(model.calls.slice(0, -1).every((call) => call.tool_choice === undefined)).toBe(true);

    const finalContent = finalCall.messages[finalCall.messages.length - 1].content;
    expect(JSON.stringify(finalContent)).toContain("final step");
  });

  it("starts every tool in a turn before any finishes and keeps results matched to their ids", async () => {
    const model = recordingModel((params) =>
      params.messages.length === 1
        ? reply([
            toolUse("acme", "getFinancials", { company: "Acme Corp" }),
            toolUse("globex", "getFinancials", { company: "Globex Inc" }),
            toolUse("docs", "searchDocuments", { query: "growth" }),
          ])
        : reply([text("Compared.")]),
    );
    const pending = new Map<string, (value: unknown) => void>();
    const started: string[] = [];

    const run = runAgent("Compare Acme Corp and Globex", () => {}, {
      createMessage: model.createMessage,
      executeTool: (name, input) => {
        const key = `${name}:${String(input.company ?? input.query)}`;
        started.push(key);
        return new Promise((resolve) => pending.set(key, resolve));
      },
    });

    await until(() => started.length === 3);
    // All three are in flight while none has resolved, so they were not serialized.
    expect(started).toEqual([
      "getFinancials:Acme Corp",
      "getFinancials:Globex Inc",
      "searchDocuments:growth",
    ]);

    // Resolve in reverse order; results must still line up with their tool_use ids.
    pending.get("searchDocuments:growth")?.({ documents: ["doc"] });
    pending.get("getFinancials:Globex Inc")?.({ company: "Globex Inc" });
    pending.get("getFinancials:Acme Corp")?.({ company: "Acme Corp" });
    await run;

    const results = lastToolResults(model.calls[1]);
    expect(results.map((r) => [r.tool_use_id, r.content])).toEqual([
      ["acme", '{"company":"Acme Corp"}'],
      ["globex", '{"company":"Globex Inc"}'],
      ["docs", '{"documents":["doc"]}'],
    ]);
  });

  it("stops without another model call when cancelled during tool execution", async () => {
    const controller = new AbortController();
    const model = recordingModel(() =>
      reply([toolUse("t1", "getFinancials", { company: "Globex Inc" })]),
    );
    const signals: (AbortSignal | undefined)[] = [];

    const run = runAgent(
      "Globex financials",
      (event) => {
        if (event.type === "tool_start") controller.abort();
      },
      {
        signal: controller.signal,
        createMessage: async (params, signal) => {
          signals.push(signal);
          return model.createMessage(params);
        },
        executeTool,
      },
    );

    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(model.calls).toHaveLength(1);
    expect(signals).toEqual([controller.signal]);
  });

  it("does not call the model when already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const model = recordingModel(() => reply([text("unused")]));

    await expect(
      runAgent("anything", () => {}, { signal: controller.signal, createMessage: model.createMessage }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(model.calls).toHaveLength(0);
  });

  it("never executes a tool requested on the final iteration", async () => {
    const model = recordingModel((params) =>
      reply([text("partial"), toolUse(`t${params.messages.length}`, "searchCompanies", { query: "x" })]),
    );
    let executed = 0;

    const result = await runAgent("Loop forever", () => {}, {
      createMessage: model.createMessage,
      executeTool: async () => {
        executed++;
        return {};
      },
    });

    expect(executed).toBe(MAX_ITERATIONS - 1);
    expect(result.answer).toBe("partial");
  });

  it("gives a follow-up question the earlier turns as context", async () => {
    const model = recordingModel(() => reply([text("Globex's FY2025 operating margin was 9.6%.")]));
    const history: ChatTurn[] = [
      { role: "user", content: "Tell me about Globex." },
      { role: "assistant", content: "Globex Inc (GLBX) is an industrial distributor." },
    ];

    await runAgent("What about its margins?", () => {}, { ...model, history });

    expect(model.calls[0].messages).toEqual([
      { role: "user", content: "Tell me about Globex." },
      { role: "assistant", content: "Globex Inc (GLBX) is an industrial distributor." },
      { role: "user", content: "What about its margins?" },
    ]);
  });

  it("sends at most MAX_HISTORY_MESSAGES earlier turns, keeping the most recent", async () => {
    const model = recordingModel(() => reply([text("ok")]));
    const history: ChatTurn[] = Array.from({ length: MAX_HISTORY_MESSAGES + 4 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `turn ${i}`,
    }));

    await runAgent("latest", () => {}, { ...model, history });

    const sent = model.calls[0].messages;
    expect(sent).toHaveLength(MAX_HISTORY_MESSAGES + 1);
    expect(sent[0]).toEqual({ role: "user", content: "turn 4" });
    expect(sent[sent.length - 1]).toEqual({ role: "user", content: "latest" });
  });
});
