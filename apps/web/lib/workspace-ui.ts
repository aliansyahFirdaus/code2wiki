import {
  isAdvanceableGenerationStatus,
  nextTopLevelStageForStatus,
  topLevelStageActionLabel,
  type GenerationRunControlState,
  type GenerationRunExecutionMode
} from "@code2wiki/shared";

export type GenerationStatus =
  | "QUEUED"
  | "WAITING_FOR_PAIR"
  | "CLONING"
  | "CLONED"
  | "SCANNING"
  | "FACTS_EXTRACTED"
  | "AI_GENERATING"
  | "VALIDATING"
  | "COMPLETED"
  | "CANCELED"
  | "NEEDS_REVIEW"
  | "FAILED"
  | "AI_OUTPUT_INVALID";

export const generationSteps = ["Queue", "Clone", "Analyze", "Explore", "Write", "Check", "Done"] as const;
const visibleDebugEventLimit = 200;
export type DebuggerStep = (typeof generationSteps)[number];
type StepState = "done" | "active" | "pending" | "error";

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

export function nextActionLabel(
  status: GenerationStatus,
  executionMode: GenerationRunExecutionMode = "AUTO",
  advanceRequestedAt: string | null = null,
  controlState: GenerationRunControlState = "ACTIVE"
) {
  if (controlState === "PAUSED") return "Operator: Resume run";
  if (controlState === "CANCEL_REQUESTED") return "Worker: Stop safely";
  const stage = nextTopLevelStageForStatus(status);
  if (stage) {
    if (executionMode === "MANUAL") {
      return advanceRequestedAt ? `${topLevelStageActionLabel(stage)} queued` : `Operator: ${topLevelStageActionLabel(stage)}`;
    }
    return `Worker: ${topLevelStageActionLabel(stage)}`;
  }
  if (status === "AI_GENERATING") return "Run generation";
  if (status === "FAILED" || status === "AI_OUTPUT_INVALID" || status === "NEEDS_REVIEW") return "Blocked / needs review";
  if (status === "CANCELED") return "Canceled";
  if (status === "COMPLETED") return "Done";
  return "Waiting";
}

export function executionModeLabel(executionMode: GenerationRunExecutionMode) {
  return executionMode === "AUTO" ? "Auto worker" : "Manual";
}

export function executionStateLabel(
  status: GenerationStatus,
  executionMode: GenerationRunExecutionMode,
  advanceRequestedAt: string | null,
  controlState: GenerationRunControlState = "ACTIVE"
) {
  if (controlState === "PAUSED") return "Paused";
  if (controlState === "CANCEL_REQUESTED") return "Cancel requested";
  if (executionMode === "MANUAL" && isAdvanceableGenerationStatus(status)) {
    return advanceRequestedAt ? "Next step queued" : "Waiting for operator";
  }
  if (executionMode === "AUTO" && isAdvanceableGenerationStatus(status)) {
    return "Waiting for worker";
  }
  if (status === "CLONING" || status === "SCANNING" || status === "AI_GENERATING" || status === "VALIDATING") {
    return "Worker in progress";
  }
  if (status === "COMPLETED") return "Run complete";
  if (status === "CANCELED") return "Run canceled";
  if (status === "FAILED" || status === "AI_OUTPUT_INVALID" || status === "NEEDS_REVIEW") return "Needs review";
  return "Waiting";
}

export function canRequestNextStep(status: GenerationStatus, executionMode: GenerationRunExecutionMode, controlState: GenerationRunControlState = "ACTIVE") {
  return controlState === "ACTIVE" && executionMode === "MANUAL" && isAdvanceableGenerationStatus(status);
}

export function generationStepState(status: GenerationStatus) {
  const isError = status === "FAILED" || status === "AI_OUTPUT_INVALID" || status === "NEEDS_REVIEW";
  const isCanceled = status === "CANCELED";
  const active =
    status === "QUEUED" || status === "WAITING_FOR_PAIR" ? 0 :
      status === "CLONING" ? 1 :
        status === "CLONED" || status === "SCANNING" ? 2 :
          status === "FACTS_EXTRACTED" || status === "AI_GENERATING" ? 3 :
            status === "AI_OUTPUT_INVALID" ? 4 :
              status === "VALIDATING" || status === "NEEDS_REVIEW" || status === "FAILED" ? 5 :
                status === "CANCELED" ? 6 : 6;
  return generationSteps.map((label, index) => ({
    label,
    state: (
      index < active || status === "COMPLETED"
        ? "done"
        : index === active
          ? (isCanceled ? "done" : isError ? "error" : "active")
          : "pending"
    ) as StepState
  }));
}

export function severityTone(severity: string) {
  if (severity === "ERROR") return "red";
  if (severity === "WARN") return "amber";
  return "neutral";
}

