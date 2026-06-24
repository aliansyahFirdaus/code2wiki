import { describe, expect, it } from "vitest";

import { validateQuality } from "./quality-validator";
import type { ProductWikiBlock } from "@code2wiki/document";

describe("quality validator", () => {
  it("passes valid evidence-backed output", () => {
    const report = validateQuality(input());

    expect(report.gateResult).toBe("PASS");
  });

  it("fails for missing evidence, wrong-generation evidence, invented page key, leaks, empty page, and unsupported related page", () => {
    const report = validateQuality(
      input({
        allowedPageKeys: ["crew.add"],
        evidence: [
          { id: "ev-1", generationRunId: "run-2", repositoryRole: "FRONTEND" },
          { id: "ev-2", generationRunId: "run-1", repositoryRole: "BACKEND" }
        ],
        output: {
          pages: [
            {
              pageKey: "invented",
              title: "Invented",
              blocks: [
                block({ stableKey: "missing", evidenceIds: [] }),
                block({ stableKey: "wrong-run", evidenceIds: ["ev-1"] }),
                block({ stableKey: "leak", text: "Authorization: Bearer live-token sk-or-v1-secretsecret OPENROUTER_API_KEY=secret /Users/me/app x-openrouter" }),
                block({ stableKey: "technical", text: "The API endpoint calls a backend handler.", evidenceIds: ["ev-2"] }),
                relatedPage("unknown-page")
              ]
            },
            { pageKey: "crew.add", title: "Empty", blocks: [] }
          ]
        }
      })
    );

    expect(report.gateResult).toBe("FAIL");
    expect(codes(report)).toEqual(expect.arrayContaining([
      "CODE_STATEMENT_WITHOUT_VALID_EVIDENCE",
      "EVIDENCE_NOT_SAME_GENERATION",
      "INVENTED_PAGE_KEY",
      "AUTHORIZATION_BEARER_LEAK",
      "SECRET_TOKEN_LEAK",
      "RAW_ENV_ASSIGNMENT_LEAK",
      "LOCAL_PATH_LEAK",
      "PROVIDER_METADATA_LEAK",
      "TECHNICAL_PROSE_LEAK",
      "EMPTY_PAGE",
      "UNSUPPORTED_RELATED_PAGE"
    ]));
  });

  it("warn checks do not fail gate", () => {
    const report = validateQuality(
      input({
        evidence: [
          { id: "ev-1", generationRunId: "run-1", repositoryRole: "FRONTEND" },
          { id: "ev-2", generationRunId: "run-1", repositoryRole: "BACKEND" },
          { id: "ev-3", generationRunId: "run-1", repositoryRole: "BACKEND" },
          { id: "ev-4", generationRunId: "run-1", repositoryRole: "BACKEND" },
          { id: "ev-5", generationRunId: "run-1", repositoryRole: "BACKEND" }
        ],
        output: {
          pages: [
            {
              pageKey: "crew.add",
              title: "Add Crew",
              blocks: [
                heading("Ringkasan"),
                block({ stableKey: "a", text: "Some various stuff can happen etc.", evidenceIds: ["ev-1"] }),
                heading("Konsep Penting"),
                block({ stableKey: "b", text: "Some various stuff can happen etc.", evidenceIds: ["ev-1"] }),
                heading("Alur Kerja Utama"),
                block({ stableKey: "technical", text: "The API endpoint calls a backend handler.", evidenceIds: ["ev-2"] }),
                paragraph("Crew can save after validation."),
                { ...block({ stableKey: "long", evidenceIds: ["ev-1"] }), text: "x".repeat(501), type: "statement" as const, confidence: 0.8, lastGeneratedRunId: "run-1" },
                openQuestion(),
                openQuestion()
              ]
            }
          ]
        }
      })
    );

    expect(report.gateResult).toBe("WARN");
    expect(report.issues.every((issue) => issue.severity === "WARN")).toBe(true);
  });

  it("allows technical terms that are present in cited user-facing evidence", () => {
    const report = validateQuality(
      input({
        evidence: [{ id: "ev-1", generationRunId: "run-1", repositoryRole: "FRONTEND", userFacingText: "API Key" }],
        output: {
          pages: [
            {
              pageKey: "crew.add",
              title: "Add Crew",
              blocks: [
                block({ stableKey: "api-key", text: "API Key can be copied after creation.", evidenceIds: ["ev-1"] }),
                block({ stableKey: "share", text: "The key can be shared with approved teammates.", evidenceIds: ["ev-1"] })
              ]
            }
          ]
        }
      })
    );

    expect(report.gateResult).toBe("PASS");
  });

  it("passes a full internal-module section page", () => {
    const report = validateQuality(
      input({
        evidence: [
          { id: "ev-1", generationRunId: "run-1", repositoryRole: "FRONTEND" },
          { id: "ev-2", generationRunId: "run-1", repositoryRole: "BACKEND" },
          { id: "ev-3", generationRunId: "run-1", repositoryRole: "BACKEND" }
        ],
        output: {
          pages: [
            {
              pageKey: "crew.add",
              title: "Add Crew",
              blocks: [
                heading("Ringkasan"),
                block({ stableKey: "fe", text: "Crew can be added from the form.", evidenceIds: ["ev-1"] }),
                heading("Siapa Yang Menggunakan Modul Ini"),
                block({ stableKey: "be", text: "Crew creation is saved after submission.", evidenceIds: ["ev-2"] }),
                heading("Alur Kerja Utama"),
                block({ stableKey: "rule", text: "Crew records become available after the saved submission.", evidenceIds: ["ev-3"] })
              ]
            }
          ]
        }
      })
    );

    expect(report.gateResult).toBe("PASS");
    expect(metric(report, "internalModuleSectionCount")).toBe(3);
  });

  it("fails a thin page when substantial evidence exists", () => {
    const report = validateQuality(
      input({
        evidence: [
          { id: "ev-1", generationRunId: "run-1", repositoryRole: "FRONTEND" },
          { id: "ev-2", generationRunId: "run-1", repositoryRole: "BACKEND" },
          { id: "ev-3", generationRunId: "run-1", repositoryRole: "BACKEND" }
        ],
        output: {
          pages: [
            {
              pageKey: "crew.add",
              title: "Add Crew",
              blocks: [block({ stableKey: "only", text: "Crew can be added from the form.", evidenceIds: ["ev-1"] })]
            }
          ]
        }
      })
    );

    expect(report.gateResult).toBe("FAIL");
    expect(codes(report)).toEqual(expect.arrayContaining(["INTERNAL_MODULE_THIN_PAGE", "MISSING_INTERNAL_MODULE_STRUCTURE"]));
  });

  it("does not fail weak evidence just because it uses open questions", () => {
    const report = validateQuality(
      input({
        evidence: [{ id: "ev-1", generationRunId: "run-1", repositoryRole: "FRONTEND" }],
        output: {
          pages: [
            {
              pageKey: "crew.add",
              title: "Add Crew",
              blocks: [openQuestion()]
            }
          ]
        }
      })
    );

    expect(report.gateResult).toBe("WARN");
    expect(codes(report)).not.toContain("INTERNAL_MODULE_THIN_PAGE");
  });
});

