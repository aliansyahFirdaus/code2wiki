"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import type { ProductWikiBlock } from "@code2wiki/document";

import { collectChangedEdits, flattenBlocks, getEditableText, getEvidenceIds, isEditableBlock } from "../../lib/wiki-blocks";
import { LeftSidebar } from "../layout/left-sidebar";
import { RightSidebar, type EvidenceItem, type GenerationRunSummary } from "../layout/right-sidebar";
import { WikiEditor } from "./wiki-editor";

type WikiPageItem = {
  id: string;
  title: string;
  slug: string;
  pageKey: string;
  parentPageId: string | null;
};

type Props = {
  currentPageId: string;
  pages: WikiPageItem[];
  blocks: ProductWikiBlock[];
  tiptap: Parameters<typeof WikiEditor>[0]["document"];
  generationRun: GenerationRunSummary | null;
};

export function WikiReaderShell({ currentPageId, pages, blocks, tiptap, generationRun }: Props) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [localText, setLocalText] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<EvidenceItem[]>([]);
  const [loadingEvidence, setLoadingEvidence] = useState(false);
  const blockById = useMemo(() => new Map(flattenBlocks(blocks).map((block) => [block.id, block])), [blocks]);
  const changedEdits = useMemo(() => collectChangedEdits(blocks, localText), [blocks, localText]);

  useEffect(() => {
    setLocalText(Object.fromEntries(flattenBlocks(blocks).filter(isEditableBlock).map((block) => [block.id, getEditableText(block)])));
  }, [blocks]);

  async function selectBlock(block: ProductWikiBlock) {
    setSelectedBlockId(block.id);
    if ((block.origin !== "CODE" && block.origin !== "CODE_EDITED") || getEvidenceIds(block).length === 0) {
      setEvidence([]);
      return;
    }

    setLoadingEvidence(true);
    try {
      const response = await fetch(`/api/wiki/blocks/${block.id}/evidence`);
      const payload = (await response.json()) as { evidence?: EvidenceItem[] };
      setEvidence(payload.evidence ?? []);
    } finally {
      setLoadingEvidence(false);
    }
  }

  function cancelEditing() {
    setEditing(false);
    setLocalText(Object.fromEntries(flattenBlocks(blocks).filter(isEditableBlock).map((block) => [block.id, getEditableText(block)])));
  }

  async function saveEditing() {
    if (changedEdits.length === 0) {
      setEditing(false);
      return;
    }

    setSaving(true);
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
        throw new Error("Failed to save wiki overlays.");
      }

      setEditing(false);
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  return (
    <main style={{ display: "grid", gridTemplateColumns: "260px minmax(0, 1fr) 320px", minHeight: "100vh" }}>
      <LeftSidebar pages={pages} currentPageId={currentPageId} />
      <WikiEditor
        document={tiptap}
        blocks={blocks}
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
      />
      <RightSidebar
        generationRun={generationRun}
        selectedBlock={selectedBlockId ? blockById.get(selectedBlockId) ?? null : null}
        evidence={evidence}
        loadingEvidence={loadingEvidence}
      />
    </main>
  );
}
