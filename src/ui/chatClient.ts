import {
  isChatStreamEvent,
  isErrorBody,
  MAX_HISTORY_MESSAGE_CHARS,
  MAX_HISTORY_MESSAGES,
  type ActivityStep,
  type ChatRequest,
  type ChatTurn,
} from "../api/api.ts";

/** A failure with a message that is safe and useful to show the analyst. */
export class ChatError extends Error {}

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

const UNREACHABLE = "Couldn't reach the research server. Check that it is running and try again.";
const MALFORMED = "The research server sent a response the app couldn't read. Please try again.";
const NO_ANSWER = "The research server stopped before sending an answer. Please try again.";

/**
 * Sends a question and resolves with the final answer, reporting activity as it streams in.
 * Rejects with ChatError for anything that went wrong, or with the abort reason if cancelled.
 */
export async function streamChat(
  request: ChatRequest,
  onStep: (step: ActivityStep) => void,
  signal: AbortSignal,
  fetchImpl: Fetch = fetch,
): Promise<string> {
  let res: Response;
  try {
    res = await fetchImpl("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify(request),
      signal,
    });
  } catch (err) {
    if (signal.aborted) throw err;
    throw new ChatError(UNREACHABLE);
  }

  if (!res.ok) {
    const body: unknown = await res.json().catch(() => null);
    throw new ChatError(
      isErrorBody(body) ? body.error : `The research server returned an error (${res.status}). Please try again.`,
    );
  }
  if (!res.body) throw new ChatError(MALFORMED);

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  try {
    while (true) {
      let chunk: ReadableStreamReadResult<string>;
      try {
        chunk = await reader.read();
      } catch (err) {
        if (signal.aborted) throw err;
        throw new ChatError(UNREACHABLE);
      }
      if (chunk.done) break;
      buffer += chunk.value.replace(/\r\n/g, "\n");

      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = parseFrame(frame);
        if (!event) continue;
        if (event.type === "activity") onStep(event.step);
        else if (event.type === "error") throw new ChatError(event.message);
        else return event.answer;
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  throw new ChatError(NO_ANSWER);
}

function parseFrame(frame: string) {
  const data = frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data) return undefined;

  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    throw new ChatError(MALFORMED);
  }
  if (!isChatStreamEvent(value)) throw new ChatError(MALFORMED);
  return value;
}

export interface TranscriptEntry {
  role: "user" | "assistant";
  text: string;
  /** Assistant entries only. Only answered turns are sent back as context. */
  status?: "answered" | "error" | "stopped";
}

/** The most recent answered question/answer pairs, oldest first, within MAX_HISTORY_MESSAGES. */
export function buildHistory(transcript: readonly TranscriptEntry[]): ChatTurn[] {
  const turns: ChatTurn[] = [];
  for (let i = 0; i + 1 < transcript.length; i++) {
    const question = transcript[i];
    const reply = transcript[i + 1];
    if (question.role === "user" && reply.role === "assistant" && reply.status === "answered") {
      turns.push(
        { role: "user", content: question.text.slice(0, MAX_HISTORY_MESSAGE_CHARS) },
        { role: "assistant", content: reply.text.slice(0, MAX_HISTORY_MESSAGE_CHARS) },
      );
      i++;
    }
  }
  return turns.slice(-MAX_HISTORY_MESSAGES);
}

export function upsertStep(steps: readonly ActivityStep[], step: ActivityStep): ActivityStep[] {
  return steps.some((s) => s.id === step.id)
    ? steps.map((s) => (s.id === step.id ? step : s))
    : [...steps, step];
}
