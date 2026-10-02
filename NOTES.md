# Notes

## What changed

### Trustworthy research

- Added a shared company resolver supporting names and tickers while handling ambiguous references conservatively.
- Tool failures are returned to the agent as errors rather than being treated as successful data.
- Strengthened grounding around missing, preliminary, restated, and acquisition-driven financial data.
- Added source attribution based only on information returned by the tools.

### Agent efficiency

- Removed the redundant second model call that rewrote the completed answer.
- Independent tool calls in the same model turn now run in parallel.
- Added cancellation through the model and tool calls.
- Trimmed bookkeeping-only metadata from model-facing financial payloads.
- Added Anthropic prompt caching for the static system prompt and tool definitions, so later model calls in a request read that prefix from cache instead of reprocessing it.

### Research UX and API

- Added bounded conversation history so follow-up questions work while figures are re-fetched for grounding.
- Added real-time research activity using SSE events emitted by the backend.
- Added request validation and clearer error handling.
- Added safe Markdown rendering and a Stop action for in-progress research.

### Testing and measurement

- Added deterministic unit/integration tests covering the resolver, tools, agent loop, API, streaming client, and Markdown rendering.
- Added a 15-case live evaluation harness with three runs per case.
- Added request-level instrumentation for latency, model/tool calls, failures, and token usage.
- Compared the improved implementation against the untouched initial implementation using the same evaluation harness.

## Results

- `npm run typecheck` passes.
- `npm test` passes 94 tests.
- The latest paired evaluation passed 39/45 initial runs and 45/45 improved runs.
- Mean latency decreased from 18.7s to 8.2s in the provided local benchmark.
- Model calls decreased from 3.16 to 1.98 per turn.

The latency benchmark uses the exercise's simulated tool delays, so it is intended to demonstrate architectural improvements rather than production performance.

## What I deliberately did not change

I did not add external research APIs, vector search/embeddings, Redis, database persistence, authentication, multi-agent orchestration, saved conversations, token-by-token answer streaming, or a large UI redesign. These would add substantial scope without addressing the highest-impact issues in the provided exercise.

## One evaluation-driven fix

The evaluation exposed a stopping-policy regression: when a result pointed to an 8-K containing the requested information, the agent sometimes offered to retrieve it instead of doing so. I changed the stopping rule to fetch a referenced source when it can answer the question. This improved that targeted case while keeping the general stopping behavior.

## Known limitations

- The provided corpus is intentionally small, so the evaluation measures agent behavior rather than retrieval quality at scale.
- Three runs per case indicate consistency but are not a statistically meaningful accuracy estimate.
- The model can still occasionally add unsupported qualifiers, such as describing a filing as audited when the data only establishes that it was filed.
