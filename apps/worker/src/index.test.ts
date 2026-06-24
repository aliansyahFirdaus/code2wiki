import { beforeEach, describe, expect, it, vi } from "vitest";

import { parseWorkerCliArgs, runWorkerCli } from "./index";

const mocks = vi.hoisted(() => ({
  analyzeCode: vi.fn(),
  cloneRepository: vi.fn(),
  runSelfExpandingGeneration: vi.fn()
}));

vi.mock("./jobs/analyze-code", () => ({ analyzeCode: mocks.analyzeCode }));
vi.mock("./jobs/clone-repository", () => ({ cloneRepository: mocks.cloneRepository }));
vi.mock("./jobs/self-expanding-generation/task-queue", () => ({ runSelfExpandingGeneration: mocks.runSelfExpandingGeneration }));

describe("parseWorkerCliArgs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

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

  it("dispatches generate to the self-expanding task queue", async () => {
    mocks.runSelfExpandingGeneration.mockResolvedValue({ status: "tasks_processed", generationRunId: "run_123" });

    await expect(runWorkerCli(["generate", "run_123"])).resolves.toEqual({
      command: "generate",
      result: { status: "tasks_processed", generationRunId: "run_123" }
    });
    expect(mocks.runSelfExpandingGeneration).toHaveBeenCalledWith("run_123");
  });
});
