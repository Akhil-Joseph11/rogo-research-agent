/**
 * Company resolution shared by every tool. Turns whatever the model or analyst
 * wrote ("glbx", "Globex Industries", "Acme") into one covered company, a set of
 * candidates when the reference is ambiguous, or no match. It never picks
 * between candidates.
 */

import { companies, type Company } from "./data.ts";

export type CompanyResolution =
  | { kind: "found"; company: Company }
  | { kind: "ambiguous"; candidates: Company[] }
  | { kind: "not_found" };

/** Corporate suffixes that do not identify a company on their own. */
const LEGAL_SUFFIXES = new Set([
  "inc",
  "incorporated",
  "corp",
  "corporation",
  "co",
  "company",
  "ltd",
  "limited",
  "llc",
  "plc",
  "holdings",
  "group",
  "industries",
]);

const SUFFIX_SYNONYMS: Record<string, string> = {
  incorporated: "inc",
  corporation: "corp",
  limited: "ltd",
};

/** Lowercase, drop possessives and punctuation, collapse whitespace, unify suffix spellings. */
export function normalizeName(input: string): string {
  return input
    .toLowerCase()
    .replace(/['’]s\b/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => SUFFIX_SYNONYMS[word] ?? word)
    .join(" ");
}

/** The identifying part of a name: "globex inc" -> "globex", "acme robotics" stays. */
function coreName(normalized: string): string {
  const words = normalized.split(" ");
  while (words.length > 1 && LEGAL_SUFFIXES.has(words[words.length - 1])) {
    words.pop();
  }
  return words.join(" ");
}

function containsWords(haystack: string, needle: string): boolean {
  return ` ${haystack} `.includes(` ${needle} `);
}

/**
 * Resolution order:
 * 1. Exact name after normalization ("acme corp", "Globex Inc.").
 * 2. Exact ticker written in capitals ("ACME"), the usual ticker notation.
 * 3. Otherwise collect every company matched by a case-insensitive ticker, the
 *    same core name ("Globex Industries" -> Globex Inc), or a core name that
 *    appears as whole words in the company name ("umbrella"). One candidate
 *    resolves; several are ambiguous.
 *
 * Step 3 is why "acme", "Acme" and "Acme Inc" stay ambiguous even though they
 * point at Acme Corp by ticker or suffix: "acme" is also part of Acme Robotics.
 */
export function resolveCompany(
  input: string,
  universe: readonly Company[] = companies,
): CompanyResolution {
  const raw = input.trim();
  const normalized = normalizeName(raw);
  if (!normalized) return { kind: "not_found" };

  const exactName = universe.find((c) => normalizeName(c.name) === normalized);
  if (exactName) return { kind: "found", company: exactName };

  const exactTicker = universe.find((c) => c.ticker === raw);
  if (exactTicker) return { kind: "found", company: exactTicker };

  const core = coreName(normalized);
  if (LEGAL_SUFFIXES.has(core)) return { kind: "not_found" };

  const candidates = universe.filter((c) => {
    const name = normalizeName(c.name);
    return (
      c.ticker.toLowerCase() === normalized ||
      coreName(name) === core ||
      containsWords(name, core)
    );
  });

  if (candidates.length === 1) return { kind: "found", company: candidates[0] };
  if (candidates.length > 1) return { kind: "ambiguous", candidates };
  return { kind: "not_found" };
}

export function describeCompany(company: Company): string {
  return `${company.name} (${company.ticker})`;
}

export function coverageList(universe: readonly Company[] = companies): string {
  return universe.map(describeCompany).join(", ");
}
