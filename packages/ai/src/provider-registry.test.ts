import { describe, expect, it } from "vitest";

import { OpenRouterProvider } from "./openrouter-provider";
import {
  createAIProvider,
  getProviderCapabilities,
  listSupportedProviders,
  ProviderConfigurationError,
  resolveAIProviderConfig
} from "./index";

describe("provider registry", () => {
  it("defaults missing AI_PROVIDER to openrouter", () => {
    expect(
      resolveAIProviderConfig({
        AI_API_KEY: "test-key",
        AI_MODEL: "openai/gpt-4.1-mini",
        AI_BASE_URL: "https://openrouter.ai/api/v1"
      })
    ).toMatchObject({
      provider: "openrouter",
      model: "openai/gpt-4.1-mini"
    });
  });

  it("resolves AI_PROVIDER=openrouter to OpenRouterProvider", () => {
    const config = resolveAIProviderConfig({
      AI_PROVIDER: "openrouter",
      AI_API_KEY: "test-key",
      AI_MODEL: "openai/gpt-4.1-mini",
      AI_BASE_URL: "https://openrouter.ai/api/v1"
    });

    expect(createAIProvider(config)).toBeInstanceOf(OpenRouterProvider);
  });

  it("infers nvidia from AI_BASE_URL without AI_PROVIDER", () => {
    const config = resolveAIProviderConfig({
      AI_API_KEY: "test-key",
      AI_MODEL: "meta/llama-3.1-8b-instruct",
      AI_BASE_URL: "https://integrate.api.nvidia.com/v1"
    });

    expect(config).toMatchObject({
      provider: "nvidia",
      model: "meta/llama-3.1-8b-instruct",
      apiKey: "test-key",
      baseUrl: "https://integrate.api.nvidia.com/v1"
    });
    expect(createAIProvider(config)).toBeInstanceOf(OpenRouterProvider);
  });

  it("uses AI_MODEL as primary model env", () => {
    expect(
      resolveAIProviderConfig({
        AI_API_KEY: "test-key",
        AI_MODEL: "generic-model",
        AI_BASE_URL: "https://openrouter.ai/api/v1"
      }).model
    ).toBe("generic-model");
  });

  it("uses explicit RPM env when provided", () => {
    expect(
      resolveAIProviderConfig({
        AI_API_KEY: "test-key",
        AI_MODEL: "generic-model",
        AI_BASE_URL: "https://openrouter.ai/api/v1",
        AI_MAX_REQUESTS_PER_MINUTE: "10"
      })
    ).toMatchObject({
      maxRequestsPerMinute: 10
    });
    expect(
      resolveAIProviderConfig({
        AI_PROVIDER: "nvidia",
        AI_API_KEY: "test-key",
        AI_MODEL: "nim-model",
        AI_BASE_URL: "https://integrate.api.nvidia.com/v1",
        AI_MAX_REQUESTS_PER_MINUTE: "7"
      })
    ).toMatchObject({
      maxRequestsPerMinute: 7
    });
  });

  it("throws when required AI envs are missing", () => {
    expect(() => resolveAIProviderConfig({ AI_MODEL: "generic-model", AI_BASE_URL: "https://openrouter.ai/api/v1" })).toThrow(
      /AI_API_KEY is required/
    );
    expect(() => resolveAIProviderConfig({ AI_API_KEY: "test-key", AI_BASE_URL: "https://openrouter.ai/api/v1" })).toThrow(
      /AI_MODEL is required/
    );
    expect(() => resolveAIProviderConfig({ AI_API_KEY: "test-key", AI_MODEL: "generic-model" })).toThrow(
      /AI_BASE_URL is required/
    );
  });

  it("throws sanitized ProviderConfigurationError for unknown providers", () => {
    expect(() => resolveAIProviderConfig({ AI_PROVIDER: "anthropic", AI_API_KEY: "sk-or-v1-secretsecret" })).toThrow(
      ProviderConfigurationError
    );
    expect(() => resolveAIProviderConfig({ AI_PROVIDER: "anthropic" })).toThrow(/anthropic/);
    expect(() => resolveAIProviderConfig({ AI_PROVIDER: "anthropic" })).toThrow(/openrouter/);
  });

  it("returns OpenRouter capabilities", () => {
    expect(
      getProviderCapabilities(
        resolveAIProviderConfig({
          AI_API_KEY: "test-key",
          AI_MODEL: "test-model",
          AI_BASE_URL: "https://openrouter.ai/api/v1"
        })
      )
    ).toEqual({
      provider: "openrouter",
      model: "test-model",
      supportsStrictJsonSchema: true,
      supportsUsage: true,
      supportsRepair: true,
      usageSource: "provider",
      structuredOutputMode: "json_schema"
    });
    expect(
      getProviderCapabilities(
        resolveAIProviderConfig({
          AI_API_KEY: "test-key",
          AI_BASE_URL: "https://integrate.api.nvidia.com/v1",
          AI_MODEL: "nim-model"
        })
      )
    ).toEqual({
      provider: "nvidia",
      model: "nim-model",
      supportsStrictJsonSchema: true,
      supportsUsage: true,
      supportsRepair: true,
      usageSource: "provider",
      structuredOutputMode: "json_schema"
    });
    expect(listSupportedProviders()).toEqual(["openrouter", "nvidia"]);
  });

  it("does not expose secret env values in configuration errors", () => {
    const secret = "sk-or-v1-secretsecretsecret";

    try {
      resolveAIProviderConfig({ AI_PROVIDER: secret, AI_API_KEY: secret, AUTHORIZATION: `Bearer ${secret}` });
      throw new Error("expected resolveAIProviderConfig to throw");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(secret);
      expect(message).not.toContain("Bearer");
      expect(message).not.toContain("OPENROUTER_API_KEY");
      expect(message).toContain("[redacted-provider]");
      expect(message).toContain("openrouter");
      expect(message).toContain("nvidia");
    }
  });
});
