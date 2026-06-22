import { z } from "zod";

export const blockOriginSchema = z.enum(["CODE", "MANUAL", "CODE_EDITED"]);
export const reviewStateSchema = z.enum(["VERIFIED", "NEEDS_REVIEW", "OPEN_QUESTION"]);

export const productWikiBlockBaseSchema = z.object({
  id: z.string().min(1),
  stableKey: z.string().min(1),
  type: z.enum([
    "title",
    "heading",
    "paragraph",
    "statement",
    "callout",
    "open_question",
    "related_page",
    "divider"
  ]),
  origin: blockOriginSchema,
  reviewState: reviewStateSchema,
  sourceHash: z.string().min(1),
  contentHash: z.string().min(1),
  locked: z.boolean(),
  evidenceIds: z.array(z.string()).optional()
});

export type BlockOrigin = z.infer<typeof blockOriginSchema>;
export type ReviewState = z.infer<typeof reviewStateSchema>;

type ProductWikiBlockSchema = z.ZodType<ProductWikiBlock>;

export const productWikiBlockSchema: ProductWikiBlockSchema = z.lazy(() =>
  z.discriminatedUnion("type", [
    productWikiBlockBaseSchema
      .extend({
        type: z.literal("title"),
        text: z.string().min(1),
        children: z.array(productWikiBlockSchema).optional()
      }),
    productWikiBlockBaseSchema
      .extend({
        type: z.literal("heading"),
        level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
        text: z.string().min(1),
        children: z.array(productWikiBlockSchema).optional()
      }),
    productWikiBlockBaseSchema
      .extend({
        type: z.literal("paragraph"),
        text: z.string().min(1),
        children: z.array(productWikiBlockSchema).optional()
      }),
    productWikiBlockBaseSchema
      .extend({
        type: z.literal("statement"),
        text: z.string().min(1),
        confidence: z.number().min(0).max(1),
        evidenceIds: z.array(z.string().min(1)),
        lastGeneratedRunId: z.string().min(1),
        children: z.array(productWikiBlockSchema).optional()
      }),
    productWikiBlockBaseSchema
      .extend({
        type: z.literal("callout"),
        tone: z.enum(["info", "warning", "success"]),
        text: z.string().min(1),
        children: z.array(productWikiBlockSchema).optional()
      }),
    productWikiBlockBaseSchema
      .extend({
        type: z.literal("open_question"),
        question: z.string().min(1),
        reason: z.string().min(1),
        relatedEvidenceIds: z.array(z.string().min(1)).optional(),
        children: z.array(productWikiBlockSchema).optional()
      }),
    productWikiBlockBaseSchema
      .extend({
        type: z.literal("related_page"),
        pageId: z.string().min(1),
        title: z.string().min(1),
        children: z.array(productWikiBlockSchema).optional()
      }),
    productWikiBlockBaseSchema.extend({
      type: z.literal("divider"),
      children: z.array(productWikiBlockSchema).optional()
    })
  ])
);

export const productWikiPageSchema = z.object({
  pageKey: z.string().min(1),
  title: z.string().min(1),
  blocks: z.array(productWikiBlockSchema)
});

export const productWikiOutputSchema = z.object({
  pages: z.array(productWikiPageSchema)
});

export type ProductWikiBlock =
  | TitleBlock
  | HeadingBlock
  | ParagraphBlock
  | StatementBlock
  | CalloutBlock
  | OpenQuestionBlock
  | RelatedPageBlock
  | DividerBlock;

export type ProductWikiBlockBase = z.infer<typeof productWikiBlockBaseSchema> & {
  children?: ProductWikiBlock[];
};

export type TitleBlock = ProductWikiBlockBase & {
  type: "title";
  text: string;
};

export type HeadingBlock = ProductWikiBlockBase & {
  type: "heading";
  level: 1 | 2 | 3;
  text: string;
};

export type ParagraphBlock = ProductWikiBlockBase & {
  type: "paragraph";
  text: string;
};

export type StatementBlock = ProductWikiBlockBase & {
  type: "statement";
  text: string;
  confidence: number;
  evidenceIds: string[];
  lastGeneratedRunId: string;
};

export type CalloutBlock = ProductWikiBlockBase & {
  type: "callout";
  tone: "info" | "warning" | "success";
  text: string;
};

export type OpenQuestionBlock = ProductWikiBlockBase & {
  type: "open_question";
  question: string;
  reason: string;
  relatedEvidenceIds?: string[];
};

export type RelatedPageBlock = ProductWikiBlockBase & {
  type: "related_page";
  pageId: string;
  title: string;
};

export type DividerBlock = ProductWikiBlockBase & {
  type: "divider";
};

export type ProductWikiBlockTree = {
  pageKey: string;
  blocks: ProductWikiBlock[];
};

export type ProductWikiPage = z.infer<typeof productWikiPageSchema>;
export type ProductWikiOutput = z.infer<typeof productWikiOutputSchema>;
