import { buildCodeMap, buildCodeSummaries, scanCode, type ScannerEvidence } from "@code2wiki/analyzer";
import { codeFacts, codeMaps, codeSummaries, evidence as evidenceTable, generationRuns, getDb, repositories } from "@code2wiki/db";
import { cloneRepositoryAtCommit, createGitHubInstallationAccessToken, type RepositoryCheckout } from "@code2wiki/github";
import { and, asc, eq, sql } from "drizzle-orm";
import { assertGenerationRepositoryRoles, mapScanCoverage, type ScanCoverage } from "./role-mapping";
import { checkpointRunControl } from "./run-state";
import { emitDebugEvent } from "./self-expanding-generation/debug-events";

type AnalyzeCodeResult =
  | { status: "skipped"; reason: string; scanWarnings?: string[] }
  | {
      status: "facts_extracted";
      generationRunId: string;
      totalEligibleFiles: number;
      indexedEligibleFiles: number;
      frontendTotalEligibleFiles: number;
      frontendIndexedEligibleFiles: number;
      backendTotalEligibleFiles: number;
      backendIndexedEligibleFiles: number;
      scanWarnings?: string[];
    }
  | { status: "failed"; generationRunId: string; errorMessage: string; scanWarnings?: string[] };

type ClaimedGenerationRun = typeof generationRuns.$inferSelect;
type RepositoryRecord = typeof repositories.$inferSelect;

