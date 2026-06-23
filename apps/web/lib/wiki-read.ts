import { and, eq, inArray } from "drizzle-orm";

import { evidence, generationRuns, getDb, wikiBlocks, wikiPages } from "@code2wiki/db";

import { blocksToTiptap, buildBlockTree } from "./wiki-blocks";

export type WikiReaderData = Awaited<ReturnType<typeof getWikiReaderData>>;

export async function getWikiReaderData(pageId: string) {
  const db = getDb();
  const [page] = await db.select().from(wikiPages).where(eq(wikiPages.id, pageId)).limit(1);

  if (!page) {
    return null;
  }

  const [run, pages, blockRows] = await Promise.all([
    db.select().from(generationRuns).where(eq(generationRuns.id, page.generationRunId)).limit(1),
    db.select().from(wikiPages).where(eq(wikiPages.workspaceId, page.workspaceId)),
    db.select().from(wikiBlocks).where(eq(wikiBlocks.pageId, page.id))
  ]);

  const blocks = buildBlockTree(blockRows);

  return {
    page,
    generationRun: run[0] ?? null,
    pages,
    blocks,
    tiptap: blocksToTiptap(blocks)
  };
}

export async function getBlockEvidence(blockId: string) {
  const db = getDb();
  const [block] = await db.select().from(wikiBlocks).where(eq(wikiBlocks.id, blockId)).limit(1);

  if (!block) {
    return null;
  }
  if (block.evidenceIds.length === 0) {
    return [];
  }

  return db
    .select()
    .from(evidence)
    .where(and(eq(evidence.generationRunId, block.generationRunId), inArray(evidence.id, block.evidenceIds)));
}
