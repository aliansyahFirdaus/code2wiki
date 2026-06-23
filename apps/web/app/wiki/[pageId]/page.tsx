import { notFound } from "next/navigation";

import { WikiReaderShell } from "../../../components/wiki/wiki-reader-shell";
import { getWikiReaderData } from "../../../lib/wiki-read";

type Props = {
  params: Promise<{ pageId: string }>;
};

export const dynamic = "force-dynamic";

export default async function WikiPage({ params }: Props) {
  const { pageId } = await params;
  const data = await getWikiReaderData(pageId);

  if (!data) {
    notFound();
  }

  return (
    <WikiReaderShell
      currentPageId={pageId}
      pages={data.pages}
      blocks={data.blocks}
      generationRun={data.generationRun}
    />
  );
}
