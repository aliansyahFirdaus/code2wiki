import { createHash } from "node:crypto";
import { z } from "zod";

import type { ProductWikiBlock, ProductWikiOutput } from "@code2wiki/document";

const candidateBlockSchema: z.ZodType<CandidateBlock> = z.lazy(() =>
  z
    .object({
      type: z.enum(["title", "heading", "paragraph", "statement", "callout", "open_question", "related_page", "divider"]),
      text: z.string().optional(),
      level: z.number().optional(),
      confidence: z.number().optional(),
      evidenceIds: z.array(z.string()).optional(),
      question: z.string().optional(),
      reason: z.string().optional(),
      relatedEvidenceIds: z.array(z.string()).optional(),
      tone: z.string().optional(),
      pageId: z.string().optional(),
      title: z.string().optional(),
      children: z.array(candidateBlockSchema).optional()
    })
    .passthrough()
);

const candidateOutputSchema = z.object({
  pages: z.array(
    z.object({
      pageKey: z.string().min(1),
      title: z.string().min(1),
      blocks: z.array(candidateBlockSchema)
    })
  )
});

type CandidateBlock = {
  type: "title" | "heading" | "paragraph" | "statement" | "callout" | "open_question" | "related_page" | "divider";
  text?: string;
  level?: number;
  confidence?: number;
  evidenceIds?: string[];
  question?: string;
  reason?: string;
  relatedEvidenceIds?: string[];
  tone?: string;
  pageId?: string;
  title?: string;
  children?: CandidateBlock[];
};

export type ValidateProductWikiOutputInput = {
  generationRunId: string;
  allowedPageKeys: string[];
  validEvidenceIds: string[];
  output: unknown;
};

export type ValidatedProductWikiOutput = ProductWikiOutput & {
  generatedStatementCount: number;
  generatedStatementWithEvidenceCount: number;
};

export function validateProductWikiOutput(input: ValidateProductWikiOutputInput): ValidatedProductWikiOutput {
  const parsed = candidateOutputSchema.safeParse(input.output);
  if (!parsed.success) {
    throw new ProductWikiValidationError(parsed.error.issues.map((issue) => issue.message));
  }

  const allowedPageKeys = new Set(input.allowedPageKeys);
  const validEvidenceIds = new Set(input.validEvidenceIds);
  const errors: string[] = [];
  const pages: ProductWikiOutput["pages"] = [];

  for (const page of parsed.data.pages) {
    if (!allowedPageKeys.has(page.pageKey)) {
      errors.push(`Page key is not allowed: ${page.pageKey}`);
      continue;
    }

    const normalizedBlocks = page.blocks.map((block, index) =>
      normalizeBlock({
        generationRunId: input.generationRunId,
        pageKey: page.pageKey,
        block,
        indexPath: [index],
        validEvidenceIds,
        errors
      })
    );

    pages.push({
      pageKey: page.pageKey,
      title: page.title,
      blocks: normalizedBlocks
    });
  }

  if (pages.length === 0) {
    errors.push("AI output did not include any valid pages.");
  }

  if (errors.length > 0) {
    throw new ProductWikiValidationError(errors);
  }

  const counts = countGeneratedStatements(pages.flatMap((page) => page.blocks));

  return {
    pages,
    ...counts
  };
}

export class ProductWikiValidationError extends Error {
  readonly validationErrors: string[];

  constructor(validationErrors: string[]) {
    super(validationErrors.join("; "));
    this.name = "ProductWikiValidationError";
    this.validationErrors = validationErrors;
  }
}

