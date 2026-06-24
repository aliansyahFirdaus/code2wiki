import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import { desc, eq } from "drizzle-orm";

import { generationRuns, getDb, githubInstallations, repositories, wikiPages } from "@code2wiki/db";
import { sanitizeErrorText } from "@code2wiki/shared";
import { GenerationDebugger } from "../../components/generation-debugger";
import { materializationCountsByGenerationRun, pagesByGenerationRun } from "../../lib/run-pages";
import { generationStepState, nextActionLabel } from "../../lib/workspace-ui";
import { formatCoverage } from "../../lib/wiki-blocks";

export const dynamic = "force-dynamic";

type Props = {
  searchParams: Promise<{ workspaceId?: string }>;
};

type Run = typeof generationRuns.$inferSelect;

export default async function WorkspacePage({ searchParams }: Props) {
  const workspaceId = (await searchParams).workspaceId?.trim();
  if (!workspaceId) {
    return (
      <main style={pageStyle}>
        <h1 style={titleStyle}>Workspace setup</h1>
        <p style={mutedStyle}>Open this page with an explicit workspaceId, for example `/workspace?workspaceId=demo`.</p>
      </main>
    );
  }

  const data = await loadWorkspaceData(workspaceId);
  if (!data.ok) {
    return (
      <main style={pageStyle}>
        <h1 style={titleStyle}>Workspace {workspaceId}</h1>
        <p style={errorStyle}>{data.error}</p>
      </main>
    );
  }

  return (
    <main style={pageStyle}>
      <header style={headerStyle}>
        <div>
          <p style={eyebrowStyle}>inspect-only workspace</p>
          <h1 style={titleStyle}>{workspaceId}</h1>
        </div>
        <div style={headerMetricsStyle}>
          <Metric label="Installations" value={String(data.installations.length)} />
          <Metric label="Repositories" value={String(data.repositories.length)} />
          <Metric label="Runs" value={String(data.runs.length)} />
        </div>
      </header>

      <div style={topGridStyle}>
        <Section title="GitHub installations" empty={data.installations.length === 0 ? "No GitHub App installations recorded." : null}>
          <div style={compactRowsStyle}>
            {data.installations.map((installation) => (
              <div key={installation.id} style={compactRowStyle}>
                <strong>{installation.githubInstallationId}</strong>
                <span style={mutedStyle}>{installation.status}</span>
                <StatusChip label={installation.active ? "active" : "inactive"} tone={installation.active ? "green" : "neutral"} />
              </div>
            ))}
          </div>
        </Section>

        <Section title="Repositories" empty={data.repositories.length === 0 ? "No frontend/backend repositories registered." : null}>
          <div style={compactRowsStyle}>
            {data.repositories.map((repository) => (
              <div key={repository.id} style={compactRowStyle}>
                <RoleLabel role={repository.role === "FRONTEND" ? "FE" : "BE"} />
                <strong style={truncateStyle}>{repository.repositoryFullName}</strong>
                <span style={mutedStyle}>tags `{repository.tagPattern}`</span>
                <StatusChip label={repository.active ? "active" : "inactive"} tone={repository.active ? "green" : "neutral"} />
              </div>
            ))}
          </div>
        </Section>
      </div>

      <Section title="Generation runs" empty={data.runs.length === 0 ? "No generation runs yet." : null}>
        <div style={runsStyle}>
          {data.runs.map((run) => {
            const frontendRepository = data.repositoriesById.get(run.frontendRepositoryId)?.repositoryFullName ?? run.frontendRepositoryId;
            const backendRepository = data.repositoriesById.get(run.backendRepositoryId)?.repositoryFullName ?? run.backendRepositoryId;
            const materialized = data.materializationCounts.get(run.id) ?? { written: 0, reused: 0 };
            const affected = affectedPageKeys(run.incrementalReportJson).length;
            const reviewTone = run.status === "FAILED" || run.status === "AI_OUTPUT_INVALID" ? "red" : run.status === "NEEDS_REVIEW" ? "amber" : "neutral";

            return (
              <article key={run.id} style={runRowStyle}>
                <div style={runMainStyle}>
                  <div style={runHeadStyle}>
                    <div style={runTitleStyle}>
                      <StatusChip label={run.status} tone={statusTone(run.status)} />
                      <strong style={truncateStyle}>{run.id}</strong>
                    </div>
                    <span style={mutedStyle}>{run.createdAt.toISOString()}</span>
                  </div>

                  <div style={nextActionStyle}>
                    <span style={mutedStyle}>Next action</span>
                    <strong>{nextActionLabel(run.status)}</strong>
                  </div>

                  <Stepper status={run.status} />

                  <div style={repoGridStyle}>
                    <RepoLine role="FE" repository={frontendRepository} tag={run.frontendTag} commit={run.frontendCommitSha} coverage={formatCoverage({ indexed: run.frontendIndexedEligibleFiles, total: run.frontendTotalEligibleFiles })} />
                    <RepoLine role="BE" repository={backendRepository} tag={run.backendTag} commit={run.backendCommitSha} coverage={formatCoverage({ indexed: run.backendIndexedEligibleFiles, total: run.backendTotalEligibleFiles })} />
                  </div>

                  <div style={countGridStyle}>
                    <Metric label="Written" value={String(materialized.written)} />
                    <Metric label="Reused" value={String(materialized.reused)} />
                    <Metric label="Affected" value={String(affected)} />
                    <Metric label="Statements" value={`${run.generatedStatementWithEvidenceCount}/${run.generatedStatementCount}`} />
                    <Metric label="Review" value={reviewTone === "neutral" ? "none" : run.status} tone={reviewTone} />
                  </div>

                  {run.errorMessage ? <p style={errorBandStyle}>{sanitizeErrorText(run.errorMessage)}</p> : null}
                  <WikiLinks pages={data.pagesByRun.get(run.id) ?? []} />
                </div>

                <GenerationDebugger generationRunId={run.id} />
              </article>
            );
          })}
        </div>
      </Section>
    </main>
  );
}