export async function analyzeCode(generationRunId?: string): Promise<AnalyzeCodeResult> {
  const db = getDb();
  const frontendScope = scanScopeFromEnv("FRONTEND");
  const backendScope = scanScopeFromEnv("BACKEND");
  const scanWarnings = scanWarningsForScope({ frontendScope, backendScope });
  const claimedRun = await claimGenerationRun(generationRunId);

  if (!claimedRun) {
    return withScanWarnings({
      status: "skipped",
      reason: generationRunId ? "Generation run is not cloned or does not exist." : "No cloned generation run found."
    }, scanWarnings);
  }

  const checkouts: RepositoryCheckout[] = [];
  const abortController = new AbortController();

  try {
    const [frontendRepository, backendRepository] = await Promise.all([
      getActiveRepository(claimedRun.frontendRepositoryId),
      getActiveRepository(claimedRun.backendRepositoryId)
    ]);
    assertGenerationRepositoryRoles(frontendRepository, backendRepository);
    await emitDebugEvent({
      generationRunId: claimedRun.id,
      stage: "analyze",
      eventType: "ANALYZE_STARTED",
      message: "Code analysis started.",
      payload: {
        frontendRepository: frontendRepository.repositoryFullName,
        backendRepository: backendRepository.repositoryFullName,
        scanScope: scanScopeDebug({ frontendScope, backendScope }),
        scanWarnings
      },
      severity: scanWarnings.length > 0 ? "WARN" : "INFO"
    });

    const tokenByInstallationId = new Map<string, string>();
    const getInstallationToken = async (installationId: string) => {
      const existing = tokenByInstallationId.get(installationId);
      if (existing) {
        return existing;
      }

      const { token } = await createGitHubInstallationAccessToken(installationId);
      tokenByInstallationId.set(installationId, token);
      return token;
    };

    const beforeFrontendClone = await checkpointRunControl({
      generationRunId: claimedRun.id,
      runningStatus: "SCANNING",
      pausedStatus: "CLONED"
    });
    if (beforeFrontendClone.action !== "continue") {
      return withScanWarnings({
        status: beforeFrontendClone.action === "cancel" ? "failed" : "skipped",
        generationRunId: claimedRun.id,
        ...(beforeFrontendClone.action === "cancel" ? { errorMessage: "RUN_CANCELED" } : { reason: "RUN_PAUSED" })
      } as AnalyzeCodeResult, scanWarnings);
    }

    const frontendCheckout = await cloneRepositoryAtCommit({
      owner: frontendRepository.owner,
      repo: frontendRepository.repo,
      commitSha: claimedRun.frontendCommitSha,
      token: await getInstallationToken(frontendRepository.githubInstallationId),
      signal: abortController.signal
    });
    checkouts.push(frontendCheckout);

    const beforeBackendClone = await checkpointRunControl({
      generationRunId: claimedRun.id,
      runningStatus: "SCANNING",
      pausedStatus: "CLONED"
    });
    if (beforeBackendClone.action !== "continue") {
      return withScanWarnings({
        status: beforeBackendClone.action === "cancel" ? "failed" : "skipped",
        generationRunId: claimedRun.id,
        ...(beforeBackendClone.action === "cancel" ? { errorMessage: "RUN_CANCELED" } : { reason: "RUN_PAUSED" })
      } as AnalyzeCodeResult, scanWarnings);
    }

    const backendCheckout = await cloneRepositoryAtCommit({
      owner: backendRepository.owner,
      repo: backendRepository.repo,
      commitSha: claimedRun.backendCommitSha,
      token: await getInstallationToken(backendRepository.githubInstallationId),
      signal: abortController.signal
    });
    checkouts.push(backendCheckout);

    const [frontendScan, backendScan] = await Promise.all([
      scanCode({
        repositoryRole: frontendRepository.role,
        repositoryRoot: frontendCheckout.path,
        includePaths: frontendScope.includePaths,
        maxFiles: frontendScope.maxFiles,
        shouldStop: async () => (await checkpointRunControl({
          generationRunId: claimedRun.id,
          runningStatus: "SCANNING",
          pausedStatus: "CLONED"
        })).action !== "continue"
      }),
      scanCode({
        repositoryRole: backendRepository.role,
        repositoryRoot: backendCheckout.path,
        includePaths: backendScope.includePaths,
        maxFiles: backendScope.maxFiles,
        shouldStop: async () => (await checkpointRunControl({
          generationRunId: claimedRun.id,
          runningStatus: "SCANNING",
          pausedStatus: "CLONED"
        })).action !== "continue"
      })
    ]);

    const coverage = mapScanCoverage([
      {
        repositoryRole: frontendRepository.role,
        totalEligibleFiles: frontendScan.totalEligibleFiles,
        indexedEligibleFiles: frontendScan.indexedEligibleFiles
      },
      {
        repositoryRole: backendRepository.role,
        totalEligibleFiles: backendScan.totalEligibleFiles,
        indexedEligibleFiles: backendScan.indexedEligibleFiles
      }
    ]);
    const totalEligibleFiles = coverage.totalEligibleFiles;
    const indexedEligibleFiles = coverage.indexedEligibleFiles;

    if (totalEligibleFiles === 0) {
      await markNoEligibleFiles(claimedRun.id, coverage);
      await emitDebugEvent({
        generationRunId: claimedRun.id,
        stage: "analyze",
        eventType: "ANALYZE_FAILED",
        severity: "ERROR",
        message: "Code analysis found no eligible files.",
        payload: {
          errorMessage: "NO_ELIGIBLE_FILES",
          scanWarnings,
          scanScope: scanScopeDebug({ frontendScope, backendScope }),
          coverage,
          files: scanFilesDebug({ frontendScan, backendScan })
        }
      });
      return withScanWarnings({ status: "failed", generationRunId: claimedRun.id, errorMessage: "NO_ELIGIBLE_FILES" }, scanWarnings);
    }

    const evidenceRows = [
      ...frontendScan.evidence.map((item) => toEvidenceRow(claimedRun, frontendRepository, item)),
      ...backendScan.evidence.map((item) => toEvidenceRow(claimedRun, backendRepository, item))
    ];
    const evidenceIdByKey = new Map(evidenceRows.map((row) => [row.evidenceKey, row.id]));
    let factCount = 0;
    let codeSummaryCount = 0;

    const beforePersistence = await checkpointRunControl({
      generationRunId: claimedRun.id,
      runningStatus: "SCANNING",
      pausedStatus: "CLONED"
    });
    if (beforePersistence.action !== "continue") {
      return withScanWarnings({
        status: beforePersistence.action === "cancel" ? "failed" : "skipped",
        generationRunId: claimedRun.id,
        ...(beforePersistence.action === "cancel" ? { errorMessage: "RUN_CANCELED" } : { reason: "RUN_PAUSED" })
      } as AnalyzeCodeResult, scanWarnings);
    }

    await db.transaction(async (tx) => {
      await tx.delete(codeFacts).where(eq(codeFacts.generationRunId, claimedRun.id));
      await tx.delete(evidenceTable).where(eq(evidenceTable.generationRunId, claimedRun.id));

      for (const chunk of chunks(evidenceRows.map(({ evidenceKey, ...row }) => row), 500)) {
        if (chunk.length > 0) {
          await tx.insert(evidenceTable).values(chunk);
        }
      }

      const frontendEvidenceKeys = new Set(frontendScan.evidence.map((item) => item.evidenceKey));
      const backendEvidenceKeys = new Set(backendScan.evidence.map((item) => item.evidenceKey));
      for (const fact of frontendScan.facts) {
        if (!fact.evidenceKeys.every((key) => frontendEvidenceKeys.has(key))) {
          throw new Error("Frontend fact references missing evidence.");
        }
      }
      for (const fact of backendScan.facts) {
        if (!fact.evidenceKeys.every((key) => backendEvidenceKeys.has(key))) {
          throw new Error("Backend fact references missing evidence.");
        }
      }

      const codeFactRows = [
        ...frontendScan.facts.map((fact) => ({
          id: crypto.randomUUID(),
          generationRunId: claimedRun.id,
          repositoryRole: "FRONTEND" as const,
          repositoryFullName: frontendRepository.repositoryFullName,
          tag: claimedRun.frontendTag,
          commitSha: claimedRun.frontendCommitSha,
          factKind: fact.factKind,
          text: fact.text,
          evidenceIds: resolveEvidenceIds(fact.evidenceKeys, evidenceIdByKey),
          confidence: fact.confidence
        })),
        ...backendScan.facts.map((fact) => ({
          id: crypto.randomUUID(),
          generationRunId: claimedRun.id,
          repositoryRole: "BACKEND" as const,
          repositoryFullName: backendRepository.repositoryFullName,
          tag: claimedRun.backendTag,
          commitSha: claimedRun.backendCommitSha,
          factKind: fact.factKind,
          text: fact.text,
          evidenceIds: resolveEvidenceIds(fact.evidenceKeys, evidenceIdByKey),
          confidence: fact.confidence
        }))
      ].filter((row) => row.evidenceIds.length > 0);
      factCount = codeFactRows.length;

      for (const chunk of chunks(codeFactRows, 500)) {
        if (chunk.length > 0) {
          await tx.insert(codeFacts).values(chunk);
        }
      }

      const codeMap = buildCodeMap({
        generationRunId: claimedRun.id,
        facts: codeFactRows,
        evidence: evidenceRows.map(({ evidenceKey, ...row }) => row)
      });
      await tx
        .insert(codeMaps)
        .values({
          id: `code_map_${claimedRun.id}`,
          generationRunId: claimedRun.id,
          sourceHash: codeMap.sourceHash,
          mapJson: codeMap,
          updatedAt: new Date()
        })
        .onConflictDoUpdate({
          target: codeMaps.generationRunId,
          set: {
            sourceHash: codeMap.sourceHash,
            mapJson: codeMap,
            updatedAt: new Date()
          }
        });

      const summaries = buildCodeSummaries({
        generationRunId: claimedRun.id,
        codeMap,
        facts: codeFactRows,
        evidence: evidenceRows.map(({ evidenceKey, codeSnippet, ...row }) => row)
      });
      const summaryRows = [...summaries.fileSummaries, ...summaries.moduleSummaries].map((summary) => ({
        id: `code_summary_${summary.type.toLowerCase()}_${summary.cacheKey}`,
        generationRunId: claimedRun.id,
        summaryType: summary.type,
        cacheKey: summary.cacheKey,
        sourceHash: summary.sourceHash,
        inputHash: summary.inputHash,
        outputHash: summary.outputHash,
        summaryJson: summary as unknown as Record<string, unknown>,
        updatedAt: new Date()
      }));
      codeSummaryCount = summaryRows.length;

      await tx.delete(codeSummaries).where(eq(codeSummaries.generationRunId, claimedRun.id));
      for (const chunk of chunks(summaryRows, 250)) {
        await tx
          .insert(codeSummaries)
          .values(chunk)
          .onConflictDoUpdate({
            target: [codeSummaries.generationRunId, codeSummaries.summaryType, codeSummaries.cacheKey],
            set: {
              sourceHash: sql`excluded.source_hash`,
              inputHash: sql`excluded.input_hash`,
              outputHash: sql`excluded.output_hash`,
              summaryJson: sql`excluded.summary_json`,
              updatedAt: new Date()
            }
          });
      }

      await tx
        .update(generationRuns)
        .set({
          totalEligibleFiles,
          indexedEligibleFiles,
          frontendTotalEligibleFiles: coverage.frontendTotalEligibleFiles,
          frontendIndexedEligibleFiles: coverage.frontendIndexedEligibleFiles,
          backendTotalEligibleFiles: coverage.backendTotalEligibleFiles,
          backendIndexedEligibleFiles: coverage.backendIndexedEligibleFiles,
          status: "FACTS_EXTRACTED",
          errorMessage: null
        })
        .where(eq(generationRuns.id, claimedRun.id));
    });
    await emitDebugEvent({
      generationRunId: claimedRun.id,
      stage: "analyze",
      eventType: "ANALYZE_DONE",
      message: "Code analysis completed.",
      payload: {
        scanWarnings,
        scanScope: scanScopeDebug({ frontendScope, backendScope }),
        coverage,
        files: scanFilesDebug({ frontendScan, backendScan }),
        evidenceCount: evidenceRows.length,
        factCount,
        codeSummaryCount
      },
      severity: scanWarnings.length > 0 ? "WARN" : "INFO"
    });

    return withScanWarnings({
      status: "facts_extracted",
      generationRunId: claimedRun.id,
      totalEligibleFiles,
      indexedEligibleFiles,
      frontendTotalEligibleFiles: coverage.frontendTotalEligibleFiles,
      frontendIndexedEligibleFiles: coverage.frontendIndexedEligibleFiles,
      backendTotalEligibleFiles: coverage.backendTotalEligibleFiles,
      backendIndexedEligibleFiles: coverage.backendIndexedEligibleFiles
    }, scanWarnings);
  } catch (error) {
    if (error instanceof Error && error.message === "SCAN_STOP_REQUESTED") {
      const checkpoint = await checkpointRunControl({
        generationRunId: claimedRun.id,
        runningStatus: "SCANNING",
        pausedStatus: "CLONED"
      });
      if (checkpoint.action === "pause") {
        return withScanWarnings({ status: "skipped", reason: "RUN_PAUSED" }, scanWarnings);
      }
      if (checkpoint.action === "cancel") {
        return withScanWarnings({ status: "failed", generationRunId: claimedRun.id, errorMessage: "RUN_CANCELED" }, scanWarnings);
      }
    }
    const errorMessage = sanitizeErrorMessage(error);
    await markFailed(claimedRun.id, errorMessage);
    await emitDebugEvent({
      generationRunId: claimedRun.id,
      stage: "analyze",
      eventType: "ANALYZE_FAILED",
      severity: "ERROR",
      message: "Code analysis failed.",
      payload: { errorMessage, scanWarnings }
    });
    return withScanWarnings({
      status: "failed",
      generationRunId: claimedRun.id,
      errorMessage
    }, scanWarnings);
  } finally {
    await cleanupCheckouts(checkouts);
  }
}

