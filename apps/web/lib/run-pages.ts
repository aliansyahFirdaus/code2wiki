import { inArray } from "drizzle-orm";

import { getDb, wikiPages, wikiRunPages } from "@code2wiki/db";

export async function pagesByGenerationRun(runIds: string[]) {
  if (runIds.length === 0) {
    return new Map<string, Array<typeof wikiPages.$inferSelect>>();
  }

  const db = getDb();
  const [materializations, legacyPages] = await Promise.all([
    db.select().from(wikiRunPages).where(inArray(wikiRunPages.generationRunId, runIds)),
    db.select().from(wikiPages).where(inArray(wikiPages.generationRunId, runIds))
  ]);
  const pagesById = new Map(
    (materializations.length > 0 ? await db.select().from(wikiPages).where(inArray(wikiPages.id, materializations.map((row) => row.pageId))) : []).map((page) => [page.id, page])
  );
  const byRun = new Map<string, Array<typeof wikiPages.$inferSelect>>();

  for (const row of materializations) {
    const page = pagesById.get(row.pageId);
    if (page) {
      addPage(byRun, row.generationRunId, page);
    }
  }
  for (const page of legacyPages) {
    addPage(byRun, page.generationRunId, page);
  }

  return byRun;
}

function addPage(map: Map<string, Array<typeof wikiPages.$inferSelect>>, runId: string, page: typeof wikiPages.$inferSelect) {
  const existing = map.get(runId) ?? [];
  if (!existing.some((item) => item.pageKey === page.pageKey)) {
    map.set(runId, [...existing, page]);
  }
}
