import type { CodeMapConfidence } from "./code-map";
import type { ProductConcept } from "./product-concepts";

export type ConceptPageDisposition = "CREATE_PAGE" | "UPDATE_PAGE" | "NEEDS_REVIEW" | "EXCLUDED_NO_WIKI_VALUE";

export type ConceptPageDecision = {
  disposition: ConceptPageDisposition;
  pageKey: string;
  conceptKey: string;
  evidenceIds: string[];
  reason: string;
};

export type MatchConceptsToPagesInput = {
  concepts: ProductConcept[];
  existingPageKeys: string[];
  sourcePageKey?: string;
};

const rootPageConcepts = new Set(["vessel", "crew", "contract", "payroll", "company", "role", "permission", "insurance"]);
const genericConcepts = new Set(["api", "app", "component", "data", "field", "form", "handler", "page", "route", "schema"]);

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

  if (evidenceIds.length === 0 || !conceptKey || genericConcepts.has(conceptKey)) {
    return {
      disposition: "EXCLUDED_NO_WIKI_VALUE",
      pageKey: conceptKey || "unmatched",
      conceptKey,
      evidenceIds,
      reason: evidenceIds.length === 0 ? "concept has no evidence" : "concept is implementation-only"
    };
  }

  if (isWeak(concept.confidence)) {
    return {
      disposition: "NEEDS_REVIEW",
      pageKey: sourceNamespace && !rootPageConcepts.has(conceptKey) ? `${sourceNamespace}.${conceptKey}` : conceptKey,
      conceptKey,
      evidenceIds,
      reason: `concept confidence is ${concept.confidence}`
    };
  }

  const exact = existing.get(conceptKey);
  if (exact) {
    return {
      disposition: "UPDATE_PAGE",
      pageKey: exact,
      conceptKey,
      evidenceIds,
      reason: "existing page matched concept"
    };
  }

  const namespacedKey = sourceNamespace && !rootPageConcepts.has(conceptKey) ? `${sourceNamespace}.${conceptKey}` : conceptKey;
  const namespaced = existing.get(namespacedKey);
  if (namespaced) {
    return {
      disposition: "UPDATE_PAGE",
      pageKey: namespaced,
      conceptKey,
      evidenceIds,
      reason: "existing namespaced page matched concept"
    };
  }

  return {
    disposition: "CREATE_PAGE",
    pageKey: namespacedKey,
    conceptKey,
    evidenceIds,
    reason: sourceNamespace && namespacedKey !== conceptKey ? "new concept page under source namespace" : "new root concept page"
  };
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

function mergeDecision(left: ConceptPageDecision, right: ConceptPageDecision): ConceptPageDecision {
  return {
    ...left,
    evidenceIds: uniqueSorted([...left.evidenceIds, ...right.evidenceIds]),
    reason: uniqueSorted([left.reason, right.reason]).join("; ")
  };
}

function uniqueSorted(values: string[]) {
  return [...new Set(values)].sort();
}
