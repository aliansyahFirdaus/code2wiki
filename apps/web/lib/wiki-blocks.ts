import type { ProductWikiBlock } from "@code2wiki/document";

export type EditableBlockType = "statement" | "paragraph" | "callout" | "open_question";

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
  indexed: number | null | undefined;
  total: number | null | undefined;
};

export type WikiOverlayRow = {
  id: string;
  targetStableKey: string;
  overlayType: "EDIT" | "HIDE" | "ADD_AFTER" | "ADD_CHILD";
  overlayJson: unknown;
  createdAt: Date;
};

export type EditDraft = {
  targetBlockId: string;
  targetStableKey: string;
  text: string;
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

export function applyEditOverlays(blocks: ProductWikiBlock[], overlays: WikiOverlayRow[]): ProductWikiBlock[] {
  const latest = latestEditOverlays(overlays);
  return blocks.map((block) => applyOverlayToBlock(block, latest));
}

export function blocksToTiptap(blocks: ProductWikiBlock[]): TiptapDocument {
  return {
    type: "doc",
    content: blocks.flatMap(blockToTiptap)
  };
}

export function blockBadges(block: ProductWikiBlock): string[] {
  const badges: string[] = [block.origin];

  if (block.reviewState === "NEEDS_REVIEW" || block.reviewState === "OPEN_QUESTION") {
    badges.push("NEEDS_REVIEW");
  }
  if (getEvidenceIds(block).length > 0) {
    badges.push(`${getEvidenceIds(block).length} ${getEvidenceIds(block).length === 1 ? "source" : "sources"}`);
  }

  return badges;
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

export function isEditableBlock(block: ProductWikiBlock): block is ProductWikiBlock & { type: EditableBlockType } {
  return block.type === "statement" || block.type === "paragraph" || block.type === "callout" || block.type === "open_question";
}

export function getEditableText(block: ProductWikiBlock): string {
  if (block.type === "open_question") {
    return block.question;
  }
  if (block.type === "statement" || block.type === "paragraph" || block.type === "callout") {
    return block.text;
  }
  return "";
}

export function withEditedText(block: ProductWikiBlock, textValue: string): ProductWikiBlock {
  if (block.type === "open_question") {
    return { ...block, question: textValue };
  }
  if (block.type === "statement" || block.type === "paragraph" || block.type === "callout") {
    return { ...block, text: textValue };
  }
  return block;
}

export function collectChangedEdits(blocks: ProductWikiBlock[], localText: Record<string, string>): EditDraft[] {
  return flattenBlocks(blocks)
    .filter(isEditableBlock)
    .flatMap((block) => {
      const textValue = localText[block.id];
      if (textValue === undefined || textValue === getEditableText(block)) {
        return [];
      }
      return [{ targetBlockId: block.id, targetStableKey: block.stableKey, text: textValue }];
    });
}

export function formatCoverage(input: CoverageInput): string {
  if (input.indexed == null || input.total == null) {
    return "N/A - no data";
  }
  if (input.total === 0) {
    return "N/A - no eligible files";
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

export function flattenBlocks(blocks: ProductWikiBlock[]): ProductWikiBlock[] {
  return blocks.flatMap((block) => [block, ...flattenBlocks(block.children ?? [])]);
}

function latestEditOverlays(overlays: WikiOverlayRow[]) {
  const latest = new Map<string, WikiOverlayRow>();
  for (const overlay of overlays.filter((item) => item.overlayType === "EDIT")) {
    const current = latest.get(overlay.targetStableKey);
    if (!current || compareOverlay(overlay, current) > 0) {
      latest.set(overlay.targetStableKey, overlay);
    }
  }
  return latest;
}

function compareOverlay(left: WikiOverlayRow, right: WikiOverlayRow) {
  const byDate = left.createdAt.getTime() - right.createdAt.getTime();
  return byDate === 0 ? left.id.localeCompare(right.id) : byDate;
}

function applyOverlayToBlock(block: ProductWikiBlock, latest: Map<string, WikiOverlayRow>): ProductWikiBlock {
  const children = block.children?.map((child) => applyOverlayToBlock(child, latest));
  const base = children ? { ...block, children } : { ...block };
  const overlay = latest.get(block.stableKey);
  const textValue = readOverlayText(overlay);

  if (!overlay || textValue === null || !isEditableBlock(base)) {
    return base;
  }

  return {
    ...withEditedText(base, textValue),
    origin: base.origin === "CODE" ? "CODE_EDITED" : base.origin,
    evidenceIds: getEvidenceIds(base),
    locked: false
  } as ProductWikiBlock;
}

function readOverlayText(overlay: WikiOverlayRow | undefined): string | null {
  if (!overlay || typeof overlay.overlayJson !== "object" || !overlay.overlayJson) {
    return null;
  }

  const block = "block" in overlay.overlayJson ? overlay.overlayJson.block : undefined;
  if (!block || typeof block !== "object") {
    return null;
  }

  if ("question" in block && typeof block.question === "string") {
    return block.question;
  }
  if ("text" in block && typeof block.text === "string") {
    return block.text;
  }
  return null;
}
