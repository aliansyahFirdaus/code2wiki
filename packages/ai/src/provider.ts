import type { ProductWikiBlock } from "@code2wiki/document";

export type GenerateProductWikiFact = {
  id: string;
  repositoryRole: "FRONTEND" | "BACKEND";
  repositoryFullName: string;
  tag: string;
  commitSha: string;
  factKind: string;
  text: string;
  evidenceIds: string[];
  confidence: number;
};

export type GenerateProductWikiEvidence = {
  id: string;
  repositoryRole: "FRONTEND" | "BACKEND";
  repositoryFullName: string;
  tag: string;
  commitSha: string;
  filePath: string;
  startLine: number;
  endLine: number;
  sourceKind: string;
  summary: string;
  githubUrl: string;
};

export type ProductWikiPageGroup = {
  pageKey: string;
  title: string;
  facts: GenerateProductWikiFact[];
  evidence: GenerateProductWikiEvidence[];
  existingPage?: {
    title: string;
    blocks: ProductWikiBlock[];
  };
};

export type GenerateProductWikiInput = {
  generationRunId: string;
  pageGroups: ProductWikiPageGroup[];
};

export type GenerateProductWikiRepairInput = {
  invalidOutput: unknown;
  validationErrors: string[];
};

export type ProviderUsage = {
  provider: string;
  model: string;
  promptTokenEstimate: number;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  inputCharCount: number;
  outputCharCount: number;
};

export type SupportedAIProvider = "openrouter";

export type AIProviderCapabilities = {
  provider: SupportedAIProvider;
  model: string;
  supportsStrictJsonSchema: boolean;
  supportsUsage: boolean;
  supportsRepair: boolean;
  usageSource: "provider";
  structuredOutputMode: "json_schema";
};

export type AIProviderConfig = {
  provider: SupportedAIProvider;
  model: string;
  apiKey?: string;
  baseUrl?: string;
};

export type GenerateProductWikiResult = {
  output: unknown;
  usage: ProviderUsage;
};

export type AIProvider = {
  capabilities?: AIProviderCapabilities;
  generateProductWiki(input: GenerateProductWikiInput, repair?: GenerateProductWikiRepairInput): Promise<GenerateProductWikiResult>;
};

export class ProviderConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderConfigurationError";
  }
}

export class StructuredOutputUnsupportedError extends Error {
  constructor(message = "MODEL_DOES_NOT_SUPPORT_STRUCTURED_OUTPUT") {
    super(message);
    this.name = "StructuredOutputUnsupportedError";
  }
}
