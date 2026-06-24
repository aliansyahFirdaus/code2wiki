import { createHash } from "node:crypto";

import { codeFacts, codeMaps, evidence, generationRuns, generationTasks, getDb, wikiPageEvidence, wikiPages } from "@code2wiki/db";
import { eq } from "drizzle-orm";
import { emitDebugEvent } from "./debug-events";

type GenerationRun = typeof generationRuns.$inferSelect;
type GenerationTask = typeof generationTasks.$inferSelect;
type CodeFact = typeof codeFacts.$inferSelect;
type Evidence = typeof evidence.$inferSelect;
type WikiPageEvidence = typeof wikiPageEvidence.$inferSelect;
type WikiPage = typeof wikiPages.$inferSelect;
type CodeMapNode = {
  kind: string;
  repositoryRole: "FRONTEND" | "BACKEND";
  filePath: string;
  metadata?: Record<string, unknown>;
  evidenceIds?: string[];
};
type CoverageInput = {
  facts: CodeFact[];
  evidence: Evidence[];
  codeMapNodes: CodeMapNode[];
  pageEvidence: WikiPageEvidence[];
  pages: WikiPage[];
};
type CoverageItem = {
  evidenceId: string;
  factId: string | null;
  repositoryRole: "FRONTEND" | "BACKEND";
  filePath: string;
  sourceKind: string;
  summary: string;
};
type CoverageGap = {
  disposition: "CREATE_PAGE" | "UPDATE_PAGE" | "EXCLUDED_NO_WIKI_VALUE" | "NEEDS_REVIEW";
  pageKey: string;
  evidenceId: string;
  factId: string | null;
  reason: string;
};
export type CoverageReport = {
  acceptable: boolean;
  fingerprint: string;
  counts: {
    facts: number;
    evidence: number;
    positiveCoverage: number;
    terminalNegativeCoverage: number;
    uncovered: number;
    queuedTasks: number;
    reviewGaps: number;
  };
  gaps: CoverageGap[];
  queuedTaskDedupeKeys: string[];
  negativeCoverageCount: number;
};
export type CoverageEvaluationResult =
  | { ok: true; report: CoverageReport; queuedTaskDedupeKeys: string[]; reviewGaps: CoverageGap[] }
  | { ok: false; errorMessage: string };

const POSITIVE_ROLES = new Set(["PRIMARY", "SUPPORTING"]);
const NEGATIVE_ROLES = new Set(["EXCLUDED_NO_WIKI_VALUE", "NEEDS_REVIEW"]);

export async function currentCoverageFingerprint(run: GenerationRun) {
  return fingerprintForInput(await loadCoverageInput(run));
}