async function claimGenerationRun(generationRunId?: string): Promise<ClaimedGenerationRun | null> {
  const db = getDb();

  if (generationRunId) {
    const [claimedRun] = await db
      .update(generationRuns)
      .set({
        status: "SCANNING",
        finishedAt: null,
        errorMessage: null
      })
      .where(and(eq(generationRuns.id, generationRunId), eq(generationRuns.status, "CLONED")))
      .returning();

    return claimedRun ?? null;
  }

  return db.transaction(async (tx) => {
    const [clonedRun] = await tx
      .select()
      .from(generationRuns)
      .where(eq(generationRuns.status, "CLONED"))
      .orderBy(asc(generationRuns.createdAt))
      .limit(1);

    if (!clonedRun) {
      return null;
    }

    const [claimedRun] = await tx
      .update(generationRuns)
      .set({
        status: "SCANNING",
        finishedAt: null,
        errorMessage: null
      })
      .where(and(eq(generationRuns.id, clonedRun.id), eq(generationRuns.status, "CLONED")))
      .returning();

    return claimedRun ?? null;
  });
}

async function getActiveRepository(repositoryId: string): Promise<RepositoryRecord> {
  const db = getDb();
  const [repository] = await db
    .select()
    .from(repositories)
    .where(and(eq(repositories.id, repositoryId), eq(repositories.active, true)))
    .limit(1);

  if (!repository) {
    throw new Error(`Active repository record not found for ${repositoryId}.`);
  }

  return repository;
}

