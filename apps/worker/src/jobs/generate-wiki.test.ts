import { beforeEach, describe, expect, it, vi } from "vitest";

import { generateWiki } from "./generate-wiki";

const mocks = vi.hoisted(() => ({
  ProductWikiValidationError: class ProductWikiValidationError extends Error {
    readonly validationErrors: string[];

    constructor(validationErrors: string[]) {
      super(validationErrors.join("; "));
      this.name = "ProductWikiValidationError";
      this.validationErrors = validationErrors;
    }
  },
  buildRetrievalContexts: vi.fn(),
  generateProductWiki: vi.fn(),
  getDb: vi.fn(),
  codeFacts: { generationRunId: "code_facts.generation_run_id" },
  codeMaps: { generationRunId: "code_maps.generation_run_id" },
  codeSummaries: { generationRunId: "code_summaries.generation_run_id" },
  evidence: { generationRunId: "evidence.generation_run_id" },
  generationRuns: {
    id: "generation_runs.id",
    status: "generation_runs.status",
    createdAt: "generation_runs.created_at"
  },
  wikiBlocks: { pageId: "wiki_blocks.page_id" },
  wikiPages: {
    id: "wiki_pages.id",
    generationRunId: "wiki_pages.generation_run_id",
    workspaceId: "wiki_pages.workspace_id",
    pageKey: "wiki_pages.page_key"
  }
}));

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: unknown[]) => args),
  asc: vi.fn((value: unknown) => value),
  eq: vi.fn((left: unknown, right: unknown) => ({ left, right })),
  inArray: vi.fn((left: unknown, values: unknown[]) => ({ left, values })),
  or: vi.fn((...args: unknown[]) => args)
}));

vi.mock("@code2wiki/analyzer", () => ({
  buildRetrievalContexts: mocks.buildRetrievalContexts
}));

vi.mock("@code2wiki/db", () => ({
  codeFacts: mocks.codeFacts,
  codeMaps: mocks.codeMaps,
  codeSummaries: mocks.codeSummaries,
  evidence: mocks.evidence,
  generationRuns: mocks.generationRuns,
  getDb: mocks.getDb,
  wikiBlocks: mocks.wikiBlocks,
  wikiPages: mocks.wikiPages
}));

vi.mock("@code2wiki/ai", () => ({
  buildAiUsageCall: vi.fn((kind: string, usage: unknown) => ({
    kind,
    usage,
    promptTokensUsed: 10,
    completionTokensUsed: 5,
    totalTokensUsed: 15,
    estimatedCostUsdMicros: null,
    pricingSource: null
  })),
  buildAiUsageReport: vi.fn((calls: unknown[]) => ({
    calls,
    summary: {
      callCount: calls.length,
      promptTokens: calls.length * 10,
      completionTokens: calls.length * 5,
      totalTokens: calls.length * 15,
      estimatedCostUsdMicros: null,
      pricingSource: null
    }
  })),
  OpenRouterProvider: vi.fn(() => ({ generateProductWiki: mocks.generateProductWiki })),
  ProductWikiValidationError: mocks.ProductWikiValidationError,
  StructuredOutputUnsupportedError: class StructuredOutputUnsupportedError extends Error {},
  validateQuality: vi.fn((input: { output: { pages?: Array<{ blocks: Array<{ text?: string }> }> } | null }) => {
    const text = input.output?.pages?.flatMap((page) => page.blocks).map((block) => block.text ?? "").join("\n") ?? "";
    const gateResult = text.includes("quality fail") ? "FAIL" : text.includes("needs warning") ? "WARN" : "PASS";
    return { gateResult, issues: gateResult === "PASS" ? [] : [{ code: gateResult, severity: gateResult === "FAIL" ? "ERROR" : "WARN", message: gateResult }], metrics: [] };
  }),
  validateProductWikiOutput: vi.fn((input: { generationRunId: string; allowedPageKeys: string[]; validEvidenceIds: string[]; output: unknown }) => {
    const output = input.output as { pages?: Array<{ pageKey: string; title: string; blocks: Array<{ type: string; text?: string; evidenceIds?: string[]; confidence?: number }> }> };
    if (!output?.pages?.length) {
      throw new mocks.ProductWikiValidationError(["AI output did not include any valid pages."]);
    }
    for (const page of output.pages) {
      if (!input.allowedPageKeys.includes(page.pageKey)) {
        throw new mocks.ProductWikiValidationError([`Page key is not allowed: ${page.pageKey}`]);
      }
      for (const block of page.blocks) {
        if (block.type === "statement" && !block.evidenceIds?.some((id) => input.validEvidenceIds.includes(id))) {
          throw new mocks.ProductWikiValidationError(["CODE statement is missing valid evidence: page.statement"]);
        }
      }
    }
    const generatedStatementCount = output.pages.flatMap((page) => page.blocks).filter((block) => block.type === "statement").length;
    return {
      pages: output.pages.map((page) => ({
        ...page,
        blocks: page.blocks.map((block, index) => ({
          id: `blk-${index}`,
          stableKey: `${page.pageKey}.${index}`,
          origin: "CODE",
          reviewState: "VERIFIED",
          sourceHash: "source",
          contentHash: "content",
          locked: true,
          confidence: block.type === "statement" ? (block.confidence ?? 0.8) : undefined,
          lastGeneratedRunId: block.type === "statement" ? input.generationRunId : undefined,
          ...block
        }))
      })),
      generatedStatementCount,
      generatedStatementWithEvidenceCount: generatedStatementCount
    };
  })
}));

