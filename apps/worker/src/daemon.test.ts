import { beforeEach, describe, expect, it, vi } from "vitest";

import { runWorkerDaemon, runWorkerDaemonIteration } from "./daemon";
import { claimNextDaemonRun } from "./run-control";

const mocks = vi.hoisted(() => ({
  analyzeCode: vi.fn(),
  claimNextDaemonRun: vi.fn(),
  cloneRepository: vi.fn(),
  runSelfExpandingGeneration: vi.fn()
}));

vi.mock("./run-control", () => ({ claimNextDaemonRun: mocks.claimNextDaemonRun }));
vi.mock("./jobs/clone-repository", () => ({ cloneRepository: mocks.cloneRepository }));
vi.mock("./jobs/analyze-code", () => ({ analyzeCode: mocks.analyzeCode }));
vi.mock("./jobs/self-expanding-generation/task-queue", () => ({
  runSelfExpandingGeneration: mocks.runSelfExpandingGeneration
}));

describe("runWorkerDaemonIteration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("runs clone for AUTO queued work", async () => {
    mocks.claimNextDaemonRun.mockResolvedValue({ generationRunId: "run-1", stage: "clone", executionMode: "AUTO" });
    mocks.cloneRepository.mockResolvedValue({ status: "cloned", generationRunId: "run-1" });

    await expect(runWorkerDaemonIteration()).resolves.toEqual({
      status: "processed",
      generationRunId: "run-1",
      stage: "clone",
      executionMode: "AUTO",
      result: { status: "cloned", generationRunId: "run-1" }
    });
    expect(mocks.cloneRepository).toHaveBeenCalledWith("run-1");
  });

  it("runs analyze for AUTO cloned work", async () => {
    mocks.claimNextDaemonRun.mockResolvedValue({ generationRunId: "run-2", stage: "analyze", executionMode: "AUTO" });
    mocks.analyzeCode.mockResolvedValue({ status: "facts_extracted", generationRunId: "run-2" });

    await expect(runWorkerDaemonIteration()).resolves.toEqual({
      status: "processed",
      generationRunId: "run-2",
      stage: "analyze",
      executionMode: "AUTO",
      result: { status: "facts_extracted", generationRunId: "run-2" }
    });
    expect(mocks.analyzeCode).toHaveBeenCalledWith("run-2");
  });

  it("runs generate for AUTO facts extracted work", async () => {
    mocks.claimNextDaemonRun.mockResolvedValue({ generationRunId: "run-3", stage: "generate", executionMode: "AUTO" });
    mocks.runSelfExpandingGeneration.mockResolvedValue({ status: "tasks_processed", generationRunId: "run-3" });

    await expect(runWorkerDaemonIteration()).resolves.toEqual({
      status: "processed",
      generationRunId: "run-3",
      stage: "generate",
      executionMode: "AUTO",
      result: { status: "tasks_processed", generationRunId: "run-3" }
    });
    expect(mocks.runSelfExpandingGeneration).toHaveBeenCalledWith("run-3");
  });

  it("stays idle when no runnable work exists", async () => {
    mocks.claimNextDaemonRun.mockResolvedValue(null);

    await expect(runWorkerDaemonIteration()).resolves.toEqual({ status: "idle" });
    expect(mocks.cloneRepository).not.toHaveBeenCalled();
    expect(mocks.analyzeCode).not.toHaveBeenCalled();
    expect(mocks.runSelfExpandingGeneration).not.toHaveBeenCalled();
  });

  it("runs exactly one top-level stage for a manual advance", async () => {
    mocks.claimNextDaemonRun.mockResolvedValue({ generationRunId: "run-4", stage: "analyze", executionMode: "MANUAL" });
    mocks.analyzeCode.mockResolvedValue({ status: "facts_extracted", generationRunId: "run-4" });

    await expect(runWorkerDaemonIteration()).resolves.toMatchObject({
      status: "processed",
      generationRunId: "run-4",
      stage: "analyze",
      executionMode: "MANUAL"
    });
    expect(mocks.analyzeCode).toHaveBeenCalledTimes(1);
  });
});

describe("runWorkerDaemon", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stops polling after SIGTERM", async () => {
    const sleep = vi.fn(async () => {
      process.emit("SIGTERM");
    });
    mocks.claimNextDaemonRun.mockResolvedValue(null);

    await runWorkerDaemon({ pollIntervalMs: 1, sleep });

    expect(mocks.claimNextDaemonRun).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledTimes(1);
  });
});
