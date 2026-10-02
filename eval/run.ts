/**
 * Live evaluation against the Anthropic API.
 *
 *   npm run eval -- [--impl improved|baseline|both] [--reps 3] [--cases 6,7] [--concurrency 4]
 *   npm run eval -- --rescore eval/results/<file>.json
 *
 * Runs every case `reps` times per implementation, applies the factual checks in
 * cases.ts, and writes the raw results to eval/results/. Model calls and token
 * usage are metered the same way for both implementations, by wrapping the SDK's
 * messages.create, so the comparison does not depend on either agent's own counters.
 * --rescore re-applies the current checks to saved answers without calling the model.
 */

import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { runAgent, type AgentEvent } from "../src/agent/agent.ts";
import type { ChatTurn } from "../src/api/api.ts";
import { cases, toolCalls, type EvalCase, type ToolCall } from "./cases.ts";

type ImplName = "improved" | "baseline";

/** Answers one turn. The baseline ignores history, as the original UI never sent any. */
type Impl = (message: string, history: ChatTurn[], onEvent: (event: AgentEvent) => void) => Promise<string>;

interface Meter {
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
}

interface TurnRecord extends Meter {
  message: string;
  answer: string;
  durationMs: number;
  /** Agent events: iterations and tool calls with their inputs. No tool outputs. */
  events: AgentEvent[];
  failedChecks: string[];
  error?: string;
}

interface RunRecord {
  impl: ImplName;
  caseId: string;
  rep: number;
  passed: boolean;
  turns: TurnRecord[];
}

interface ResultsFile {
  model: string;
  reps: number;
  records: RunRecord[];
}

const meters = new AsyncLocalStorage<Meter>();

function meterModelCalls() {
  const proto = Anthropic.Messages.prototype;
  const create = proto.create;
  proto.create = function (this: Anthropic.Messages, ...args: Parameters<typeof create>) {
    const pending = create.apply(this, args);
    const meter = meters.getStore();
    if (meter) {
      meter.modelCalls++;
      pending.then(
        (response) => {
          if ("usage" in response) {
            meter.inputTokens +=
              response.usage.input_tokens +
              (response.usage.cache_creation_input_tokens ?? 0) +
              (response.usage.cache_read_input_tokens ?? 0);
            meter.outputTokens += response.usage.output_tokens;
          }
        },
        () => {},
      );
    }
    return pending;
  } as typeof create;
}

async function loadImpl(name: ImplName): Promise<Impl> {
  if (name === "improved") {
    return async (message, history, onEvent) => (await runAgent(message, onEvent, { history })).answer;
  }
  // Imported lazily: the original module creates its Anthropic client on import.
  const baseline = await import("./baseline/agent.ts");
  return async (message, _history, onEvent) => (await baseline.runAgent(message, onEvent)).answer;
}

function score(record: Omit<RunRecord, "passed">): RunRecord {
  const evalCase = cases.find((c) => c.id === record.caseId);
  if (!evalCase) throw new Error(`Unknown case ${record.caseId}`);
  const turns = record.turns.map((turn, i) => ({
    ...turn,
    failedChecks: turn.error
      ? ["run failed"]
      : evalCase.turns[i].checks
          .filter((check) => !check.passes({ answer: turn.answer, events: turn.events }))
          .map((check) => check.description),
  }));
  const passed = turns.length === evalCase.turns.length && turns.every((t) => t.failedChecks.length === 0);
  return { ...record, turns, passed };
}

