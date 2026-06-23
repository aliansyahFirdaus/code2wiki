import Link from "next/link";

type WikiPageItem = {
  id: string;
  title: string;
  slug: string;
  pageKey: string;
  parentPageId: string | null;
};

type Props = {
  pages: WikiPageItem[];
  currentPageId: string;
};

export function LeftSidebar({ pages, currentPageId }: Props) {
  const roots = pages.filter((page) => !page.parentPageId).sort(comparePages);

  return (
    <aside style={{ borderRight: "1px solid #e5e7eb", padding: 16 }}>
      <h2 style={{ fontSize: 14, margin: "0 0 12px" }}>Wiki pages</h2>
      <nav aria-label="Wiki pages">
        {roots.length === 0 ? (
          <p style={{ color: "#6b7280", margin: 0 }}>No pages.</p>
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
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
        style={{
          color: active ? "#111827" : "#374151",
          display: "block",
          fontWeight: active ? 700 : 400,
          padding: "6px 8px",
          paddingLeft: 8 + depth * 16,
          textDecoration: "none"
        }}
      >
        {page.title}
      </Link>
      {children.length > 0 ? (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
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