function toEvidenceRow(run: ClaimedGenerationRun, repository: RepositoryRecord, scannerEvidence: ScannerEvidence) {
  const commitSha = scannerEvidence.repositoryRole === "FRONTEND" ? run.frontendCommitSha : run.backendCommitSha;
  const tag = scannerEvidence.repositoryRole === "FRONTEND" ? run.frontendTag : run.backendTag;

  return {
    evidenceKey: scannerEvidence.evidenceKey,
    id: crypto.randomUUID(),
    generationRunId: run.id,
    repositoryRole: scannerEvidence.repositoryRole,
    repositoryFullName: repository.repositoryFullName,
    tag,
    commitSha,
    filePath: scannerEvidence.filePath,
    startLine: scannerEvidence.startLine,
    endLine: scannerEvidence.endLine,
    sourceKind: scannerEvidence.sourceKind,
    summary: scannerEvidence.summary,
    codeSnippet: scannerEvidence.codeSnippet,
    githubUrl: buildGitHubUrl(repository, commitSha, scannerEvidence.filePath, scannerEvidence.startLine, scannerEvidence.endLine)
  };
}

function buildGitHubUrl(repository: RepositoryRecord, commitSha: string, filePath: string, startLine: number, endLine: number) {
  const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
  return `https://github.com/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/blob/${commitSha}/${encodedPath}#L${startLine}-L${endLine}`;
}

