import { createHash } from "node:crypto";

type Fact = {
  id: string;
  repositoryRole: "FRONTEND" | "BACKEND";
  factKind: string;
  text: string;
  evidenceIds: string[];
  confidence: number;
};
type Evidence = {
  id: string;
  repositoryRole: "FRONTEND" | "BACKEND";
  filePath: string;
  startLine: number;
  endLine: number;
  sourceKind: string;
  summary: string;
};

export const PAGE_INPUT_HASH_VERSION = "page-input-v1";

export function pageInputHash(pageKey: string, facts: Fact[], evidence: Evidence[], codeMapValue: unknown) {
  const evidenceById = new Map(evidence.map((item) => [item.id, evidenceFingerprint(item)]));
  return hash(
    JSON.stringify({
      version: PAGE_INPUT_HASH_VERSION,
      pageKey,
      facts: facts
        .map((fact) => ({ fact, evidenceFingerprints: fact.evidenceIds.map((id) => evidenceById.get(id)).filter(Boolean).sort() }))
        .filter((item) => item.evidenceFingerprints.length > 0)
        .map(({ fact, evidenceFingerprints }) => ({
          repositoryRole: fact.repositoryRole,
          factKind: fact.factKind,
          text: fact.text,
          evidenceFingerprints,
          confidence: fact.confidence
        }))
        .sort(compareJson),
      evidence: evidence.map(evidenceFingerprintInput).sort(compareJson),
      codeMap: codeMapPageInput(pageKey, codeMapValue, evidenceById)
    })
  );
}

export function evidenceFingerprint(item: Evidence) {
  return hash(JSON.stringify(evidenceFingerprintInput(item)));
}

export function factFingerprint(fact: Fact, evidenceIdMap: Map<string, string>) {
  return hash(
    JSON.stringify({
      repositoryRole: fact.repositoryRole,
      factKind: fact.factKind,
      text: fact.text,
      evidenceIds: fact.evidenceIds.map((id) => evidenceIdMap.get(id)).filter(Boolean).sort()
    })
  );
}

export function pageKeyFromPath(filePath: string) {
  const withoutExtension = filePath
    .replace(/^src\//, "")
    .replace(/^app\//, "")
    .replace(/^pages\//, "")
    .replace(/\/page\.(tsx|jsx|ts|js)$/, "")
    .replace(/\/route\.(ts|js)$/, "")
    .replace(/\.(tsx|jsx|ts|js)$/, "")
    .replace(/\/index$/, "")
    .replace(/^\/+/, "");
  return normalizePageKey(withoutExtension.replace(/^api\//, "api/").split("/").filter(Boolean).slice(0, 4).join(".")) || "frontend";
}

function evidenceFingerprintInput(item: Evidence) {
  return {
    repositoryRole: item.repositoryRole,
    filePath: item.filePath,
    startLine: item.startLine,
    endLine: item.endLine,
    sourceKind: item.sourceKind,
    summary: item.summary
  };
}

function codeMapPageInput(pageKey: string, value: unknown, evidenceById: Map<string, string>) {
  if (!value || typeof value !== "object" || !Array.isArray((value as { nodes?: unknown }).nodes)) {
    return [];
  }
  return (value as { nodes: Array<Record<string, unknown>> }).nodes
    .filter((node) => pageKeyFromNode(node) === pageKey)
    .map((node) => ({
      kind: node.kind,
      repositoryRole: node.repositoryRole,
      filePath: node.filePath,
      evidenceFingerprints: Array.isArray(node.evidenceIds) ? node.evidenceIds.map((id) => (typeof id === "string" ? evidenceById.get(id) : null)).filter(Boolean).sort() : []
    }))
    .sort(compareJson);
}

function pageKeyFromNode(node: Record<string, unknown>) {
  const metadata = node.metadata && typeof node.metadata === "object" ? (node.metadata as Record<string, unknown>) : {};
  const value = String(node.kind === "NAVIGATION" ? metadata.target ?? "" : metadata.path ?? node.filePath ?? "");
  if (value.startsWith("/")) {
    return normalizePageKey(value.replace(/^\/+/, "").split("/").filter(Boolean).slice(0, 4).join(".")) || "frontend";
  }
  return pageKeyFromPath(value);
}

function normalizePageKey(value: string) {
  return value
    .replace(/\$\{[^}]+\}/g, "id")
    .replace(/\[[^\]]+\]/g, "id")
    .replace(/\s+/g, ".")
    .replace(/^\.+|\.+$/g, "")
    .toLowerCase();
}

function compareJson(left: unknown, right: unknown) {
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}
