import { analyzeCode } from "./jobs/analyze-code";
import { cloneRepository } from "./jobs/clone-repository";
import { runSelfExpandingGeneration } from "./jobs/self-expanding-generation/task-queue";
import { claimNextDaemonRun } from "./run-control";

export type DaemonIterationResult =
  | { status: "idle" }
  | { status: "processed"; generationRunId: string; stage: "clone" | "analyze" | "generate"; executionMode: "AUTO" | "MANUAL"; result: unknown };

export async function runWorkerDaemonIteration(): Promise<DaemonIterationResult> {
  const claim = await claimNextDaemonRun();
  if (!claim) {
    return { status: "idle" };
  }

  const result =
    claim.stage === "clone"
      ? await cloneRepository(claim.generationRunId)
      : claim.stage === "analyze"
        ? await analyzeCode(claim.generationRunId)
        : await runSelfExpandingGeneration(claim.generationRunId);

  return { status: "processed", ...claim, result };
}

export async function runWorkerDaemon({
  pollIntervalMs = 3000,
  sleep = defaultSleep
}: {
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
} = {}) {
  let keepRunning = true;
  const stop = () => {
    keepRunning = false;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  try {
    while (keepRunning) {
      const iteration = await runWorkerDaemonIteration();
      if (iteration.status === "idle" && keepRunning) {
        await sleep(pollIntervalMs);
      }
    }
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

function defaultSleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
