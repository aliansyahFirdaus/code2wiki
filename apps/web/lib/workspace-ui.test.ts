import { describe, expect, it } from "vitest";

import { canRequestNextStep, debugEventLabel, debugStageLabel, debuggerFlowFromEvents, debuggerStepForEvent, debuggerStepForTask, executionStateLabel, generationStepState, groupCoverageGaps, mergeDebugEvents, nextActionLabel, runStatusLabel, severityTone, taskTypeLabel } from "./workspace-ui";

describe("workspace UI helpers", () => {
  it("maps generation status to next action labels", () => {
    expect(nextActionLabel("QUEUED")).toBe("Worker: Run clone");
    expect(nextActionLabel("CLONED")).toBe("Worker: Run analyze");
    expect(nextActionLabel("FACTS_EXTRACTED")).toBe("Worker: Run generation");
    expect(nextActionLabel("QUEUED", "MANUAL", null)).toBe("Operator: Run clone");
    expect(nextActionLabel("QUEUED", "MANUAL", "2026-06-26T00:00:00.000Z")).toBe("Run clone queued");
    expect(nextActionLabel("AI_GENERATING")).toBe("Worker: Run generation");
    expect(nextActionLabel("AI_GENERATING", "AUTO", null, "PAUSED")).toBe("Operator: Resume run");
    expect(nextActionLabel("AI_GENERATING", "AUTO", null, "CANCEL_REQUESTED")).toBe("Worker: Stop safely");
    expect(nextActionLabel("NEEDS_REVIEW")).toBe("Blocked / needs review");
    expect(nextActionLabel("COMPLETED")).toBe("Done");
  });

  it("describes execution state and button availability for manual runs", () => {
    expect(executionStateLabel("QUEUED", "MANUAL", null)).toBe("Waiting for operator");
    expect(executionStateLabel("QUEUED", "MANUAL", "2026-06-26T00:00:00.000Z")).toBe("Next step queued");
    expect(executionStateLabel("CLONING", "AUTO", null)).toBe("Worker in progress");
    expect(executionStateLabel("AI_GENERATING", "AUTO", null, "PAUSED")).toBe("Paused");
    expect(executionStateLabel("AI_GENERATING", "AUTO", null, "CANCEL_REQUESTED")).toBe("Cancel requested");
    expect(canRequestNextStep("QUEUED", "MANUAL")).toBe(true);
    expect(canRequestNextStep("QUEUED", "AUTO")).toBe(false);
    expect(canRequestNextStep("AI_GENERATING", "MANUAL")).toBe(false);
    expect(canRequestNextStep("QUEUED", "MANUAL", "PAUSED")).toBe(false);
  });

  it("maps generation status to compact step states", () => {
    expect(generationStepState("AI_GENERATING")).toMatchObject([
      { label: "Queue", state: "done" },
      { label: "Clone", state: "done" },
      { label: "Analyze", state: "done" },
      { label: "Explore", state: "active" },
      { label: "Write", state: "pending" },
      { label: "Check", state: "pending" },
      { label: "Done", state: "pending" }
    ]);
    expect(generationStepState("COMPLETED").every((step) => step.state === "done")).toBe(true);
    expect(generationStepState("CANCELED")[6]).toMatchObject({ label: "Done", state: "done" });
    expect(generationStepState("AI_OUTPUT_INVALID")[4]).toMatchObject({ label: "Write", state: "error" });
    expect(generationStepState("NEEDS_REVIEW")[5]).toMatchObject({ label: "Check", state: "error" });
  });

  it("maps severity to dashboard tones", () => {
    expect(severityTone("INFO")).toBe("neutral");
    expect(severityTone("WARN")).toBe("amber");
    expect(severityTone("ERROR")).toBe("red");
  });

  it("maps debugger enum values to readable labels", () => {
    expect(debugEventLabel("QUALITY_GATE_FAILED")).toBe("Quality Gate Failed");
    expect(debugEventLabel("TASK_QUEUED")).toBe("Task queued");
    expect(debugStageLabel("page_writer")).toBe("Page writer");
    expect(taskTypeLabel("CREATE_PAGE")).toBe("Create page");
    expect(runStatusLabel("NEEDS_REVIEW")).toBe("Needs review");
    expect(runStatusLabel("CANCELED")).toBe("Force stopped");
  });

  it("maps tasks and events to debugger steps", () => {
    expect(debuggerStepForTask("DISCOVER_RELATED_CONCEPTS")).toBe("Explore");
    expect(debuggerStepForTask("CREATE_PAGE")).toBe("Write");
    expect(debuggerStepForTask("EVALUATE_COVERAGE")).toBe("Check");
    expect(debuggerStepForEvent({ id: "1", eventType: "CLONE_STARTED", severity: "INFO", stage: "clone" })).toBe("Clone");
    expect(debuggerStepForEvent({ id: "2", eventType: "ANALYZE_DONE", severity: "INFO", stage: "analyze" })).toBe("Analyze");
    expect(debuggerStepForEvent({ id: "3", eventType: "TASK_STARTED", severity: "INFO", payloadJson: { taskType: "UPDATE_PAGE" } })).toBe("Write");
  });

  it("merges debug events by id and caps the newest 200", () => {
    const existing = Array.from({ length: 199 }, (_, index) => ({ id: `event-${index}` }));
    const merged = mergeDebugEvents(existing, [{ id: "event-198" }, { id: "event-199" }, { id: "event-200" }]);

    expect(merged).toHaveLength(200);
    expect(merged.at(0)?.id).toBe("event-1");
    expect(merged.at(-1)?.id).toBe("event-200");
    expect(merged.filter((event) => event.id === "event-198")).toHaveLength(1);
  });

  it("derives flow lanes from existing debug event types", () => {
    const flow = debuggerFlowFromEvents([
      { id: "1", eventType: "BASELINE_FOUND", severity: "INFO", payloadJson: { baselineGenerationRunId: "run-old" } },
      { id: "2", eventType: "PAGE_CANDIDATES_BUILT", severity: "INFO", message: "built" },
      { id: "3", eventType: "PAGE_REUSED", severity: "INFO", payloadJson: { pageKey: "settings" } },
      { id: "4", eventType: "PAGE_AFFECTED", severity: "INFO", payloadJson: { pageKey: "users" } },
      { id: "5", eventType: "TASK_QUEUED", severity: "INFO", payloadJson: { dedupeKey: "create-page:users" } },
      { id: "6", eventType: "PAGE_WRITTEN", severity: "INFO", payloadJson: { pageKey: "users" } },
      { id: "7", eventType: "COVERAGE_NEEDS_REVIEW", severity: "WARN", message: "review" }
    ]);

    expect(flow.map((lane) => [lane.key, lane.count, lane.latest])).toEqual([
      ["baseline", 1, "run-old"],
      ["candidates", 1, "built"],
      ["reused", 1, "settings"],
      ["affected", 1, "users"],
      ["queued", 1, "create-page:users"],
      ["written", 1, "users"],
      ["coverage", 1, "review"]
    ]);
  });

  it("shows unavailable flow lanes when no existing event supports them", () => {
    expect(debuggerFlowFromEvents([]).every((lane) => lane.latest === "not available yet")).toBe(true);
  });

  it("groups coverage gaps by reason and page key", () => {
    expect(groupCoverageGaps([
      { reason: "NO_BACKEND_EVIDENCE", pageKey: "users" },
      { reason: "NO_BACKEND_EVIDENCE", pageKey: "users" },
      { reason: "NO_FRONTEND_ANCHOR", pageKey: null }
    ])).toEqual([
      { reason: "NO_BACKEND_EVIDENCE", pageKey: "users", count: 2 },
      { reason: "NO_FRONTEND_ANCHOR", pageKey: "unknown page", count: 1 }
    ]);
  });
});
