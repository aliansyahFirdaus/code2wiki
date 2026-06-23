"use client";

import { useMemo, useState } from "react";

import type { ProductWikiBlock } from "@code2wiki/document";

import { getEvidenceIds } from "../../lib/wiki-blocks";
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
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<EvidenceItem[]>([]);
  const [loadingEvidence, setLoadingEvidence] = useState(false);
  const blockById = useMemo(() => new Map(flattenBlocks(blocks).map((block) => [block.id, block])), [blocks]);

  async function selectBlock(block: ProductWikiBlock) {
    setSelectedBlockId(block.id);
    if (block.origin !== "CODE" || getEvidenceIds(block).length === 0) {
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

  return (
    <main style={{ display: "grid", gridTemplateColumns: "260px minmax(0, 1fr) 320px", minHeight: "100vh" }}>
      <LeftSidebar pages={pages} currentPageId={currentPageId} />
      <WikiEditor document={tiptap} blocks={blocks} selectedBlockId={selectedBlockId} onSelectBlock={selectBlock} />
      <RightSidebar
        generationRun={generationRun}
        selectedBlock={selectedBlockId ? blockById.get(selectedBlockId) ?? null : null}
        evidence={evidence}
        loadingEvidence={loadingEvidence}
      />
    </main>
  );
}

function flattenBlocks(blocks: ProductWikiBlock[]): ProductWikiBlock[] {
  return blocks.flatMap((block) => [block, ...flattenBlocks(block.children ?? [])]);
}
