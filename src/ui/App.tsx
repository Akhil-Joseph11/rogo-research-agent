import { useEffect, useRef, useState } from "react";
import type { ActivityStep } from "../api/api.ts";
import { buildHistory, ChatError, streamChat, upsertStep, type TranscriptEntry } from "./chatClient.ts";
import { Markdown } from "./Markdown.tsx";

interface Entry extends TranscriptEntry {
  id: number;
  /** Research activity behind an assistant entry, kept so it can be reopened. */
  steps?: ActivityStep[];
}

const EXAMPLES = [
  "Compare Acme and Globex and tell me which one appears to be growing faster.",
  "What are the biggest risks Umbrella Health flags in its filings?",
  "How is Initech's subscription transition going?",
  "Which company in the universe is growing fastest?",
];

const STATUS_MARK: Record<ActivityStep["status"], string> = {
  running: "•",
  done: "✓",
  failed: "✕",
};

function ActivityList({ steps }: { steps: readonly ActivityStep[] }) {
  return (
    <ul className="activity">
      {steps.map((step) => (
        <li key={step.id} className={step.status}>
          <span className="mark" aria-hidden="true">
            {STATUS_MARK[step.status]}
          </span>
          {step.label}
          {step.status === "failed" && <span className="note"> (unavailable)</span>}
        </li>
      ))}
    </ul>
  );
}

let nextId = 0;

export function App() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [input, setInput] = useState("");
  const [activity, setActivity] = useState<ActivityStep[] | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const busy = activity !== null;

  useEffect(() => () => controllerRef.current?.abort(), []);
  useEffect(() => {
    // Braces matter: newer browsers return a Promise from scrollIntoView, and
    // React would treat a returned value as the effect's cleanup function.
    endRef.current?.scrollIntoView({ block: "end" });
  }, [entries.length, activity?.length]);

  async function send(text: string) {
    const question = text.trim();
    // The ref, unlike `busy`, is current even before React re-renders.
    if (!question || controllerRef.current) return;

    const history = buildHistory(entries);
    const add = (fields: Omit<Entry, "id">) => {
      const entry = { ...fields, id: nextId++ };
      setEntries((prev) => [...prev, entry]);
    };

    add({ role: "user", text: question });
    setInput("");
    setActivity([]);

    const controller = new AbortController();
    controllerRef.current = controller;
    let steps: ActivityStep[] = [];

    try {
      const answer = await streamChat(
        { message: question, history },
        (step) => {
          steps = upsertStep(steps, step);
          setActivity(steps);
        },
        controller.signal,
      );
      add({ role: "assistant", text: answer, status: "answered", steps });
    } catch (err) {
      if (controller.signal.aborted) {
        add({ role: "assistant", text: "Stopped.", status: "stopped", steps });
      } else {
        const message = err instanceof ChatError ? err.message : "Something went wrong. Please try again.";
        add({ role: "assistant", text: message, status: "error", steps });
      }
    } finally {
      controllerRef.current = null;
      setActivity(null);
    }
  }

  return (
    <div className="app">
      <header>
        <h1>Rogo Research</h1>
        <p>Ask a question about a company in our coverage universe.</p>
      </header>

      <div className="transcript">
        {entries.length === 0 && (
          <div className="examples">
            {EXAMPLES.map((example) => (
              <button key={example} onClick={() => send(example)}>
                {example}
              </button>
            ))}
          </div>
        )}

        {entries.map((entry) =>
          entry.role === "user" ? (
            <div key={entry.id} className="bubble user">
              {entry.text}
            </div>
          ) : (
            <div key={entry.id} className={`bubble assistant ${entry.status ?? ""}`}>
              {entry.steps && entry.steps.length > 0 && (
                <details className="research">
                  <summary>Research steps</summary>
                  <ActivityList steps={entry.steps} />
                </details>
              )}
              {entry.status === "answered" ? <Markdown text={entry.text} /> : <p>{entry.text}</p>}
            </div>
          ),
        )}

        {activity && (
          <div className="bubble assistant pending" aria-live="polite">
            <div className="pending-title">Researching…</div>
            <ActivityList steps={activity} />
          </div>
        )}
        <div ref={endRef} className="transcript-end" />
      </div>

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask a research question…"
          disabled={busy}
        />
        {busy ? (
          <button type="button" onClick={() => controllerRef.current?.abort()}>
            Stop
          </button>
        ) : (
          <button type="submit">Send</button>
        )}
      </form>
    </div>
  );
}
