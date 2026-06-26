import { beforeEach, describe, expect, it, vi } from "vitest";

import { claimNextDaemonRun, nextRunnableStage } from "./run-control";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn()
}));

vi.mock("@code2wiki/db", () => ({
  generationRuns: {
    id: "id",
    status: "status",
    controlState: "controlState",
    executionMode: "executionMode",
    advanceRequestedAt: "advanceRequestedAt",
    createdAt: "createdAt"
  },
  getDb: mocks.getDb
}));

describe("run-control", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maps advanceable statuses to their top-level stage", () => {
    expect(nextRunnableStage({ status: "QUEUED" })).toBe("clone");
    expect(nextRunnableStage({ status: "CLONED" })).toBe("analyze");
    expect(nextRunnableStage({ status: "FACTS_EXTRACTED" })).toBe("generate");
    expect(nextRunnableStage({ status: "AI_GENERATING" })).toBe("generate");
  });

  it("ignores manual runs without an advance request", async () => {
    const selectLimit = vi.fn().mockResolvedValue([]);
    const selectOrderBy = vi.fn(() => ({ limit: selectLimit }));
    const selectWhere = vi.fn(() => ({ orderBy: selectOrderBy }));
    mocks.getDb.mockReturnValue({
      transaction: (callback: (tx: unknown) => Promise<unknown>) =>
        callback({
          select: vi.fn(() => ({ from: vi.fn(() => ({ where: selectWhere })) }))
        })
    });

    await expect(claimNextDaemonRun()).resolves.toBeNull();
  });

  it("clears the manual advance signal before running one stage", async () => {
    const manualRun = {
      id: "run-1",
      status: "CLONED",
      controlState: "ACTIVE",
      executionMode: "MANUAL",
      advanceRequestedAt: new Date("2026-06-26T00:00:00Z"),
      createdAt: new Date("2026-06-26T00:00:00Z")
    };
    const returning = vi.fn().mockResolvedValue([{ ...manualRun, advanceRequestedAt: null }]);
    const updateWhere = vi.fn(() => ({ returning }));
    const updateSet = vi.fn(() => ({ where: updateWhere }));
    const selectLimit = vi.fn().mockResolvedValue([manualRun]);
    const selectOrderBy = vi.fn(() => ({ limit: selectLimit }));
    const selectWhere = vi.fn(() => ({ orderBy: selectOrderBy }));
    mocks.getDb.mockReturnValue({
      transaction: (callback: (tx: unknown) => Promise<unknown>) =>
        callback({
          select: vi.fn(() => ({ from: vi.fn(() => ({ where: selectWhere })) })),
          update: vi.fn(() => ({ set: updateSet }))
        })
    });

    await expect(claimNextDaemonRun()).resolves.toEqual({
      generationRunId: "run-1",
      stage: "analyze",
      executionMode: "MANUAL"
    });
    expect(updateSet).toHaveBeenCalledWith({ advanceRequestedAt: null });
  });

  it("ignores paused runs", async () => {
    const selectLimit = vi.fn().mockResolvedValue([]);
    const selectOrderBy = vi.fn(() => ({ limit: selectLimit }));
    const selectWhere = vi.fn(() => ({ orderBy: selectOrderBy }));
    mocks.getDb.mockReturnValue({
      transaction: (callback: (tx: unknown) => Promise<unknown>) =>
        callback({
          select: vi.fn(() => ({ from: vi.fn(() => ({ where: selectWhere })) }))
        })
    });

    await expect(claimNextDaemonRun()).resolves.toBeNull();
  });
});
