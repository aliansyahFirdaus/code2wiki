import type { ProductWikiBlock } from "@code2wiki/document";

import { formatCoverage, getEvidenceIds } from "../../lib/wiki-blocks";

export type GenerationRunSummary = {
  frontendTag: string;
  backendTag: string;
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
  codeSnippet: string;
  githubUrl: string;
};

type Props = {
  generationRun: GenerationRunSummary | null;
  selectedBlock: ProductWikiBlock | null;
  evidence: EvidenceItem[];
  loadingEvidence: boolean;
};

export function RightSidebar({ generationRun, selectedBlock, evidence, loadingEvidence }: Props) {
  return (
    <aside style={{ borderLeft: "1px solid #e5e7eb", padding: 16 }}>
      <h2 style={{ fontSize: 14, margin: "0 0 12px" }}>Generation</h2>
      {generationRun ? (
        <dl style={{ display: "grid", gap: 8, margin: 0 }}>
          <Row label="FE tag" value={generationRun.frontendTag} />
          <Row label="BE tag" value={generationRun.backendTag} />
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
        <p style={{ color: "#6b7280", margin: 0 }}>No generation metadata.</p>
      )}

      <h2 style={{ fontSize: 14, margin: "24px 0 12px" }}>Sources</h2>
      {!selectedBlock ? <p style={{ color: "#6b7280", margin: 0 }}>Select a sourced block.</p> : null}
      {selectedBlock && getEvidenceIds(selectedBlock).length === 0 ? (
        <p style={{ color: "#6b7280", margin: 0 }}>No sources for this block.</p>
      ) : null}
      {loadingEvidence ? <p style={{ color: "#6b7280", margin: 0 }}>Loading sources...</p> : null}
      {!loadingEvidence && evidence.length > 0 ? (
        <div style={{ display: "grid", gap: 12 }}>
          {evidence.map((item) => (
            <article key={item.id} style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: 12 }}>
              <div style={{ color: "#111827", fontSize: 13, fontWeight: 700 }}>
                {item.repositoryRole} · {item.repositoryFullName}
              </div>
              <div style={{ color: "#6b7280", fontSize: 12, marginTop: 4 }}>
                {item.tag} · {item.commitSha.slice(0, 12)}
              </div>
              <a href={item.githubUrl} rel="noreferrer" target="_blank" style={{ display: "block", fontSize: 12, marginTop: 8 }}>
                {item.filePath}:{item.startLine}-{item.endLine}
              </a>
              <pre style={{ background: "#f9fafb", fontSize: 12, margin: "8px 0 0", overflowX: "auto", padding: 8 }}>
                {item.codeSnippet}
              </pre>
            </article>
          ))}
        </div>
      ) : null}
    </aside>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt style={{ color: "#6b7280", fontSize: 12 }}>{label}</dt>
      <dd style={{ color: "#111827", fontSize: 13, margin: 0 }}>{value}</dd>
    </div>
  );
}