export async function evaluateCoverage(run: GenerationRun, task: GenerationTask): Promise<CoverageEvaluationResult> {
  try {
    await emitDebugEvent({
      generationRunId: run.id,
      stage: "coverage",
      eventType: "COVERAGE_STARTED",
      message: "Coverage evaluation started.",
      payload: { taskId: task.id }
    });
    const input = await loadCoverageInput(run);
    const evaluation = buildCoverageReport(input);
    const db = getDb();

    for (const gap of evaluation.gaps) {
      await emitDebugEvent({
        generationRunId: run.id,
        stage: "coverage",
        eventType: "COVERAGE_GAP_FOUND",
        severity: gap.disposition === "NEEDS_REVIEW" ? "WARN" : "INFO",
        message: "Coverage gap classified.",
        payload: {
          disposition: gap.disposition,
          pageKey: gap.pageKey,
          evidenceId: gap.evidenceId,
          factId: gap.factId,
          reason: gap.reason
        }
      });
    }

    for (const gap of evaluation.gaps.filter((item) => item.disposition === "EXCLUDED_NO_WIKI_VALUE" || item.disposition === "NEEDS_REVIEW")) {
      const coverageRole = gap.disposition as "EXCLUDED_NO_WIKI_VALUE" | "NEEDS_REVIEW";
      await db
        .insert(wikiPageEvidence)
        .values({
          id: wikiPageEvidenceId(run.id, gap.pageKey, gap.evidenceId, gap.factId, coverageRole),
          generationRunId: run.id,
          workspaceId: run.workspaceId,
          pageKey: gap.pageKey,
          evidenceId: gap.evidenceId,
          factId: gap.factId,
          sourceTaskId: task.id,
          coverageRole
        })
        .onConflictDoNothing({ target: wikiPageEvidence.id });
    }

    const queuedTaskDedupeKeys: string[] = [];
    for (const [dedupeKey, value] of pageTasksForGaps(run, evaluation.gaps)) {
      const inserted = await db
        .insert(generationTasks)
        .values(value)
        .onConflictDoNothing({ target: [generationTasks.generationRunId, generationTasks.dedupeKey] })
        .returning({ id: generationTasks.id });
      if (inserted.length > 0) {
        queuedTaskDedupeKeys.push(dedupeKey);
        await emitDebugEvent({
          generationRunId: run.id,
          stage: "task_queue",
          eventType: "TASK_QUEUED",
          message: "Generation task queued.",
          payload: { taskId: inserted[0].id, taskType: value.taskType, pageKey: value.pageKey, dedupeKey }
        });
      }
    }

    const report = { ...evaluation.report, counts: { ...evaluation.report.counts, queuedTasks: queuedTaskDedupeKeys.length }, queuedTaskDedupeKeys };
    await db.update(generationRuns).set({ coverageReportJson: report, errorMessage: null }).where(eq(generationRuns.id, run.id));
    await emitDebugEvent({
      generationRunId: run.id,
      stage: "coverage",
      eventType: report.acceptable ? "COVERAGE_ACCEPTED" : "COVERAGE_NEEDS_REVIEW",
      severity: report.acceptable ? "INFO" : "WARN",
      message: report.acceptable ? "Coverage accepted." : "Coverage needs more generation or review.",
      payload: { counts: report.counts, queuedTaskDedupeKeys }
    });
    return { ok: true, report, queuedTaskDedupeKeys, reviewGaps: evaluation.gaps.filter((gap) => gap.disposition === "NEEDS_REVIEW") };
  } catch (error) {
    return { ok: false, errorMessage: error instanceof Error ? error.message.slice(0, 300) : "COVERAGE_EVALUATOR_FAILED" };
  }
}

async function loadCoverageInput(run: GenerationRun): Promise<CoverageInput> {
  const db = getDb();
  const [facts, evidenceRows, codeMapRows, pageEvidence, pages] = await Promise.all([
    db.select().from(codeFacts).where(eq(codeFacts.generationRunId, run.id)),
    db.select().from(evidence).where(eq(evidence.generationRunId, run.id)),
    db.select().from(codeMaps).where(eq(codeMaps.generationRunId, run.id)),
    db.select().from(wikiPageEvidence).where(eq(wikiPageEvidence.generationRunId, run.id)),
    db.select().from(wikiPages).where(eq(wikiPages.workspaceId, run.workspaceId))
  ]);
  return {
    facts,
    evidence: evidenceRows,
    codeMapNodes: codeMapRows.flatMap((row) => readCodeMapNodes(row.mapJson)),
    pageEvidence,
    pages
  };
}

function buildCoverageReport(input: CoverageInput) {
  const items = coverageItems(input.facts, input.evidence);
  const positiveKeys = new Set(input.pageEvidence.filter((row) => POSITIVE_ROLES.has(row.coverageRole)).map(itemKey));
  const terminalRows = input.pageEvidence.filter((row) => NEGATIVE_ROLES.has(row.coverageRole) && !positiveKeys.has(itemKey(row)));
  const terminalNegativeKeys = new Set(terminalRows.map(itemKey));
  const uncovered = items.filter((item) => !positiveKeys.has(itemKey(item)) && !terminalNegativeKeys.has(itemKey(item)));
  const pageKeys = new Set(input.pages.map((page) => page.pageKey));
  const gaps = [
    ...terminalRows.filter((row) => row.coverageRole === "NEEDS_REVIEW").map((row) => ({
      disposition: "NEEDS_REVIEW" as const,
      pageKey: row.pageKey,
      evidenceId: row.evidenceId,
      factId: row.factId,
      reason: "NO_FRONTEND_ANCHOR"
    })),
    ...uncovered.map((item) => classifyGap(item, input.codeMapNodes, pageKeys))
  ];
  const queued = gaps.filter((gap) => gap.disposition === "CREATE_PAGE" || gap.disposition === "UPDATE_PAGE").length;
  const reviewGaps = gaps.filter((gap) => gap.disposition === "NEEDS_REVIEW").length;
  const report: CoverageReport = {
    acceptable: queued === 0 && reviewGaps === 0,
    fingerprint: fingerprintForInput(input),
    counts: {
      facts: input.facts.length,
      evidence: input.evidence.length,
      positiveCoverage: positiveKeys.size,
      terminalNegativeCoverage: terminalNegativeKeys.size,
      uncovered: uncovered.length,
      queuedTasks: queued,
      reviewGaps
    },
    gaps,
    queuedTaskDedupeKeys: [],
    negativeCoverageCount: terminalNegativeKeys.size + gaps.filter((gap) => gap.disposition === "EXCLUDED_NO_WIKI_VALUE" || gap.disposition === "NEEDS_REVIEW").length
  };
  return { report, gaps };
}

