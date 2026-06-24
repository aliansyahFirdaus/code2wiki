import type { CodeMap, CodeMapConfidence, CodeMapEvidenceInput, CodeMapFactInput, CodeMapNode } from "./code-map";

export type ProductConceptSource =
  | "UI_TEXT"
  | "FIELD_NAME"
  | "ACTION"
  | "API_PATH"
  | "SCHEMA"
  | "AUTH"
  | "ERROR"
  | "CODE_MAP_EDGE";

export type ProductConcept = {
  conceptKey: string;
  label: string;
  source: ProductConceptSource;
  confidence: CodeMapConfidence;
  evidenceIds: string[];
  sourceNodeKeys: string[];
  reasons: string[];
};

export type DeriveProductConceptsInput = {
  facts: CodeMapFactInput[];
  evidence: CodeMapEvidenceInput[];
  codeMap: CodeMap;
};

const genericWords = new Set([
  "api",
  "app",
  "button",
  "component",
  "data",
  "field",
  "form",
  "handler",
  "id",
  "ids",
  "index",
  "input",
  "page",
  "route",
  "schema",
  "submit",
  "uuid"
]);

export function deriveProductConcepts(input: DeriveProductConceptsInput): ProductConcept[] {
  const evidenceById = new Map(input.evidence.map((item) => [item.id, item]));
  const concepts = new Map<string, ProductConcept>();
  const add = (draft: Omit<ProductConcept, "conceptKey" | "label"> & { value: string; label?: string }) => {
    const concept = productConceptFromDraft(draft);
    if (!concept) return;
    const existing = concepts.get(concept.conceptKey);
    concepts.set(concept.conceptKey, existing ? mergeConcept(existing, concept) : concept);
  };

  for (const node of input.codeMap.nodes) {
    if (node.kind === "FORM_FIELD") {
      const fieldName = stringMetadata(node, "fieldName") ?? node.label;
      add({
        value: fieldName,
        label: humanize(fieldName),
        source: "FIELD_NAME",
        confidence: node.confidence,
        evidenceIds: node.evidenceIds,
        sourceNodeKeys: [node.stableKey],
        reasons: [`form field ${fieldName}`]
      });
    }

    if (node.kind === "FRONTEND_API_CALL") {
      const path = stringMetadata(node, "path") ?? node.label;
      add({
        value: conceptFromApiPath(path),
        source: "API_PATH",
        confidence: node.confidence,
        evidenceIds: node.evidenceIds,
        sourceNodeKeys: [node.stableKey],
        reasons: [`api path ${path}`]
      });
    }

    if (node.kind === "SCHEMA_ENTITY" || node.kind === "AUTH_CHECK" || node.kind === "ERROR_STATE") {
      add({
        value: conceptFromText(node.label),
        source: node.kind === "SCHEMA_ENTITY" ? "SCHEMA" : node.kind === "AUTH_CHECK" ? "AUTH" : "ERROR",
        confidence: downgradeTechnicalConfidence(node.confidence),
        evidenceIds: node.evidenceIds,
        sourceNodeKeys: [node.stableKey],
        reasons: [`${node.kind.toLowerCase()} ${node.label}`]
      });
    }
  }

  for (const fact of input.facts) {
    if (fact.factKind === "BUTTON_ACTION") {
      add({
        value: actionText(fact.text),
        source: "ACTION",
        confidence: confidenceFromScore(fact.confidence),
        evidenceIds: fact.evidenceIds,
        sourceNodeKeys: [],
        reasons: [`button action ${fact.text}`]
      });
    }
    if (fact.factKind === "API_CALL") {
      const path = readApiPath(fact.text);
      if (path) {
        add({
          value: conceptFromApiPath(path),
          source: "API_PATH",
          confidence: confidenceFromScore(fact.confidence),
          evidenceIds: fact.evidenceIds,
          sourceNodeKeys: [],
          reasons: [`api path ${path}`]
        });
      }
    }
  }

  for (const item of input.evidence) {
    for (const label of readUiLabels(item.codeSnippet)) {
      add({
        value: label,
        source: "UI_TEXT",
        confidence: "HIGH",
        evidenceIds: [item.id],
        sourceNodeKeys: [],
        reasons: [`ui text ${label}`]
      });
    }
  }

  const nodesByKey = new Map(input.codeMap.nodes.map((node) => [node.stableKey, node]));
  for (const edge of input.codeMap.edges) {
    if (!["CALLS_API", "FORM_HAS_FIELD", "HANDLER_USES_SCHEMA", "HANDLER_USES_AUTH", "HAS_ERROR_STATE"].includes(edge.kind)) {
      continue;
    }
    const target = nodesByKey.get(edge.toStableKey);
    if (!target) continue;
    add({
      value: edgeConceptValue(target),
      source: "CODE_MAP_EDGE",
      confidence: edge.confidence,
      evidenceIds: edge.evidenceIds,
      sourceNodeKeys: [edge.fromStableKey, edge.toStableKey],
      reasons: [`${edge.kind} to ${target.label}`]
    });
  }

  return [...concepts.values()].sort((left, right) => left.conceptKey.localeCompare(right.conceptKey));
}

