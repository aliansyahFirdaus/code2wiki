import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { scanCode } from "./scanner";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("scanCode", () => {
  it("filters ignored, generated, binary, lock, and declaration files", async () => {
    const root = await makeTempRoot();
    await write(root, "app/users/page.tsx", "export default function UsersPage() {\nreturn <input name=\"email\" />;\n}\n");
    await write(root, "node_modules/pkg/index.ts", "fetch('/api/nope')");
    await write(root, ".next/server/page.tsx", "fetch('/api/nope')");
    await write(root, "dist/out.js", "fetch('/api/nope')");
    await write(root, "types.d.ts", "export type Nope = string;");
    await write(root, "package-lock.json", "{}");
    await write(root, "generated/client.ts", "fetch('/api/nope')");
    await write(root, "src/generated-file.ts", "// @generated\nfetch('/api/nope')");
    await write(root, "src/binary.ts", "hello\0world");

    const result = await scanCode({ repositoryRole: "FRONTEND", repositoryRoot: root });

    expect(result.totalEligibleFiles).toBe(1);
    expect(result.indexedEligibleFiles).toBe(1);
    expect(result.evidence.every((item) => item.filePath === "app/users/page.tsx")).toBe(true);
  });

  it("creates stable keys, sorted output, and exact snippets for frontend facts", async () => {
    const root = await makeTempRoot();
    await write(
      root,
      "app/users/page.tsx",
      [
        "import Link from 'next/link';",
        "export default function UsersPage() {",
        "  const [isLoading, setIsLoading] = useState(false);",
        "  fetch('/api/users');",
        "  return <form>",
        "    <label htmlFor=\"email\">Email</label>",
        "    <input id=\"email\" name=\"email\" placeholder=\"Email\" />",
        "    <button type=\"submit\">Save</button>",
        "    <Link href=\"/settings\">Settings</Link>",
        "  </form>;",
        "}"
      ].join("\n")
    );

    const first = await scanCode({ repositoryRole: "FRONTEND", repositoryRoot: root });
    const second = await scanCode({ repositoryRole: "FRONTEND", repositoryRoot: root });

    expect(first).toEqual(second);
    expect(first.facts.map((fact) => fact.factKind)).toEqual([...first.facts.map((fact) => fact.factKind)].sort());
    expect(first.facts.every((fact) => fact.evidenceKeys.length > 0)).toBe(true);
    expect(first.facts).toEqual(expect.arrayContaining([expect.objectContaining({ factKind: "ROUTE" })]));
    expect(first.facts).toEqual(expect.arrayContaining([expect.objectContaining({ factKind: "FORM_FIELD" })]));
    expect(first.facts).toEqual(expect.arrayContaining([expect.objectContaining({ factKind: "BUTTON_ACTION" })]));
    expect(first.facts).toEqual(expect.arrayContaining([expect.objectContaining({ factKind: "API_CALL" })]));
    expect(first.facts).toEqual(expect.arrayContaining([expect.objectContaining({ factKind: "NAVIGATION" })]));
    expect(first.facts).toEqual(expect.arrayContaining([expect.objectContaining({ factKind: "UI_STATE" })]));

    for (const evidence of first.evidence) {
      const sourceLines = (await readFixture(root, evidence.filePath)).split(/\r?\n/);
      expect(evidence.codeSnippet).toBe(sourceLines.slice(evidence.startLine - 1, evidence.endLine).join("\n"));
      expect(evidence.endLine - evidence.startLine + 1).toBeLessThanOrEqual(8);
      expect(evidence.filePath).not.toContain(root);
    }
  });

  it("skips vague UI state and extracts conservative backend facts", async () => {
    const root = await makeTempRoot();
    await write(
      root,
      "app/api/users/route.ts",
      [
        "import { z } from 'zod';",
        "import { users } from '@/db/schema';",
        "export async function POST(request: Request) {",
        "  const body = z.object({ email: z.string().min(1) }).parse(await request.json());",
        "  if (!session?.user) return NextResponse.json({ error: 'No' }, { status: 401 });",
        "  await db.insert(users).values(body);",
        "  return NextResponse.json({ ok: true });",
        "}"
      ].join("\n")
    );
    await write(root, "components/state.tsx", "const [value, setValue] = useState('');");

    const frontend = await scanCode({ repositoryRole: "FRONTEND", repositoryRoot: root });
    const backend = await scanCode({ repositoryRole: "BACKEND", repositoryRoot: root });

    expect(frontend.facts.some((fact) => fact.factKind === "UI_STATE")).toBe(false);
    expect(backend.facts).toEqual(expect.arrayContaining([expect.objectContaining({ factKind: "API_ROUTE" })]));
    expect(backend.facts).toEqual(expect.arrayContaining([expect.objectContaining({ factKind: "CONTROLLER_HANDLER" })]));
    expect(backend.facts).toEqual(expect.arrayContaining([expect.objectContaining({ factKind: "VALIDATION_RULE" })]));
    expect(backend.facts).toEqual(expect.arrayContaining([expect.objectContaining({ factKind: "DATABASE_ENTITY" })]));
    expect(backend.facts).toEqual(expect.arrayContaining([expect.objectContaining({ factKind: "PERMISSION_CHECK" })]));
    expect(backend.facts).toEqual(expect.arrayContaining([expect.objectContaining({ factKind: "ERROR_RESPONSE" })]));
  });
});

async function makeTempRoot() {
  const root = await mkdtemp(path.join(tmpdir(), "code2wiki-scanner-test-"));
  tempRoots.push(root);
  return root;
}

async function write(root: string, filePath: string, content: string) {
  const absolutePath = path.join(root, ...filePath.split("/"));
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content);
}

async function readFixture(root: string, filePath: string) {
  return (await import("node:fs/promises")).readFile(path.join(root, ...filePath.split("/")), "utf8");
}