async function loadWorkspaceData(workspaceId: string) {
  try {
    const db = getDb();
    const [installations, repoRows, runs] = await Promise.all([
      db.select().from(githubInstallations).where(eq(githubInstallations.workspaceId, workspaceId)),
      db.select().from(repositories).where(eq(repositories.workspaceId, workspaceId)),
      db.select().from(generationRuns).where(eq(generationRuns.workspaceId, workspaceId)).orderBy(desc(generationRuns.createdAt))
    ]);
    const runIds = runs.map((run) => run.id);
    const [pagesByRun, materializationCounts] = await Promise.all([
      pagesByGenerationRun(runIds),
      materializationCountsByGenerationRun(runIds)
    ]);
    return {
      ok: true as const,
      installations,
      repositories: repoRows,
      repositoriesById: new Map(repoRows.map((repository) => [repository.id, repository])),
      runs,
      pagesByRun,
      materializationCounts
    };
  } catch (error) {
    return { ok: false as const, error: sanitizeErrorText(error) };
  }
}

function Section({ title, empty, children }: { title: string; empty: string | null; children: ReactNode }) {
  return (
    <section style={sectionStyle}>
      <div style={sectionHeaderStyle}>
        <h2 style={sectionTitleStyle}>{title}</h2>
      </div>
      {empty ? <p style={mutedStyle}>{empty}</p> : children}
    </section>
  );
}

function WikiLinks({ pages }: { pages: Array<typeof wikiPages.$inferSelect> }) {
  if (pages.length === 0) {
    return <p style={mutedStyle}>No wiki pages generated.</p>;
  }

  return (
    <div style={wikiLinksStyle}>
      {pages.map((page) => (
        <Link key={page.id} href={`/wiki/${page.id}`} style={wikiLinkStyle}>{page.title}</Link>
      ))}
    </div>
  );
}

function RepoLine({ role, repository, tag, commit, coverage }: { role: "FE" | "BE"; repository: string; tag: string; commit: string; coverage: string }) {
  return (
    <div style={repoLineStyle}>
      <RoleLabel role={role} />
      <strong style={truncateStyle}>{repository}</strong>
      <span style={mutedStyle}>{tag}</span>
      <span style={monoStyle}>{commit.slice(0, 12)}</span>
      <span style={mutedStyle}>{coverage}</span>
    </div>
  );
}

function RoleLabel({ role }: { role: "FE" | "BE" }) {
  return <span style={{ ...roleStyle, background: role === "FE" ? "#dbeafe" : "#dcfce7", color: role === "FE" ? "#1d4ed8" : "#166534" }}>{role}</span>;
}

function StatusChip({ label, tone }: { label: string; tone: "neutral" | "green" | "amber" | "red" }) {
  return <span style={{ ...statusChipStyle, ...statusStyles[tone] }}>{label}</span>;
}

function Metric({ label, value, tone = "neutral" }: { label: string; value: string; tone?: "neutral" | "amber" | "red" }) {
  return (
    <div style={metricStyle}>
      <span style={mutedStyle}>{label}</span>
      <strong style={{ color: tone === "red" ? "#991b1b" : tone === "amber" ? "#92400e" : "#111827" }}>{value}</strong>
    </div>
  );
}

function Stepper({ status }: { status: Run["status"] }) {
  return (
    <div style={stepperStyle}>
      {generationStepState(status).map((step) => (
        <span key={step.label} style={{ ...stepStyle, ...stepStateStyles[step.state] }}>
          {step.label}
        </span>
      ))}
    </div>
  );
}

function statusTone(status: Run["status"]) {
  if (status === "COMPLETED") return "green";
  if (status === "NEEDS_REVIEW") return "amber";
  if (status === "FAILED" || status === "AI_OUTPUT_INVALID") return "red";
  return "neutral";
}

