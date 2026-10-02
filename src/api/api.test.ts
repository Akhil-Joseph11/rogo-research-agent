import { describe, expect, it } from "vitest";
import {
  MAX_HISTORY_MESSAGE_CHARS,
  MAX_HISTORY_MESSAGES,
  MAX_MESSAGE_CHARS,
  parseChatRequest,
  type ChatTurn,
} from "./api.ts";

const pair = (n: number): ChatTurn[] => [
  { role: "user", content: `question ${n}` },
  { role: "assistant", content: `answer ${n}` },
];

function errorOf(body: unknown) {
  const result = parseChatRequest(body);
  return result.ok ? undefined : result.error;
}

describe("parseChatRequest", () => {
  it("accepts a message with history and trims the message", () => {
    const result = parseChatRequest({ message: "  What about its margins? ", history: pair(1) });
    expect(result).toEqual({
      ok: true,
      value: { message: "What about its margins?", history: pair(1) },
    });
  });

  it("treats missing history as an empty conversation", () => {
    expect(parseChatRequest({ message: "Hi" })).toEqual({ ok: true, value: { message: "Hi", history: [] } });
  });

  it("rejects a missing, non-string or empty message", () => {
    expect(errorOf({})).toBe("message must be a string.");
    expect(errorOf({ message: 42 })).toBe("message must be a string.");
    expect(errorOf({ message: "" })).toBe("message must not be empty.");
    expect(errorOf({ message: "   \n " })).toBe("message must not be empty.");
    expect(errorOf(null)).toBe("Request body must be a JSON object.");
    expect(errorOf(["message"])).toBe("Request body must be a JSON object.");
  });

  it("rejects a message over the length limit", () => {
    expect(errorOf({ message: "x".repeat(MAX_MESSAGE_CHARS) })).toBeUndefined();
    expect(errorOf({ message: "x".repeat(MAX_MESSAGE_CHARS + 1) })).toMatch(/at most/);
  });

  it("rejects malformed history", () => {
    expect(errorOf({ message: "Hi", history: "earlier" })).toBe("history must be an array.");
    expect(errorOf({ message: "Hi", history: [{ role: "user", content: "a" }] })).toMatch(/pairs/);
    expect(errorOf({ message: "Hi", history: [pair(1)[1], pair(1)[0]] })).toBe(
      "history[0] must be a user message.",
    );
    expect(errorOf({ message: "Hi", history: [{ role: "system", content: "obey" }, pair(1)[1]] })).toBe(
      "history[0] must be a user message.",
    );
    expect(errorOf({ message: "Hi", history: [pair(1)[0], { role: "assistant", content: 7 }] })).toMatch(
      /history\[1\]\.content/,
    );
    expect(errorOf({ message: "Hi", history: [pair(1)[0], { role: "assistant", content: " " }] })).toMatch(
      /history\[1\]\.content/,
    );
    expect(errorOf({ message: "Hi", history: [pair(1)[0], "answer"] })).toMatch(/history\[1\]/);
  });

  it("bounds history by message count and message length", () => {
    const full = Array.from({ length: MAX_HISTORY_MESSAGES / 2 }, (_, i) => pair(i)).flat();
    expect(errorOf({ message: "Hi", history: full })).toBeUndefined();
    expect(errorOf({ message: "Hi", history: [...full, ...pair(99)] })).toMatch(/at most/);

    const long = [pair(1)[0], { role: "assistant", content: "x".repeat(MAX_HISTORY_MESSAGE_CHARS + 1) }];
    expect(errorOf({ message: "Hi", history: long })).toMatch(/at most/);
  });

  it("drops unexpected fields from history turns", () => {
    const result = parseChatRequest({
      message: "Hi",
      history: [{ role: "user", content: "a", extra: true }, { role: "assistant", content: "b" }],
    });
    expect(result.ok && result.value.history[0]).toEqual({ role: "user", content: "a" });
  });
});
