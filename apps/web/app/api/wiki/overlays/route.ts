import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { getDb, wikiBlockOverlays, wikiBlocks, wikiPages } from "@code2wiki/db";
import { createId } from "@code2wiki/shared";

import {
  applyEditOverlays,
  buildBlockTree,
  flattenBlocks,
  getEditableText,
  getEvidenceIds,
  isEditableBlock,
  withEditedText
} from "../../../../lib/wiki-blocks";

type OverlayRequest = {
  pageId?: unknown;
  createdBy?: unknown;
  reason?: unknown;
  edits?: unknown;
};

type OverlayEdit = {
  targetBlockId: string;
  targetStableKey: string;
  text: string;
};

export async function POST(request: Request) {
  const body = (await request.json()) as OverlayRequest;
  const parsed = parseRequest(body);

  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const db = getDb();
  const [page] = await db.select().from(wikiPages).where(eq(wikiPages.id, parsed.value.pageId)).limit(1);

  if (!page) {
    return NextResponse.json({ error: "Wiki page not found." }, { status: 404 });
  }

  const [blockRows, overlayRows] = await Promise.all([
    db.select().from(wikiBlocks).where(eq(wikiBlocks.pageId, page.id)),
    db.select().from(wikiBlockOverlays).where(eq(wikiBlockOverlays.workspaceId, page.workspaceId))
  ]);
  const blockIds = new Set(blockRows.map((row) => row.id));
  const stableKeys = new Set(blockRows.map((row) => row.stableKey));
  const pageOverlays = overlayRows.filter(
    (overlay) => overlay.targetBlockId && blockIds.has(overlay.targetBlockId) && stableKeys.has(overlay.targetStableKey)
  );
  const baseBlocks = buildBlockTree(blockRows);
  const displayBlocks = applyEditOverlays(baseBlocks, pageOverlays);
  const baseById = new Map(flattenBlocks(baseBlocks).map((block) => [block.id, block]));
  const displayById = new Map(flattenBlocks(displayBlocks).map((block) => [block.id, block]));
  const seen = new Set<string>();
  const rows: Array<typeof wikiBlockOverlays.$inferInsert> = [];

  for (const edit of parsed.value.edits) {
    if (seen.has(edit.targetBlockId)) {
      return NextResponse.json({ error: `Duplicate edit for block ${edit.targetBlockId}.` }, { status: 400 });
    }
    seen.add(edit.targetBlockId);

    const baseBlock = baseById.get(edit.targetBlockId);
    if (!baseBlock) {
      return NextResponse.json({ error: `Block ${edit.targetBlockId} does not belong to page ${page.id}.` }, { status: 400 });
    }
    if (baseBlock.stableKey !== edit.targetStableKey) {
      return NextResponse.json({ error: `Stable key mismatch for block ${edit.targetBlockId}.` }, { status: 400 });
    }
    if (!isEditableBlock(baseBlock)) {
      return NextResponse.json({ error: `Block ${edit.targetBlockId} is not editable in Phase 8.` }, { status: 400 });
    }

    const currentBlock = displayById.get(edit.targetBlockId) ?? baseBlock;
    if (getEditableText(currentBlock) === edit.text) {
      continue;
    }

    const overlayBlock = {
      ...withEditedText(baseBlock, edit.text),
      origin: baseBlock.origin === "CODE" ? "CODE_EDITED" : baseBlock.origin,
      evidenceIds: getEvidenceIds(baseBlock),
      locked: false
    };

    rows.push({
      id: createId(),
      workspaceId: page.workspaceId,
      targetBlockId: baseBlock.id,
      targetStableKey: baseBlock.stableKey,
      overlayType: "EDIT" as const,
      overlayJson: { version: 1, block: overlayBlock },
      createdBy: parsed.value.createdBy,
      reason: parsed.value.reason
    });
  }

  if (rows.length > 0) {
    await db.transaction(async (tx) => {
      await tx.insert(wikiBlockOverlays).values(rows);
    });
  }

  return NextResponse.json({ saved: rows.length });
}

function parseRequest(body: OverlayRequest):
  | { ok: true; value: { pageId: string; createdBy: string; reason?: string; edits: OverlayEdit[] } }
  | { ok: false; error: string } {
  if (typeof body.pageId !== "string" || body.pageId.length === 0) {
    return { ok: false, error: "pageId is required." };
  }
  if (typeof body.createdBy !== "string" || body.createdBy.length === 0) {
    return { ok: false, error: "createdBy is required." };
  }
  if (body.reason !== undefined && typeof body.reason !== "string") {
    return { ok: false, error: "reason must be a string." };
  }
  if (!Array.isArray(body.edits)) {
    return { ok: false, error: "edits must be an array." };
  }

  const edits: OverlayEdit[] = [];
  for (const edit of body.edits) {
    if (!edit || typeof edit !== "object") {
      return { ok: false, error: "Each edit must be an object." };
    }
    if (!("targetBlockId" in edit) || typeof edit.targetBlockId !== "string" || edit.targetBlockId.length === 0) {
      return { ok: false, error: "Each edit needs targetBlockId." };
    }
    if (!("targetStableKey" in edit) || typeof edit.targetStableKey !== "string" || edit.targetStableKey.length === 0) {
      return { ok: false, error: "Each edit needs targetStableKey." };
    }
    if (!("text" in edit) || typeof edit.text !== "string" || edit.text.trim().length === 0) {
      return { ok: false, error: "Each edit needs non-empty text." };
    }
    edits.push({ targetBlockId: edit.targetBlockId, targetStableKey: edit.targetStableKey, text: edit.text });
  }

  return {
    ok: true,
    value: { pageId: body.pageId, createdBy: body.createdBy, reason: body.reason, edits }
  };
}
