import { describe, expect, it } from "vitest";

import { parseWorkerCliArgs } from "./index";

describe("parseWorkerCliArgs", () => {
  it("defaults to all steps", () => {
    expect(parseWorkerCliArgs([])).toEqual({ ok: true, command: "all" });
  });

  it("accepts a generation run id for all steps", () => {
    expect(parseWorkerCliArgs(["run_123"])).toEqual({ ok: true, command: "all", generationRunId: "run_123" });
  });

  it("accepts a single step with an optional generation run id", () => {
    expect(parseWorkerCliArgs(["clone", "run_123"])).toEqual({ ok: true, command: "clone", generationRunId: "run_123" });
    expect(parseWorkerCliArgs(["--", "clone", "run_123"])).toEqual({ ok: true, command: "clone", generationRunId: "run_123" });
    expect(parseWorkerCliArgs(["analyze"])).toEqual({ ok: true, command: "analyze", generationRunId: undefined });
    expect(parseWorkerCliArgs(["generate", "run_123"])).toEqual({ ok: true, command: "generate", generationRunId: "run_123" });
  });

  it("rejects extra args after a step", () => {
    expect(parseWorkerCliArgs(["clone", "run_123", "extra"])).toEqual({
      ok: false,
      error: "Usage: pnpm worker:run -- [clone|analyze|generate] [generationRunId]"
    });
  });

  it("rejects two ids without a step", () => {
    expect(parseWorkerCliArgs(["run_123", "run_456"])).toEqual({
      ok: false,
      error: "Usage: pnpm worker:run -- [generationRunId]"
    });
  });
});
