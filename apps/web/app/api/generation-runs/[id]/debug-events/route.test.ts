import { describe, expect, it, vi } from "vitest";

import { GET } from "./route";

const mocks = vi.hoisted(() => ({
  loadGenerationDebugEvents: vi.fn()
}));

vi.mock("../../../../../lib/generation-debug-events", () => ({
  loadGenerationDebugEvents: mocks.loadGenerationDebugEvents
}));

describe("generation debug events route", () => {
  it("passes polling params and returns ordered events response", async () => {
    mocks.loadGenerationDebugEvents.mockResolvedValue({
      events: [{ id: "event-2" }],
      nextAfterId: "event-2",
      previousBeforeId: "event-1",
      hasMoreBefore: true,
      hasMoreAfter: false,
      totalEventCount: 1000,
      summary: { taskCounts: { queued: 1 } }
    });

    const response = await GET(new Request("http://test.local/api/generation-runs/run-1/debug-events?afterId=event-1&beforeId=event-0&tail=1&limit=50"), {
      params: Promise.resolve({ id: "run-1" })
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ events: [{ id: "event-2" }], nextAfterId: "event-2", previousBeforeId: "event-1", hasMoreBefore: true, hasMoreAfter: false, totalEventCount: 1000, summary: { taskCounts: { queued: 1 } } });
    expect(mocks.loadGenerationDebugEvents).toHaveBeenCalledWith({ generationRunId: "run-1", afterId: "event-1", beforeId: "event-0", since: null, limit: 50, tail: true });
  });

  it("returns 404 when the generation run is absent", async () => {
    mocks.loadGenerationDebugEvents.mockResolvedValue(null);

    const response = await GET(new Request("http://test.local/api/generation-runs/missing/debug-events"), {
      params: Promise.resolve({ id: "missing" })
    });

    expect(response.status).toBe(404);
  });
});