describe("generateWiki trust fallback handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.buildRetrievalContexts.mockReturnValue({ usedFallback: true, retrievalWarnings: [], contexts: [] });
  });

  it("sets AI_OUTPUT_INVALID and inserts no wiki pages or blocks when repair output remains invalid", async () => {
    const db = makeDb();
    mocks.getDb.mockReturnValue(db.instance);
    mocks.generateProductWiki.mockResolvedValueOnce(providerResult(invalidOutput())).mockResolvedValueOnce(providerResult(invalidOutput()));

    await expect(generateWiki("run-1")).resolves.toMatchObject({ status: "invalid", generationRunId: "run-1" });

    expect(statusUpdates(db, "AI_OUTPUT_INVALID")).toHaveLength(1);
    expect(db.inserts).not.toEqual(expect.arrayContaining([expect.objectContaining({ table: mocks.wikiPages })]));
    expect(db.inserts).not.toEqual(expect.arrayContaining([expect.objectContaining({ table: mocks.wikiBlocks })]));
    expect(db.deletes).toHaveLength(0);
    expect(db.overlayMutations).toHaveLength(0);
  });

  it("sets FAILED and inserts no wiki pages or blocks when provider throws", async () => {
    const db = makeDb();
    mocks.getDb.mockReturnValue(db.instance);
    mocks.generateProductWiki.mockRejectedValueOnce(new Error("OpenRouter failed Authorization: Bearer live-token sk-or-v1-secretsecret OPENROUTER_API_KEY=secret x-provider: raw"));

    const result = await generateWiki("run-1");

    expect(result).toMatchObject({ status: "failed", generationRunId: "run-1" });
    expect(statusUpdates(db, "FAILED")).toHaveLength(1);
    expect(db.inserts).not.toEqual(expect.arrayContaining([expect.objectContaining({ table: mocks.wikiPages })]));
    expect(db.inserts).not.toEqual(expect.arrayContaining([expect.objectContaining({ table: mocks.wikiBlocks })]));
    expect(db.deletes).toHaveLength(0);
    expect(db.overlayMutations).toHaveLength(0);
  });

  it("sanitizes failed provider error messages", async () => {
    const db = makeDb();
    mocks.getDb.mockReturnValue(db.instance);
    mocks.generateProductWiki.mockRejectedValueOnce(new Error("Authorization: Bearer live-token sk-or-v1-secretsecret OPENROUTER_API_KEY=secret"));

    const result = await generateWiki("run-1");
    const update = statusUpdates(db, "FAILED")[0];

    expect(result).toMatchObject({ status: "failed" });
    expect(update.errorMessage).not.toContain("live-token");
    expect(update.errorMessage).not.toContain("sk-or-v1-secretsecret");
    expect(update.errorMessage).not.toContain("OPENROUTER_API_KEY=secret");
    expect(update.errorMessage).toContain("Bearer [redacted]");
  });

  it("preserves existing wiki pages and blocks from previous completed runs on failure", async () => {
    const db = makeDb({
      existingPages: [{ id: "page_previous", generationRunId: "run-old", workspaceId: "workspace-1", pageKey: "crew.add" }]
    });
    mocks.getDb.mockReturnValue(db.instance);
    mocks.generateProductWiki.mockRejectedValueOnce(new Error("provider down"));

    await generateWiki("run-1");

    expect(db.deletes).toHaveLength(0);
    expect(db.inserts).not.toEqual(expect.arrayContaining([expect.objectContaining({ table: mocks.wikiPages })]));
    expect(db.inserts).not.toEqual(expect.arrayContaining([expect.objectContaining({ table: mocks.wikiBlocks })]));
  });

  it("still completes and persists wiki pages and blocks for valid output", async () => {
    const db = makeDb();
    mocks.getDb.mockReturnValue(db.instance);
    mocks.generateProductWiki.mockResolvedValueOnce(providerResult(validOutput()));

    await expect(generateWiki("run-1")).resolves.toMatchObject({
      status: "completed",
      generationRunId: "run-1",
      generatedStatementCount: 1,
      generatedStatementWithEvidenceCount: 1
    });

    expect(statusUpdates(db, "COMPLETED")).toHaveLength(1);
    expect(db.inserts).toEqual(expect.arrayContaining([expect.objectContaining({ table: mocks.wikiPages })]));
    expect(db.inserts).toEqual(expect.arrayContaining([expect.objectContaining({ table: mocks.wikiBlocks })]));
  });

  it("aggregates generation and repair usage", async () => {
    const db = makeDb();
    mocks.getDb.mockReturnValue(db.instance);
    mocks.generateProductWiki.mockResolvedValueOnce(providerResult(invalidOutput())).mockResolvedValueOnce(providerResult(validOutput()));

    await generateWiki("run-1");

    const update = statusUpdates(db, "COMPLETED")[0];
    expect(update.aiUsageJson?.summary.callCount).toBe(2);
  });

  it("sets AI_OUTPUT_INVALID and inserts no wiki output on quality FAIL", async () => {
    const db = makeDb();
    mocks.getDb.mockReturnValue(db.instance);
    mocks.generateProductWiki.mockResolvedValueOnce(providerResult(validOutput("quality fail")));

    const result = await generateWiki("run-1");

    expect(result).toMatchObject({ status: "invalid", errorMessage: "QUALITY_GATE_FAILED" });
    expect(statusUpdates(db, "AI_OUTPUT_INVALID")[0].qualityReportJson.gateResult).toBe("FAIL");
    expect(db.inserts).not.toEqual(expect.arrayContaining([expect.objectContaining({ table: mocks.wikiPages })]));
    expect(db.inserts).not.toEqual(expect.arrayContaining([expect.objectContaining({ table: mocks.wikiBlocks })]));
  });

  it("completes on quality WARN", async () => {
    const db = makeDb();
    mocks.getDb.mockReturnValue(db.instance);
    mocks.generateProductWiki.mockResolvedValueOnce(providerResult(validOutput("needs warning")));

    await expect(generateWiki("run-1")).resolves.toMatchObject({ status: "completed" });

    expect(statusUpdates(db, "COMPLETED")[0].qualityReportJson.gateResult).toBe("WARN");
  });
});

