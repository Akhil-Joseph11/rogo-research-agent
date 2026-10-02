/**
 * The agent's tools. These stand in for the real research APIs — same shapes,
 * local data, plus a little latency so the app behaves like the real thing.
 *
 * A thrown ToolError means the call could not be serviced and is sent back to
 * the model as an error result. A search that runs but finds nothing returns
 * normally with an empty list and a note.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { coverageList, describeCompany, resolveCompany } from "./companies.ts";
import { documents, financials, type Company, type FinancialRecord } from "./data.ts";

/** Thrown when a tool cannot service a request. The message is shown to the model. */
export class ToolError extends Error {}

/** The upstream document index rejects longer queries. */
export const MAX_SEARCH_TERMS = 6;

/** Simulated API latency. Rejects with the signal's reason as soon as it aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * The financial record as the model sees it. The checksum and ETL pipeline
 * version identify the ingest job, not the figures, so they are left out. The
 * source, ingest date and restatements stay because they qualify the numbers.
 */
export type ModelFinancials = Omit<FinancialRecord, "provenance"> & {
  provenance: Omit<FinancialRecord["provenance"], "checksum" | "pipelineVersion">;
};

function toModelFinancials(record: FinancialRecord): ModelFinancials {
  const { checksum: _checksum, pipelineVersion: _pipelineVersion, ...provenance } =
    record.provenance;
  return { ...record, provenance };
}

const COMPANY_INPUT = {
  type: "string",
  description: "A company name or ticker, for example \"Globex Inc\" or \"GLBX\".",
} as const;

export const toolSchemas: Anthropic.Tool[] = [
  {
    name: "searchCompanies",
    description:
      "Find covered companies matching a name or ticker. Returns each match's name, ticker and sector. If the reference matches several different companies, all of them are returned with ambiguous set to true.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "A company name, part of one, or a ticker." },
      },
      required: ["query"],
    },
  },
  {
    name: "getCompanyProfile",
    description:
      "Get a company's profile: description, sector, headquarters, headcount, business segments and the filings we hold. Fails if the company is ambiguous or not covered.",
    input_schema: {
      type: "object",
      properties: { company: COMPANY_INPUT },
      required: ["company"],
    },
  },
  {
    name: "getFinancials",
    description:
      "Get annual and quarterly financials in USD millions: revenue, gross margin, operating income, net income and free cash flow. A null figure means the period has not been filed; it is not zero. Also returns provenance, restatements and any data warnings, which qualify the figures. Fails if the company is ambiguous or not covered.",
    input_schema: {
      type: "object",
      properties: { company: COMPANY_INPUT },
      required: ["company"],
    },
  },
  {
    name: "searchDocuments",
    description: `Keyword search over earnings call transcripts, filing excerpts and press releases. Returns up to 5 documents with id, company, form, title, date and body. Accepts at most ${MAX_SEARCH_TERMS} keywords, counted as space-separated words: "net revenue retention" is 3. Use the company filter rather than putting a company name in the query.`,
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: `1 to ${MAX_SEARCH_TERMS} words separated by spaces. Every word counts toward the limit.`,
        },
        company: {
          ...COMPANY_INPUT,
          description: "Optional. Restrict the search to one company, by name or ticker.",
        },
      },
      required: ["query"],
    },
  },
];

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ToolError(`"${field}" must be a non-empty string.`);
  }
  return value.trim();
}

/** Resolves a company argument or fails with a message the model can act on. */
export function requireCompany(value: unknown): Company {
  const reference = requireText(value, "company");
  const resolution = resolveCompany(reference);

  switch (resolution.kind) {
    case "found":
      return resolution.company;
    case "ambiguous":
      throw new ToolError(
        `"${reference}" is ambiguous: it matches ${resolution.candidates.map(describeCompany).join(" and ")}, which are different companies. Do not choose one. Ask the analyst which they mean, unless the question already names one exactly.`,
      );
    case "not_found":
      throw new ToolError(
        `"${reference}" is not in our coverage universe. Covered companies: ${coverageList()}. Do not substitute a different company.`,
      );
  }
}

const summarize = (c: Company) => ({ name: c.name, ticker: c.ticker, sector: c.sector });

async function searchCompanies(query: unknown, signal?: AbortSignal) {
  await sleep(250, signal);
  const reference = requireText(query, "query");
  const resolution = resolveCompany(reference);

  switch (resolution.kind) {
    case "found":
      return { matches: [summarize(resolution.company)], ambiguous: false };
    case "ambiguous":
      return {
        matches: resolution.candidates.map(summarize),
        ambiguous: true,
        note: `"${reference}" matches more than one company. Ask the analyst which one they mean unless the question already makes it clear.`,
      };
    case "not_found":
      return {
        matches: [],
        ambiguous: false,
        note: `No covered company matches "${reference}". Covered companies: ${coverageList()}.`,
      };
  }
}

async function getCompanyProfile(company: unknown, signal?: AbortSignal) {
  await sleep(450, signal);
  return requireCompany(company);
}

async function getFinancials(company: unknown, signal?: AbortSignal) {
  await sleep(800, signal);
  const match = requireCompany(company);
  const record = financials.find((f) => f.company === match.name);
  if (!record) {
    throw new ToolError(`No financial record is held for ${describeCompany(match)}.`);
  }
  return toModelFinancials(record);
}

async function searchDocuments(query: unknown, company: unknown, signal?: AbortSignal) {
  await sleep(700, signal);

  const text = requireText(query, "query");
  const terms = text.split(/\s+/).filter(Boolean);
  if (terms.length > MAX_SEARCH_TERMS) {
    throw new ToolError(
      `Document search accepts at most ${MAX_SEARCH_TERMS} keywords per query; this query had ${terms.length}. Retry with the ${MAX_SEARCH_TERMS} or fewer most specific keywords, and pass the company in the company field instead of the query.`,
    );
  }

  const unscoped = company === undefined || company === null || company === "";
  const scope = unscoped ? null : requireCompany(company);
  const pool = scope ? documents.filter((d) => d.company === scope.name) : documents;

  const scored = pool.map((doc) => {
    const haystack = `${doc.title} ${doc.body}`.toLowerCase();
    const score = terms.filter((term) => haystack.includes(term.toLowerCase())).length;
    return { doc, score };
  });

  const matches = scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((s) => s.doc);

  if (matches.length === 0) {
    const where = scope ? ` in ${describeCompany(scope)} documents` : "";
    return {
      documents: [],
      note: `No documents matched "${text}"${where}. The search ran successfully; try different keywords, or treat the topic as not covered by the documents we hold.`,
    };
  }
  return { documents: matches };
}

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  switch (name) {
    case "searchCompanies":
      return searchCompanies(input.query, signal);
    case "getCompanyProfile":
      return getCompanyProfile(input.company, signal);
    case "getFinancials":
      return getFinancials(input.company, signal);
    case "searchDocuments":
      return searchDocuments(input.query, input.company, signal);
    default:
      throw new ToolError(`Unknown tool "${name}".`);
  }
}
