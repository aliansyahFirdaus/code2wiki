import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { RepositoryRole } from "@code2wiki/shared";

import type { ScannerEvidence, EvidenceSourceKind } from "./evidence";
import type { ScannerFact, ScannerFactKind } from "./facts";

const eligibleExtensions = new Set([".ts", ".tsx", ".js", ".jsx"]);
const ignoredDirectories = new Set(["node_modules", ".next", "dist", "build", "coverage", ".git", "__generated__", "generated"]);
const lockFiles = new Set(["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "bun.lock"]);
const meaningfulStateNames = /(loading|error|success|empty|modal|open|disabled)/i;

export type ScanCodeInput = {
  repositoryRole: RepositoryRole;
  repositoryRoot: string;
};

export type ScanCodeResult = {
  totalEligibleFiles: number;
  indexedEligibleFiles: number;
  evidence: ScannerEvidence[];
  facts: ScannerFact[];
};

type MutableEvidence = Omit<ScannerEvidence, "evidenceKey">;
type FileScanContext = {
  repositoryRole: RepositoryRole;
  filePath: string;
  lines: string[];
};

export async function scanCode(input: ScanCodeInput): Promise<ScanCodeResult> {
  const candidateFiles = await collectCandidateFiles(input.repositoryRoot);
  const evidenceByKey = new Map<string, ScannerEvidence>();
  const factsByKey = new Map<string, ScannerFact>();
  let totalEligibleFiles = 0;
  let indexedEligibleFiles = 0;

  for (const filePath of candidateFiles) {
    const absolutePath = path.join(input.repositoryRoot, ...filePath.split("/"));
    const content = await readFile(absolutePath, "utf8");

    if (isBinaryContent(content) || hasGeneratedHeader(content)) {
      continue;
    }

    totalEligibleFiles += 1;

    const context: FileScanContext = {
      repositoryRole: input.repositoryRole,
      filePath,
      lines: content.split(/\r?\n/)
    };

    for (const candidate of extractCandidates(context)) {
      const evidence = withEvidenceKey(candidate.evidence);
      evidenceByKey.set(evidence.evidenceKey, evidence);
      const fact = withFactKey(context.repositoryRole, {
        ...candidate.fact,
        evidenceKeys: [evidence.evidenceKey]
      });
      factsByKey.set(fact.factKey, fact);
    }

    indexedEligibleFiles += 1;
  }

  const evidence = [...evidenceByKey.values()].sort(compareEvidence);
  const evidenceKeys = new Set(evidence.map((item) => item.evidenceKey));
  const facts = [...factsByKey.values()]
    .filter((fact) => fact.evidenceKeys.length > 0 && fact.evidenceKeys.every((key) => evidenceKeys.has(key)))
    .sort(compareFacts);

  return {
    totalEligibleFiles,
    indexedEligibleFiles,
    evidence,
    facts
  };
}

async function collectCandidateFiles(root: string) {
  const files: string[] = [];

  async function walk(relativeDirectory: string) {
    const absoluteDirectory = relativeDirectory ? path.join(root, ...relativeDirectory.split("/")) : root;
    const entries = (await readdir(absoluteDirectory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) {
          await walk(relativePath);
        }
        continue;
      }

      if (entry.isFile() && isEligibleSourceFile(relativePath)) {
        files.push(relativePath);
      }
    }
  }

  await walk("");
  return files.sort();
}

function isEligibleSourceFile(filePath: string) {
  const basename = path.posix.basename(filePath);
  const extension = path.posix.extname(filePath);

  if (!eligibleExtensions.has(extension)) {
    return false;
  }

  if (lockFiles.has(basename) || basename.endsWith(".d.ts") || basename.endsWith(".min.js")) {
    return false;
  }

  return !/(^|[.-])generated\./i.test(basename);
}

function hasGeneratedHeader(content: string) {
  const header = content.split(/\r?\n/).slice(0, 5).join("\n").toLowerCase();
  return header.includes("@generated") || header.includes("generated file") || header.includes("do not edit");
}

function isBinaryContent(content: string) {
  return content.includes("\0");
}

function extractCandidates(context: FileScanContext) {
  const candidates: Array<{ evidence: MutableEvidence; fact: Omit<ScannerFact, "factKey"> }> = [];
  const add = (factKind: ScannerFactKind, sourceKind: EvidenceSourceKind, lineIndex: number, summary: string, text: string, confidence: number) => {
    const evidence = makeEvidence(context, sourceKind, lineIndex, summary);
    if (!evidence) {
      return;
    }
    candidates.push({
      evidence,
      fact: { factKind, text, evidenceKeys: [], confidence }
    });
  };

  addPathDerivedCandidates(context, add);

  context.lines.forEach((line, lineIndex) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    if (context.repositoryRole === "FRONTEND") {
      addFrontendLineCandidates(context.filePath, trimmed, lineIndex, add);
    } else {
      addBackendLineCandidates(context.filePath, trimmed, lineIndex, add);
    }
  });

  return candidates;
}

