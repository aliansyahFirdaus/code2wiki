import type { ProductWikiBlock } from "@code2wiki/document";

import { blockBadges, getEditableText, getEvidenceIds, isEditableBlock, sourceBadge } from "../../lib/wiki-blocks";
import styles from "./wiki-reader.module.css";

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
  const evidenceCount = getEvidenceIds(block).length;
  const badges = blockBadges(block).filter((badge) => !badge.endsWith("source") && !badge.endsWith("sources"));

  return (
    <section className={`${styles.block} ${active ? styles.blockActive : ""}`}>
      <div className={styles.blockRow}>
        <BlockText block={block} editing={editing} localText={localText} onEditText={onEditText} />
        <div className={styles.blockChrome}>
          <button
            type="button"
            disabled={!clickable}
            onClick={() => onSelectBlock(block)}
            className={styles.sourceButton}
          >
            {evidenceCount > 0 ? `${evidenceCount} ${evidenceCount === 1 ? "source" : "sources"}` : sourceBadge(block)}
          </button>
          {badges.map((badge) => (
            <span key={badge} className={`${styles.badge} ${badge === "CODE_EDITED" ? styles.editedBadge : ""}`}>
              {badge.replace(/_/g, " ")}
            </span>
          ))}
        </div>
      </div>
      {block.children?.length ? (
        <div className={styles.children}>
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
        className={styles.textarea}
      />
    );
  }

  switch (block.type) {
    case "title":
      return <h2 className={styles.titleBlock}>{block.text}</h2>;
    case "heading":
      return <h3 className={styles.headingBlock}>{block.text}</h3>;
    case "paragraph":
      return <p className={styles.paragraphBlock}>{block.text}</p>;
    case "statement":
      return <p className={styles.statementBlock}>{block.text}</p>;
    case "callout":
      return <p className={styles.calloutBlock}>{block.text}</p>;
    case "open_question":
      return (
        <p className={styles.questionBlock}>
          {block.question}
          <br />
          <span>{block.reason}</span>
        </p>
      );
    case "related_page":
      return <p className={styles.relatedBlock}>{block.title}</p>;
    case "divider":
      return <hr className={styles.dividerBlock} />;
  }
}