async function markFailed(
  generationRunId: string,
  errorMessage: string,
  coverage?: ScanCoverage
) {
  const db = getDb();
  await db
    .update(generationRuns)
    .set({
      status: "FAILED",
      errorMessage,
      totalEligibleFiles: coverage?.totalEligibleFiles,
      indexedEligibleFiles: coverage?.indexedEligibleFiles,
      frontendTotalEligibleFiles: coverage?.frontendTotalEligibleFiles,
      frontendIndexedEligibleFiles: coverage?.frontendIndexedEligibleFiles,
      backendTotalEligibleFiles: coverage?.backendTotalEligibleFiles,
      backendIndexedEligibleFiles: coverage?.backendIndexedEligibleFiles,
      finishedAt: new Date()
    })
    .where(eq(generationRuns.id, generationRunId));
}

async function markNoEligibleFiles(generationRunId: string, coverage: ScanCoverage) {
  const db = getDb();
  await db.transaction(async (tx) => {
    await tx.delete(codeFacts).where(eq(codeFacts.generationRunId, generationRunId));
    await tx.delete(evidenceTable).where(eq(evidenceTable.generationRunId, generationRunId));
    await tx
      .update(generationRuns)
      .set({
        status: "FAILED",
        errorMessage: "NO_ELIGIBLE_FILES",
        totalEligibleFiles: coverage.totalEligibleFiles,
        indexedEligibleFiles: coverage.indexedEligibleFiles,
        frontendTotalEligibleFiles: coverage.frontendTotalEligibleFiles,
        frontendIndexedEligibleFiles: coverage.frontendIndexedEligibleFiles,
        backendTotalEligibleFiles: coverage.backendTotalEligibleFiles,
        backendIndexedEligibleFiles: coverage.backendIndexedEligibleFiles,
        finishedAt: new Date()
      })
      .where(eq(generationRuns.id, generationRunId));
  });
}

function sanitizeErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "Unknown scan failure.";

  return message
    .replace(/ghs_[A-Za-z0-9_]+/g, "[redacted]")
    .replace(/github_pat_[A-Za-z0-9_]+/g, "[redacted]")
    .replace(/https:\/\/[^/\s@]+:[^@\s]+@github\.com/gi, "https://[redacted]@github.com")
    .slice(0, 1000);
}

function resolveEvidenceIds(evidenceKeys: string[], evidenceIdByKey: Map<string, string>) {
  return evidenceKeys.map((key) => {
    const id = evidenceIdByKey.get(key);
    if (!id) {
      throw new Error("Fact references missing inserted evidence.");
    }
    return id;
  });
}

