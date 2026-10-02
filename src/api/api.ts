/**
 * The contract between the browser and POST /api/chat. Shared by both sides,
 * so it must stay free of Node and DOM dependencies.
 *
 * Request:   ChatRequest as JSON.
 * Rejected:  400 with ErrorBody as JSON, before any research starts.
 * Accepted:  200 text/event-stream. Each frame is `data: <ChatStreamEvent JSON>`.
 *            Zero or more "activity" events, then exactly one "answer" or "error".
 */

export const MAX_MESSAGE_CHARS = 2_000;
export const MAX_HISTORY_MESSAGES = 12;
export const MAX_HISTORY_MESSAGE_CHARS = 12_000;

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  message: string;
  /** Earlier turns, oldest first: alternating user/assistant, starting with user and ending with assistant. */
  history: ChatTurn[];
}

export interface ErrorBody {
  error: string;
}

export type ActivityStatus = "running" | "done" | "failed";

/** One line of the research activity list. A later event with the same id replaces the earlier one. */
export interface ActivityStep {
  id: string;
  label: string;
  status: ActivityStatus;
}

export type ChatStreamEvent =
  | { type: "activity"; step: ActivityStep }
  | { type: "answer"; answer: string }
  | { type: "error"; message: string };

export type ParseResult = { ok: true; value: ChatRequest } | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseChatRequest(body: unknown): ParseResult {
  if (!isRecord(body)) return { ok: false, error: "Request body must be a JSON object." };

  const { message, history = [] } = body;
  if (typeof message !== "string") return { ok: false, error: "message must be a string." };
  const trimmed = message.trim();
  if (!trimmed) return { ok: false, error: "message must not be empty." };
  if (trimmed.length > MAX_MESSAGE_CHARS) {
    return { ok: false, error: `message must be at most ${MAX_MESSAGE_CHARS} characters.` };
  }

  if (!Array.isArray(history)) return { ok: false, error: "history must be an array." };
  if (history.length > MAX_HISTORY_MESSAGES) {
    return { ok: false, error: `history must contain at most ${MAX_HISTORY_MESSAGES} messages.` };
  }
  if (history.length % 2 !== 0) {
    return { ok: false, error: "history must contain complete user/assistant pairs." };
  }

  const turns: ChatTurn[] = [];
  for (const [i, turn] of history.entries()) {
    const expectedRole = i % 2 === 0 ? "user" : "assistant";
    if (!isRecord(turn) || turn.role !== expectedRole) {
      return { ok: false, error: `history[${i}] must be a ${expectedRole} message.` };
    }
    if (typeof turn.content !== "string" || !turn.content.trim()) {
      return { ok: false, error: `history[${i}].content must be a non-empty string.` };
    }
    if (turn.content.length > MAX_HISTORY_MESSAGE_CHARS) {
      return {
        ok: false,
        error: `history[${i}].content must be at most ${MAX_HISTORY_MESSAGE_CHARS} characters.`,
      };
    }
    turns.push({ role: expectedRole, content: turn.content });
  }

  return { ok: true, value: { message: trimmed, history: turns } };
}

export function isErrorBody(value: unknown): value is ErrorBody {
  return isRecord(value) && typeof value.error === "string";
}

export function isChatStreamEvent(value: unknown): value is ChatStreamEvent {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case "activity": {
      const step = value.step;
      return (
        isRecord(step) &&
        typeof step.id === "string" &&
        typeof step.label === "string" &&
        (step.status === "running" || step.status === "done" || step.status === "failed")
      );
    }
    case "answer":
      return typeof value.answer === "string";
    case "error":
      return typeof value.message === "string";
    default:
      return false;
  }
}
