/**
 * Evaluation cases. Each check is a factual or behavioural assertion about the
 * answer text or the tool trace, derived from src/research/data.ts. Nothing here scores
 * writing quality.
 */

import type { AgentEvent } from "../src/agent/agent.ts";

export interface TurnOutcome {
  answer: string;
  events: AgentEvent[];
}

export interface Check {
  description: string;
  passes: (outcome: TurnOutcome) => boolean;
}

export interface Turn {
  message: string;
  checks: Check[];
}

export interface EvalCase {
  id: string;
  group: "sample" | "targeted";
  turns: Turn[];
}

const mentions = (description: string, pattern: RegExp): Check => ({
  description,
  passes: ({ answer }) => pattern.test(answer),
});

const omits = (description: string, pattern: RegExp): Check => ({
  description,
  passes: ({ answer }) => !pattern.test(answer),
});

const BOTH_ACMES = {
  description: "names both Acme Corp and Acme Robotics instead of silently picking one",
  passes: ({ answer }: TurnOutcome) => /Acme Corp/.test(answer) && /Acme Robotics/.test(answer),
};

/**
 * Answering with one Acme's figures and none of the other's means one was chosen,
 * even if the answer mentions the other ("I'm assuming you mean Acme Corp").
 */
const ACME_CORP_FACTS = /2,260|2\.26\s?(billion|bn|B)\b|1,840|6,420|Cleveland|\b5\.[345]\d?\s?%/i;
const ACME_ROBOTICS_FACTS = /1,015|1\.015|1\.0\d?\s?(billion|bn|B)\b|\b4[678](\.\d+)?\s?%|1,180|Austin/i;
const NOT_ONE_ACME_ONLY: Check = {
  description: "does not answer with figures for only one of the two Acmes",
  passes: ({ answer }) => ACME_CORP_FACTS.test(answer) === ACME_ROBOTICS_FACTS.test(answer),
};

const NOT_COVERED = /(not|isn'?t) (a company )?(in|within|part of|among|included in) (our |the |my )?(coverage|universe|covered)|(don'?t|do not) (cover|have (any )?(financial )?(data|coverage|information))|isn'?t covered|(isn'?t|is not) (a company|one( of the companies)?) (I|we) (have|cover)|outside (our|the|my) coverage/i;
const CLARIFYING = /which (one|company|of (these|the two))|did you mean|do you mean|could you (clarify|specify)/i;
const INITECH_FY2025_CAVEAT = /preliminary|unaudited|not (yet )?(been )?(filed|reported|audited|finali[sz]ed)|(aren'?t|isn'?t|hasn'?t|haven'?t) (yet )?(been )?filed|unfiled|not yet available|delayed|guid(ed|ance)|(filed|data) (only )?through FY ?(20)?24|only has filed/i;

export interface ToolCall {
  name: string;
  input: unknown;
  failed: boolean;
}

/**
 * Pairs tool events into calls. Events carry no call id, so a failure is
 * attributed to the oldest unfinished call of the same tool.
 */
export function toolCalls(events: AgentEvent[]): ToolCall[] {
  const calls: (ToolCall & { ended: boolean })[] = [];
  const open = (name: string) => calls.find((c) => c.name === name && !c.ended);
  for (const event of events) {
    if (event.type === "tool_start") calls.push({ name: event.name, input: event.input, failed: false, ended: false });
    if (event.type === "tool_failed") {
      const call = open(event.name);
      if (call) call.failed = true;
    }
    if (event.type === "tool_end") {
      const call = open(event.name);
      if (call) call.ended = true;
    }
  }
  return calls.map(({ ended: _ended, ...call }) => call);
}

/** Resolved means a tool call for the company succeeded, or the answer uses its name or figures. */
const resolves = (description: string, inputPattern: RegExp, answerPattern: RegExp): Check => ({
  description,
  passes: ({ answer, events }) =>
    toolCalls(events).some((c) => !c.failed && inputPattern.test(JSON.stringify(c.input))) ||
    answerPattern.test(answer),
});

/** FY2025 year-over-year growth was 47.1%; the FY2021–25 CAGR is 48.3%. Either is correct. */
const ACME_ROBOTICS_GROWTH = /\b4[78](\.\d+)?\s?%/;
const ACME_CORP_GROWTH = /\b5\.[45]\d?\s?%/;

/** Every searchDocuments call that failed was followed by one that succeeded. */
const recoversFromSearchFailures: Check = {
  description: "any failed document search is followed by a successful one",
  passes: ({ events }) => {
    const searches = toolCalls(events).filter((c) => c.name === "searchDocuments");
    return searches.length === 0 || !searches[searches.length - 1].failed;
  },
};