function chunks<T>(items: T[], size: number) {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

type EnvScanScope = {
  includePaths: string[];
  maxFiles?: number;
};

function scanScopeFromEnv(role: "FRONTEND" | "BACKEND"): EnvScanScope {
  const rolePrefix = role === "FRONTEND" ? "FRONTEND" : "BACKEND";
  const includePaths = [
    ...scanPathListFromEnv("CODE2WIKI_SCAN_ROOTS"),
    ...scanPathListFromEnv(`CODE2WIKI_${rolePrefix}_SCAN_ROOTS`)
  ];
  return {
    includePaths: [...new Set(includePaths)],
    maxFiles: scanMaxFilesFromEnv(process.env[`CODE2WIKI_${rolePrefix}_SCAN_MAX_FILES`] ?? process.env.CODE2WIKI_SCAN_MAX_FILES)
  };
}

function scanPathListFromEnv(name: string) {
  return (process.env[name] ?? "")
    .split(",")
    .map((path) => path.trim().replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, ""))
    .filter(Boolean);
}

function scanMaxFilesFromEnv(value: string | undefined) {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : undefined;
}

function scanWarningsForScope(input: { frontendScope: EnvScanScope; backendScope: EnvScanScope }) {
  const warnings: string[] = [];
  if (input.frontendScope.includePaths.length > 0 || input.backendScope.includePaths.length > 0) {
    warnings.push(
      `SCAN_ROOTS_ACTIVE: generation is scoped to FE roots [${input.frontendScope.includePaths.join(", ") || "all"}] and BE roots [${input.backendScope.includePaths.join(", ") || "all"}]; coverage is not full-repository coverage.`
    );
  }
  if (input.frontendScope.maxFiles !== undefined || input.backendScope.maxFiles !== undefined) {
    warnings.push(
      `SCAN_MAX_FILES_ACTIVE: generation indexes at most FE ${input.frontendScope.maxFiles ?? "all"} files and BE ${input.backendScope.maxFiles ?? "all"} files; coverage is capped.`
    );
  }
  return warnings;
}

function scanScopeDebug(input: { frontendScope: EnvScanScope; backendScope: EnvScanScope }) {
  return {
    envGuardActive: input.frontendScope.includePaths.length > 0 || input.backendScope.includePaths.length > 0,
    maxFilesGuardActive: input.frontendScope.maxFiles !== undefined || input.backendScope.maxFiles !== undefined,
    envVariables: {
      sharedRoots: envSet("CODE2WIKI_SCAN_ROOTS"),
      frontendRoots: envSet("CODE2WIKI_FRONTEND_SCAN_ROOTS"),
      backendRoots: envSet("CODE2WIKI_BACKEND_SCAN_ROOTS"),
      sharedMaxFiles: envSet("CODE2WIKI_SCAN_MAX_FILES"),
      frontendMaxFiles: envSet("CODE2WIKI_FRONTEND_SCAN_MAX_FILES"),
      backendMaxFiles: envSet("CODE2WIKI_BACKEND_SCAN_MAX_FILES")
    },
    frontend: input.frontendScope,
    backend: input.backendScope
  };
}

function scanFilesDebug(input: { frontendScan: Awaited<ReturnType<typeof scanCode>>; backendScan: Awaited<ReturnType<typeof scanCode>> }) {
  return {
    frontend: oneScanFilesDebug(input.frontendScan),
    backend: oneScanFilesDebug(input.backendScan)
  };
}

function oneScanFilesDebug(scan: Awaited<ReturnType<typeof scanCode>>) {
  return {
    eligibleCount: scan.totalEligibleFiles,
    indexedCount: scan.indexedEligibleFiles,
    ignoredCount: scan.ignoredFiles?.length ?? 0,
    eligibleFiles: scan.eligibleFiles ?? [],
    indexedFiles: scan.indexedFiles ?? [],
    ignoredFiles: scan.ignoredFiles ?? []
  };
}

function envSet(name: string) {
  return Boolean(process.env[name]?.trim());
}


function withScanWarnings<T extends object>(result: T, warnings: string[]): T & { scanWarnings?: string[] } {
  return warnings.length > 0 ? { ...result, scanWarnings: warnings } : result;
}

async function cleanupCheckouts(checkouts: RepositoryCheckout[]) {
  for (const checkout of checkouts.reverse()) {
    try {
      await checkout.cleanup();
    } catch {
      // Cleanup failure must not mask scan or status-update outcomes.
    }
  }
}
