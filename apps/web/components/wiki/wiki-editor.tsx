"use client";

import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";

import type { ProductWikiBlock } from "@code2wiki/document";

import type { TiptapDocument } from "../../lib/wiki-blocks";
import { BlockRenderer } from "./block-renderer";

type Props = {
  document: TiptapDocument;
  blocks: ProductWikiBlock[];
  selectedBlockId: string | null;
  onSelectBlock: (block: ProductWikiBlock) => void;
};

export function WikiEditor({ document, blocks, selectedBlockId, onSelectBlock }: Props) {
  const editor = useEditor({
    extensions: [StarterKit],
    content: document,
    editable: false,
    immediatelyRender: false
  });

  return (
    <section style={{ padding: 24 }}>
      <EditorContent editor={editor} />
      <div style={{ display: "grid", gap: 12, marginTop: 24 }}>
        {blocks.map((block) => (
          <BlockRenderer key={block.id} block={block} selectedBlockId={selectedBlockId} onSelectBlock={onSelectBlock} />
        ))}
      </div>
    </section>
  );
}