export const cases: EvalCase[] = [
  {
    id: "1-compare-acme-globex",
    group: "sample",
    turns: [
      {
        message: "Compare Acme and Globex and tell me which one appears to be growing faster.",
        checks: [
          BOTH_ACMES,
          NOT_ONE_ACME_ONLY,
          omits("does not claim a covered company is outside coverage", NOT_COVERED),
        ],
      },
    ],
  },
  {
    id: "2-umbrella-risks",
    group: "sample",
    turns: [
      {
        message: "What are the biggest risks Umbrella Health flags in its filings?",
        checks: [
          mentions("cites dependence on acquisitions", /acqui/i),
          mentions("cites government reimbursement exposure", /reimbursement/i),
        ],
      },
    ],
  },
  {
    id: "3-initech-transition",
    group: "sample",
    turns: [
      {
        message: "How is Initech's subscription transition going?",
        checks: [
          mentions("gives a subscription figure from the sources (62%, 68% or 26%)", /\b(62|68|26)\s?%/),
          mentions("labels FY2025 figures as preliminary/unaudited/unfiled", INITECH_FY2025_CAVEAT),
        ],
      },
    ],
  },
  {
    id: "4-fastest-growing",
    group: "sample",
    turns: [
      {
        message: "Which company in the universe is growing fastest?",
        checks: [
          mentions("identifies Acme Robotics", /Acme Robotics/),
          mentions("states Acme Robotics' ~47% FY2025 growth", ACME_ROBOTICS_GROWTH),
          {
            description: "if Initech is discussed, its FY2025 figures carry a caveat",
            passes: ({ answer }) => !/Initech/.test(answer) || INITECH_FY2025_CAVEAT.test(answer),
          },
        ],
      },
    ],
  },
  {
    id: "5-glbx-vs-itch",
    group: "sample",
    turns: [
      {
        message: "Is GLBX a better business than ITCH?",
        checks: [
          resolves("resolves GLBX to Globex", /globex|glbx/i, /Globex|8,905|8,720/),
          resolves("resolves ITCH to Initech", /initech|itch/i, /Initech|\b988\b/),
          mentions("flags Initech's unfiled/preliminary FY2025", INITECH_FY2025_CAVEAT),
          omits("does not claim either ticker is unknown", NOT_COVERED),
        ],
      },
    ],
  },
  {
    id: "6-lowercase-ticker",
    group: "targeted",
    turns: [
      {
        message: "Tell me about glbx.",
        checks: [
          mentions("answers about Globex", /Globex/),
          mentions("includes a Globex-specific fact", /Springfield|41,300|conglomerate|Diversified Industrials|8,905|8\.9 billion/i),
          omits("does not claim GLBX is unknown", NOT_COVERED),
        ],
      },
    ],
  },
  {
    id: "7-ambiguous-acme",
    group: "targeted",
    turns: [{ message: "Tell me about acme.", checks: [BOTH_ACMES, NOT_ONE_ACME_ONLY] }],
  },
  {
    id: "8-explicit-acme-pair",
    group: "targeted",
    turns: [
      {
        message: "Compare FY2025 revenue growth for Acme Corp and Acme Robotics.",
        checks: [
          mentions("states Acme Corp's ~5.5% growth", ACME_CORP_GROWTH),
          mentions("states Acme Robotics' ~47% growth", ACME_ROBOTICS_GROWTH),
          omits("does not ask which Acme is meant", CLARIFYING),
        ],
      },
    ],
  },
  {
    id: "9-unknown-company",
    group: "targeted",
    turns: [
      {
        message: "What was Tesla's revenue last year?",
        checks: [
          mentions("says Tesla is not covered", NOT_COVERED),
          omits("gives no revenue figure", /\$\s?\d|\d[\d,.]*\s?(billion|million|bn)\b/i),
        ],
      },
    ],
  },
  {
    id: "10-clarification-flow",
    group: "targeted",
    turns: [
      { message: "How fast is Acme growing?", checks: [BOTH_ACMES, NOT_ONE_ACME_ONLY] },
      {
        message: "Acme Robotics.",
        checks: [
          mentions("answers with Acme Robotics' ~47% growth", ACME_ROBOTICS_GROWTH),
          omits("does not ask again which company", CLARIFYING),
        ],
      },
    ],
  },
  {
    id: "11-follow-up-pronoun",
    group: "targeted",
    turns: [
      { message: "Tell me about Globex.", checks: [mentions("answers about Globex", /Globex/)] },
      {
        message: "What was its operating margin in FY2025?",
        checks: [
          mentions("gives Globex's FY2025 operating margin (~9.9%, $878M)", /9\.9\s?%|9\.86|878/),
          omits("does not ask which company 'its' means", CLARIFYING),
        ],
      },
    ],
  },
  {
    id: "12-missing-period",
    group: "targeted",
    turns: [
      {
        message: "Compare Initech's and Acme Corp's FY2025 revenue.",
        checks: [
          mentions("gives Acme Corp's FY2025 revenue ($2,260M)", /2,260|2\.26\s?(billion|bn|B)/i),
          mentions("says Initech's FY2025 is not filed or only preliminary", INITECH_FY2025_CAVEAT),
          omits("does not treat the missing period as zero", /\$0\b|zero revenue|revenue of 0\b/i),
        ],
      },
    ],
  },
  {
    id: "13-preliminary-data",
    group: "targeted",
    turns: [
      {
        message: "What were Initech's FY2025 results?",
        checks: [
          mentions("gives the preliminary range ($1.12–1.14B or 13–15%)", /1\.1[24]|1,1[24]0|\b1[35]\s?%/),
          mentions("labels them preliminary/unaudited", /preliminary|unaudited/i),
          omits("does not present them as final or audited", /\b(reported|final|audited) FY2025 (revenue|results) (of|were|was)\b/i),
        ],
      },
    ],
  },
  {
    id: "14-organic-vs-acquired",
    group: "targeted",
    turns: [
      {
        message: "Which grew faster organically in FY2025, Umbrella Health or Globex?",
        checks: [
          mentions("gives Umbrella's organic growth (~3.1%) or acquisition contribution (6.5 pts)", /3\.1\s?(%|percent|percentage|points|pts)|6\.5/i),
          mentions("gives Globex's organic growth (~0.6%)", /0\.6\s?(%|percent)/i),
          omits("does not call Umbrella's 9.6% organic", /9\.6\s?%\s*(organic|organically)/i),
        ],
      },
    ],
  },
  {
    id: "15-long-document-query",
    group: "targeted",
    turns: [
      {
        message:
          "Search the filings for Initech subscription transition perpetual license conversion net revenue retention discounting, and summarize what they say.",
        checks: [
          mentions("reports the 112% net revenue retention from the transcript", /112\s?%/),
          recoversFromSearchFailures,
        ],
      },
    ],
  },
];
