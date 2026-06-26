"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import type { ProductWikiBlock } from "@code2wiki/document";

import { collectChangedEdits, flattenBlocks, getEditableText, getEvidenceIds, isEditableBlock } from "../../lib/wiki-blocks";
import { LeftSidebar } from "../layout/left-sidebar";
import { RightSidebar, type EvidenceItem, type GenerationRunSummary } from "../layout/right-sidebar";
import { WikiEditor } from "./wiki-editor";
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
  currentPageId: string;
  workspaceId: string;
  pages: WikiPageItem[];
  blocks: ProductWikiBlock[];
  generationRun: GenerationRunSummary | null;
};

export function WikiReaderShell({ currentPageId, workspaceId, pages, blocks, generationRun }: Props) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [localText, setLocalText] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<EvidenceItem[]>([]);
  const [loadingEvidence, setLoadingEvidence] = useState(false);
  const [evidenceError, setEvidenceError] = useState<string | null>(null);
  const blockById = useMemo(() => new Map(flattenBlocks(blocks).map((block) => [block.id, block])), [blocks]);
  const changedEdits = useMemo(() => collectChangedEdits(blocks, localText), [blocks, localText]);
  const currentPage = pages.find((page) => page.id === currentPageId) ?? null;

  useEffect(() => {
    setLocalText(Object.fromEntries(flattenBlocks(blocks).filter(isEditableBlock).map((block) => [block.id, getEditableText(block)])));
  }, [blocks]);

  async function selectBlock(block: ProductWikiBlock) {
    setSelectedBlockId(block.id);
    setEvidenceError(null);
    if ((block.origin !== "CODE" && block.origin !== "CODE_EDITED") || getEvidenceIds(block).length === 0) {
      setEvidence([]);
      return;
    }

    setLoadingEvidence(true);
    try {
      const response = await fetch(`/api/wiki/blocks/${block.id}/evidence`);
      const payload = (await response.json()) as { evidence?: EvidenceItem[]; error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? "Failed to load sources.");
      }
      setEvidence(payload.evidence ?? []);
    } catch (error) {
      setEvidence([]);
      setEvidenceError(error instanceof Error ? error.message : "Failed to load sources.");
    } finally {
      setLoadingEvidence(false);
    }
  }

  function cancelEditing() {
    setEditing(false);
    setSaveError(null);
    setLocalText(Object.fromEntries(flattenBlocks(blocks).filter(isEditableBlock).map((block) => [block.id, getEditableText(block)])));
  }

  async function saveEditing() {
    if (changedEdits.length === 0) {
      setEditing(false);
      return;
    }

    setSaving(true);
    setSaveError(null);
    try {
      const response = await fetch("/api/wiki/overlays", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          pageId: currentPageId,
          createdBy: "local-dev",
          edits: changedEdits
        })
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? "Failed to save wiki overlays.");
      }

      setEditing(false);
      router.refresh();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Failed to save wiki overlays.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className={styles.shell}>
      <LeftSidebar pages={pages} currentPageId={currentPageId} />
      <WikiEditor
        page={currentPage}
        generationRun={generationRun}
        blocks={blocks}
        workspaceId={workspaceId}
        selectedBlockId={selectedBlockId}
        onSelectBlock={selectBlock}
        editing={editing}
        localText={localText}
        onEditText={(blockId, text) => setLocalText((current) => ({ ...current, [blockId]: text }))}
        onEnableEditing={() => setEditing(true)}
        onCancelEditing={cancelEditing}
        onSaveEditing={saveEditing}
        saving={saving}
        changedCount={changedEdits.length}
        saveError={saveError}
      />
      <RightSidebar
        generationRun={generationRun}
        selectedBlock={selectedBlockId ? blockById.get(selectedBlockId) ?? null : null}
        evidence={evidence}
        loadingEvidence={loadingEvidence}
        evidenceError={evidenceError}
      />
    </main>
  );
}
