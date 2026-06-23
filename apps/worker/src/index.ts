import { sanitizeErrorText, sanitizeJson } from "@code2wiki/shared";

import { analyzeCode } from "./jobs/analyze-code";
import { cloneRepository } from "./jobs/clone-repository";
import { generateWiki } from "./jobs/generate-wiki";

export type WorkerCommand = "all" | "clone" | "analyze" | "generate";

export type WorkerCliArgs =
  | { ok: true; command: WorkerCommand; generationRunId?: string }
  | { ok: false; error: string };

export function parseWorkerCliArgs(args: string[]): WorkerCliArgs {
  const normalizedArgs = args[0] === "--" ? args.slice(1) : args;
  const [first, second, ...rest] = normalizedArgs;
  const commands = new Set<WorkerCommand>(["clone", "analyze", "generate"]);

  if (rest.length > 0) {
    return { ok: false, error: "Usage: pnpm worker:run -- [clone|analyze|generate] [generationRunId]" };
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
    return { command: parsed.command, result: await generateWiki(parsed.generationRunId) };
  }

  return {
    command: parsed.command,
    generationRunId: parsed.generationRunId,
    results: [
      await cloneRepository(parsed.generationRunId),
      await analyzeCode(parsed.generationRunId),
      await generateWiki(parsed.generationRunId)
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
