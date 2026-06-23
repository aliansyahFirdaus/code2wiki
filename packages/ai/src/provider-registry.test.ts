import { describe, expect, it } from "vitest";

import { OpenRouterProvider, OPENROUTER_DEFAULT_MODEL } from "./openrouter-provider";
import {
  createAIProvider,
  getProviderCapabilities,
  listSupportedProviders,
  ProviderConfigurationError,
  resolveAIProviderConfig
} from "./index";

describe("provider registry", () => {
  it("defaults missing AI_PROVIDER to openrouter", () => {
    expect(resolveAIProviderConfig({ OPENROUTER_API_KEY: "test-key" })).toMatchObject({
      provider: "openrouter",
      model: OPENROUTER_DEFAULT_MODEL
    });
  });

  it("resolves AI_PROVIDER=openrouter to OpenRouterProvider", () => {
    const config = resolveAIProviderConfig({ AI_PROVIDER: "openrouter", OPENROUTER_API_KEY: "test-key" });

    expect(createAIProvider(config)).toBeInstanceOf(OpenRouterProvider);
  });

  it("uses OPENROUTER_MODEL", () => {
    expect(resolveAIProviderConfig({ OPENROUTER_MODEL: "openrouter-model" }).model).toBe("openrouter-model");
  });

  it("uses AI_MODEL as OpenRouter fallback", () => {
    expect(resolveAIProviderConfig({ AI_MODEL: "ai-model" }).model).toBe("ai-model");
  });

  it("prefers OPENROUTER_MODEL over AI_MODEL", () => {
    expect(resolveAIProviderConfig({ OPENROUTER_MODEL: "openrouter-model", AI_MODEL: "ai-model" }).model).toBe("openrouter-model");
  });

  it("throws sanitized ProviderConfigurationError for unknown providers", () => {
    expect(() => resolveAIProviderConfig({ AI_PROVIDER: "anthropic", OPENROUTER_API_KEY: "sk-or-v1-secretsecret" })).toThrow(
      ProviderConfigurationError
    );
    expect(() => resolveAIProviderConfig({ AI_PROVIDER: "anthropic" })).toThrow(/anthropic/);
    expect(() => resolveAIProviderConfig({ AI_PROVIDER: "anthropic" })).toThrow(/openrouter/);
  });

  it("returns OpenRouter capabilities", () => {
    expect(getProviderCapabilities(resolveAIProviderConfig({ OPENROUTER_MODEL: "test-model" }))).toEqual({
      provider: "openrouter",
      model: "test-model",
      supportsStrictJsonSchema: true,
      supportsUsage: true,
      supportsRepair: true,
      usageSource: "provider",
      structuredOutputMode: "json_schema"
    });
    expect(listSupportedProviders()).toEqual(["openrouter"]);
  });

  it("does not expose secret env values in configuration errors", () => {
    const secret = "sk-or-v1-secretsecretsecret";

    try {
      resolveAIProviderConfig({ AI_PROVIDER: secret, OPENROUTER_API_KEY: secret, AUTHORIZATION: `Bearer ${secret}` });
      throw new Error("expected resolveAIProviderConfig to throw");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(secret);
      expect(message).not.toContain("Bearer");
      expect(message).not.toContain("OPENROUTER_API_KEY");
      expect(message).toContain("[redacted-provider]");
      expect(message).toContain("openrouter");
    }
  });
});
