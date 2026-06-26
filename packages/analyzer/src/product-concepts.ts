import type { CodeMap, CodeMapConfidence, CodeMapEvidenceInput, CodeMapFactInput, CodeMapNode } from "./code-map";

export type ProductConceptSource =
  | "UI_TEXT"
  | "FIELD_NAME"
  | "ACTION"
  | "STATE"
  | "VALIDATION"
  | "API_PATH"
  | "SCHEMA"
  | "AUTH"
  | "ERROR"
  | "CODE_MAP_EDGE";

export type ProductConceptRole =
  | "route"
  | "workspace"
  | "tab"
  | "modal"
  | "async"
  | "mutation"
  | "validation"
  | "permission"
  | "error"
  | "empty_state"
  | "action"
  | "field";

export type ProductConceptProfile = {
  roles: ProductConceptRole[];
  score: number;
  parentPageKey?: string;
  lineageReason?: string;
  technicalOnly: boolean;
};

export type ProductConcept = {
  conceptKey: string;
  label: string;
  source: ProductConceptSource;
  confidence: CodeMapConfidence;
  evidenceIds: string[];
  sourceNodeKeys: string[];
  reasons: string[];
  profile: ProductConceptProfile;
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
  const add = (draft: Omit<ProductConcept, "conceptKey" | "label" | "profile"> & { value: string; label?: string; profile?: Partial<ProductConceptProfile> }) => {
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
        reasons: [`form field ${fieldName}`],
        profile: nodeProfile(node, ["field"])
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
        reasons: [`api path ${path}`],
        profile: nodeProfile(node, apiRoles(node))
      });
    }

    if (node.kind === "VALIDATION" || node.kind === "SCHEMA_ENTITY" || node.kind === "AUTH_CHECK" || node.kind === "ERROR_STATE") {
      add({
        value: conceptFromText(node.label),
        source: node.kind === "VALIDATION" ? "VALIDATION" : node.kind === "SCHEMA_ENTITY" ? "SCHEMA" : node.kind === "AUTH_CHECK" ? "AUTH" : "ERROR",
        confidence: downgradeTechnicalConfidence(node.confidence),
        evidenceIds: node.evidenceIds,
        sourceNodeKeys: [node.stableKey],
        reasons: [`${node.kind.toLowerCase()} ${node.label}`],
        profile: nodeProfile(node, node.kind === "VALIDATION" ? ["validation"] : node.kind === "AUTH_CHECK" ? ["permission"] : node.kind === "ERROR_STATE" ? stateRoles(node.label) : [])
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
        reasons: [`button action ${fact.text}`],
        profile: factProfile(fact, ["action", ...textRoles(fact.text)])
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
          reasons: [`api path ${path}`],
          profile: factProfile(fact, apiRoles({ metadata: { path }, label: fact.text }))
        });
      }
    }
    if (fact.factKind === "VALIDATION_HINT" || fact.factKind === "VALIDATION_RULE" || fact.factKind === "PERMISSION_HINT" || fact.factKind === "PERMISSION_CHECK" || fact.factKind === "UI_STATE") {
      add({
        value: conceptFromText(fact.text),
        source: fact.factKind.includes("VALIDATION") ? "VALIDATION" : fact.factKind.includes("PERMISSION") ? "AUTH" : "STATE",
        confidence: confidenceFromScore(fact.confidence),
        evidenceIds: fact.evidenceIds,
        sourceNodeKeys: [],
        reasons: [`${fact.factKind.toLowerCase()} ${fact.text}`],
        profile: factProfile(fact, fact.factKind.includes("VALIDATION") ? ["validation", ...textRoles(fact.text)] : fact.factKind.includes("PERMISSION") ? ["permission"] : stateRoles(fact.text))
      });
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
        reasons: [`ui text ${label}`],
        profile: evidenceProfile(item, textRoles(label))
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
      reasons: [`${edge.kind} to ${target.label}`],
      profile: nodeProfile(target, edgeRoles(edge.kind, target))
    });
  }

  return [...concepts.values()].sort((left, right) => left.conceptKey.localeCompare(right.conceptKey));
}

