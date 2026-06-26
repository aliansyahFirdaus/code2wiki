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
    await write(root, ".code2wikiignore", "ignored-by-code2wiki/\nAGENTS.md\n");
    await write(root, "ignored-by-code2wiki/page.tsx", "fetch('/api/nope')");
    await write(root, "AGENTS.md", "fetch('/api/nope')");

    const result = await scanCode({ repositoryRole: "FRONTEND", repositoryRoot: root });

    expect(result.totalEligibleFiles).toBe(1);
    expect(result.indexedEligibleFiles).toBe(1);
    expect(result.eligibleFiles).toEqual(["app/users/page.tsx"]);
    expect(result.indexedFiles).toEqual(["app/users/page.tsx"]);
    expect(result.ignoredFiles).toEqual(expect.arrayContaining([
      { filePath: ".next/", reason: "ignored directory" },
      { filePath: "AGENTS.md", reason: ".code2wikiignore" },
      { filePath: "package-lock.json", reason: "ignored filename" },
      { filePath: "src/binary.ts", reason: "binary content" },
      { filePath: "src/generated-file.ts", reason: "generated header" },
      { filePath: "types.d.ts", reason: "ignored filename" }
    ]));
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

  it("indexes Go backend files", async () => {
    const root = await makeTempRoot();
    await write(
      root,
      "internal/payroll/handler.go",
      [
        "package payroll",
        "func RegisterRoutes(router *gin.Engine) {",
        "  router.POST(\"/payroll/recalculate\", RecalculatePayroll)",
        "}",
        "func RecalculatePayroll(c *gin.Context) {",
        "  if !isAdmin(c) { c.AbortWithStatusJSON(http.StatusForbidden, gin.H{\"error\":\"forbidden\"}); return }",
        "  if err := c.ShouldBind(&request); err != nil { c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{\"error\":\"bad request\"}); return }",
        "  db.Where(\"vessel_id = ?\", request.VesselID).Find(&rows)",
        "}"
      ].join("\n")
    );

    const backend = await scanCode({ repositoryRole: "BACKEND", repositoryRoot: root });

    expect(backend.totalEligibleFiles).toBe(1);
    expect(backend.indexedEligibleFiles).toBe(1);
    expect(backend.facts).toEqual(expect.arrayContaining([expect.objectContaining({ factKind: "API_ROUTE" })]));
    expect(backend.facts).toEqual(expect.arrayContaining([expect.objectContaining({ factKind: "CONTROLLER_HANDLER" })]));
    expect(backend.facts).toEqual(expect.arrayContaining([expect.objectContaining({ factKind: "VALIDATION_RULE" })]));
    expect(backend.facts).toEqual(expect.arrayContaining([expect.objectContaining({ factKind: "DATABASE_ENTITY" })]));
    expect(backend.facts).toEqual(expect.arrayContaining([expect.objectContaining({ factKind: "PERMISSION_CHECK" })]));
    expect(backend.facts).toEqual(expect.arrayContaining([expect.objectContaining({ factKind: "ERROR_RESPONSE" })]));
  });

  it("limits scan scope by include paths and max indexed files", async () => {
    const root = await makeTempRoot();
    await write(root, "src/app/payroll/page.tsx", "export default function PayrollPage() {\nreturn <button>Run Payroll</button>;\n}");
    await write(root, "src/app/payroll/detail/page.tsx", "export default function PayrollDetailPage() {\nreturn <button>Recalculate</button>;\n}");
    await write(root, "src/app/users/page.tsx", "export default function UsersPage() {\nreturn <button>Save</button>;\n}");

    const frontend = await scanCode({
      repositoryRole: "FRONTEND",
      repositoryRoot: root,
      includePaths: ["src/app/payroll"],
      maxFiles: 1
    });

    expect(frontend.totalEligibleFiles).toBe(2);
    expect(frontend.indexedEligibleFiles).toBe(1);
    expect(frontend.eligibleFiles).toEqual(["src/app/payroll/detail/page.tsx", "src/app/payroll/page.tsx"]);
    expect(frontend.indexedFiles).toEqual(["src/app/payroll/detail/page.tsx"]);
    expect(frontend.ignoredFiles).toEqual(expect.arrayContaining([
      { filePath: "src/app/payroll/page.tsx", reason: "max files cap" },
      { filePath: "src/app/users/page.tsx", reason: "outside scan roots" }
    ]));
    expect(new Set(frontend.evidence.map((item) => item.filePath))).toEqual(new Set(["src/app/payroll/detail/page.tsx"]));
  });

  it("anchors tab components to their parent route", async () => {
    const root = await makeTempRoot();
    await write(
      root,
      "src/app/payroll/[vesselId]/[year]/[month]/_components/InsuranceTab.tsx",
      "export function InsuranceTab() {\nreturn <TableHead>Insurance</TableHead>;\n}\n"
    );

    const frontend = await scanCode({ repositoryRole: "FRONTEND", repositoryRoot: root, includePaths: ["src/app/payroll"] });

    expect(frontend.facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          factKind: "PAGE_COMPONENT",
          text: "Tab component for /payroll/[vesselId]/[year]/[month]/insurance"
        })
      ])
    );
  });

  it("indexes backend SQL and worker files", async () => {
    const root = await makeTempRoot();
    await write(
      root,
      "migrations/001_create_payroll.sql",
      [
        "CREATE TABLE payroll_runs (",
        "  id uuid PRIMARY KEY,",
        "  vessel_id uuid NOT NULL REFERENCES vessels(id),",
        "  status text NOT NULL CHECK (status <> '')",
        ");"
      ].join("\n")
    );
    await write(
      root,
      "internal/workers/payroll_worker.go",
      [
        "package workers",
        "func ProcessPayrollQueue(ctx context.Context) {",
        "  db.Where(\"status = ?\", \"queued\").Find(&runs)",
        "}"
      ].join("\n")
    );

    const backend = await scanCode({ repositoryRole: "BACKEND", repositoryRoot: root });

    expect(backend.totalEligibleFiles).toBe(2);
    expect(backend.facts).toEqual(expect.arrayContaining([expect.objectContaining({ factKind: "DATABASE_ENTITY" })]));
    expect(backend.facts).toEqual(expect.arrayContaining([expect.objectContaining({ factKind: "VALIDATION_RULE" })]));
    expect(backend.facts).toEqual(expect.arrayContaining([expect.objectContaining({ factKind: "SERVICE_METHOD" })]));
  });

  it("does not require a language-specific extension whitelist", async () => {
    const root = await makeTempRoot();
    await write(
      root,
      "src/routes/payroll.rs",
      [
        "pub fn recalculate_payroll() {",
        "  if !has_permission { return StatusCode::FORBIDDEN; }",
        "  sqlx::query!(\"UPDATE payroll SET status = 'done'\");",
        "}"
      ].join("\n")
    );

    const backend = await scanCode({ repositoryRole: "BACKEND", repositoryRoot: root });

    expect(backend.totalEligibleFiles).toBe(1);
    expect(backend.facts).toEqual(expect.arrayContaining([expect.objectContaining({ factKind: "DATABASE_ENTITY" })]));
    expect(backend.facts).toEqual(expect.arrayContaining([expect.objectContaining({ factKind: "PERMISSION_CHECK" })]));
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