function coverageItems(facts: CodeFact[], evidenceRows: Evidence[]) {
  const evidenceById = new Map(evidenceRows.map((row) => [row.id, row]));
  const items = new Map<string, CoverageItem>();
  for (const fact of facts) {
    for (const evidenceId of fact.evidenceIds) {
      const row = evidenceById.get(evidenceId);
      if (row) {
        const item = { ...coverageItemFromEvidence(row), factId: fact.id };
        items.set(itemKey(item), item);
      }
    }
  }
  for (const row of evidenceRows) {
    const item = coverageItemFromEvidence(row);
    if (![...items.values()].some((value) => value.evidenceId === row.id)) {
      items.set(itemKey(item), item);
    }
  }
  return [...items.values()];
}

function coverageItemFromEvidence(row: Evidence): CoverageItem {
  return {
    evidenceId: row.id,
    factId: null,
    repositoryRole: row.repositoryRole,
    filePath: row.filePath,
    sourceKind: row.sourceKind,
    summary: row.summary
  };
}

function classifyGap(item: CoverageItem, nodes: CodeMapNode[], existingPageKeys: Set<string>): CoverageGap {
  const pageKey = frontendPageKey(item, nodes);
  if (isLowSignal(item)) {
    return { disposition: "EXCLUDED_NO_WIKI_VALUE", pageKey, evidenceId: item.evidenceId, factId: item.factId, reason: "LOW_SIGNAL_EVIDENCE" };
  }
  if (!pageKey || (item.repositoryRole !== "FRONTEND" && !existingPageKeys.has(pageKey))) {
    return { disposition: "NEEDS_REVIEW", pageKey: pageKey || "unanchored", evidenceId: item.evidenceId, factId: item.factId, reason: "NO_FRONTEND_ANCHOR" };
  }
  return {
    disposition: existingPageKeys.has(pageKey) ? "UPDATE_PAGE" : "CREATE_PAGE",
    pageKey,
    evidenceId: item.evidenceId,
    factId: item.factId,
    reason: "UNCOVERED_FRONTEND_ANCHOR"
  };
}

function pageTasksForGaps(run: GenerationRun, gaps: CoverageGap[]) {
  const byPage = new Map<string, CoverageGap[]>();
  for (const gap of gaps.filter((item) => item.disposition === "CREATE_PAGE" || item.disposition === "UPDATE_PAGE")) {
    byPage.set(gap.pageKey, [...(byPage.get(gap.pageKey) ?? []), gap]);
  }
  return [...byPage.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([pageKey, pageGaps]) => {
    const disposition = pageGaps.some((gap) => gap.disposition === "UPDATE_PAGE") ? "UPDATE_PAGE" : "CREATE_PAGE";
    const verb = disposition === "UPDATE_PAGE" ? "update" : "create";
    const evidenceIds = [...new Set(pageGaps.map((gap) => gap.evidenceId))].sort();
    const dedupeKey = `${verb}-page:${pageKey}`;
    return [
      dedupeKey,
      {
        id: crypto.randomUUID(),
        generationRunId: run.id,
        workspaceId: run.workspaceId,
        repositoryRole: "FRONTEND",
        repositoryId: run.frontendRepositoryId,
        taskType: disposition,
        status: "QUEUED",
        pageKey,
        dedupeKey,
        reason: "coverage evaluator uncovered frontend evidence",
        payloadJson: { pageKey, evidenceIds, coverageGaps: pageGaps },
        updatedAt: new Date()
      }
    ] as const;
  });
}

