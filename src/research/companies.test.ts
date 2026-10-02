import { describe, expect, it } from "vitest";
import { resolveCompany, type CompanyResolution } from "./companies.ts";

function resolvedName(resolution: CompanyResolution): string | undefined {
  return resolution.kind === "found" ? resolution.company.name : undefined;
}

describe("resolveCompany", () => {
  it.each([
    ["exact name", "Acme Corp", "Acme Corp"],
    ["lowercase name", "acme corp", "Acme Corp"],
    ["surrounding whitespace and punctuation", "  Globex Inc.  ", "Globex Inc"],
    ["repeated internal whitespace", "Acme \t  Robotics", "Acme Robotics"],
    ["ticker with surrounding whitespace", " UMBR ", "Umbrella Health"],
    ["suffix spelled out", "Acme Corporation", "Acme Corp"],
    ["possessive", "Initech's", "Initech"],
    ["ticker", "GLBX", "Globex Inc"],
    ["lowercase ticker", "glbx", "Globex Inc"],
    ["capitalised ticker that is also a name word", "ACME", "Acme Corp"],
    ["unique substring", "globex", "Globex Inc"],
    ["unique substring of a longer name", "Umbrella", "Umbrella Health"],
    ["different legal suffix", "Globex Industries", "Globex Inc"],
  ])("resolves %s", (_label, input, expected) => {
    expect(resolvedName(resolveCompany(input))).toBe(expected);
  });

  it("resolves Acme Corp and Acme Robotics separately when each is named", () => {
    expect(resolvedName(resolveCompany("Acme Corp"))).toBe("Acme Corp");
    expect(resolvedName(resolveCompany("Acme Robotics"))).toBe("Acme Robotics");
    expect(resolvedName(resolveCompany("ACMR"))).toBe("Acme Robotics");
  });

  it.each(["Acme", "acme", "Acme Inc"])("treats %s as ambiguous", (input) => {
    const resolution = resolveCompany(input);
    expect(resolution.kind).toBe("ambiguous");
    if (resolution.kind === "ambiguous") {
      expect(resolution.candidates.map((c) => c.name).sort()).toEqual([
        "Acme Corp",
        "Acme Robotics",
      ]);
    }
  });

  it.each(["Tesla", "Globotron", "Inc", "", "   "])("finds no match for %j", (input) => {
    expect(resolveCompany(input).kind).toBe("not_found");
  });
});
