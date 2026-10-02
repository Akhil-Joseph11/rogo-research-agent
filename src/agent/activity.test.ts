import { describe, expect, it } from "vitest";
import { ResearchActivity } from "./activity.ts";
import type { AgentEvent } from "./agent.ts";
import type { ActivityStep } from "../api/api.ts";

function run(events: AgentEvent[]) {
  const activity = new ResearchActivity();
  const updates: ActivityStep[] = events.flatMap((event) => activity.handle(event));
  updates.push(...activity.finish());
  const final = new Map(updates.map((step) => [step.id, step]));
  return { updates, final: [...final.values()] };
}

const start = (name: string): AgentEvent => ({ type: "tool_start", name, input: { company: "secret input" } });
const end = (name: string): AgentEvent => ({ type: "tool_end", name, ms: 5 });
const fail = (name: string): AgentEvent => ({ type: "tool_failed", name, message: "internal detail" });

describe("ResearchActivity", () => {
  it("maps model calls and tool calls to labelled steps that complete in order", () => {
    const { updates, final } = run([
      { type: "iteration", n: 1 },
      start("getFinancials"),
      start("getFinancials"),
      start("searchDocuments"),
      end("getFinancials"),
      end("searchDocuments"),
      end("getFinancials"),
      { type: "iteration", n: 2 },
    ]);

    expect(final).toEqual([
      { id: "1", label: "Understanding your question", status: "done" },
      { id: "2", label: "Checking financials", status: "done" },
      { id: "3", label: "Reviewing filings and transcripts", status: "done" },
      { id: "4", label: "Synthesizing findings", status: "done" },
    ]);
    // Parallel calls to one tool share a line that completes only when the last call ends.
    const financials = updates.filter((step) => step.id === "2").map((step) => step.status);
    expect(financials).toEqual(["running", "running", "done"]);
  });

  it("marks a step failed, not done, when every call behind it failed", () => {
    const { final } = run([{ type: "iteration", n: 1 }, start("searchDocuments"), fail("searchDocuments"), end("searchDocuments")]);
    expect(final).toContainEqual({ id: "2", label: "Reviewing filings and transcripts", status: "failed" });
  });

  it("marks a step done when a retry succeeded after a failure", () => {
    const { final } = run([
      start("searchDocuments"),
      fail("searchDocuments"),
      end("searchDocuments"),
      start("searchDocuments"),
      end("searchDocuments"),
    ]);
    expect(final).toEqual([{ id: "1", label: "Reviewing filings and transcripts", status: "done" }]);
  });

  it("never exposes tool inputs or error messages", () => {
    const { updates } = run([start("getFinancials"), fail("getFinancials"), end("getFinancials")]);
    const serialized = JSON.stringify(updates);
    expect(serialized).not.toContain("secret input");
    expect(serialized).not.toContain("internal detail");
  });

  it("gives unknown tools a generic label", () => {
    const { final } = run([start("somethingNew"), end("somethingNew")]);
    expect(final).toEqual([{ id: "1", label: "Gathering research", status: "done" }]);
  });
});
