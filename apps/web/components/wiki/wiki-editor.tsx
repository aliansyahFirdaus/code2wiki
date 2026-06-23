"use client";

import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";

import type { ProductWikiBlock } from "@code2wiki/document";

import type { TiptapDocument } from "../../lib/wiki-blocks";
import { BlockRenderer } from "./block-renderer";
import { EnableEditingButton } from "./enable-editing-button";

type Props = {
  document: TiptapDocument;
  blocks: ProductWikiBlock[];
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
};

export function WikiEditor({
  document,
  blocks,
  selectedBlockId,
  onSelectBlock,
  editing,
  localText,
  onEditText,
  onEnableEditing,
  onCancelEditing,
  onSaveEditing,
  saving,
  changedCount
}: Props) {
  const editor = useEditor({
    extensions: [StarterKit],
    content: document,
    editable: false,
    immediatelyRender: false
  });

  return (
    <section style={{ padding: 24 }}>
      <header style={{ alignItems: "center", display: "flex", justifyContent: "space-between", marginBottom: 16 }}>
        <div style={{ color: "#6b7280", fontSize: 13 }}>{editing ? `${changedCount} unsaved edits` : "Read-only"}</div>
        {editing ? (
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" onClick={onCancelEditing} disabled={saving}>
              Cancel
            </button>
            <button type="button" onClick={onSaveEditing} disabled={saving}>
              {saving ? "Saving..." : "Save"}
            </button>
          </div>
        ) : (
          <EnableEditingButton onClick={onEnableEditing} />
        )}
      </header>
      <EditorContent editor={editor} />
      <div style={{ display: "grid", gap: 12, marginTop: 24 }}>
        {blocks.map((block) => (
          <BlockRenderer
            key={block.id}
            block={block}
            selectedBlockId={selectedBlockId}
            onSelectBlock={onSelectBlock}
            editing={editing}
            localText={localText}
            onEditText={onEditText}
          />
        ))}
      </div>
    </section>
  );
}
