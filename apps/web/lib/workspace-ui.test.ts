import { describe, expect, it } from "vitest";

import { generationStepState, nextActionLabel } from "./workspace-ui";

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
});
