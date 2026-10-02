/**
 * The research agent: a tool-use loop over the mocked research tools.
 */

import Anthropic from "@anthropic-ai/sdk";
import { MAX_HISTORY_MESSAGES, type ChatTurn } from "../api/api.ts";
import { executeTool, toolSchemas, ToolError } from "../research/tools.ts";
import { FINAL_TURN_NOTE, SYSTEM_PROMPT } from "./prompts.ts";

const MODEL = process.env.ROGO_MODEL ?? "claude-sonnet-5";
export const MAX_ITERATIONS = 12;

// The breakpoint caches the tools and system prompt, which are identical on every
// call. Messages come after it, so history, questions and tool results are never cached.
const SYSTEM: Anthropic.TextBlockParam[] = [
  { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
];

const NO_ANSWER =
  "I wasn't able to put together a reliable answer from the research I gathered. Try asking a narrower question.";

export type AgentEvent =
  | { type: "iteration"; n: number }
  | { type: "tool_start"; id?: string; name: string; input: unknown }
  | { type: "tool_end"; id?: string; name: string; ms: number }
  /** `message` is for server-side logs; the model may have been sent a sanitized version. */
  | { type: "tool_failed"; id?: string; name: string; message: string };

export interface AgentResult {
  answer: string;
  iterations: number;
  modelCalls: number;
  toolCalls: number;
  toolFailures: number;
  /** Summed from the usage the API reports on each model response, including cache writes and reads. */
  inputTokens: number;
  outputTokens: number;
}

export type CreateMessage = (
  params: Anthropic.MessageCreateParamsNonStreaming,
  signal?: AbortSignal,
) => Promise<Anthropic.Message>;

export type ExecuteTool = (
  name: string,
  input: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<unknown>;

export interface AgentOptions {
  /** Aborting stops the run: in-flight model and tool calls are cancelled and runAgent rejects. */
  signal?: AbortSignal;
  /** Earlier turns, oldest first, already validated. Only the most recent MAX_HISTORY_MESSAGES are used. */
  history?: readonly ChatTurn[];
  /** Seams for tests. Production uses the Anthropic client and the local tools. */
  createMessage?: CreateMessage;
  executeTool?: ExecuteTool;
}

let client: Anthropic | undefined;

const createWithAnthropic: CreateMessage = (params, signal) => {
  client ??= new Anthropic();
  return client.messages.create(params, { signal });
};

function textOf(message: Anthropic.Message): string {
  return message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withFinalTurnNote(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  const last = messages[messages.length - 1];
  const content: Anthropic.ContentBlockParam[] =
    typeof last.content === "string"
      ? [{ type: "text", text: last.content }]
      : [...last.content];
  content.push({ type: "text", text: FINAL_TURN_NOTE });
  return [...messages.slice(0, -1), { ...last, content }];
}

/**
 * Runs one tool call and always resolves to its result block, turning failures
 * into is_error results. The only rejection is cancellation of the whole run.
 */
async function runTool(
  use: Anthropic.ToolUseBlock,
  execute: ExecuteTool,
  onEvent: (event: AgentEvent) => void,
  signal: AbortSignal | undefined,
): Promise<Anthropic.ToolResultBlockParam> {
  const startedAt = Date.now();
  onEvent({ type: "tool_start", id: use.id, name: use.name, input: use.input });

  try {
    const output = await execute(use.name, isRecord(use.input) ? use.input : {}, signal);
    return { type: "tool_result", tool_use_id: use.id, content: JSON.stringify(output) };
  } catch (err) {
    if (signal?.aborted) throw err;
    // Only ToolError messages are written for the model. Anything else may carry
    // internal details, so the model gets a generic message and the logs get the cause.
    const isToolError = err instanceof ToolError;
    const modelMessage = isToolError
      ? err.message
      : `${use.name} failed unexpectedly. Continue without this result.`;
    const logMessage = isToolError
      ? err.message
      : `${use.name} failed unexpectedly (${err instanceof Error ? err.message : String(err)})`;
    onEvent({ type: "tool_failed", id: use.id, name: use.name, message: logMessage });
    return { type: "tool_result", tool_use_id: use.id, content: modelMessage, is_error: true };
  } finally {
    onEvent({ type: "tool_end", id: use.id, name: use.name, ms: Date.now() - startedAt });
  }
}

export async function runAgent(
  question: string,
  onEvent: (event: AgentEvent) => void,
  options: AgentOptions = {},
): Promise<AgentResult> {
  const { signal } = options;
  const createMessage = options.createMessage ?? createWithAnthropic;
  const execute = options.executeTool ?? executeTool;

  const messages: Anthropic.MessageParam[] = [
    ...(options.history ?? [])
      .slice(-MAX_HISTORY_MESSAGES)
      .map((turn): Anthropic.MessageParam => ({ role: turn.role, content: turn.content })),
    { role: "user", content: question },
  ];

  let answer = "";
  let iterations = 0;
  let toolCalls = 0;
  let toolFailures = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  while (iterations < MAX_ITERATIONS) {
    signal?.throwIfAborted();
    iterations++;
    onEvent({ type: "iteration", n: iterations });

    // On the last step the model must answer from what it already has, so tool
    // calls are switched off. The tools stay in the request so earlier
    // tool_use blocks in the conversation remain valid.
    const isFinal = iterations === MAX_ITERATIONS;

    const response = await createMessage(
      {
        model: MODEL,
        max_tokens: 16000,
        system: SYSTEM,
        tools: toolSchemas,
        messages: isFinal ? withFinalTurnNote(messages) : [...messages],
        ...(isFinal && { tool_choice: { type: "none" } }),
      },
      signal,
    );

    inputTokens +=
      response.usage.input_tokens +
      (response.usage.cache_creation_input_tokens ?? 0) +
      (response.usage.cache_read_input_tokens ?? 0);
    outputTokens += response.usage.output_tokens;
    messages.push({ role: "assistant", content: response.content });

    const toolUses = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
    );

    if (toolUses.length === 0 || isFinal) {
      answer = textOf(response);
      break;
    }

    // The model chose every call in this turn before seeing any result, so they
    // are independent and run together. runTool never rejects for a tool
    // failure, and Promise.all keeps results in toolUses order.
    const toolResults = await Promise.all(
      toolUses.map((use) => runTool(use, execute, onEvent, signal)),
    );
    toolCalls += toolUses.length;
    toolFailures += toolResults.filter((result) => result.is_error).length;
    messages.push({ role: "user", content: toolResults });
  }

  return {
    answer: answer || NO_ANSWER,
    iterations,
    modelCalls: iterations,
    toolCalls,
    toolFailures,
    inputTokens,
    outputTokens,
  };
}
