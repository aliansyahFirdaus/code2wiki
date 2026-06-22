import type { ProductWikiBlockTree } from "@code2wiki/document";

export type GenerateProductWikiInput = {
  generationRunId: string;
  facts: unknown[];
  evidence: unknown[];
};

export type AIProvider = {
  generateProductWiki(input: GenerateProductWikiInput): Promise<ProductWikiBlockTree>;
};
