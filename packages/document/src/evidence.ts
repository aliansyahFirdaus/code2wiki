import { z } from "zod";

export const evidenceSchema = z.object({
  id: z.string().min(1),
  generationRunId: z.string().min(1),
  repositoryRole: z.enum(["FRONTEND", "BACKEND"]),
  repositoryFullName: z.string().min(1),
  tag: z.string().min(1),
  commitSha: z.string().min(1),
  filePath: z.string().min(1),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  sourceKind: z.string().min(1),
  summary: z.string(),
  codeSnippet: z.string(),
  githubUrl: z.string().url()
});

export type Evidence = z.infer<typeof evidenceSchema>;
