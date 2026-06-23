import type { ProviderUsage } from "./provider";

export type AiUsageCallKind = "generation" | "repair";

export type AiUsageCall = {
  kind: AiUsageCallKind;
  usage: ProviderUsage;
  promptTokensUsed: number;
  completionTokensUsed: number | null;
  totalTokensUsed: number | null;
  estimatedCostUsdMicros: number | null;
  pricingSource: string | null;
};

export type AiUsageReport = {
  calls: AiUsageCall[];
  summary: AiUsageSummary;
};

export type AiUsageSummary = {
  callCount: number;
  promptTokens: number;
  completionTokens: number | null;
  totalTokens: number | null;
  estimatedCostUsdMicros: number | null;
  pricingSource: string | null;
};

export function buildAiUsageCall(kind: AiUsageCallKind, usage: ProviderUsage, env: NodeJS.ProcessEnv = process.env): AiUsageCall {
  const promptTokensUsed = usage.promptTokens ?? usage.promptTokenEstimate;
  const completionTokensUsed = usage.completionTokens;
  const totalTokensUsed = usage.totalTokens ?? (completionTokensUsed === null ? null : promptTokensUsed + completionTokensUsed);
  const pricing = readPricing(env);

  return {
    kind,
    usage,
    promptTokensUsed,
    completionTokensUsed,
    totalTokensUsed,
    estimatedCostUsdMicros: pricing
      ? Math.round((promptTokensUsed * pricing.promptUsdPer1m + (completionTokensUsed ?? 0) * pricing.completionUsdPer1m) * 1_000_000 / 1_000_000)
      : null,
    pricingSource: pricing ? "env" : null
  };
}

export function buildAiUsageReport(calls: AiUsageCall[]): AiUsageReport {
  const completionValues = calls.map((call) => call.completionTokensUsed);
  const totalValues = calls.map((call) => call.totalTokensUsed);
  const costValues = calls.map((call) => call.estimatedCostUsdMicros);
  const pricingSources = new Set(calls.map((call) => call.pricingSource).filter((source): source is string => source !== null));

  return {
    calls,
    summary: {
      callCount: calls.length,
      promptTokens: calls.reduce((total, call) => total + call.promptTokensUsed, 0),
      completionTokens: completionValues.some((value) => value === null) ? null : sum(completionValues),
      totalTokens: totalValues.some((value) => value === null) ? null : sum(totalValues),
      estimatedCostUsdMicros: costValues.some((value) => value === null) ? null : sum(costValues),
      pricingSource: pricingSources.size === 1 ? [...pricingSources][0] : null
    }
  };
}

function readPricing(env: NodeJS.ProcessEnv) {
  const promptUsdPer1m = positiveNumber(env.CODE2WIKI_AI_PROMPT_USD_PER_1M_TOKENS);
  const completionUsdPer1m = positiveNumber(env.CODE2WIKI_AI_COMPLETION_USD_PER_1M_TOKENS);
  return promptUsdPer1m === null || completionUsdPer1m === null ? null : { promptUsdPer1m, completionUsdPer1m };
}

function positiveNumber(value: string | undefined) {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function sum(values: Array<number | null>) {
  return values.reduce<number>((total, value) => total + (value ?? 0), 0);
}
