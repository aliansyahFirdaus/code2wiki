import type { RepositoryRole } from "@code2wiki/shared";

export type EvidenceSourceKind =
  | "ROUTE"
  | "COMPONENT"
  | "FORM"
  | "ACTION"
  | "API_CALL"
  | "NAVIGATION"
  | "VALIDATION"
  | "HANDLER"
  | "SERVICE"
  | "PERMISSION"
  | "MODEL"
  | "OTHER";

export type ScannerEvidence = {
  evidenceKey: string;
  repositoryRole: RepositoryRole;
  filePath: string;
  startLine: number;
  endLine: number;
  sourceKind: EvidenceSourceKind;
  summary: string;
  codeSnippet: string;
};
