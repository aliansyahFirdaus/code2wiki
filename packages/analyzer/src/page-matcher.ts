import type { CodeMapConfidence } from "./code-map";
import type { ProductConcept, ProductConceptRole } from "./product-concepts";

export type ConceptPageDisposition = "CREATE_PAGE" | "UPDATE_PAGE" | "ATTACH_TO_PAGE" | "NEEDS_REVIEW" | "EXCLUDED_NO_WIKI_VALUE";

export type ConceptPageDecision = {
  disposition: ConceptPageDisposition;
  pageKey: string;
  conceptKey: string;
  evidenceIds: string[];
  reason: string;
  score: number;
  roles: ProductConceptRole[];
  attachToPageKey?: string;
  parentPageKey?: string;
  lineageReason?: string;
};

export type MatchConceptsToPagesInput = {
  concepts: ProductConcept[];
  existingPageKeys: string[];
  sourcePageKey?: string;
};

const rootPageConcepts = new Set(["vessel", "crew", "contract", "payroll", "company", "role", "permission", "insurance"]);
const genericConcepts = new Set(["api", "app", "component", "data", "field", "form", "handler", "page", "route", "schema"]);
const technicalSources = new Set<ProductConcept["source"]>(["API_PATH", "SCHEMA", "CODE_MAP_EDGE"]);

export function matchConceptsToPages(input: MatchConceptsToPagesInput): ConceptPageDecision[] {
  const existing = new Map(input.existingPageKeys.map((pageKey) => [normalizePageKey(pageKey), pageKey]));
  const sourceNamespace = sourceNamespaceFromPageKey(input.sourcePageKey);
  const decisions = new Map<string, ConceptPageDecision>();

  for (const concept of input.concepts) {
    const decision = decisionForConcept(concept, existing, sourceNamespace);
    const key = `${decision.disposition}:${decision.pageKey}:${decision.conceptKey}`;
    const existingDecision = decisions.get(key);
    decisions.set(key, existingDecision ? mergeDecision(existingDecision, decision) : decision);
  }

  return [...decisions.values()].sort((left, right) => left.pageKey.localeCompare(right.pageKey) || left.conceptKey.localeCompare(right.conceptKey) || left.disposition.localeCompare(right.disposition));
}

function decisionForConcept(concept: ProductConcept, existing: Map<string, string>, sourceNamespace: string | null): ConceptPageDecision {
  const conceptKey = normalizePageKey(concept.conceptKey);
  const evidenceIds = uniqueSorted(concept.evidenceIds);
  const score = concept.profile?.score ?? fallbackScore(concept);
  const roles = concept.profile?.roles ?? [];
  const parentPageKey = normalizePageKey(concept.profile?.parentPageKey ?? "");
  const attachToPageKey = attachTarget(conceptKey, existing, sourceNamespace, parentPageKey);
  const base = {
    conceptKey,
    evidenceIds,
    score,
    roles,
    ...(parentPageKey ? { parentPageKey } : {}),
    ...(concept.profile?.lineageReason ? { lineageReason: concept.profile.lineageReason } : {})
  };

  if (evidenceIds.length === 0 || !conceptKey || genericConcepts.has(conceptKey) || concept.profile?.technicalOnly || isTechnicalOnly(concept, score)) {
    return {
      ...base,
      disposition: "EXCLUDED_NO_WIKI_VALUE",
      pageKey: conceptKey || "unmatched",
      reason: evidenceIds.length === 0 ? "concept has no evidence" : "concept is implementation-only or technical-only"
    };
  }

  if (isWeak(concept.confidence) || (score <= 1 && !attachToPageKey)) {
    return {
      ...base,
      disposition: "NEEDS_REVIEW",
      pageKey: sourceNamespace && !rootPageConcepts.has(conceptKey) ? `${sourceNamespace}.${conceptKey}` : conceptKey,
      reason: isWeak(concept.confidence) ? `concept confidence is ${concept.confidence}` : "weak concept has no deterministic parent page"
    };
  }

  const exact = existing.get(conceptKey);
  if (exact) {
    return {
      ...base,
      disposition: "UPDATE_PAGE",
      pageKey: exact,
      reason: score >= 4 ? "existing page matched strong concept" : "existing page absorbs related concept"
    };
  }

  const namespacedKey = sourceNamespace && !rootPageConcepts.has(conceptKey) ? `${sourceNamespace}.${conceptKey}` : conceptKey;
  const namespaced = existing.get(namespacedKey);
  if (namespaced) {
    return {
      ...base,
      disposition: "UPDATE_PAGE",
      pageKey: namespaced,
      reason: score >= 4 ? "existing namespaced page matched strong concept" : "existing namespaced page absorbs related concept"
    };
  }

  if (!hasStandalonePageValue(roles)) {
    if (attachToPageKey) {
      return {
        ...base,
        disposition: "ATTACH_TO_PAGE",
        pageKey: attachToPageKey,
        attachToPageKey,
        reason: "concept is not standalone page value and attaches to parent page"
      };
    }
    return {
      ...base,
      disposition: "EXCLUDED_NO_WIKI_VALUE",
      pageKey: namespacedKey,
      reason: "concept is not standalone page value"
    };
  }

  if (score < 4) {
    if (attachToPageKey) {
      return {
        ...base,
        disposition: "ATTACH_TO_PAGE",
        pageKey: attachToPageKey,
        attachToPageKey,
        reason: score <= 1 ? "weak concept attaches to deterministic parent page" : "related concept attaches to parent page"
      };
    }
    return {
      ...base,
      disposition: "NEEDS_REVIEW",
      pageKey: namespacedKey,
      reason: "related concept has no deterministic parent page"
    };
  }

  return {
    ...base,
    disposition: "CREATE_PAGE",
    pageKey: namespacedKey,
    reason: sourceNamespace && namespacedKey !== conceptKey ? "strong concept page under source namespace" : "strong root concept page"
  };
}

