import type { GenerateProductWikiInput } from "./provider";

export type ProductWikiMessage = {
  role: "system" | "user";
  content: string;
};

const systemPrompt = [
  "Generate Code2Wiki ProductWikiBlock JSON from deterministic code evidence only.",
  "Return ONLY one JSON object. Do not output markdown, prose wrappers, or a markdown canonical document; no markdown is canonical.",
  "The top-level object MUST use exactly this shape: {\"pages\":[...]}",
  "Never use top-level keys such as wikiBlocks, blocks, documents, data, result, or output.",
  "Each page MUST contain pageKey, title, and blocks.",
  "Each block MUST contain type. Use block.type, never blockType.",
  "For sourced behavior, use type=\"statement\", text, and evidenceIds.",
  "Use evidenceIds as an array of strings, never evidenceReferences.",
  "Do not browse, inspect files, ask for hidden context, or assume context that is not in the provided pageGroups.",
  "Use only provided pageGroups, facts, evidence, allowed pageKeys, and evidence IDs.",
  "Never invent evidence IDs. Every CODE statement must use valid provided evidenceIds.",
  "Unsupported behavior must be omitted, treated as NEEDS_REVIEW, or represented as open_question; prefer omit/open_question because reviewState is normalized locally.",
  "Do not expose local paths, secrets, tokens, env values, Authorization headers, provider metadata, or raw hidden context.",
  "Write user-facing product stories, not implementation explanations.",
  "Do not use technical implementation terms such as API, endpoint, handler, SQL, database, frontend, backend, component, route, function, schema, or code identifiers unless that exact term is visibly user-facing in the product evidence.",
  "Valid minimal example: {\"pages\":[{\"pageKey\":\"payroll.vessel-bonus\",\"title\":\"Payroll Vessel Bonus\",\"blocks\":[{\"type\":\"title\",\"text\":\"Payroll Vessel Bonus\"},{\"type\":\"statement\",\"text\":\"Users can review Vessel Bonus payroll values before recalculating payroll.\",\"evidenceIds\":[\"ev_manual_1\"],\"confidence\":0.9}]}]}"
].join("\n");

const blockContract = {
  title: "Page title only.",
  heading: "Section labels only.",
  paragraph: "Brief overview/context only; no unsupported behavior claims.",
  statement: "Source-backed product behavior with valid provided evidenceIds.",
  callout: "Important warning or operational note only when evidence-backed by context.",
  open_question: "Missing, incomplete, or ambiguous evidence needing human review.",
  related_page: "Only if the page is provided and allowed by input.",
  divider: "Optional formatting only; use sparingly."
} as const;

const evidencePolicy = [
  "statement blocks require valid provided evidenceIds.",
  "Evidence must directly support the exact statement text.",
  "Use same-run provided IDs only.",
  "Weak, incomplete, ambiguous, or low-confidence support must be omitted or written as open_question.",
  "Unsupported behavior must be omitted, treated as NEEDS_REVIEW, or written as open_question.",
  "Never invent evidence IDs.",
  "Never make a claim without evidence.",
  "Never expose local paths, secrets, tokens, env values, Authorization headers, provider metadata, or raw hidden context."
] as const;

const styleGuide = [
  "Write product knowledge, not implementation trivia.",
  "Audience: product, operations, support, QA, and implementation readers who need product behavior without implementation prose.",
  "Write complete product docs, not terse bullet dumps.",
  "Make the page read like a clear feature story: context, user goal, main flow, important variations, business rules, permissions, side effects, empty/error states, and operational impact.",
  "Use natural section headings and combine related evidence into coherent statements when the evidence directly supports the same user-visible behavior.",
  "Avoid generic repeated phrasing such as \"This page allows users to\"; explain what happens, when it happens, and why it matters.",
  "Be factual, specific, and non-marketing.",
  "Explain user-visible flows, business rules, validations, permissions, side effects, error states, and dependencies.",
  "Avoid file names, route names, component names, function names, and code-map stable keys unless user-visible and evidence-backed.",
  "Prefer what happens and under what condition over where code lives.",
  "For updates, return the full updated page using existingPage as context; do not return a patch."
] as const;

