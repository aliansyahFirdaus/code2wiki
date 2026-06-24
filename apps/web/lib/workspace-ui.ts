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
const visibleDebugEventLimit = 200;
type StepState = "done" | "active" | "pending";

export type WorkspaceDebugEvent = {
  id: string;
  eventType: string;
  severity: string;
  stage?: string;
  message?: string;
  payloadJson?: Record<string, unknown>;
};

export type CoverageGap = {
  pageKey: string | null;
  reason: string | null;
};

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
    state: (index < active || status === "COMPLETED" ? "done" : index === active ? "active" : "pending") as StepState
  }));
}

export function severityTone(severity: string) {
  if (severity === "ERROR") return "red";
  if (severity === "WARN") return "amber";
  return "neutral";
}

export function mergeDebugEvents<T extends { id: string }>(existing: T[], incoming: T[]) {
  const seen = new Set(existing.map((event) => event.id));
  const merged = [...existing];
  for (const event of incoming) {
    if (!seen.has(event.id)) {
      merged.push(event);
      seen.add(event.id);
    }
  }
  return merged.slice(-visibleDebugEventLimit);
}

export function debuggerFlowFromEvents(events: WorkspaceDebugEvent[]) {
  const lanes = [
    { key: "baseline", label: "Baseline", types: ["BASELINE_MISSING", "BASELINE_FOUND"] },
    { key: "candidates", label: "Candidates", types: ["PAGE_CANDIDATES_BUILT"] },
    { key: "reused", label: "Reused", types: ["PAGE_REUSED"] },
    { key: "affected", label: "Affected", types: ["PAGE_AFFECTED"] },
    { key: "queued", label: "Queued", types: ["TASK_QUEUED"] },
    { key: "written", label: "Written", types: ["PAGE_WRITTEN"] },
    { key: "coverage", label: "Coverage", types: ["COVERAGE_STARTED", "COVERAGE_GAP_FOUND", "COVERAGE_ACCEPTED", "COVERAGE_NEEDS_REVIEW"] }
  ] as const;

  return lanes.map((lane) => {
    const laneEvents = events.filter((event) => (lane.types as readonly string[]).includes(event.eventType));
    return {
      key: lane.key,
      label: lane.label,
      count: laneEvents.length,
      latest: laneEvents.at(-1) ? flowEventLabel(laneEvents.at(-1)!) : "not available yet"
    };
  });
}

export function groupCoverageGaps(gaps: CoverageGap[]) {
  const groups = new Map<string, { reason: string; pageKey: string; count: number }>();
  for (const gap of gaps) {
    const reason = gap.reason ?? "unknown reason";
    const pageKey = gap.pageKey ?? "unknown page";
    const key = `${reason}\u0000${pageKey}`;
    const existing = groups.get(key);
    groups.set(key, existing ? { ...existing, count: existing.count + 1 } : { reason, pageKey, count: 1 });
  }
  return [...groups.values()].sort((left, right) => left.reason.localeCompare(right.reason) || left.pageKey.localeCompare(right.pageKey));
}

function flowEventLabel(event: WorkspaceDebugEvent) {
  const payload = event.payloadJson ?? {};
  const pageKey = stringValue(payload.pageKey);
  const dedupeKey = stringValue(payload.dedupeKey);
  const baselineGenerationRunId = stringValue(payload.baselineGenerationRunId);
  return pageKey ?? dedupeKey ?? baselineGenerationRunId ?? event.message ?? event.eventType;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : null;
}
