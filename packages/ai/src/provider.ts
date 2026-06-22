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
};

export type GenerateProductWikiInput = {
  generationRunId: string;
  pageGroups: ProductWikiPageGroup[];
};

export type GenerateProductWikiRepairInput = {
  invalidOutput: unknown;
  validationErrors: string[];
};

export type AIProvider = {
  generateProductWiki(input: GenerateProductWikiInput, repair?: GenerateProductWikiRepairInput): Promise<unknown>;
};

export class StructuredOutputUnsupportedError extends Error {
  constructor(message = "MODEL_DOES_NOT_SUPPORT_STRUCTURED_OUTPUT") {
    super(message);
    this.name = "StructuredOutputUnsupportedError";
  }
}