const stagedInstructions = [
  {
    stage: "Page Planning",
    instructions: [
      "For each allowed pageKey, identify useful product behavior sections from provided facts and evidence only.",
      "Do not infer product intent from file names, route names, component names, function names, labels, or stable keys alone."
    ]
  },
  {
    stage: "Product Page Writing",
    instructions: [
      "Write concise ProductWikiBlock pages in product-story language.",
      "Prefer flows, business rules, validations, permissions, side effects, error states, and dependencies over code trivia.",
      "Do not mention implementation mechanics or technical layers in user-facing text."
    ]
  },
  {
    stage: "Evidence Criticism",
    instructions: [
      "Before final JSON, reject every statement whose evidenceIds do not directly support the exact claim.",
      "If support is weak, low-confidence, incomplete, or ambiguous, omit it or create an open_question with relatedEvidenceIds when uncertainty is evidence-backed."
    ]
  },
  {
    stage: "JSON Finalization",
    instructions: [
      "Return only schema-compatible JSON.",
      "Use only allowed pageKeys and provided evidence IDs.",
      "Do not include markdown, prose wrappers, local paths, secrets, tokens, env values, Authorization headers, provider metadata, or hidden context."
    ]
  }
] as const;

const repairPolicy = [
  "Repair JSON only.",
  "Do not regenerate the document conceptually.",
  "Do not introduce new claims.",
  "Preserve valid evidenceIds.",
  "Remove invalid or invented evidenceIds.",
  "Remove unsupported statements.",
  "Convert unsupported behavior to open_question only if provided evidence supports uncertainty.",
  "Keep pageKeys allowed.",
  "Keep schema-compatible JSON."
] as const;

export function buildProductWikiMessages(input: GenerateProductWikiInput): ProductWikiMessage[] {
  return messagesForPayload({
    task: "generate_product_wiki",
    generationRunId: input.generationRunId,
    allowedPageKeys: input.pageGroups.map((group) => group.pageKey),
    blockContract,
    evidencePolicy,
    styleGuide,
    stagedInstructions,
    pageGroups: input.pageGroups
  });
}

export function buildProductWikiRepairMessages(
  input: GenerateProductWikiInput,
  invalidOutput: unknown,
  validationErrors: string[]
): ProductWikiMessage[] {
  return messagesForPayload({
    task: "repair_product_wiki_json",
    generationRunId: input.generationRunId,
    allowedPageKeys: input.pageGroups.map((group) => group.pageKey),
    blockContract,
    evidencePolicy,
    styleGuide,
    stagedInstructions: [
      ...stagedInstructions,
      {
        stage: "JSON Repair",
        instructions: repairPolicy
      }
    ],
    pageGroups: input.pageGroups,
    repairPolicy,
    invalidOutput,
    validationErrors
  });
}

function messagesForPayload(payload: Record<string, unknown>): ProductWikiMessage[] {
  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: stableStringify(sanitizeForPrompt(payload)) }
  ];
}

function sanitizeForPrompt(value: unknown): unknown {
  if (typeof value === "string") {
    return sanitizeString(value);
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeForPrompt);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeForPrompt(item)]));
  }
  return value;
}

function sanitizeString(value: string) {
  return value
    .replace(/(?:\/tmp|\/private|\/Users|\/home)\/[^\s"'`),]*/g, "[redacted-local-path]")
    .replace(/[A-Za-z]:\\[^\s"'`),]*/g, "[redacted-local-path]")
    .replace(/\bAuthorization\s*:\s*Bearer\s+[A-Za-z0-9._-]+/gi, "Authorization: Bearer [redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .replace(/\b(?:sk|pk|rk|or)-[A-Za-z0-9_-]{12,}\b/g, "[redacted-token]")
    .replace(/\b[A-Z][A-Z0-9_]{2,}\s*=\s*[^,\s"'`]+/g, "[redacted-env]")
    .replace(/\b(?:raw\s+)?provider metadata\s*[:=]\s*[^,\n"}]+/gi, "provider metadata: [redacted]");
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, sortKeys(item)]));
  }
  return value;
}