function productConceptFromDraft(input: Omit<ProductConcept, "conceptKey" | "label"> & { value: string; label?: string }): ProductConcept | null {
  const tokens = conceptTokens(input.value);
  if (tokens.length === 0) return null;
  const conceptKey = tokens.join("-");
  return {
    conceptKey,
    label: input.label ?? humanize(conceptKey),
    source: input.source,
    confidence: input.confidence,
    evidenceIds: uniqueSorted(input.evidenceIds),
    sourceNodeKeys: uniqueSorted(input.sourceNodeKeys),
    reasons: uniqueSorted(input.reasons)
  };
}

function conceptTokens(value: string) {
  const rawTokens = splitWords(value).map((token) => singularize(token.toLowerCase()));
  const hasSalary = rawTokens.includes("salary");
  return rawTokens.filter((token) => token.length >= 3 && (!genericWords.has(token) || (token === "component" && hasSalary)));
}

function splitWords(value: string) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_./:[\](){}"'`,]+/g, " ")
    .replace(/\b[A-Z]{2,}\b/g, (word) => word.toLowerCase())
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
}

function singularize(value: string) {
  return value.endsWith("s") && value.length > 4 ? value.slice(0, -1) : value;
}

function humanize(value: string) {
  return conceptTokens(value)
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
    .join(" ");
}

function conceptFromApiPath(path: string) {
  return path
    .replace(/^\/+/, "")
    .split("/")
    .filter(Boolean)
    .filter((part) => !part.startsWith("[") && !part.startsWith(":"))
    .join(" ");
}

function conceptFromText(value: string) {
  return value.replace(/\b(?:database entity|data definition|permission check|error response|controller handler|backend route|frontend route)\b/gi, " ");
}

function actionText(value: string) {
  return value.replace(/\bButton action\b/gi, " ");
}

function edgeConceptValue(node: CodeMapNode) {
  if (node.kind === "FRONTEND_API_CALL") return conceptFromApiPath(stringMetadata(node, "path") ?? node.label);
  if (node.kind === "FORM_FIELD") return stringMetadata(node, "fieldName") ?? node.label;
  return conceptFromText(node.label);
}

function readApiPath(value: string) {
  return value.match(/["'`](\/api\/[^"'`)\s,]+)["'`]/)?.[1] ?? null;
}

function readUiLabels(snippet: string) {
  const labels: string[] = [];
  for (const match of snippet.matchAll(/<label\b[^>]*>([^<]+)<\/label>/gi)) {
    labels.push(match[1].trim());
  }
  for (const match of snippet.matchAll(/<(?:button|Button)\b[^>]*>([^<]+)<\/(?:button|Button)>/g)) {
    labels.push(match[1].trim());
  }
  return labels.filter(Boolean);
}

function stringMetadata(node: CodeMapNode, key: string) {
  const value = node.metadata[key];
  return typeof value === "string" ? value : undefined;
}

function confidenceFromScore(score: number): CodeMapConfidence {
  if (score >= 0.9) return "HIGH";
  if (score >= 0.75) return "MEDIUM";
  if (score > 0) return "LOW";
  return "NEEDS_REVIEW";
}

function downgradeTechnicalConfidence(confidence: CodeMapConfidence): CodeMapConfidence {
  return confidence === "HIGH" ? "MEDIUM" : confidence;
}

function mergeConcept(left: ProductConcept, right: ProductConcept): ProductConcept {
  return {
    ...left,
    confidence: strongerConfidence(left.confidence, right.confidence),
    evidenceIds: uniqueSorted([...left.evidenceIds, ...right.evidenceIds]),
    sourceNodeKeys: uniqueSorted([...left.sourceNodeKeys, ...right.sourceNodeKeys]),
    reasons: uniqueSorted([...left.reasons, ...right.reasons])
  };
}

function strongerConfidence(left: CodeMapConfidence, right: CodeMapConfidence): CodeMapConfidence {
  const rank: Record<CodeMapConfidence, number> = { NEEDS_REVIEW: 0, LOW: 1, MEDIUM: 2, HIGH: 3 };
  return rank[right] > rank[left] ? right : left;
}

function uniqueSorted(values: string[]) {
  return [...new Set(values)].sort();
}