function normalizeBlock(input: {
  generationRunId: string;
  pageKey: string;
  block: CandidateBlock;
  indexPath: number[];
  validEvidenceIds: Set<string>;
  errors: string[];
}): ProductWikiBlock {
  const stableKey = `${input.pageKey}.${input.indexPath.join(".")}.${slugify(blockLabel(input.block))}`;
  const evidenceIds = (input.block.evidenceIds ?? []).filter((id) => input.validEvidenceIds.has(id));
  const relatedEvidenceIds = (input.block.relatedEvidenceIds ?? []).filter((id) => input.validEvidenceIds.has(id));
  const children = input.block.children?.map((child, index) =>
    normalizeBlock({
      ...input,
      block: child,
      indexPath: [...input.indexPath, index]
    })
  );

  if (input.block.type === "statement" && evidenceIds.length === 0) {
    input.errors.push(`CODE statement is missing valid evidence: ${stableKey}`);
  }

  const base = {
    id: `blk_${hash([input.generationRunId, stableKey].join("|"))}`,
    stableKey,
    origin: "CODE" as const,
    reviewState: input.block.type === "open_question" ? ("OPEN_QUESTION" as const) : ("VERIFIED" as const),
    sourceHash: hash([input.pageKey, input.block.type, ...evidenceIds, ...relatedEvidenceIds].join("|")),
    contentHash: hash(JSON.stringify(blockContent(input.block))),
    locked: true,
    evidenceIds,
    children
  };

  switch (input.block.type) {
    case "title":
      return { ...base, type: "title", text: requireText(input.block.text, input.errors, stableKey) };
    case "heading":
      return {
        ...base,
        type: "heading",
        level: normalizeHeadingLevel(input.block.level),
        text: requireText(input.block.text, input.errors, stableKey)
      };
    case "paragraph":
      return { ...base, type: "paragraph", text: requireText(input.block.text, input.errors, stableKey) };
    case "statement":
      return {
        ...base,
        type: "statement",
        text: requireText(input.block.text, input.errors, stableKey),
        confidence: clampConfidence(input.block.confidence),
        evidenceIds,
        lastGeneratedRunId: input.generationRunId
      };
    case "callout":
      return {
        ...base,
        type: "callout",
        tone: normalizeTone(input.block.tone),
        text: requireText(input.block.text, input.errors, stableKey)
      };
    case "open_question":
      return {
        ...base,
        type: "open_question",
        question: requireText(input.block.question ?? input.block.text, input.errors, stableKey),
        reason: requireText(input.block.reason ?? "Needs human review.", input.errors, stableKey),
        relatedEvidenceIds
      };
    case "related_page":
      return {
        ...base,
        type: "related_page",
        pageId: input.block.pageId ?? `page_${hash(input.block.title ?? stableKey)}`,
        title: requireText(input.block.title ?? input.block.text, input.errors, stableKey)
      };
    case "divider":
      return { ...base, type: "divider" };
  }
}

function countGeneratedStatements(blocks: ProductWikiBlock[]) {
  let generatedStatementCount = 0;
  let generatedStatementWithEvidenceCount = 0;

  for (const block of blocks) {
    if (block.type === "statement" && block.origin === "CODE") {
      generatedStatementCount += 1;
      if (block.evidenceIds.length > 0) {
        generatedStatementWithEvidenceCount += 1;
      }
    }

    if (block.children) {
      const childCounts = countGeneratedStatements(block.children);
      generatedStatementCount += childCounts.generatedStatementCount;
      generatedStatementWithEvidenceCount += childCounts.generatedStatementWithEvidenceCount;
    }
  }

  return { generatedStatementCount, generatedStatementWithEvidenceCount };
}

function requireText(value: string | undefined, errors: string[], stableKey: string) {
  const text = value?.trim();
  if (!text) {
    errors.push(`Block is missing text: ${stableKey}`);
    return "";
  }
  return text;
}

function normalizeHeadingLevel(level: number | undefined) {
  return level === 1 || level === 2 || level === 3 ? level : 2;
}

function normalizeTone(tone: string | undefined) {
  return tone === "warning" || tone === "success" ? tone : "info";
}

function clampConfidence(confidence: number | undefined) {
  if (typeof confidence !== "number" || Number.isNaN(confidence)) {
    return 0.75;
  }
  return Math.max(0, Math.min(1, confidence));
}

function blockLabel(block: CandidateBlock) {
  return block.text ?? block.question ?? block.title ?? block.type;
}

function blockContent(block: CandidateBlock) {
  return {
    type: block.type,
    text: block.text,
    level: block.level,
    confidence: block.confidence,
    evidenceIds: block.evidenceIds,
    question: block.question,
    reason: block.reason,
    relatedEvidenceIds: block.relatedEvidenceIds,
    tone: block.tone,
    pageId: block.pageId,
    title: block.title
  };
}

function slugify(value: string) {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return slug || "block";
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}
