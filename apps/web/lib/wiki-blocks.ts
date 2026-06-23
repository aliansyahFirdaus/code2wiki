import type { ProductWikiBlock } from "@code2wiki/document";

export type WikiBlockRow = {
  id: string;
  parentBlockId: string | null;
  position: number;
  stableKey: string;
  type: string;
  origin: ProductWikiBlock["origin"];
  reviewState: ProductWikiBlock["reviewState"];
  sourceHash: string;
  contentHash: string;
  evidenceIds: string[];
  locked: boolean;
  blockJson: unknown;
};

export type TiptapNode = {
  type: string;
  attrs?: Record<string, unknown>;
  content?: TiptapNode[];
  text?: string;
};

export type TiptapDocument = {
  type: "doc";
  content: TiptapNode[];
};

export type CoverageInput = {
  indexed: number;
  total: number;
};

export function buildBlockTree(rows: WikiBlockRow[]): ProductWikiBlock[] {
  const blocks = new Map<string, ProductWikiBlock>();
  const children = new Map<string | null, WikiBlockRow[]>();

  for (const row of rows) {
    children.set(row.parentBlockId, [...(children.get(row.parentBlockId) ?? []), row]);
    blocks.set(row.id, normalizeBlock(row));
  }

  for (const list of children.values()) {
    list.sort((a, b) => a.position - b.position);
  }

  for (const [parentId, list] of children) {
    if (!parentId) {
      continue;
    }

    const parent = blocks.get(parentId);
    if (parent) {
      parent.children = list.map((row) => blocks.get(row.id)).filter(isBlock);
    }
  }

  return (children.get(null) ?? []).map((row) => blocks.get(row.id)).filter(isBlock);
}

export function blocksToTiptap(blocks: ProductWikiBlock[]): TiptapDocument {
  return {
    type: "doc",
    content: blocks.flatMap(blockToTiptap)
  };
}

export function sourceBadge(block: ProductWikiBlock): string {
  const evidenceIds = getEvidenceIds(block);

  if (block.origin === "MANUAL") {
    return "Manual";
  }
  if (block.origin === "CODE_EDITED") {
    return "Code + manual edit";
  }
  if (block.type === "statement" && evidenceIds.length === 0) {
    return "Needs review";
  }
  if (evidenceIds.length > 0) {
    return `Code · ${evidenceIds.length} ${evidenceIds.length === 1 ? "source" : "sources"}`;
  }
  return "Code";
}

export function formatCoverage(input: CoverageInput): string {
  if (input.total === 0) {
    return "N/A";
  }

  return `${input.indexed}/${input.total} (${Math.round((input.indexed / input.total) * 100)}%)`;
}

function normalizeBlock(row: WikiBlockRow): ProductWikiBlock {
  const raw = typeof row.blockJson === "object" && row.blockJson ? row.blockJson : {};
  return {
    ...raw,
    id: row.id,
    stableKey: row.stableKey,
    type: row.type,
    origin: row.origin,
    reviewState: row.reviewState,
    sourceHash: row.sourceHash,
    contentHash: row.contentHash,
    evidenceIds: row.evidenceIds,
    locked: row.locked
  } as ProductWikiBlock;
}

function blockToTiptap(block: ProductWikiBlock): TiptapNode[] {
  const attrs = { blockId: block.id, evidenceIds: getEvidenceIds(block) };
  const nested = block.children?.flatMap(blockToTiptap) ?? [];

  switch (block.type) {
    case "title":
      return [{ type: "heading", attrs: { ...attrs, level: 1 }, content: text(block.text) }, ...nested];
    case "heading":
      return [{ type: "heading", attrs: { ...attrs, level: block.level }, content: text(block.text) }, ...nested];
    case "paragraph":
      return [{ type: "paragraph", attrs, content: text(block.text) }, ...nested];
    case "statement":
      return [{ type: "paragraph", attrs, content: text(block.text) }, ...nested];
    case "callout":
      return [{ type: "blockquote", attrs, content: [{ type: "paragraph", content: text(block.text) }] }, ...nested];
    case "open_question":
      return [
        { type: "blockquote", attrs, content: [{ type: "paragraph", content: text(`${block.question} ${block.reason}`) }] },
        ...nested
      ];
    case "related_page":
      return [{ type: "paragraph", attrs, content: text(block.title) }, ...nested];
    case "divider":
      return [{ type: "horizontalRule", attrs }, ...nested];
  }
}

function text(value: string): TiptapNode[] {
  return value ? [{ type: "text", text: value }] : [];
}

function isBlock(value: ProductWikiBlock | undefined): value is ProductWikiBlock {
  return Boolean(value);
}

export function getEvidenceIds(block: ProductWikiBlock): string[] {
  return block.evidenceIds ?? [];
}
