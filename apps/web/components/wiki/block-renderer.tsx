import type { ProductWikiBlock } from "@code2wiki/document";

import { getEvidenceIds, sourceBadge } from "../../lib/wiki-blocks";

type Props = {
  block: ProductWikiBlock;
  selectedBlockId: string | null;
  onSelectBlock: (block: ProductWikiBlock) => void;
};

export function BlockRenderer({ block, selectedBlockId, onSelectBlock }: Props) {
  const clickable = block.origin === "CODE" && getEvidenceIds(block).length > 0;
  const active = selectedBlockId === block.id;

  return (
    <section
      style={{
        borderLeft: active ? "3px solid #2563eb" : "3px solid transparent",
        paddingLeft: 12
      }}
    >
      <div style={{ alignItems: "center", display: "flex", gap: 8 }}>
        <BlockText block={block} />
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
          {sourceBadge(block)}
        </button>
      </div>
      {block.children?.length ? (
        <div style={{ display: "grid", gap: 12, marginTop: 12, paddingLeft: 16 }}>
          {block.children.map((child) => (
            <BlockRenderer key={child.id} block={child} selectedBlockId={selectedBlockId} onSelectBlock={onSelectBlock} />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function BlockText({ block }: { block: ProductWikiBlock }) {
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
