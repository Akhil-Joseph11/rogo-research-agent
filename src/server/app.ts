/**
 * The HTTP API. See api.ts for the request, error and stream event shapes.
 */

import { randomUUID } from "node:crypto";
import express, { type ErrorRequestHandler, type Response } from "express";
import { ResearchActivity } from "../agent/activity.ts";
import { runAgent, type AgentEvent } from "../agent/agent.ts";
import { parseChatRequest, type ChatStreamEvent, type ErrorBody } from "../api/api.ts";

const GENERIC_FAILURE = "Something went wrong while researching. Please try again.";

/**
 * One structured line per request. Holds counts and timings only: never the
 * question, history, answer or tool payloads.
 */
export interface RequestLog {
  event: "chat_request";
  requestId: string;
  outcome: "answered" | "rejected" | "cancelled" | "failed";
  status: number;
  durationMs: number;
  historyMessages?: number;
  iterations?: number;
  modelCalls?: number;
  toolCalls?: number;
  toolFailures?: number;
  /** Only known when the run completes; the API reports usage per response. */
  inputTokens?: number;
  outputTokens?: number;
}

function logRequest(entry: RequestLog) {
  console.log(JSON.stringify(entry));
}

/** Human-readable trace for the dev terminal, tagged with the request it belongs to. */
function logEvent(tag: string, event: AgentEvent) {
  switch (event.type) {
    case "iteration":
      console.log(`${tag} [agent] iteration ${event.n}`);
      break;
    case "tool_start":
      console.log(`${tag} [tool]  → ${event.name} ${JSON.stringify(event.input)}`);
      break;
    case "tool_end":
      console.log(`${tag} [tool]  ← ${event.name} (${event.ms}ms)`);
      break;
    case "tool_failed":
      console.log(`${tag} [tool]  ! ${event.name}: ${event.message}`);
      break;
  }
}

function requestIdOf(res: Response): string {
  return typeof res.locals.requestId === "string" ? res.locals.requestId : "unknown";
}

function elapsedMs(res: Response): number {
  return typeof res.locals.startedAt === "number" ? Date.now() - res.locals.startedAt : 0;
}

export function createApp(run: typeof runAgent = runAgent) {
  const app = express();

  app.use((_req, res, next) => {
    const requestId = randomUUID();
    res.locals.requestId = requestId;
    res.locals.startedAt = Date.now();
    res.setHeader("X-Request-Id", requestId);
    next();
  });
  // Room for MAX_HISTORY_MESSAGES long answers; parseChatRequest enforces the real limits.
  app.use(express.json({ limit: "256kb" }));

  app.post("/api/chat", async (req, res) => {
    const requestId = requestIdOf(res);

    const parsed = parseChatRequest(req.body);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error } satisfies ErrorBody);
      logRequest({ event: "chat_request", requestId, outcome: "rejected", status: 400, durationMs: elapsedMs(res) });
      return;
    }
    const { message, history } = parsed.value;
    const tag = `[${requestId.slice(0, 8)}]`;
    console.log(`\n${tag} [chat] ${message.length > 100 ? `${message.slice(0, 100)}…` : message}`);

    // "close" fires when the response finishes or the client goes away; only the
    // second case should stop the agent.
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) controller.abort();
    });

    // From here on the status is 200 and failures are reported as stream events.
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    const send = (event: ChatStreamEvent) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    // Counts seen so far, so cancelled and failed runs are still measurable.
    const seen = { iterations: 0, toolCalls: 0, toolFailures: 0 };
    const activity = new ResearchActivity();
    try {
      const result = await run(
        message,
        (event) => {
          if (event.type === "iteration") seen.iterations = event.n;
          if (event.type === "tool_start") seen.toolCalls++;
          if (event.type === "tool_failed") seen.toolFailures++;
          logEvent(tag, event);
          for (const step of activity.handle(event)) send({ type: "activity", step });
        },
        { signal: controller.signal, history },
      );
      for (const step of activity.finish()) send({ type: "activity", step });
      send({ type: "answer", answer: result.answer });
      logRequest({
        event: "chat_request",
        requestId,
        outcome: "answered",
        status: 200,
        durationMs: elapsedMs(res),
        historyMessages: history.length,
        iterations: result.iterations,
        modelCalls: result.modelCalls,
        toolCalls: result.toolCalls,
        toolFailures: result.toolFailures,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
      });
    } catch (err) {
      const aborted = controller.signal.aborted;
      if (!aborted) {
        console.error(tag, err);
        send({ type: "error", message: GENERIC_FAILURE });
      }
      logRequest({
        event: "chat_request",
        requestId,
        outcome: aborted ? "cancelled" : "failed",
        status: 200,
        durationMs: elapsedMs(res),
        historyMessages: history.length,
        ...seen,
        modelCalls: seen.iterations,
      });
    } finally {
      res.end();
    }
  });

  // Malformed JSON, oversized bodies and anything unexpected: a JSON error, never a stack trace.
  const handleError: ErrorRequestHandler = (err, _req, res, next) => {
    if (res.headersSent) return next(err);
    const raw =
      typeof err === "object" && err !== null && "status" in err && typeof err.status === "number"
        ? err.status
        : 500;
    const status = raw >= 400 && raw < 600 ? raw : 500;
    if (status >= 500) console.error(err);
    const error =
      status === 413
        ? "Request body is too large."
        : status === 400
          ? "Request body must be valid JSON."
          : status < 500
            ? "The request could not be read."
            : GENERIC_FAILURE;
    res.status(status).json({ error } satisfies ErrorBody);
    logRequest({
      event: "chat_request",
      requestId: requestIdOf(res),
      outcome: status < 500 ? "rejected" : "failed",
      status,
      durationMs: elapsedMs(res),
    });
  };
  app.use(handleError);

  return app;
}
