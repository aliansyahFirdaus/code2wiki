import type { AIProvider, GenerateProductWikiInput } from "./provider";
import type { ProductWikiBlockTree } from "@code2wiki/document";

export class OpenRouterProvider implements AIProvider {
  async generateProductWiki(_input: GenerateProductWikiInput): Promise<ProductWikiBlockTree> {
    throw new Error("OpenRouter generation is not implemented in Phase 1.");
  }
}
