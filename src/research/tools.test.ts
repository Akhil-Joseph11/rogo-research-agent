import { describe, expect, it } from "vitest";
import type { ResearchDocument } from "./data.ts";
import { executeTool, ToolError, type ModelFinancials } from "./tools.ts";

describe("cancellation", () => {
  it("rejects a tool call without waiting when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      executeTool("getFinancials", { company: "GLBX" }, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("interrupts the simulated latency when aborted mid-call", async () => {
    const controller = new AbortController();
    const call = executeTool("getFinancials", { company: "GLBX" }, controller.signal);
    controller.abort();
    await expect(call).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("getFinancials", () => {
  it("resolves a lowercase ticker to the company's record", async () => {
    const record = (await executeTool("getFinancials", { company: "glbx" })) as ModelFinancials;
    expect(record.company).toBe("Globex Inc");
  });

  it("keeps unfiled periods as null and returns the record's warnings", async () => {
    const record = (await executeTool("getFinancials", { company: "ITCH" })) as ModelFinancials;
    const fy2025 = record.annual.find((year) => year.fiscalYear === 2025);
    expect(fy2025?.revenue).toBeNull();
    expect(record.warnings?.length).toBeGreaterThan(0);
  });

  it("leaves ingest bookkeeping out of the model-facing record but keeps provenance that qualifies the figures", async () => {
    const record = (await executeTool("getFinancials", { company: "UMBR" })) as ModelFinancials;
    expect(record.provenance).toEqual({
      source: "internal-fundamentals-warehouse",
      ingestedAt: "2026-03-14T08:12:44Z",
      restatements: [expect.objectContaining({ period: "FY2022" })],
    });
    expect(JSON.stringify(record)).not.toMatch(/checksum|pipelineVersion/);
  });

  it("fails on an ambiguous company and names the candidates", async () => {
    const call = executeTool("getFinancials", { company: "Acme" });
    await expect(call).rejects.toBeInstanceOf(ToolError);
    await expect(call).rejects.toThrow(/Acme Corp \(ACME\) and Acme Robotics \(ACMR\)/);
  });

  it("fails on a company outside the coverage universe", async () => {
    await expect(executeTool("getFinancials", { company: "Tesla" })).rejects.toThrow(
      /not in our coverage universe/,
    );
  });
});

describe("getCompanyProfile", () => {
  it("resolves an explicitly named company", async () => {
    const profile = (await executeTool("getCompanyProfile", { company: "acme robotics" })) as {
      ticker: string;
    };
    expect(profile.ticker).toBe("ACMR");
  });
});

describe("searchCompanies", () => {
  it("finds a single company by ticker", async () => {
    expect(await executeTool("searchCompanies", { query: "itch" })).toEqual({
      matches: [{ name: "Initech", ticker: "ITCH", sector: "Enterprise Software" }],
      ambiguous: false,
    });
  });

  it("returns every candidate for an ambiguous name instead of choosing one", async () => {
    const result = (await executeTool("searchCompanies", { query: "Acme" })) as {
      matches: { ticker: string }[];
      ambiguous: boolean;
    };
    expect(result.ambiguous).toBe(true);
    expect(result.matches.map((m) => m.ticker).sort()).toEqual(["ACME", "ACMR"]);
  });

  it("returns an empty, non-error result for an unknown company", async () => {
    const result = (await executeTool("searchCompanies", { query: "Tesla" })) as {
      matches: unknown[];
    };
    expect(result.matches).toEqual([]);
  });
});

describe("searchDocuments", () => {
  it("searches across all companies and ranks documents by matched keywords", async () => {
    const result = (await executeTool("searchDocuments", {
      query: "organic acquisitions",
    })) as { documents: ResearchDocument[] };
    const ids = result.documents.map((d) => d.id);
    // Both Globex and Umbrella documents discuss organic vs acquired growth.
    expect(ids).toEqual(expect.arrayContaining(["DOC-GLBX-001", "DOC-UMBR-002"]));
    expect(new Set(result.documents.map((d) => d.company)).size).toBeGreaterThan(1);
    expect(ids.indexOf("DOC-UMBR-002")).toBeLessThan(ids.indexOf("DOC-UMBR-001"));
  });

  it("resolves the company filter by ticker", async () => {
    const result = (await executeTool("searchDocuments", {
      query: "acquisitions",
      company: "UMBR",
    })) as { documents: ResearchDocument[] };
    expect(result.documents.length).toBeGreaterThan(0);
    expect(result.documents.every((d) => d.company === "Umbrella Health")).toBe(true);
  });

  it("fails on an ambiguous company filter", async () => {
    await expect(
      executeTool("searchDocuments", { query: "risk", company: "acme" }),
    ).rejects.toBeInstanceOf(ToolError);
  });

  it("reports no matches as an empty successful result", async () => {
    const result = (await executeTool("searchDocuments", { query: "zeppelin" })) as {
      documents: ResearchDocument[];
      note?: string;
    };
    expect(result.documents).toEqual([]);
    expect(result.note).toMatch(/No documents matched/);
  });

  it("rejects more than six keywords with a message explaining how to retry", async () => {
    await expect(
      executeTool("searchDocuments", { query: "one two three four five six seven" }),
    ).rejects.toThrow(/at most 6 keywords per query; this query had 7/);
  });

  it("fails on a company filter outside the coverage universe", async () => {
    await expect(executeTool("searchDocuments", { query: "risk", company: "Tesla" })).rejects.toThrow(
      /not in our coverage universe/,
    );
  });
});

describe("malformed input", () => {
  it.each([
    ["getFinancials", {}, /"company" must be a non-empty string/],
    ["getCompanyProfile", { company: 42 }, /"company" must be a non-empty string/],
    ["searchCompanies", { query: "   " }, /"query" must be a non-empty string/],
    ["searchDocuments", { query: ["risk"] }, /"query" must be a non-empty string/],
    ["searchDocuments", { query: "risk", company: { name: "Globex" } }, /"company" must be a non-empty string/],
    ["deleteCompany", { company: "GLBX" }, /Unknown tool "deleteCompany"/],
  ])("rejects %s with %j as a tool error", async (name, input, message) => {
    const call = executeTool(name, input);
    await expect(call).rejects.toBeInstanceOf(ToolError);
    await expect(call).rejects.toThrow(message);
  });
});
