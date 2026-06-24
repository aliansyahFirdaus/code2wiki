import Link from "next/link";

import { pageStatusLabel } from "../../lib/wiki-ui";
import styles from "../wiki/wiki-reader.module.css";

type WikiPageItem = {
  id: string;
  title: string;
  slug: string;
  pageKey: string;
  parentPageId: string | null;
  generationStrategy?: string | null;
  reusedFromGenerationRunId?: string | null;
};

type Props = {
  pages: WikiPageItem[];
  currentPageId: string;
};

export function LeftSidebar({ pages, currentPageId }: Props) {
  const roots = pages.filter((page) => !page.parentPageId).sort(comparePages);

  return (
    <aside className={styles.leftRail}>
      <h2 className={styles.railTitle}>Wiki pages</h2>
      <nav aria-label="Wiki pages">
        {roots.length === 0 ? (
          <p className={styles.emptyState}>No wiki pages generated yet.</p>
        ) : (
          <ul className={styles.pageList}>
            {roots.map((page) => (
              <PageNode key={page.id} page={page} pages={pages} currentPageId={currentPageId} depth={0} />
            ))}
          </ul>
        )}
      </nav>
    </aside>
  );
}

function PageNode({ page, pages, currentPageId, depth }: { page: WikiPageItem; pages: WikiPageItem[]; currentPageId: string; depth: number }) {
  const children = pages.filter((item) => item.parentPageId === page.id).sort(comparePages);
  const active = page.id === currentPageId;

  return (
    <li>
      <Link
        href={`/wiki/${page.id}`}
        aria-current={active ? "page" : undefined}
        className={`${styles.pageLink} ${active ? styles.pageLinkActive : ""}`}
        style={{ marginLeft: depth * 14 }}
      >
        <span className={styles.pageTitle}>{page.title}</span>
        <span className={styles.pageMeta}>
          <span className={styles.pageKey}>{page.pageKey || page.slug}</span>
          <span className={styles.pageStatus}>{pageStatusLabel(page)}</span>
        </span>
      </Link>
      {children.length > 0 ? (
        <ul className={styles.pageList}>
          {children.map((child) => (
            <PageNode key={child.id} page={child} pages={pages} currentPageId={currentPageId} depth={depth + 1} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function comparePages(a: WikiPageItem, b: WikiPageItem) {
  return (a.slug || a.pageKey).localeCompare(b.slug || b.pageKey);
}