function addPathDerivedCandidates(
  context: FileScanContext,
  add: (factKind: ScannerFactKind, sourceKind: EvidenceSourceKind, lineIndex: number, summary: string, text: string, confidence: number) => void
) {
  const meaningfulLine = firstMeaningfulLine(context.lines);
  if (meaningfulLine === -1) {
    return;
  }

  if (context.repositoryRole === "FRONTEND" && isFrontendRouteFile(context.filePath)) {
    const route = routeFromFilePath(context.filePath);
    add("ROUTE", "ROUTE", meaningfulLine, `Frontend route ${route}`, `Frontend route ${route}`, 0.95);
    add("PAGE_COMPONENT", "COMPONENT", meaningfulLine, `Page component for ${route}`, `Page component for ${route}`, 0.9);
  }

  if (context.repositoryRole === "BACKEND" && isBackendApiRouteFile(context.filePath)) {
    const route = routeFromFilePath(context.filePath);
    add("API_ROUTE", "ROUTE", meaningfulLine, `Backend API route ${route}`, `Backend API route ${route}`, 0.95);
  }
}

function addFrontendLineCandidates(
  filePath: string,
  trimmed: string,
  lineIndex: number,
  add: (factKind: ScannerFactKind, sourceKind: EvidenceSourceKind, lineIndex: number, summary: string, text: string, confidence: number) => void
) {
  const navigation = trimmed.match(/(?:router\.(?:push|replace)|redirect)\(([^)]+)\)/) ?? trimmed.match(/<Link\b[^>]*\bhref=(["'{][^>"'}]+["'}])/);
  if (navigation) {
    add("NAVIGATION", "NAVIGATION", lineIndex, "Frontend navigation target", `Navigation uses ${cleanText(navigation[0])}`, 0.9);
  }

  if (/\bfetch\(/.test(trimmed) || /\b(?:axios|client|api)\.(?:get|post|put|patch|delete)\(/.test(trimmed) || /["'`]\/api\/[^"'`]+["'`]/.test(trimmed)) {
    add("API_CALL", "API_CALL", lineIndex, "Frontend API call", `API call ${cleanText(trimmed)}`, 0.9);
  }

  if (/<(?:input|select|textarea|label)\b/.test(trimmed) && /\b(?:name|id|placeholder|aria-label|htmlFor)=/.test(trimmed)) {
    add("FORM_FIELD", "FORM", lineIndex, "Frontend form field", `Form field ${cleanText(trimmed)}`, 0.9);
  }

  if (/<button\b/.test(trimmed) && (/\bonClick=/.test(trimmed) || /\btype=["']submit["']/.test(trimmed) || />[^<\s][^<]*<\/button>/.test(trimmed))) {
    add("BUTTON_ACTION", "ACTION", lineIndex, "Frontend button action", `Button action ${cleanText(trimmed)}`, 0.9);
  }

  if (/\b(?:z\.object|z\.string|yup\.|Joi\.|required|min|max|pattern)\b/.test(trimmed)) {
    add("VALIDATION_HINT", "VALIDATION", lineIndex, "Frontend validation hint", `Validation hint ${cleanText(trimmed)}`, 0.9);
  }

  const stateMatch = trimmed.match(/\buseState(?:<[^>]+>)?\([^)]*\)/);
  if (stateMatch && meaningfulStateNames.test(trimmed)) {
    add("UI_STATE", "OTHER", lineIndex, "Frontend UI state", `UI state ${cleanText(trimmed)}`, 0.8);
  }

  if (/\b(?:auth|session|role|permission|can[A-Z]|isAdmin)\b/.test(trimmed)) {
    add("PERMISSION_HINT", "PERMISSION", lineIndex, "Frontend permission hint", `Permission hint ${cleanText(trimmed)}`, 0.85);
  }
}

function addBackendLineCandidates(
  filePath: string,
  trimmed: string,
  lineIndex: number,
  add: (factKind: ScannerFactKind, sourceKind: EvidenceSourceKind, lineIndex: number, summary: string, text: string, confidence: number) => void
) {
  const routeRegistration = trimmed.match(/\b(?:router|app)\.(?:get|post|put|patch|delete)\s*\(/);
  if (routeRegistration) {
    add("API_ROUTE", "ROUTE", lineIndex, "Backend API route registration", `Backend route ${cleanText(trimmed)}`, 0.95);
  }

  if (/\bexport\s+(?:async\s+)?function\s+(?:GET|POST|PUT|PATCH|DELETE)\b/.test(trimmed) || /\bexport\s+const\s+(?:GET|POST|PUT|PATCH|DELETE)\b/.test(trimmed)) {
    add("CONTROLLER_HANDLER", "HANDLER", lineIndex, "Backend controller handler", `Controller handler ${cleanText(trimmed)}`, 0.95);
  }

  if (/service/i.test(filePath) && /\bexport\s+(?:async\s+)?(?:function|class|const)\s+[A-Za-z0-9_]+/.test(trimmed)) {
    add("SERVICE_METHOD", "SERVICE", lineIndex, "Backend service method", `Service method ${cleanText(trimmed)}`, 0.8);
  }

  if (/\b(?:z\.object|z\.string|yup\.|Joi\.|required|min|max|pattern)\b/.test(trimmed)) {
    add("VALIDATION_RULE", "VALIDATION", lineIndex, "Backend validation rule", `Validation rule ${cleanText(trimmed)}`, 0.9);
  }

  if (/\b(?:pgTable|model\s+[A-Z]|schema\s*=|prisma\.|db\.(?:select|insert|update|delete|query))\b/.test(trimmed)) {
    add("DATABASE_ENTITY", "MODEL", lineIndex, "Backend database entity", `Database entity ${cleanText(trimmed)}`, 0.9);
  }

  if (/\b(?:auth|session|role|permission|requireAuth|isAdmin)\b/.test(trimmed)) {
    add("PERMISSION_CHECK", "PERMISSION", lineIndex, "Backend permission check", `Permission check ${cleanText(trimmed)}`, 0.9);
  }

  if (/\b(?:status\s*:\s*[45]\d\d|\.status\(\s*[45]\d\d|NextResponse\.json\([^)]*\{\s*status\s*:\s*[45]\d\d)/.test(trimmed)) {
    add("ERROR_RESPONSE", "HANDLER", lineIndex, "Backend error response", `Error response ${cleanText(trimmed)}`, 0.9);
  }
}

function makeEvidence(context: FileScanContext, sourceKind: EvidenceSourceKind, lineIndex: number, summary: string): MutableEvidence | null {
  const startLine = lineIndex + 1;
  const endLine = findSnippetEndLine(context.lines, lineIndex);
  const codeSnippet = context.lines.slice(lineIndex, endLine).join("\n");

  if (!codeSnippet.trim()) {
    return null;
  }

  return {
    repositoryRole: context.repositoryRole,
    filePath: context.filePath,
    startLine,
    endLine,
    sourceKind,
    summary,
    codeSnippet
  };
}

function findSnippetEndLine(lines: string[], startIndex: number) {
  const maxExclusive = Math.min(lines.length, startIndex + 8);
  for (let index = startIndex; index < maxExclusive; index += 1) {
    if (/[)>};]\s*$/.test(lines[index].trim())) {
      return index + 1;
    }
  }
  return maxExclusive;
}

function firstMeaningfulLine(lines: string[]) {
  const exportIndex = lines.findIndex((line) => /\bexport\b|\bfunction\b|\bconst\b|\bclass\b/.test(line));
  if (exportIndex !== -1) {
    return exportIndex;
  }
  return lines.findIndex((line) => line.trim().length > 0);
}

function isFrontendRouteFile(filePath: string) {
  return /(^|\/)app\/(?:.*\/)?page\.(tsx|jsx|ts|js)$/.test(filePath) || /(^|\/)pages\/.+\.(tsx|jsx|ts|js)$/.test(filePath);
}

function isBackendApiRouteFile(filePath: string) {
  return /(^|\/)app\/api\/(?:.*\/)?route\.(ts|js)$/.test(filePath) || /(^|\/)pages\/api\/.+\.(ts|js)$/.test(filePath);
}

function routeFromFilePath(filePath: string) {
  return `/${filePath
    .replace(/^src\//, "")
    .replace(/^app\//, "")
    .replace(/^pages\//, "")
    .replace(/^api\//, "api/")
    .replace(/^page\.(tsx|jsx|ts|js)$/, "")
    .replace(/\/page\.(tsx|jsx|ts|js)$/, "")
    .replace(/\/route\.(ts|js)$/, "")
    .replace(/\.(tsx|jsx|ts|js)$/, "")
    .replace(/\/index$/, "")
    .replace(/^index$/, "")
    .replace(/\([^)]*\)\//g, "")}`;
}

function withEvidenceKey(evidence: MutableEvidence): ScannerEvidence {
  const snippetHash = hash(evidence.codeSnippet);
  const evidenceKey = hash([
    evidence.repositoryRole,
    evidence.filePath,
    evidence.sourceKind,
    String(evidence.startLine),
    String(evidence.endLine),
    snippetHash
  ].join("|"));

  return { ...evidence, evidenceKey };
}

function withFactKey(repositoryRole: RepositoryRole, fact: Omit<ScannerFact, "factKey">): ScannerFact {
  const evidenceKeys = [...fact.evidenceKeys].sort();
  const factKey = hash([repositoryRole, fact.factKind, normalizeFactText(fact.text), ...evidenceKeys].join("|"));
  return { ...fact, evidenceKeys, factKey };
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function normalizeFactText(text: string) {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

function cleanText(text: string) {
  return text.trim().replace(/\s+/g, " ").slice(0, 180);
}

function compareEvidence(left: ScannerEvidence, right: ScannerEvidence) {
  return (
    left.filePath.localeCompare(right.filePath) ||
    left.startLine - right.startLine ||
    left.endLine - right.endLine ||
    left.sourceKind.localeCompare(right.sourceKind) ||
    left.evidenceKey.localeCompare(right.evidenceKey)
  );
}

function compareFacts(left: ScannerFact, right: ScannerFact) {
  return left.factKind.localeCompare(right.factKind) || left.text.localeCompare(right.text) || left.factKey.localeCompare(right.factKey);
}