function productConceptFromDraft(input: Omit<ProductConcept, "conceptKey" | "label" | "profile"> & { value: string; label?: string; profile?: Partial<ProductConceptProfile> }): ProductConcept | null {
  const tokens = conceptTokens(input.value);
  if (tokens.length === 0) return null;
  const conceptKey = tokens.join("-");
  const roles = uniqueSorted(input.profile?.roles ?? []) as ProductConceptRole[];
  return {
    conceptKey,
    label: input.label ?? humanize(conceptKey),
    source: input.source,
    confidence: input.confidence,
    evidenceIds: uniqueSorted(input.evidenceIds),
    sourceNodeKeys: uniqueSorted(input.sourceNodeKeys),
    reasons: uniqueSorted(input.reasons),
    profile: {
      roles,
      score: scoreRoles(roles, conceptKey),
      parentPageKey: input.profile?.parentPageKey,
      lineageReason: input.profile?.lineageReason,
      technicalOnly: input.profile?.technicalOnly ?? isTechnicalOnly(input.source, roles)
    }
  };
}

function conceptTokens(value: string) {
  const rawTokens = splitWords(value).map((token) => singularize(token.toLowerCase()));
  const hasSalary = rawTokens.includes("salary");
  const hasMerge = rawTokens.includes("merge");
  return rawTokens.filter((token) => token.length >= 3 && (!genericWords.has(token) || (token === "component" && hasSalary) || (token === "data" && hasMerge)));
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
  if (value.endsWith("ies") && value.length > 4) return `${value.slice(0, -3)}y`;
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
  return value
    .replace(/\b(?:database entity|data definition|permission check|permission hint|validation rule|validation hint|ui state|error response|controller handler|backend route|frontend route)\b/gi, " ")
    .replace(/\b(?:requires?|must|should|when|if|before|after)\b.*$/i, " ");
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

function nodeProfile(node: CodeMapNode, roles: ProductConceptRole[]): Partial<ProductConceptProfile> {
  return {
    roles: uniqueSorted([...roles, ...textRoles(`${node.label} ${node.filePath}`)]) as ProductConceptRole[],
    parentPageKey: pageKeyFromPath(node.filePath),
    lineageReason: `from ${node.kind.toLowerCase()} evidence`
  };
}

function factProfile(fact: CodeMapFactInput, roles: ProductConceptRole[]): Partial<ProductConceptProfile> {
  return {
    roles: uniqueSorted(roles) as ProductConceptRole[],
    technicalOnly: fact.repositoryRole === "BACKEND" && roles.every((role) => role === "validation" || role === "permission")
  };
}

function evidenceProfile(item: CodeMapEvidenceInput, roles: ProductConceptRole[]): Partial<ProductConceptProfile> {
  return {
    roles: uniqueSorted([...roles, ...sourceKindRoles(item.sourceKind), ...textRoles(`${item.summary} ${item.codeSnippet}`)]) as ProductConceptRole[],
    parentPageKey: pageKeyFromPath(item.filePath),
    lineageReason: `from ${item.sourceKind.toLowerCase()} evidence`
  };
}

function apiRoles(input: { metadata: Record<string, unknown>; label: string }): ProductConceptRole[] {
  const method = String(input.metadata.method ?? "").toUpperCase();
  const path = String(input.metadata.path ?? input.label);
  return uniqueSorted([
    "async",
    ...(method && method !== "GET" ? (["mutation"] as const) : []),
    ...textRoles(path)
  ]) as ProductConceptRole[];
}

function edgeRoles(edgeKind: string, target: CodeMapNode): ProductConceptRole[] {
  if (edgeKind === "FORM_HAS_FIELD") return ["field"];
  if (edgeKind === "FIELD_HAS_VALIDATION" || edgeKind === "HANDLER_USES_SCHEMA") return ["validation"];
  if (edgeKind === "HANDLER_USES_AUTH") return ["permission"];
  if (edgeKind === "HAS_ERROR_STATE") return stateRoles(target.label);
  if (edgeKind === "CALLS_API") return apiRoles(target);
  return textRoles(target.label);
}

function sourceKindRoles(sourceKind: string): ProductConceptRole[] {
  if (sourceKind === "ACTION") return ["action"];
  if (sourceKind === "VALIDATION") return ["validation"];
  if (sourceKind === "PERMISSION") return ["permission"];
  if (sourceKind === "ERROR") return ["error"];
  return [];
}

function stateRoles(value: string): ProductConceptRole[] {
  const text = value.toLowerCase();
  return uniqueSorted([
    ...(text.match(/\b(?:empty|none|blank|no\b.*\bresults?)\b/) ? (["empty_state"] as const) : []),
    ...(text.match(/\b(?:error|failed|invalid|warning)\b/) ? (["error"] as const) : []),
    ...textRoles(text)
  ]) as ProductConceptRole[];
}

function textRoles(value: string): ProductConceptRole[] {
  const text = value.toLowerCase();
  const roles: ProductConceptRole[] = [];
  if (/\b(?:workspace|tenant|organization)\b/.test(text)) roles.push("workspace");
  if (/\btab\b/.test(text)) roles.push("tab");
  if (/\b(?:modal|dialog|drawer)\b/.test(text)) roles.push("modal");
  if (/\b(?:loading|async|recalculate|refresh|sync|import|export|submit|save|delete|create|update|merge)\b/.test(text)) roles.push("async");
  if (/\b(?:recalculate|submit|save|delete|create|update|merge|import|approve|reject|assign)\b/.test(text)) roles.push("mutation");
  if (/\b(?:required|validate|validation|invalid|must|minimum|maximum)\b/.test(text)) roles.push("validation");
  if (/\b(?:permission|role|auth|access|allowed|admin)\b/.test(text)) roles.push("permission");
  if (/\b(?:error|failed|failure|warning)\b/.test(text)) roles.push("error");
  if (/\b(?:empty|no\b.*\bresults?|blank)\b/.test(text)) roles.push("empty_state");
  if (/\b(?:button|click|action|filter|search|sort)\b/.test(text)) roles.push("action");
  if (/\b(?:field|input|select|filter)\b/.test(text)) roles.push("field");
  return uniqueSorted(roles) as ProductConceptRole[];
}

function scoreRoles(roles: ProductConceptRole[], conceptKey: string) {
  const roleSet = new Set(roles);
  let score = 0;
  for (const role of roleSet) {
    if (role === "route" || role === "workspace" || role === "tab" || role === "modal") score += 2;
    else if (role === "async" || role === "mutation" || role === "validation" || role === "permission") score += 1;
    else if (role === "action" || role === "error" || role === "empty_state" || role === "field") score += 1;
  }
  if (roleSet.has("action") && roleSet.has("async") && roleSet.has("mutation")) score += 1;
  if (rootConceptTokens.some((token) => conceptKey.startsWith(`${token}-`) || conceptKey === token) && score >= 2) score += 2;
  return score;
}

function isTechnicalOnly(source: ProductConceptSource, roles: ProductConceptRole[]) {
  return source === "SCHEMA" || (source === "API_PATH" && roles.length <= 2) || (source === "CODE_MAP_EDGE" && roles.length === 0);
}

const rootConceptTokens = ["payroll", "insurance", "vessel", "crew", "contract"];

function pageKeyFromPath(filePath: string) {
  return filePath
    .replace(/^src\//, "")
    .replace(/^app\//, "")
    .replace(/^pages\//, "")
    .replace(/\/page\.(tsx|jsx|ts|js)$/, "")
    .replace(/\.(tsx|jsx|ts|js)$/, "")
    .split("/")
    .filter((part) => part && !part.startsWith("["))
    .slice(0, 3)
    .join(".")
    .toLowerCase();
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
  const roles = uniqueSorted([...left.profile.roles, ...right.profile.roles]) as ProductConceptRole[];
  return {
    ...left,
    confidence: strongerConfidence(left.confidence, right.confidence),
    evidenceIds: uniqueSorted([...left.evidenceIds, ...right.evidenceIds]),
    sourceNodeKeys: uniqueSorted([...left.sourceNodeKeys, ...right.sourceNodeKeys]),
    reasons: uniqueSorted([...left.reasons, ...right.reasons]),
    profile: {
      roles,
      score: Math.max(left.profile.score, right.profile.score, scoreRoles(roles, left.conceptKey)),
      parentPageKey: left.profile.parentPageKey ?? right.profile.parentPageKey,
      lineageReason: left.profile.lineageReason ?? right.profile.lineageReason,
      technicalOnly: left.profile.technicalOnly && right.profile.technicalOnly
    }
  };
}

function strongerConfidence(left: CodeMapConfidence, right: CodeMapConfidence): CodeMapConfidence {
  const rank: Record<CodeMapConfidence, number> = { NEEDS_REVIEW: 0, LOW: 1, MEDIUM: 2, HIGH: 3 };
  return rank[right] > rank[left] ? right : left;
}

function uniqueSorted(values: string[]) {
  return [...new Set(values)].sort();
}
