import Link from "next/link";
import type { ReactNode } from "react";
import { desc, eq, inArray } from "drizzle-orm";

import { generationRuns, getDb, githubInstallations, repositories, wikiPages } from "@code2wiki/db";
import { sanitizeErrorText } from "@code2wiki/shared";
import { formatCoverage } from "../../lib/wiki-blocks";

export const dynamic = "force-dynamic";

type Props = {
  searchParams: Promise<{ workspaceId?: string }>;
};

export default async function WorkspacePage({ searchParams }: Props) {
  const workspaceId = (await searchParams).workspaceId?.trim();
  if (!workspaceId) {
    return (
      <main style={pageStyle}>
        <h1>Workspace setup</h1>
        <p style={mutedStyle}>Open this page with an explicit workspaceId, for example `/workspace?workspaceId=demo`.</p>
      </main>
    );
  }

  const data = await loadWorkspaceData(workspaceId);
  if (!data.ok) {
    return (
      <main style={pageStyle}>
        <h1>Workspace {workspaceId}</h1>
        <p style={errorStyle}>{data.error}</p>
      </main>
    );
  }

  return (
    <main style={pageStyle}>
      <header>
        <h1 style={{ marginBottom: 4 }}>Workspace {workspaceId}</h1>
        <p style={mutedStyle}>Inspect-only demo dashboard. Jobs run from `pnpm worker:run`.</p>
      </header>

      <Section title="GitHub installations" empty={data.installations.length === 0 ? "No GitHub App installations recorded." : null}>
        {data.installations.map((installation) => (
          <article key={installation.id} style={cardStyle}>
            <strong>{installation.githubInstallationId}</strong>
            <p style={mutedStyle}>
              {installation.status} · {installation.active ? "active" : "inactive"}
            </p>
          </article>
        ))}
      </Section>

      <Section title="Repositories" empty={data.repositories.length === 0 ? "No frontend/backend repositories registered." : null}>
        {data.repositories.map((repository) => (
          <article key={repository.id} style={cardStyle}>
            <strong>
              {repository.role}: {repository.repositoryFullName}
            </strong>
            <p style={mutedStyle}>
              tags `{repository.tagPattern}` · {repository.active ? "active" : "inactive"}
            </p>
          </article>
        ))}
      </Section>

      <Section title="Generation runs" empty={data.runs.length === 0 ? "No generation runs yet." : null}>
        {data.runs.map((run) => {
          const frontendRepository = data.repositoriesById.get(run.frontendRepositoryId)?.repositoryFullName ?? run.frontendRepositoryId;
          const backendRepository = data.repositoriesById.get(run.backendRepositoryId)?.repositoryFullName ?? run.backendRepositoryId;

          return (
            <article key={run.id} style={cardStyle}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 16 }}>
                <strong>{run.status}</strong>
                <span style={mutedStyle}>{run.createdAt.toISOString()}</span>
              </div>
              <p style={mutedStyle}>
                FE {frontendRepository} · {run.frontendTag} ({run.frontendCommitSha.slice(0, 12)}) ·{" "}
                {formatCoverage({ indexed: run.frontendIndexedEligibleFiles, total: run.frontendTotalEligibleFiles })}
              </p>
              <p style={mutedStyle}>
                BE {backendRepository} · {run.backendTag} ({run.backendCommitSha.slice(0, 12)}) ·{" "}
                {formatCoverage({ indexed: run.backendIndexedEligibleFiles, total: run.backendTotalEligibleFiles })}
              </p>
              {run.errorMessage ? <p style={errorStyle}>{sanitizeErrorText(run.errorMessage)}</p> : null}
              <WikiLinks pages={data.pagesByRun.get(run.id) ?? []} />
            </article>
          );
        })}
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
    const pages =
      runs.length > 0
        ? await db.select().from(wikiPages).where(inArray(wikiPages.generationRunId, runs.map((run) => run.id)))
        : [];
    const pagesByRun = new Map<string, Array<typeof wikiPages.$inferSelect>>();
    for (const page of pages) {
      pagesByRun.set(page.generationRunId, [...(pagesByRun.get(page.generationRunId) ?? []), page]);
    }
    return {
      ok: true as const,
      installations,
      repositories: repoRows,
      repositoriesById: new Map(repoRows.map((repository) => [repository.id, repository])),
      runs,
      pagesByRun
    };
  } catch (error) {
    return { ok: false as const, error: sanitizeErrorText(error) };
  }
}

function Section({ title, empty, children }: { title: string; empty: string | null; children: ReactNode }) {
  return (
    <section style={{ display: "grid", gap: 12 }}>
      <h2 style={{ fontSize: 18, margin: 0 }}>{title}</h2>
      {empty ? <p style={mutedStyle}>{empty}</p> : <div style={{ display: "grid", gap: 12 }}>{children}</div>}
    </section>
  );
}

function WikiLinks({ pages }: { pages: Array<typeof wikiPages.$inferSelect> }) {
  if (pages.length === 0) {
    return <p style={mutedStyle}>No wiki pages generated.</p>;
  }

  return (
    <ul style={{ margin: "8px 0 0", paddingLeft: 18 }}>
      {pages.map((page) => (
        <li key={page.id}>
          <Link href={`/wiki/${page.id}`}>{page.title}</Link>
        </li>
      ))}
    </ul>
  );
}

const pageStyle = { display: "grid", gap: 24, margin: "0 auto", maxWidth: 960, padding: 24 };
const cardStyle = { border: "1px solid #e5e7eb", borderRadius: 8, padding: 16 };
const mutedStyle = { color: "#6b7280", margin: 0 };
const errorStyle = { color: "#b91c1c", margin: 0 };
