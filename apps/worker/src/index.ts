import { sanitizeErrorText, sanitizeJson } from "@code2wiki/shared";

import { analyzeCode } from "./jobs/analyze-code";
import { cloneRepository } from "./jobs/clone-repository";
import { deleteGenerationRun } from "./jobs/delete-generation-run";
import { runSelfExpandingGeneration } from "./jobs/self-expanding-generation/task-queue";
import { runWorkerDaemon } from "./daemon";

export type WorkerCommand = "all" | "clone" | "analyze" | "generate" | "delete-generation" | "daemon";

export type WorkerCliArgs =
  | { ok: true; command: WorkerCommand; generationRunId?: string; pollIntervalMs?: number }
  | { ok: false; error: string };

export function parseWorkerCliArgs(args: string[]): WorkerCliArgs {
  const normalizedArgs = args[0] === "--" ? args.slice(1) : args;
  const [first, second, ...rest] = normalizedArgs;
  const commands = new Set<WorkerCommand>(["clone", "analyze", "generate", "delete-generation", "daemon"]);

  if (first === "daemon") {
    if (rest.length > 0) {
      return { ok: false, error: "Usage: pnpm worker:run -- daemon [pollIntervalMs]" };
    }
    if (!second) {
      return { ok: true, command: "daemon" };
    }
    const pollIntervalMs = Number(second);
    if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 0) {
      return { ok: false, error: "Usage: pnpm worker:run -- daemon [pollIntervalMs]" };
    }
    return { ok: true, command: "daemon", pollIntervalMs };
  }

  if (rest.length > 0) {
    return { ok: false, error: "Usage: pnpm worker:run -- [clone|analyze|generate|delete-generation] [generationRunId]" };
  }

  if (!first) {
    return { ok: true, command: "all" };
  }

  if (commands.has(first as WorkerCommand)) {
    return { ok: true, command: first as WorkerCommand, generationRunId: second };
  }

  if (second) {
    return { ok: false, error: "Usage: pnpm worker:run -- [generationRunId]" };
  }

  return { ok: true, command: "all", generationRunId: first };
}

export async function runWorkerCli(args = process.argv.slice(2)) {
  const parsed = parseWorkerCliArgs(args);
  if (!parsed.ok) {
    return { status: "error" as const, errorMessage: parsed.error };
  }

  if (parsed.command === "clone") {
    return { command: parsed.command, result: await cloneRepository(parsed.generationRunId) };
  }
  if (parsed.command === "analyze") {
    return { command: parsed.command, result: await analyzeCode(parsed.generationRunId) };
  }
  if (parsed.command === "generate") {
    return { command: parsed.command, result: await runSelfExpandingGeneration(parsed.generationRunId) };
  }
  if (parsed.command === "delete-generation") {
    return { command: parsed.command, result: await deleteGenerationRun(parsed.generationRunId) };
  }
  if (parsed.command === "daemon") {
    await runWorkerDaemon({ pollIntervalMs: parsed.pollIntervalMs });
    return { command: parsed.command, status: "running" as const };
  }

  return {
    command: parsed.command,
    generationRunId: parsed.generationRunId,
    results: [
      await cloneRepository(parsed.generationRunId),
      await analyzeCode(parsed.generationRunId),
      await runSelfExpandingGeneration(parsed.generationRunId)
    ]
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runWorkerCli()
    .then((result) => {
      process.stdout.write(`${JSON.stringify(sanitizeJson(result), null, 2)}\n`);
      if ("status" in result && result.status === "error") {
        process.exitCode = 1;
      }
    })
    .catch((error) => {
      process.stdout.write(`${JSON.stringify({ status: "error", errorMessage: sanitizeErrorText(error) }, null, 2)}\n`);
      process.exitCode = 1;
    });
}
