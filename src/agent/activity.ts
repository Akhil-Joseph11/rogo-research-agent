/**
 * Turns agent events into the short activity list shown to the analyst.
 * Steps are keyed by label, so repeated calls to the same tool share one line.
 * Only labels and statuses leave the server: never tool inputs, outputs or model text.
 */

import type { AgentEvent } from "./agent.ts";
import type { ActivityStep } from "../api/api.ts";

const TOOL_LABELS: Record<string, string> = {
  searchCompanies: "Searching for companies",
  getCompanyProfile: "Reading company profiles",
  getFinancials: "Checking financials",
  searchDocuments: "Reviewing filings and transcripts",
};

const FIRST_MODEL_LABEL = "Understanding your question";
const LATER_MODEL_LABEL = "Synthesizing findings";
const FALLBACK_TOOL_LABEL = "Gathering research";

interface StepState {
  step: ActivityStep;
  running: number;
  succeeded: number;
  failed: number;
}

export class ResearchActivity {
  private readonly steps = new Map<string, StepState>();
  /**
   * Calls that reported a failure and have not ended yet, keyed by tool_use id so
   * parallel calls to one tool are tracked independently. Events without an id
   * fall back to the step label.
   */
  private readonly failing = new Map<string, number>();
  private modelLabel: string | undefined;

  handle(event: AgentEvent): ActivityStep[] {
    switch (event.type) {
      case "iteration": {
        const updates = this.endModelCall();
        this.modelLabel = event.n === 1 ? FIRST_MODEL_LABEL : LATER_MODEL_LABEL;
        updates.push(this.begin(this.modelLabel));
        return updates;
      }
      case "tool_start": {
        const updates = this.endModelCall();
        updates.push(this.begin(TOOL_LABELS[event.name] ?? FALLBACK_TOOL_LABEL));
        return updates;
      }
      case "tool_failed": {
        const key = event.id ?? TOOL_LABELS[event.name] ?? FALLBACK_TOOL_LABEL;
        this.failing.set(key, (this.failing.get(key) ?? 0) + 1);
        return [];
      }
      case "tool_end": {
        const label = TOOL_LABELS[event.name] ?? FALLBACK_TOOL_LABEL;
        const state = this.steps.get(label);
        if (!state) return [];
        const key = event.id ?? label;
        const pending = this.failing.get(key) ?? 0;
        if (pending > 0) {
          if (pending === 1) this.failing.delete(key);
          else this.failing.set(key, pending - 1);
          state.failed++;
        } else {
          state.succeeded++;
        }
        return this.end(state);
      }
    }
  }

  /** Call once the answer is ready: the model call that produced it is complete. */
  finish(): ActivityStep[] {
    return this.endModelCall();
  }

  private begin(label: string): ActivityStep {
    let state = this.steps.get(label);
    if (!state) {
      state = {
        step: { id: String(this.steps.size + 1), label, status: "running" },
        running: 0,
        succeeded: 0,
        failed: 0,
      };
      this.steps.set(label, state);
    }
    state.running++;
    state.step = { ...state.step, status: "running" };
    return state.step;
  }

  private end(state: StepState): ActivityStep[] {
    state.running = Math.max(0, state.running - 1);
    if (state.running > 0) return [];
    // A step only reads as done if at least one of its calls actually returned data.
    state.step = { ...state.step, status: state.succeeded > 0 ? "done" : "failed" };
    return [state.step];
  }

  private endModelCall(): ActivityStep[] {
    if (!this.modelLabel) return [];
    const state = this.steps.get(this.modelLabel);
    this.modelLabel = undefined;
    if (!state) return [];
    state.succeeded++;
    return this.end(state);
  }
}
