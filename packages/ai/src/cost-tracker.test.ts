import { describe, expect, it } from "vitest";

import { buildAiUsageCall, buildAiUsageReport } from "./cost-tracker";
import type { ProviderUsage } from "./provider";

describe("cost tracker", () => {
  it("uses provider usage when present", () => {
    const call = buildAiUsageCall("generation", usage({ promptTokens: 100, completionTokens: 20, totalTokens: 120 }));

    expect(call.promptTokensUsed).toBe(100);
    expect(call.completionTokensUsed).toBe(20);
    expect(call.totalTokensUsed).toBe(120);
  });

  it("estimates prompt tokens when usage is absent", () => {
    const call = buildAiUsageCall("generation", usage({ inputCharCount: 401, promptTokens: null }));

    expect(call.promptTokensUsed).toBe(101);
  });

  it("returns null cost without pricing env", () => {
    const call = buildAiUsageCall("generation", usage({ promptTokens: 100, completionTokens: 50 }), {});

    expect(call.estimatedCostUsdMicros).toBeNull();
    expect(call.pricingSource).toBeNull();
  });

  it("estimates cost deterministically with pricing env", () => {
    const call = buildAiUsageCall("generation", usage({ promptTokens: 100, completionTokens: 50, totalTokens: 150 }), {
      CODE2WIKI_AI_PROMPT_USD_PER_1M_TOKENS: "2",
      CODE2WIKI_AI_COMPLETION_USD_PER_1M_TOKENS: "10"
    });
    const report = buildAiUsageReport([call]);

    expect(call.estimatedCostUsdMicros).toBe(700);
    expect(report.summary).toMatchObject({
      callCount: 1,
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      estimatedCostUsdMicros: 700,
      pricingSource: "env"
    });
  });
});

function usage(overrides: Partial<ProviderUsage> = {}): ProviderUsage {
  return {
    provider: "openrouter",
    model: "test-model",
    promptTokenEstimate: Math.ceil((overrides.inputCharCount ?? 40) / 4),
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
    inputCharCount: 40,
    outputCharCount: 20,
    ...overrides
  };
}