export function debugEventLabel(eventType: string) {
  const labels: Record<string, string> = {
    AI_PAGE_WRITE_REPAIR_STARTED: "AI repair started",
    AI_PAGE_WRITE_STARTED: "AI writing page",
    ANALYZE_DONE: "Analyze done",
    ANALYZE_FAILED: "Analyze failed",
    ANALYZE_STARTED: "Analyze started",
    BASELINE_FOUND: "Baseline found",
    BASELINE_MISSING: "No baseline",
    CLONE_DONE: "Clone done",
    CLONE_FAILED: "Clone failed",
    CLONE_STARTED: "Clone started",
    COVERAGE_ACCEPTED: "Coverage accepted",
    COVERAGE_GAP_FOUND: "Coverage gap",
    COVERAGE_GAP_UNROUTED: "Coverage gap unrouted",
    COVERAGE_NEEDS_REVIEW: "Coverage needs review",
    COVERAGE_STARTED: "Coverage check started",
    EVIDENCE_REMAP_FAILED: "Evidence remap failed",
    PAGE_AFFECTED: "Page affected",
    PAGE_CANDIDATES_BUILT: "Page candidates built",
    PAGE_REUSED: "Page reused",
    PAGE_WRITTEN: "Page written",
    RUN_COMPLETED: "Run completed",
    RUN_CANCELED: "Run canceled",
    RUN_FAILED: "Run failed",
    RUN_NEEDS_REVIEW: "Run needs review",
    TASK_FAILED: "Task failed",
    TASK_FINISHED: "Task finished",
    TASK_QUEUED: "Task queued",
    TASK_REQUEUED: "Task re-queued",
    TASK_STARTED: "Task started"
  };
  return labels[eventType] ?? humanizeEnum(eventType);
}

export function debugStageLabel(stage: string) {
  const labels: Record<string, string> = {
    completion: "Completion",
    analyze: "Analyze",
    clone: "Clone",
    coverage: "Coverage",
    incremental_planner: "Planner",
    page_writer: "Page writer",
    task_queue: "Task queue"
  };
  return labels[stage] ?? humanizeEnum(stage);
}

export function debuggerStepForTask(taskType: string): DebuggerStep {
  if (taskType === "DISCOVER_SURFACE" || taskType === "TRACE_BEHAVIOR" || taskType === "DISCOVER_RELATED_CONCEPTS") return "Explore";
  if (taskType === "CREATE_PAGE" || taskType === "UPDATE_PAGE") return "Write";
  if (taskType === "EVALUATE_COVERAGE") return "Check";
  return "Explore";
}

export function debuggerStepForEvent(event: WorkspaceDebugEvent): DebuggerStep {
  if (event.stage === "clone" || event.eventType.startsWith("CLONE_")) return "Clone";
  if (event.stage === "analyze" || event.eventType.startsWith("ANALYZE_")) return "Analyze";
  if (event.stage === "coverage" || event.eventType.startsWith("COVERAGE_")) return "Check";
  if (event.stage === "completion" || event.eventType.startsWith("RUN_")) return "Done";
  const taskType = typeof event.payloadJson?.taskType === "string" ? event.payloadJson.taskType : null;
  if (taskType) return debuggerStepForTask(taskType);
  if (event.eventType.startsWith("AI_PAGE_WRITE_") || event.eventType === "PAGE_WRITTEN") return "Write";
  return "Explore";
}

export function taskTypeLabel(taskType: string) {
  const labels: Record<string, string> = {
    CREATE_PAGE: "Create page",
    DISCOVER_RELATED_CONCEPTS: "Discover related",
    DISCOVER_SURFACE: "Discover surface",
    EVALUATE_COVERAGE: "Evaluate coverage",
    TRACE_BEHAVIOR: "Trace behavior",
    UPDATE_PAGE: "Update page"
  };
  return labels[taskType] ?? humanizeEnum(taskType);
}

export function runStatusLabel(status: string) {
  const labels: Record<string, string> = {
    AI_GENERATING: "Generating pages",
    AI_OUTPUT_INVALID: "AI output invalid",
    CANCELED: "Force stopped",
    CLONED: "Clone complete",
    CLONING: "Cloning repos",
    COMPLETED: "Completed",
    FACTS_EXTRACTED: "Facts extracted",
    FAILED: "Failed",
    NEEDS_REVIEW: "Needs review",
    QUEUED: "Queued",
    SCANNING: "Scanning code",
    VALIDATING: "Validating coverage",
    WAITING_FOR_PAIR: "Waiting for matching tag"
  };
  return labels[status] ?? humanizeEnum(status);
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

function humanizeEnum(value: string) {
  return value
    .toLowerCase()
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}