async function runCase(impl: Impl, implName: ImplName, evalCase: EvalCase, rep: number): Promise<RunRecord> {
  const history: ChatTurn[] = [];
  const turns: TurnRecord[] = [];

  for (const turn of evalCase.turns) {
    const events: AgentEvent[] = [];
    const meter: Meter = { modelCalls: 0, inputTokens: 0, outputTokens: 0 };
    const startedAt = Date.now();
    let answer = "";
    let error: string | undefined;
    try {
      answer = await meters.run(meter, () => impl(turn.message, [...history], (e) => events.push(e)));
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    turns.push({ message: turn.message, answer, durationMs: Date.now() - startedAt, ...meter, events, failedChecks: [], error });
    if (error) break;
    history.push({ role: "user", content: turn.message }, { role: "assistant", content: answer });
  }

  return score({ impl: implName, caseId: evalCase.id, rep, turns });
}

async function pool<T>(tasks: (() => Promise<T>)[], concurrency: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  return results;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

function isOverLimitSearch(call: ToolCall): boolean {
  const input = call.input;
  const query = typeof input === "object" && input !== null && "query" in input ? input.query : undefined;
  return call.name === "searchDocuments" && typeof query === "string" && query.trim().split(/\s+/).length > 6;
}

const mean = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);
const fmt = (n: number, digits = 1) => n.toFixed(digits);

function summarize(records: RunRecord[]) {
  const implNames = (["baseline", "improved"] as const).filter((impl) => records.some((r) => r.impl === impl));

  console.log("\n## Pass counts (runs passing every check)\n");
  console.log(`| Case | ${implNames.join(" | ")} |`);
  console.log(`| --- | ${implNames.map(() => "---").join(" | ")} |`);
  for (const evalCase of cases.filter((c) => records.some((r) => r.caseId === c.id))) {
    const cells = implNames.map((impl) => {
      const runs = records.filter((r) => r.impl === impl && r.caseId === evalCase.id);
      return `${runs.filter((r) => r.passed).length}/${runs.length}`;
    });
    console.log(`| ${evalCase.id} | ${cells.join(" | ")} |`);
  }

  console.log("\n## Failed checks\n");
  for (const impl of implNames) {
    const counts = new Map<string, number>();
    for (const record of records.filter((r) => r.impl === impl)) {
      for (const [i, turn] of record.turns.entries()) {
        for (const check of turn.failedChecks) {
          const key = `${record.caseId} (turn ${i + 1}): ${check}`;
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
      }
    }
    console.log(`### ${impl}`);
    if (counts.size === 0) console.log("- none");
    for (const [key, count] of counts) console.log(`- ${key} ×${count}`);
  }

  console.log("\n## Tool failures\n");
  for (const impl of implNames) {
    const turns = records.filter((r) => r.impl === impl).flatMap((r) => r.turns);
    const calls = turns.flatMap((t) => toolCalls(t.events));
    const failed = calls.filter((c) => c.failed);
    const byTool = new Map<string, number>();
    for (const call of failed) byTool.set(call.name, (byTool.get(call.name) ?? 0) + 1);
    const overLimitTurns = turns.filter((t) => toolCalls(t.events).some(isOverLimitSearch));
    const recovered = overLimitTurns.filter((t) => {
      const searches = toolCalls(t.events).filter((c) => c.name === "searchDocuments");
      return !isOverLimitSearch(searches[searches.length - 1]);
    });
    const breakdown = [...byTool].map(([name, n]) => `${name} ×${n}`).join(", ") || "none";
    console.log(
      `- ${impl}: ${failed.length} of ${calls.length} tool calls failed (${breakdown}); ` +
        `${overLimitTurns.length} turns sent a search over 6 keywords, ${recovered.length} followed it with a valid search`,
    );
  }

  console.log("\n## Per-turn cost (mean over all turns)\n");
  console.log("| Impl | Turns | Model calls | Tool calls | Tool failures | Latency (s) | Input tokens | Output tokens |");
  console.log("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const impl of implNames) {
    const turns = records.filter((r) => r.impl === impl).flatMap((r) => r.turns).filter((t) => !t.error);
    const per = (f: (t: TurnRecord) => number) => mean(turns.map(f));
    const count = (t: TurnRecord, type: AgentEvent["type"]) => t.events.filter((e) => e.type === type).length;
    console.log(
      `| ${impl} | ${turns.length} | ${fmt(per((t) => t.modelCalls), 2)} | ${fmt(per((t) => count(t, "tool_start")), 2)} | ${fmt(per((t) => count(t, "tool_failed")), 2)} | ${fmt(per((t) => t.durationMs) / 1000)} | ${fmt(per((t) => t.inputTokens), 0)} | ${fmt(per((t) => t.outputTokens), 0)} |`,
    );
  }
}

async function main() {
  const rescore = arg("rescore");
  if (rescore) {
    const saved: ResultsFile = JSON.parse(readFileSync(rescore, "utf8"));
    console.log(`Rescoring ${saved.records.length} saved runs (${saved.model}) with the current checks`);
    summarize(saved.records.map(score));
    return;
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is not set. The evaluation calls the live model.");
    process.exit(1);
  }
  const implArg = arg("impl") ?? "both";
  const implNames: ImplName[] = implArg === "both" ? ["baseline", "improved"] : [implArg as ImplName];
  if (!implNames.every((name) => name === "improved" || name === "baseline")) {
    console.error(`Unknown --impl ${implArg}`);
    process.exit(1);
  }
  const reps = Number(arg("reps") ?? 3);
  const concurrency = Number(arg("concurrency") ?? 4);
  const only = arg("cases")?.split(",");
  const selected = cases.filter((c) => !only || only.some((prefix) => c.id.startsWith(`${prefix}-`) || c.id === prefix));

  meterModelCalls();
  const impls = new Map<ImplName, Impl>();
  for (const name of implNames) impls.set(name, await loadImpl(name));

  const tasks = implNames.flatMap((implName) =>
    selected.flatMap((evalCase) =>
      Array.from({ length: reps }, (_, rep) => async () => {
        const record = await runCase(impls.get(implName)!, implName, evalCase, rep + 1);
        console.log(`${record.passed ? "PASS" : "FAIL"}  ${implName.padEnd(8)} ${evalCase.id} #${rep + 1}`);
        return record;
      }),
    ),
  );
  console.log(`Running ${tasks.length} case runs (${selected.length} cases × ${reps} reps × ${implNames.join(", ")})`);
  const records = await pool(tasks, concurrency);

  mkdirSync(new URL("./results/", import.meta.url), { recursive: true });
  const file = new URL(`./results/${new Date().toISOString().replace(/[:.]/g, "-")}.json`, import.meta.url);
  const results: ResultsFile = { model: process.env.ROGO_MODEL ?? "claude-sonnet-5", reps, records };
  writeFileSync(file, JSON.stringify(results, null, 2));

  summarize(records);
  console.log(`\nRaw results: ${file.pathname}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