function attachTarget(conceptKey: string, existing: Map<string, string>, sourceNamespace: string | null, parentPageKey: string) {
  if (parentPageKey && existing.has(parentPageKey)) return existing.get(parentPageKey);
  if (sourceNamespace && existing.has(sourceNamespace)) return existing.get(sourceNamespace);
  if (sourceNamespace) return sourceNamespace;
  const root = conceptKey.split("-")[0];
  return root && root !== conceptKey && existing.has(root) ? existing.get(root) : null;
}

function sourceNamespaceFromPageKey(pageKey: string | undefined) {
  if (!pageKey) return null;
  const parts = normalizePageKey(pageKey).split(".").filter(Boolean);
  return parts[0] ?? null;
}

function normalizePageKey(value: string) {
  return value
    .replace(/\$\{[^}]+\}/g, "id")
    .replace(/\[[^\]]+\]/g, "id")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[_/:\s]+/g, ".")
    .replace(/-+/g, "-")
    .replace(/\.+/g, ".")
    .replace(/^\.+|\.+$/g, "")
    .toLowerCase();
}

function isWeak(confidence: CodeMapConfidence) {
  return confidence === "LOW" || confidence === "NEEDS_REVIEW";
}

function isTechnicalOnly(concept: ProductConcept, score: number) {
  return technicalSources.has(concept.source) && score <= 1;
}

function fallbackScore(concept: ProductConcept) {
  if (concept.source === "ACTION") return 2;
  if (concept.source === "FIELD_NAME" || concept.source === "UI_TEXT") return 1;
  if (concept.source === "AUTH" || concept.source === "ERROR" || concept.source === "VALIDATION") return 2;
  return 0;
}

function hasStandalonePageValue(roles: ProductConceptRole[]) {
  const roleSet = new Set(roles);
  if (roleSet.has("route") || roleSet.has("workspace") || roleSet.has("tab") || roleSet.has("modal")) {
    return true;
  }
  return roleSet.has("action");
}

function mergeDecision(left: ConceptPageDecision, right: ConceptPageDecision): ConceptPageDecision {
  return {
    ...left,
    evidenceIds: uniqueSorted([...left.evidenceIds, ...right.evidenceIds]),
    score: Math.max(left.score, right.score),
    roles: uniqueSorted([...left.roles, ...right.roles]) as ProductConceptRole[],
    reason: uniqueSorted([left.reason, right.reason]).join("; ")
  };
}

function uniqueSorted(values: string[]) {
  return [...new Set(values)].sort();
}
