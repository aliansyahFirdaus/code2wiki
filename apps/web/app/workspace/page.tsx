import Link from "next/link";
import type { ReactNode } from "react";
import { desc, eq } from "drizzle-orm";

import { generationRuns, getDb, githubInstallations, repositories, wikiPages } from "@code2wiki/db";
import { readEnv, sanitizeErrorText } from "@code2wiki/shared";
import { CopyableId } from "../../components/copyable-id";
import { GenerationDebugger } from "../../components/generation-debugger";
import { LiveRunSummary } from "../../components/live-run-summary";
import { QueueLatestTagsButton } from "../../components/queue-latest-tags-button";
import {
  materializationCountsByGenerationRun,
  pagesByGenerationRun,
} from "../../lib/run-pages";
import { runStatusLabel } from "../../lib/workspace-ui";
import { formatDateTime } from "../../lib/date-format";
import { toGenerationRunResponse } from "../../lib/generation-run-response";

export const dynamic = "force-dynamic";

type Props = {
  searchParams: Promise<{ workspaceId?: string }>;
};

type Run = typeof generationRuns.$inferSelect;

export default async function WorkspacePage({ searchParams }: Props) {
  const configuredModelLabel = formatConfiguredModelLabel();
  const workspaceId = (await searchParams).workspaceId?.trim();
  if (!workspaceId) {
    return (
      <main className="min-h-screen bg-white px-6 py-16 text-[#171717] md:px-8 md:py-24">
        <div className="mx-auto max-w-6xl">
          <h1 className="text-balance text-[48px] font-medium leading-[1.1] tracking-[-1.44px]">
            Workspace Setup
          </h1>
          <p className="mt-8 max-w-[60ch] text-[16px] leading-[1.5] text-[#707070]">
            Open this page with an explicit workspace ID, for example{" "}
            <code className="font-mono text-sm">
              /workspace?workspaceId=demo
            </code>
            .
          </p>
        </div>
      </main>
    );
  }

  const data = await loadWorkspaceData(workspaceId);
  if (!data.ok) {
    return (
      <main className="min-h-screen bg-white px-6 py-16 text-[#171717] md:px-8 md:py-24">
        <div className="mx-auto max-w-6xl">
          <h1 className="text-balance text-[48px] font-medium leading-[1.1] tracking-[-1.44px]">
            Workspace {workspaceId}
          </h1>
          <p className="mt-8 rounded-[8px] border border-[#ff2201]/30 bg-[#fafafa] p-4 text-[16px] leading-[1.5] text-[#ff2201]">
            {data.error}
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-white py-12 text-[#171717] md:py-16">
      <div className="mx-auto grid max-w-7xl gap-12 px-6 md:px-8">
        <header className="grid gap-8 border-b border-[#ededed] pb-10">
          <div>
            <p className="text-[13px] leading-[1.45] text-[#707070]">
              Inspect-Only Workspace
            </p>
            <h1 className="mt-5 text-balance text-[48px] font-medium leading-[1.1] tracking-[-1.44px] md:text-[64px] md:tracking-[-1.92px]">
              {workspaceId}
            </h1>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Metric
              label="Installations"
              value={String(data.installations.length)}
            />
            <Metric
              label="Repositories"
              value={String(data.repositories.length)}
            />
            <Metric label="Runs" value={String(data.runs.length)} />
          </div>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <p className="max-w-[60ch] text-sm leading-relaxed text-[#707070]">
              Queue one run from the latest matching FE and BE tags without waiting for a new tag push.
            </p>
            <QueueLatestTagsButton
              workspaceId={workspaceId}
              disabled={!hasRepositoryPair(data.repositories)}
            />
          </div>
          <p className="max-w-[70ch] text-xs leading-relaxed text-[#707070]">
            Rate-limit env changes need a daemon restart. Scan-root and scan-cap changes only affect new runs or reruns from before Analyze.
          </p>
        </header>

        <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
          <Section
            title="GitHub Installations"
            empty={
              data.installations.length === 0
                ? "No GitHub App installations recorded."
                : null
            }
          >
            <div className="grid gap-0">
              {data.installations.map((installation) => (
                <div
                  key={installation.id}
                  className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-4 border-t border-[#ededed] py-5"
                >
                  <div className="grid min-w-0 gap-2">
                    <strong className="min-w-0 truncate font-mono text-sm font-medium tabular-nums">
                      {installation.githubInstallationId}
                    </strong>
                    <span className="text-sm text-[#707070]">
                      {installation.status}
                    </span>
                  </div>
                  <StatusChip
                    label={installation.active ? "active" : "inactive"}
                    active={installation.active}
                  />
                </div>
              ))}
            </div>
          </Section>

          <Section
            title="Repositories"
            empty={
              data.repositories.length === 0
                ? "No frontend/backend repositories registered."
                : null
            }
          >
            <div className="grid gap-0">
              {data.repositories.map((repository) => (
                <div
                  key={repository.id}
                  className={`grid min-w-0 gap-4 border-t border-[#ededed] px-4 py-5 ${repository.role === "FRONTEND" ? "bg-[#f5f9ff]" : "bg-[#f4fbf6]"}`}
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <RoleLabel
                      role={repository.role === "FRONTEND" ? "FE" : "BE"}
                    />
                    <strong className="min-w-0 truncate text-sm font-medium">
                      {repository.repositoryFullName}
                    </strong>
                  </div>
                  <div className="flex min-w-0 flex-wrap items-center gap-3">
                    <span className="font-mono text-sm text-[#707070]">
                      tags {repository.tagPattern}
                    </span>
                    <StatusChip
                      label={repository.active ? "active" : "inactive"}
                      active={repository.active}
                    />
                  </div>
                </div>
              ))}
            </div>
          </Section>
        </div>

        <Section
          wide
          title="Generation Runs"
          empty={data.runs.length === 0 ? "No generation runs yet." : null}
        >
          <div className="grid gap-8">
            {data.runs.map((run) => {
              const frontendRepository =
                data.repositoriesById.get(run.frontendRepositoryId)
                  ?.repositoryFullName ?? run.frontendRepositoryId;
              const backendRepository =
                data.repositoriesById.get(run.backendRepositoryId)
                  ?.repositoryFullName ?? run.backendRepositoryId;
              const materialized = data.materializationCounts.get(run.id) ?? {
                written: 0,
                reused: 0,
              };
              const affected = affectedPageKeys(
                run.incrementalReportJson,
              ).length;
              const issue = runIssueLabel(run);
              const response = toGenerationRunResponse(run, []);

              return (
                <article
                  key={run.id}
                  className="grid gap-8 rounded-[12px] border border-[#dfdfdf] bg-white p-5"
                >
                  <div className="grid min-w-0 gap-8">
                    <div className="flex min-w-0 flex-wrap items-start justify-between gap-4">
                      <CopyableId label="generationId" value={run.id} />
                      <time
                        className="font-mono text-xs tabular-nums text-[#9a9a9a]"
                        dateTime={run.createdAt.toISOString()}
                      >
                        {formatDateTime(run.createdAt)}
                      </time>
                    </div>

                    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                      <RepoLine
                        role="FE"
                        repository={frontendRepository}
                        tag={run.frontendTag}
                        commit={run.frontendCommitSha}
                        indexed={run.frontendIndexedEligibleFiles}
                        total={run.frontendTotalEligibleFiles}
                      />
                      <RepoLine
                        role="BE"
                        repository={backendRepository}
                        tag={run.backendTag}
                        commit={run.backendCommitSha}
                        indexed={run.backendIndexedEligibleFiles}
                        total={run.backendTotalEligibleFiles}
                      />
                    </div>

                    <LiveRunSummary
                      initialRun={{
                        id: run.id,
                        status: run.status,
                        executionMode: run.executionMode,
                        controlState: run.controlState,
                        advanceRequestedAt: run.advanceRequestedAt?.toISOString() ?? null,
                        generatedStatementCount: run.generatedStatementCount,
                        generatedStatementWithEvidenceCount: run.generatedStatementWithEvidenceCount,
                        writtenPageCount: materialized.written,
                        reusedPageCount: materialized.reused,
                        affectedPageCount: affected,
                        errorMessage: issue,
                        qualityIssues: qualityIssues(run.qualityReportJson),
                        configuredModelLabel,
                        aiUsageSummary: response.aiUsageSummary,
                      }}
                    />

                    {run.errorMessage &&
                    issue !== humanizeIssue(sanitizeErrorText(run.errorMessage)) ? (
                      <p className="rounded-[8px] border border-[#ff2201]/30 bg-[#fafafa] p-4 text-sm leading-relaxed text-[#ff2201]">
                        {sanitizeErrorText(run.errorMessage)}
                      </p>
                    ) : null}
                    <WikiLinks pages={data.pagesByRun.get(run.id) ?? []} />
                  </div>

                  <GenerationDebugger generationRunId={run.id} />
                </article>
              );
            })}
          </div>
        </Section>
      </div>
    </main>
  );
}

async function loadWorkspaceData(workspaceId: string) {
  try {
    const db = getDb();
    const [installations, repoRows, runs] = await Promise.all([
      db
        .select()
        .from(githubInstallations)
        .where(eq(githubInstallations.workspaceId, workspaceId)),
      db
        .select()
        .from(repositories)
        .where(eq(repositories.workspaceId, workspaceId)),
      db
        .select()
        .from(generationRuns)
        .where(eq(generationRuns.workspaceId, workspaceId))
        .orderBy(desc(generationRuns.createdAt)),
    ]);
    const runIds = runs.map((run) => run.id);
    const [pagesByRun, materializationCounts] = await Promise.all([
      pagesByGenerationRun(runIds),
      materializationCountsByGenerationRun(runIds),
    ]);
    return {
      ok: true as const,
      installations,
      repositories: repoRows,
      repositoriesById: new Map(
        repoRows.map((repository) => [repository.id, repository]),
      ),
      runs,
      pagesByRun,
      materializationCounts,
    };
  } catch (error) {
    return { ok: false as const, error: sanitizeErrorText(error) || "Workspace data unavailable." };
  }
}

function Section({
  title,
  empty,
  children,
  wide = false,
}: {
  title: string;
  empty: string | null;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <section className={`${wide ? "grid gap-8" : "grid min-w-0 gap-8"}`}>
      <div className="border-t border-[#ededed] pt-4">
        <h2 className="text-balance text-[28px] font-medium leading-[1.2] tracking-[-0.42px]">
          {title}
        </h2>
      </div>
      {empty ? (
        <p className="max-w-[60ch] text-base leading-relaxed text-[#707070]">
          {empty}
        </p>
      ) : (
        children
      )}
    </section>
  );
}

function WikiLinks({ pages }: { pages: Array<typeof wikiPages.$inferSelect> }) {
  if (pages.length === 0) {
    return (
      <p className="max-w-[60ch] text-sm leading-relaxed text-[#707070]">
        No wiki pages generated.
      </p>
    );
  }

  return (
    <div className="grid gap-3 rounded-[8px] border border-[#dfdfdf] bg-[#fafafa] p-4">
      <div className="flex items-center justify-between gap-3">
        <strong className="text-sm font-medium">Generated Pages</strong>
        <span className="rounded-[9999px] bg-[#3ecf8e] px-2 py-1 font-mono text-xs text-[#171717]">
          {pages.length}
        </span>
      </div>
      <div className="grid max-h-[360px] grid-cols-1 gap-2 overflow-y-auto pr-2 sm:grid-cols-2 xl:grid-cols-3">
        {pages.map((page) => (
          <Link
            key={page.id}
            href={`/wiki/${page.id}`}
            title={page.title}
            className="min-h-[40px] truncate rounded-[6px] border border-[#dfdfdf] bg-white px-3 py-2 text-sm font-medium text-[#171717] motion-safe:transition-colors hover:border-[#3ecf8e] hover:bg-[#fafafa] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#171717]"
          >
            {page.title}
          </Link>
        ))}
      </div>
    </div>
  );
}

function RepoLine({
  role,
  repository,
  tag,
  commit,
  indexed,
  total,
}: {
  role: "FE" | "BE";
  repository: string;
  tag: string;
  commit: string;
  indexed: number | null;
  total: number | null;
}) {
  const percent =
    total && indexed != null ? Math.round((indexed / total) * 100) : null;
  const tone =
    role === "FE"
      ? {
          card: "border-[#9ec5ff] bg-[#e8f1ff]",
          divider: "#9ec5ff",
          ring: "#2563eb",
        }
      : {
          card: "border-[#cfead9] bg-[#f4fbf6]",
          divider: "#cfead9",
          ring: "#22c55e",
        };

  return (
    <div
      className={`grid min-w-0 grid-cols-[minmax(0,1fr)_112px] gap-0 rounded-[8px] border p-4 ${tone.card}`}
    >
      <div className="grid min-w-0 gap-4">
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <RoleLabel role={role} />
          <strong className="min-w-0 truncate text-sm font-medium">
            {repository}
          </strong>
        </div>
        <div className="flex flex-wrap items-stretch gap-0">
          <RepoMeta label="Tag" value={tag} dividerColor={tone.divider} />
          <RepoMeta
            label="Commit"
            value={commit.slice(0, 12)}
            divider
            dividerColor={tone.divider}
          />
          <RepoMeta
            label="Indexed files"
            value={
              indexed == null || total == null ? "N/A" : `${indexed}/${total}`
            }
            divider
            dividerColor={tone.divider}
          />
        </div>
      </div>
      <CoverageRing percent={percent} ringColor={tone.ring} />
    </div>
  );
}

function RepoMeta({
  label,
  value,
  divider = false,
  dividerColor = "#dfdfdf",
}: {
  label: string;
  value: string;
  divider?: boolean;
  dividerColor?: string;
}) {
  return (
    <div className="relative shrink-0">
      {divider ? (
        <span
          aria-hidden="true"
          className="absolute left-0 top-1/2 h-11 -translate-y-1/2 border-l"
          style={{ borderColor: dividerColor }}
        />
      ) : null}
      <div className="grid min-w-0 justify-items-start gap-1 px-6 text-left">
        <span className="text-xs font-medium text-[#707070]">{label}</span>
        <strong className="font-mono text-sm font-normal tabular-nums text-[#171717]">
          {value}
        </strong>
      </div>
    </div>
  );
}

function CoverageRing({
  percent,
  divider = false,
  ringColor = "#3ecf8e",
}: {
  percent: number | null;
  divider?: boolean;
  ringColor?: string;
}) {
  const value = percent ?? 0;

  return (
    <div className="relative grid w-[112px] place-items-center gap-1">
      {divider ? (
        <span
          aria-hidden="true"
          className="absolute left-0 top-1/2 h-11 -translate-y-1/2 border-l border-[#dfdfdf]"
        />
      ) : null}
      <div
        className="grid h-16 w-16 place-items-center rounded-full"
        style={{
          background: `conic-gradient(${ringColor} ${value * 3.6}deg, #ededed 0deg)`,
        }}
        aria-label={
          percent == null ? "Coverage unavailable" : `${percent}% coverage`
        }
      >
        <div className="grid h-12 w-12 place-items-center rounded-full bg-[#fafafa]">
          <strong className="font-mono text-xs font-medium tabular-nums">
            {percent == null ? "N/A" : `${percent}%`}
          </strong>
        </div>
      </div>
      <span className="text-xs font-medium text-[#707070]">Coverage</span>
    </div>
  );
}

function RoleLabel({ role }: { role: "FE" | "BE" }) {
  return (
    <span
      className={`rounded-[9999px] border px-2 py-1 text-xs font-medium ${
        role === "FE"
          ? "border-[#9ec5ff] bg-[#dbeafe] text-[#1d4ed8]"
          : "border-[#b7dfc5] bg-[#dcfce7] text-[#15803d]"
      }`}
    >
      {role}
    </span>
  );
}

function StatusChip({ label, active }: { label: string; active: boolean }) {
  return (
    <span
      className={`${active ? "border-[#3ecf8e] bg-[#3ecf8e] text-[#171717]" : "border-[#dfdfdf] bg-[#fafafa] text-[#707070]"} inline-flex shrink-0 rounded-[9999px] border px-3 py-2 text-xs font-medium`}
    >
      {label}
    </span>
  );
}

function Metric({
  label,
  value,
  accent = false,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div className="grid min-w-0 gap-4 rounded-[8px] border border-[#dfdfdf] bg-[#fafafa] p-5">
      <span className="break-words text-xs font-medium leading-normal text-[#707070]">
        {label}
      </span>
      <strong
        className={`${accent ? "text-[#ff2201]" : "text-[#171717]"} min-w-0 break-words font-mono text-3xl font-normal tabular-nums`}
      >
        {value}
      </strong>
    </div>
  );
}

function runIssueLabel(run: Run) {
  if (
    run.status === "FAILED" ||
    run.status === "AI_OUTPUT_INVALID" ||
    run.status === "NEEDS_REVIEW"
  ) {
    return run.errorMessage
      ? humanizeIssue(sanitizeErrorText(run.errorMessage))
      : runStatusLabel(run.status);
  }
  return null;
}

function humanizeIssue(value: string) {
  if (/^[A-Z0-9_]+$/.test(value)) {
    return value
      .toLowerCase()
      .split("_")
      .filter(Boolean)
      .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
      .join(" ");
  }
  return value;
}

function qualityIssues(value: unknown) {
  if (!value || typeof value !== "object" || !Array.isArray((value as { issues?: unknown[] }).issues)) {
    return [];
  }
  return (value as { issues: Array<Record<string, unknown>> }).issues
    .map((issue) => ({
      severity: issue.severity === "ERROR" || issue.severity === "WARN" ? issue.severity : null as "ERROR" | "WARN" | null,
      code: typeof issue.code === "string" ? issue.code : null,
      message: typeof issue.message === "string" ? issue.message : null
    }))
    .filter((issue) => issue.message);
}

function affectedPageKeys(value: unknown) {
  return isRecord(value) && Array.isArray(value.affectedPageKeys)
    ? value.affectedPageKeys.filter(
        (item): item is string => typeof item === "string",
      )
    : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasRepositoryPair(rows: Array<typeof repositories.$inferSelect>) {
  return rows.some((repository) => repository.active && repository.role === "FRONTEND")
    && rows.some((repository) => repository.active && repository.role === "BACKEND");
}

function formatConfiguredModelLabel() {
  const env = readEnv();
  if (!env.AI_MODEL) {
    return null;
  }
  return env.AI_PROVIDER ? `${env.AI_PROVIDER} / ${env.AI_MODEL}` : env.AI_MODEL;
}