function makeDb(options: { existingPages?: unknown[] } = {}) {
  const run = {
    id: "run-1",
    workspaceId: "workspace-1",
    frontendRepositoryId: "repo-fe",
    backendRepositoryId: "repo-be",
    frontendTag: "fe-v1",
    frontendCommitSha: "fe-sha",
    backendTag: "be-v1",
    backendCommitSha: "be-sha"
  };
  const facts = [
    {
      id: "fact-1",
      generationRunId: "run-1",
      repositoryRole: "FRONTEND",
      repositoryFullName: "acme/web",
      tag: "v1",
      commitSha: "fe-sha",
      factKind: "ROUTE",
      text: "Crew can be added.",
      evidenceIds: ["ev-1"],
      confidence: 0.95
    }
  ];
  const evidence = [
    {
      id: "ev-1",
      generationRunId: "run-1",
      repositoryRole: "FRONTEND",
      repositoryFullName: "acme/web",
      tag: "v1",
      commitSha: "fe-sha",
      filePath: "app/crew/add/page.tsx",
      startLine: 1,
      endLine: 2,
      sourceKind: "ROUTE",
      summary: "Crew can be added.",
      codeSnippet: "export default function Page() {}",
      githubUrl: "https://github.com/acme/web/blob/fe-sha/app/crew/add/page.tsx#L1-L2"
    }
  ];
  const inserts: Array<{ table: unknown; value: unknown }> = [];
  const deletes: Array<{ table: unknown }> = [];
  const updates: unknown[] = [];
  const overlayMutations: unknown[] = [];

  const selectRows = (table: unknown) => {
    if (table === mocks.codeFacts) return facts;
    if (table === mocks.evidence) return evidence;
    if (table === mocks.codeMaps) return [];
    if (table === mocks.codeSummaries) return [];
    if (table === mocks.wikiPages) return options.existingPages ?? [];
    return [];
  };

  const makeUpdate = () => ({
    set: vi.fn((value: unknown) => {
      updates.push(value);
      return {
        where: vi.fn(() => ({
          returning: vi.fn().mockResolvedValue([run])
        }))
      };
    })
  });

  const tx = {
    select: vi.fn((selection?: unknown) => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn().mockResolvedValue(selection ? (options.existingPages ?? []) : selectRows(table))
      }))
    })),
    delete: vi.fn((table: unknown) => {
      deletes.push({ table });
      return { where: vi.fn().mockResolvedValue(undefined) };
    }),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((value: unknown) => {
        inserts.push({ table, value });
        return Promise.resolve();
      })
    })),
    update: vi.fn(makeUpdate)
  };

  const instance = {
    update: vi.fn(makeUpdate),
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn().mockResolvedValue(selectRows(table)),
        orderBy: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([run]) }))
      }))
    })),
    transaction: vi.fn((callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx))
  };

  return { instance, inserts, deletes, updates, overlayMutations };
}

function validOutput(text = "Crew can be added.") {
  return {
    pages: [
      {
        pageKey: "crew.add",
        title: "Crew Add",
        blocks: [{ type: "statement", text, evidenceIds: ["ev-1"], confidence: 0.95 }]
      }
    ]
  };
}

function invalidOutput() {
  return {
    pages: [
      {
        pageKey: "crew.add",
        title: "Crew Add",
        blocks: [{ type: "statement", text: "Crew can be added.", evidenceIds: ["missing"], confidence: 0.95 }]
      }
    ]
  };
}

function providerResult(output: unknown) {
  return {
    output,
    usage: {
      provider: "openrouter",
      model: "test-model",
      promptTokenEstimate: 10,
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      inputCharCount: 40,
      outputCharCount: 20
    }
  };
}

function statusUpdates(db: ReturnType<typeof makeDb>, status: string) {
  return db.updates.filter((update): update is { status: string; errorMessage?: string; qualityReportJson?: any; aiUsageJson?: any } => {
    return Boolean(update && typeof update === "object" && "status" in update && update.status === status);
  });
}