function fingerprintForInput(input: CoverageInput) {
  const positiveKeys = new Set(input.pageEvidence.filter((row) => POSITIVE_ROLES.has(row.coverageRole)).map(itemKey));
  const rows = input.pageEvidence
    .filter((row) => POSITIVE_ROLES.has(row.coverageRole))
    .map((row) => [row.evidenceId, row.factId ?? "", row.pageKey, row.coverageRole].join("|"))
    .sort();
  const items = coverageItems(input.facts, input.evidence);
  const uncovered = items
    .filter((item) => !positiveKeys.has(itemKey(item)))
    .map((item) => [item.evidenceId, item.factId ?? ""].join("|"))
    .sort();
  return hash(JSON.stringify({ rows, uncovered, pageKeys: input.pages.map((page) => page.pageKey).sort() }));
}

function itemKey(value: { evidenceId: string; factId: string | null }) {
  return `${value.evidenceId}|${value.factId ?? ""}`;
}

function wikiPageEvidenceId(generationRunId: string, pageKey: string, evidenceId: string, factId: string | null, coverageRole: string) {
  return `wpe_${hash([generationRunId, pageKey, evidenceId, factId ?? "", coverageRole].join("|"))}`;
}

function frontendPageKey(item: CoverageItem, nodes: CodeMapNode[]) {
  const node = nodes.find((candidate) => candidate.repositoryRole === "FRONTEND" && candidate.evidenceIds?.includes(item.evidenceId));
  if (node) {
    return pageKeyFromNode(node);
  }
  return item.repositoryRole === "FRONTEND" ? pageKeyFromPath(item.filePath) : "";
}

function isLowSignal(item: CoverageItem) {
  const haystack = `${item.filePath} ${item.sourceKind} ${item.summary}`.toLowerCase();
  return /(\.d\.ts|\.test\.|\.spec\.|__tests__|mock|fixture|generated|__generated__|\.css|\.scss|style|type|interface|config)/.test(haystack);
}

function readCodeMapNodes(value: unknown) {
  if (!value || typeof value !== "object" || !Array.isArray((value as { nodes?: unknown }).nodes)) {
    return [];
  }
  return (value as { nodes: unknown[] }).nodes.filter(isCodeMapNode);
}

function isCodeMapNode(value: unknown): value is CodeMapNode {
  return Boolean(value && typeof value === "object" && ((value as CodeMapNode).repositoryRole === "FRONTEND" || (value as CodeMapNode).repositoryRole === "BACKEND") && typeof (value as CodeMapNode).kind === "string" && typeof (value as CodeMapNode).filePath === "string");
}

function pageKeyFromNode(node: CodeMapNode) {
  if (node.kind === "NAVIGATION") {
    return pageKeyFromRouteLike(String(node.metadata?.target ?? ""));
  }
  return pageKeyFromRouteLike(String(node.metadata?.path ?? node.filePath));
}

function pageKeyFromRouteLike(value: string) {
  if (!value) {
    return "";
  }
  if (value.startsWith("/")) {
    return value.replace(/^\/+/, "").split("/").filter(Boolean).slice(0, 4).join(".").replace(/\s+/g, ".").replace(/^\.+|\.+$/g, "").toLowerCase() || "frontend";
  }
  return pageKeyFromPath(value);
}

function pageKeyFromPath(filePath: string) {
  const withoutExtension = filePath
    .replace(/^src\//, "")
    .replace(/^app\//, "")
    .replace(/^pages\//, "")
    .replace(/\/page\.(tsx|jsx|ts|js)$/, "")
    .replace(/\/route\.(ts|js)$/, "")
    .replace(/\.(tsx|jsx|ts|js)$/, "")
    .replace(/\/index$/, "")
    .replace(/^\/+/, "");
  return withoutExtension.replace(/^api\//, "api/").split("/").filter(Boolean).slice(0, 4).join(".").replace(/\s+/g, ".").replace(/^\.+|\.+$/g, "").toLowerCase() || "frontend";
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}
