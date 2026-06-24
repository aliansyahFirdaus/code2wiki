import { describe, expect, it } from "vitest";

import { debuggerFlowFromEvents, generationStepState, groupCoverageGaps, mergeDebugEvents, nextActionLabel, severityTone } from "./workspace-ui";

describe("workspace UI helpers", () => {
  it("maps generation status to next action labels", () => {
    expect(nextActionLabel("QUEUED")).toBe("Run clone");
    expect(nextActionLabel("CLONED")).toBe("Run analyze");
    expect(nextActionLabel("FACTS_EXTRACTED")).toBe("Run generation");
    expect(nextActionLabel("AI_GENERATING")).toBe("Run generation");
    expect(nextActionLabel("NEEDS_REVIEW")).toBe("Blocked / needs review");
    expect(nextActionLabel("COMPLETED")).toBe("Done");
  });

  it("maps generation status to compact step states", () => {
    expect(generationStepState("AI_GENERATING")).toMatchObject([
      { label: "Queue", state: "done" },
      { label: "Clone", state: "done" },
      { label: "Analyze", state: "done" },
      { label: "Generate", state: "active" },
      { label: "Coverage", state: "pending" },
      { label: "Done", state: "pending" }
    ]);
    expect(generationStepState("COMPLETED").every((step) => step.state === "done")).toBe(true);
  });

  it("maps severity to dashboard tones", () => {
    expect(severityTone("INFO")).toBe("neutral");
    expect(severityTone("WARN")).toBe("amber");
    expect(severityTone("ERROR")).toBe("red");
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
