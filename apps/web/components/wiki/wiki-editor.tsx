"use client";

import type { ProductWikiBlock } from "@code2wiki/document";

import { formatCoverage } from "../../lib/wiki-blocks";
import { pageStatusLabel } from "../../lib/wiki-ui";
import type { GenerationRunSummary } from "../layout/right-sidebar";
import { BlockRenderer } from "./block-renderer";
import { EnableEditingButton } from "./enable-editing-button";
import styles from "./wiki-reader.module.css";

type WikiPageItem = {
  id: string;
  title: string;
  slug: string;
  pageKey: string;
  parentPageId: string | null;
  generationStrategy?: string | null;
  reusedFromGenerationRunId?: string | null;
};

type Props = {
  page: WikiPageItem | null;
  generationRun: GenerationRunSummary | null;
  blocks: ProductWikiBlock[];
  workspaceId: string;
  selectedBlockId: string | null;
  onSelectBlock: (block: ProductWikiBlock) => void;
  editing: boolean;
  localText: Record<string, string>;
  onEditText: (blockId: string, text: string) => void;
  onEnableEditing: () => void;
  onCancelEditing: () => void;
  onSaveEditing: () => void;
  saving: boolean;
  changedCount: number;
  saveError: string | null;
};

export function WikiEditor({
  page,
  generationRun,
  blocks,
  workspaceId,
  selectedBlockId,
  onSelectBlock,
  editing,
  localText,
  onEditText,
  onEnableEditing,
  onCancelEditing,
  onSaveEditing,
  saving,
  changedCount,
  saveError
}: Props) {
  return (
    <section className={styles.document}>
      <div className={styles.documentInner}>
        <header className={styles.docHeader}>
          <div>
            <h1 className={styles.docTitle}>{page?.title ?? "Untitled wiki page"}</h1>
            <div className={styles.pageMeta}>
              <span>{page?.pageKey ?? "missing-page-key"}</span>
              <span>{page?.slug ?? "missing-slug"}</span>
              {page ? <span className={styles.pageStatus}>{pageStatusLabel(page)}</span> : null}
            </div>
          </div>
          <div className={styles.docMetaGrid}>
            <Metric label="FE tag" value={generationRun?.frontendTag ?? "N/A"} />
            <Metric label="BE tag" value={generationRun?.backendTag ?? "N/A"} />
            <Metric
              label="FE coverage"
              value={formatCoverage({
                indexed: generationRun?.frontendIndexedEligibleFiles,
                total: generationRun?.frontendTotalEligibleFiles
              })}
            />
            <Metric
              label="Evidence coverage"
              value={formatCoverage({
                indexed: generationRun?.generatedStatementWithEvidenceCount,
                total: generationRun?.generatedStatementCount
              })}
            />
          </div>
        </header>
        <div className={styles.toolbar}>
          <div className={styles.toolbarStatus}>
            {editing ? `${changedCount} unsaved ${changedCount === 1 ? "edit" : "edits"}` : "Read-only"}
          </div>
          {editing ? (
            <div className={styles.toolbarActions}>
              <a className={`${styles.button} ${styles.buttonSecondary}`} href={`/workspace?workspaceId=${encodeURIComponent(workspaceId)}`}>
                Workspace
              </a>
              <button type="button" onClick={onCancelEditing} disabled={saving} className={`${styles.button} ${styles.buttonSecondary}`}>
                Cancel
              </button>
              <button type="button" onClick={onSaveEditing} disabled={saving} className={styles.button}>
                {saving ? "Saving..." : "Save"}
              </button>
            </div>
          ) : (
            <div className={styles.toolbarActions}>
              <a className={`${styles.button} ${styles.buttonSecondary}`} href={`/workspace?workspaceId=${encodeURIComponent(workspaceId)}`}>
                Workspace
              </a>
              <EnableEditingButton onClick={onEnableEditing} />
            </div>
          )}
        </div>
        {saveError ? <p className={styles.errorBand}>{saveError}</p> : null}
        <div className={styles.blocks}>
          {blocks.length === 0 ? (
            <p className={styles.emptyState}>No blocks generated for this page yet.</p>
          ) : (
            blocks.map((block) => (
              <BlockRenderer
                key={block.id}
                block={block}
                selectedBlockId={selectedBlockId}
                onSelectBlock={onSelectBlock}
                editing={editing}
                localText={localText}
                onEditText={onEditText}
              />
            ))
          )}
        </div>
      </div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.metric}>
      <span className={styles.metricLabel}>{label}</span>
      <span className={styles.metricValue}>{value}</span>
    </div>
  );
}