function input(overrides: Partial<Parameters<typeof validateQuality>[0]> = {}): Parameters<typeof validateQuality>[0] {
  return {
    generationRunId: "run-1",
    allowedPageKeys: ["crew.add"],
    evidence: [
      { id: "ev-1", generationRunId: "run-1", repositoryRole: "FRONTEND" },
      { id: "ev-2", generationRunId: "run-1", repositoryRole: "BACKEND" }
    ],
    output: {
      pages: [
        {
          pageKey: "crew.add",
          title: "Add Crew",
          blocks: [
            block({ stableKey: "fe", text: "Crew can be added from the form.", evidenceIds: ["ev-1"] }),
            block({ stableKey: "be", text: "Crew creation is saved after submission.", evidenceIds: ["ev-2"] })
          ]
        }
      ]
    },
    ...overrides
  };
}

function block(overrides: Partial<ProductWikiBlock & { type: "statement" }> = {}) {
  return {
    id: `blk-${overrides.stableKey ?? "statement"}`,
    stableKey: overrides.stableKey ?? "statement",
    type: "statement" as const,
    origin: "CODE" as const,
    reviewState: "VERIFIED" as const,
    sourceHash: "source",
    contentHash: "content",
    locked: true,
    text: "Crew can be added.",
    confidence: 0.8,
    evidenceIds: ["ev-1"],
    lastGeneratedRunId: "run-1",
    ...overrides
  };
}

function paragraph(text: string) {
  return { ...block({ stableKey: "paragraph", evidenceIds: [] }), type: "paragraph" as const, text };
}

function heading(text: string) {
  return { ...block({ stableKey: text, evidenceIds: [] }), type: "heading" as const, text, level: 2 as const };
}

function relatedPage(pageId: string) {
  return { ...block({ stableKey: "related", evidenceIds: [] }), type: "related_page" as const, pageId, title: "Unknown" };
}

function openQuestion() {
  return { ...block({ stableKey: `question-${Math.random()}`, evidenceIds: [] }), type: "open_question" as const, question: "What happens?", reason: "Needs review." };
}

function codes(report: ReturnType<typeof validateQuality>) {
  return report.issues.map((issue) => issue.code);
}

function metric(report: ReturnType<typeof validateQuality>, name: string) {
  return report.metrics.find((item) => item.name === name)?.value;
}
