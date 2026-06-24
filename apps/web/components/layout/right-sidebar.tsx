import type { ProductWikiBlock } from "@code2wiki/document";

import { formatCoverage, getEvidenceIds } from "../../lib/wiki-blocks";
import { groupEvidenceByRoleAndFile } from "../../lib/wiki-ui";
import styles from "../wiki/wiki-reader.module.css";

export type GenerationRunSummary = {
  frontendTag: string;
  frontendCommitSha: string;
  backendTag: string;
  backendCommitSha: string;
  frontendTotalEligibleFiles: number;
  frontendIndexedEligibleFiles: number;
  backendTotalEligibleFiles: number;
  backendIndexedEligibleFiles: number;
  totalEligibleFiles: number;
  indexedEligibleFiles: number;
  generatedStatementCount: number;
  generatedStatementWithEvidenceCount: number;
};

export type EvidenceItem = {
  id: string;
  repositoryRole: "FRONTEND" | "BACKEND";
  repositoryFullName: string;
  tag: string;
  commitSha: string;
  filePath: string;
  startLine: number;
  endLine: number;
  sourceKind: string;
  codeSnippet: string;
  githubUrl: string;
};

type Props = {
  generationRun: GenerationRunSummary | null;
  selectedBlock: ProductWikiBlock | null;
  evidence: EvidenceItem[];
  loadingEvidence: boolean;
  evidenceError: string | null;
};

export function RightSidebar({ generationRun, selectedBlock, evidence, loadingEvidence, evidenceError }: Props) {
  const groups = groupEvidenceByRoleAndFile(evidence);

  return (
    <aside className={styles.rightRail}>
      <h2 className={styles.railTitle}>Generation</h2>
      {generationRun ? (
        <dl className={styles.sourceGroup}>
          <Row label="FE tag" value={`${generationRun.frontendTag} · ${shortSha(generationRun.frontendCommitSha)}`} />
          <Row label="BE tag" value={`${generationRun.backendTag} · ${shortSha(generationRun.backendCommitSha)}`} />
          <Row
            label="FE coverage"
            value={formatCoverage({
              indexed: generationRun.frontendIndexedEligibleFiles,
              total: generationRun.frontendTotalEligibleFiles
            })}
          />
          <Row
            label="BE coverage"
            value={formatCoverage({
              indexed: generationRun.backendIndexedEligibleFiles,
              total: generationRun.backendTotalEligibleFiles
            })}
          />
          <Row
            label="Total coverage"
            value={formatCoverage({ indexed: generationRun.indexedEligibleFiles, total: generationRun.totalEligibleFiles })}
          />
          <Row
            label="Evidence coverage"
            value={formatCoverage({
              indexed: generationRun.generatedStatementWithEvidenceCount,
              total: generationRun.generatedStatementCount
            })}
          />
        </dl>
      ) : (
        <p className={styles.emptyState}>No generation metadata available.</p>
      )}

      <section className={styles.sourceSection}>
        <h2 className={styles.railTitle}>Sources</h2>
        {!selectedBlock ? <p className={styles.emptyState}>Select a sourced statement to inspect evidence.</p> : null}
        {selectedBlock && getEvidenceIds(selectedBlock).length === 0 ? (
          <p className={styles.emptyState}>This block has no evidence IDs. Treat it as needs review.</p>
        ) : null}
        {loadingEvidence ? <p className={styles.emptyState}>Loading sources...</p> : null}
        {evidenceError ? <p className={styles.errorBand}>{evidenceError}</p> : null}
        {!loadingEvidence && selectedBlock && getEvidenceIds(selectedBlock).length > 0 && evidence.length === 0 && !evidenceError ? (
          <p className={styles.emptyState}>No source rows returned for this block.</p>
        ) : null}
        {!loadingEvidence && groups.length > 0 ? (
          <div className={styles.sourceGroup}>
            {groups.map((group) => (
              <section key={group.role} className={styles.sourceGroup}>
                <h3 className={styles.roleHeader}>{group.role}</h3>
                {group.files.map((file) => (
                  <div key={file.filePath} className={styles.fileGroup}>
                    <div className={styles.sourcePath}>{file.filePath}</div>
                    {file.items.map((item) => (
                      <SourceCard key={item.id} item={item} />
                    ))}
                  </div>
                ))}
              </section>
            ))}
          </div>
        ) : null}
      </section>
    </aside>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.metric}>
      <dt className={styles.metricLabel}>{label}</dt>
      <dd className={styles.metricValue}>{value}</dd>
    </div>
  );
}

function SourceCard({ item }: { item: EvidenceItem }) {
  return (
    <article className={styles.sourceCard}>
      <div className={styles.sourceMeta}>
        {item.repositoryFullName} · {item.tag} · {shortSha(item.commitSha)} · {item.sourceKind}
      </div>
      <a href={item.githubUrl} rel="noreferrer" target="_blank" className={styles.sourceLink}>
        Lines {item.startLine}-{item.endLine}
      </a>
      {item.codeSnippet ? <pre className={styles.snippet}>{item.codeSnippet}</pre> : null}
    </article>
  );
}

function shortSha(value: string) {
  return value ? value.slice(0, 12) : "unknown";
}
