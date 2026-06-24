type GenerationStatus =
  | "QUEUED"
  | "WAITING_FOR_PAIR"
  | "CLONING"
  | "CLONED"
  | "SCANNING"
  | "FACTS_EXTRACTED"
  | "AI_GENERATING"
  | "VALIDATING"
  | "COMPLETED"
  | "NEEDS_REVIEW"
  | "FAILED"
  | "AI_OUTPUT_INVALID";

export const generationSteps = ["Queue", "Clone", "Analyze", "Generate", "Coverage", "Done"] as const;

export function nextActionLabel(status: GenerationStatus) {
  if (status === "QUEUED") return "Run clone";
  if (status === "CLONED") return "Run analyze";
  if (status === "FACTS_EXTRACTED" || status === "AI_GENERATING") return "Run generation";
  if (status === "FAILED" || status === "AI_OUTPUT_INVALID" || status === "NEEDS_REVIEW") return "Blocked / needs review";
  if (status === "COMPLETED") return "Done";
  return "Waiting";
}

export function generationStepState(status: GenerationStatus) {
  const active =
    status === "QUEUED" || status === "WAITING_FOR_PAIR" ? 0 :
      status === "CLONING" ? 1 :
        status === "CLONED" || status === "SCANNING" ? 2 :
          status === "FACTS_EXTRACTED" || status === "AI_GENERATING" ? 3 :
            status === "VALIDATING" || status === "NEEDS_REVIEW" || status === "AI_OUTPUT_INVALID" || status === "FAILED" ? 4 :
              5;
  return generationSteps.map((label, index) => ({
    label,
    state: index < active || status === "COMPLETED" ? "done" : index === active ? "active" : "pending"
  }));
}
