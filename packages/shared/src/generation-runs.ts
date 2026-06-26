export const generationRunExecutionModes = ["AUTO", "MANUAL"] as const;
export type GenerationRunExecutionMode = (typeof generationRunExecutionModes)[number];
export const generationRunControlStates = ["ACTIVE", "PAUSED", "CANCEL_REQUESTED"] as const;
export type GenerationRunControlState = (typeof generationRunControlStates)[number];

export const advanceableGenerationStatuses = ["QUEUED", "CLONED", "FACTS_EXTRACTED"] as const;
export type AdvanceableGenerationStatus = (typeof advanceableGenerationStatuses)[number];

export const topLevelGenerationStages = ["clone", "analyze", "generate"] as const;
export type TopLevelGenerationStage = (typeof topLevelGenerationStages)[number];

export function nextTopLevelStageForStatus(status: string): TopLevelGenerationStage | null {
  if (status === "QUEUED") return "clone";
  if (status === "CLONED") return "analyze";
  if (status === "FACTS_EXTRACTED" || status === "AI_GENERATING") return "generate";
  return null;
}

export function isAdvanceableGenerationStatus(status: string): status is AdvanceableGenerationStatus {
  return advanceableGenerationStatuses.includes(status as AdvanceableGenerationStatus);
}

export function topLevelStageActionLabel(stage: TopLevelGenerationStage) {
  if (stage === "clone") return "Run clone";
  if (stage === "analyze") return "Run analyze";
  return "Run generation";
}

export function isTerminalGenerationStatus(status: string) {
  return status === "COMPLETED" || status === "CANCELED" || status === "FAILED" || status === "AI_OUTPUT_INVALID" || status === "NEEDS_REVIEW";
}