function affectedPageKeys(value: unknown) {
  return isRecord(value) && Array.isArray(value.affectedPageKeys)
    ? value.affectedPageKeys.filter((item): item is string => typeof item === "string")
    : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

const pageStyle: CSSProperties = { background: "#f7f7f5", color: "#111827", display: "grid", fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif", gap: 18, lineHeight: 1.45, margin: "0 auto", maxWidth: 1180, minHeight: "100vh", padding: 18 };
const headerStyle: CSSProperties = { alignItems: "end", borderBottom: "1px solid #d4d4d4", display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(min(280px, 100%), 1fr))", paddingBottom: 14 };
const eyebrowStyle: CSSProperties = { color: "#737373", fontSize: 12, fontWeight: 700, letterSpacing: 0, margin: "0 0 4px", textTransform: "uppercase" };
const titleStyle: CSSProperties = { fontSize: 28, lineHeight: 1.1, margin: 0, overflowWrap: "anywhere" };
const headerMetricsStyle: CSSProperties = { display: "grid", gap: 8, gridTemplateColumns: "repeat(3, minmax(0, 1fr))" };
const topGridStyle: CSSProperties = { display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(min(320px, 100%), 1fr))" };
const sectionStyle: CSSProperties = { background: "#fff", border: "1px solid #d4d4d4", borderRadius: 8, display: "grid", gap: 10, padding: 12 };
const sectionHeaderStyle: CSSProperties = { alignItems: "center", display: "flex", justifyContent: "space-between" };
const sectionTitleStyle: CSSProperties = { fontSize: 15, margin: 0, textTransform: "uppercase" };
const compactRowsStyle: CSSProperties = { display: "grid", gap: 7 };
const compactRowStyle: CSSProperties = { alignItems: "center", borderTop: "1px solid #e5e5e5", display: "flex", flexWrap: "wrap", gap: 8, paddingTop: 7 };
const runsStyle: CSSProperties = { display: "grid", gap: 12 };
const runRowStyle: CSSProperties = { borderTop: "1px solid #d4d4d4", display: "grid", gap: 10, paddingTop: 12 };
const runMainStyle: CSSProperties = { display: "grid", gap: 10, minWidth: 0 };
const runHeadStyle: CSSProperties = { alignItems: "center", display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "space-between" };
const runTitleStyle: CSSProperties = { alignItems: "center", display: "flex", gap: 8, minWidth: 0 };
const nextActionStyle: CSSProperties = { alignItems: "center", background: "#fafafa", border: "1px solid #e5e5e5", borderRadius: 6, display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "space-between", padding: "8px 10px" };
const repoGridStyle: CSSProperties = { display: "grid", gap: 7, gridTemplateColumns: "repeat(auto-fit, minmax(min(360px, 100%), 1fr))" };
const repoLineStyle: CSSProperties = { alignItems: "center", border: "1px solid #e5e5e5", borderRadius: 6, display: "flex", flexWrap: "wrap", gap: 8, minWidth: 0, padding: 8 };
const countGridStyle: CSSProperties = { display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))" };
const metricStyle: CSSProperties = { background: "#fafafa", border: "1px solid #e5e5e5", borderRadius: 6, display: "grid", gap: 2, minWidth: 0, padding: "7px 9px" };
const wikiLinksStyle: CSSProperties = { display: "flex", flexWrap: "wrap", gap: 6 };
const wikiLinkStyle: CSSProperties = { border: "1px solid #d4d4d4", borderRadius: 6, color: "#1d4ed8", fontSize: 12, padding: "3px 7px", textDecoration: "none" };
const roleStyle: CSSProperties = { borderRadius: 6, display: "inline-block", fontSize: 12, fontWeight: 800, padding: "2px 6px" };
const statusChipStyle: CSSProperties = { borderRadius: 6, display: "inline-block", fontSize: 12, fontWeight: 700, padding: "3px 7px", whiteSpace: "nowrap" };
const statusStyles = {
  neutral: { background: "#f5f5f5", color: "#404040" },
  green: { background: "#dcfce7", color: "#166534" },
  amber: { background: "#fef3c7", color: "#92400e" },
  red: { background: "#fee2e2", color: "#991b1b" }
} as const;
const stepperStyle: CSSProperties = { display: "flex", flexWrap: "wrap", gap: 6 };
const stepStyle: CSSProperties = { border: "1px solid #e5e5e5", borderRadius: 6, fontSize: 12, padding: "3px 8px" };
const stepStateStyles = {
  pending: { background: "#fff", color: "#737373" },
  active: { background: "#eff6ff", borderColor: "#60a5fa", color: "#1d4ed8" },
  done: { background: "#f5f5f5", color: "#111827" }
} as const;
const mutedStyle: CSSProperties = { color: "#737373", fontSize: 12, margin: 0, minWidth: 0, overflowWrap: "anywhere" };
const monoStyle: CSSProperties = { color: "#404040", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace", fontSize: 12 };
const truncateStyle: CSSProperties = { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const errorStyle: CSSProperties = { color: "#991b1b", margin: 0 };
const errorBandStyle: CSSProperties = { background: "#fee2e2", border: "1px solid #fecaca", borderRadius: 6, color: "#991b1b", margin: 0, padding: 8, overflowWrap: "anywhere" };
