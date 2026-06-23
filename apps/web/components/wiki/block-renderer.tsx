import type { ProductWikiBlock } from "@code2wiki/document";

import { blockBadges, getEditableText, getEvidenceIds, isEditableBlock } from "../../lib/wiki-blocks";

type Props = {
  block: ProductWikiBlock;
  selectedBlockId: string | null;
  onSelectBlock: (block: ProductWikiBlock) => void;
  editing: boolean;
  localText: Record<string, string>;
  onEditText: (blockId: string, text: string) => void;
};

export function BlockRenderer({ block, selectedBlockId, onSelectBlock, editing, localText, onEditText }: Props) {
  const clickable = (block.origin === "CODE" || block.origin === "CODE_EDITED") && getEvidenceIds(block).length > 0;
  const active = selectedBlockId === block.id;

  return (
    <section
      style={{
        borderLeft: active ? "3px solid #2563eb" : "3px solid transparent",
        paddingLeft: 12
      }}
    >
      <div style={{ alignItems: "flex-start", display: "flex", gap: 8 }}>
        <BlockText block={block} editing={editing} localText={localText} onEditText={onEditText} />
        <button
          type="button"
          disabled={!clickable}
          onClick={() => onSelectBlock(block)}
          style={{
            background: clickable ? "#eff6ff" : "#f3f4f6",
            border: "1px solid #d1d5db",
            borderRadius: 999,
            color: clickable ? "#1d4ed8" : "#6b7280",
            cursor: clickable ? "pointer" : "default",
            fontSize: 12,
            padding: "3px 8px"
          }}
        >
          Sources
        </button>
        {blockBadges(block).map((badge) => (
          <span
            key={badge}
            style={{ background: "#f3f4f6", border: "1px solid #d1d5db", borderRadius: 999, color: "#374151", fontSize: 12, padding: "3px 8px" }}
          >
            {badge}
          </span>
        ))}
      </div>
      {block.children?.length ? (
        <div style={{ display: "grid", gap: 12, marginTop: 12, paddingLeft: 16 }}>
          {block.children.map((child) => (
            <BlockRenderer
              key={child.id}
              block={child}
              selectedBlockId={selectedBlockId}
              onSelectBlock={onSelectBlock}
              editing={editing}
              localText={localText}
              onEditText={onEditText}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function BlockText({
  block,
  editing,
  localText,
  onEditText
}: {
  block: ProductWikiBlock;
  editing: boolean;
  localText: Record<string, string>;
  onEditText: (blockId: string, text: string) => void;
}) {
  if (editing && isEditableBlock(block)) {
    return (
      <textarea
        aria-label={`Edit ${block.type}`}
        value={localText[block.id] ?? getEditableText(block)}
        onChange={(event) => onEditText(block.id, event.target.value)}
        rows={block.type === "open_question" ? 2 : 3}
        style={{ flex: 1, font: "inherit", minWidth: 0, padding: 8 }}
      />
    );
  }

  switch (block.type) {
    case "title":
      return <h1 style={{ fontSize: 28, margin: 0 }}>{block.text}</h1>;
    case "heading":
      return <h2 style={{ fontSize: block.level === 1 ? 24 : 20, margin: 0 }}>{block.text}</h2>;
    case "paragraph":
    case "statement":
      return <p style={{ margin: 0 }}>{block.text}</p>;
    case "callout":
      return <p style={{ margin: 0 }}>{block.text}</p>;
    case "open_question":
      return <p style={{ margin: 0 }}>{block.question}</p>;
    case "related_page":
      return <p style={{ margin: 0 }}>{block.title}</p>;
    case "divider":
      return <hr style={{ flex: 1 }} />;
  }
}
