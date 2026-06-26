import { describe, expect, it, vi } from "vitest";

import { POST } from "./route";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn()
}));

vi.mock("@code2wiki/db", () => ({
  generationRuns: { id: "id" },
  getDb: mocks.getDb
}));

describe("generation run next-step route", () => {
  it("queues one manual advance for eligible runs", async () => {
    const returning = vi.fn().mockResolvedValue([{ id: "run-1", advanceRequestedAt: new Date("2026-06-26T00:00:00Z") }]);
    const updateWhere = vi.fn(() => ({ returning }));
    const updateSet = vi.fn(() => ({ where: updateWhere }));
    const selectLimit = vi.fn().mockResolvedValue([{ id: "run-1", status: "QUEUED", executionMode: "MANUAL", controlState: "ACTIVE" }]);
    const selectWhere = vi.fn(() => ({ limit: selectLimit }));
    mocks.getDb.mockReturnValue({
      select: vi.fn(() => ({ from: vi.fn(() => ({ where: selectWhere })) })),
      update: vi.fn(() => ({ set: updateSet }))
    });

    const response = await POST(new Request("http://test.local/api/generation-runs/run-1/next-step", { method: "POST" }), {
      params: Promise.resolve({ id: "run-1" })
    });

    expect(response.status).toBe(200);
    expect(updateSet).toHaveBeenCalledWith({ advanceRequestedAt: expect.any(Date) });
    expect(await response.json()).toEqual({
      generationRunId: "run-1",
      advanceRequestedAt: "2026-06-26T00:00:00.000Z"
    });
  });

  it("rejects in-progress or terminal statuses", async () => {
    const selectLimit = vi.fn().mockResolvedValue([{ id: "run-1", status: "AI_GENERATING", executionMode: "MANUAL", controlState: "ACTIVE" }]);
    const selectWhere = vi.fn(() => ({ limit: selectLimit }));
    mocks.getDb.mockReturnValue({
      select: vi.fn(() => ({ from: vi.fn(() => ({ where: selectWhere })) }))
    });

    const response = await POST(new Request("http://test.local/api/generation-runs/run-1/next-step", { method: "POST" }), {
      params: Promise.resolve({ id: "run-1" })
    });

    expect(response.status).toBe(400);
  });
});
