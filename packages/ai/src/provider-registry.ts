import { OpenRouterProvider, OPENROUTER_DEFAULT_MODEL } from "./openrouter-provider";
import {
  ProviderConfigurationError,
  type AIProvider,
  type AIProviderCapabilities,
  type AIProviderConfig,
  type SupportedAIProvider
} from "./provider";

type ProviderEnv = Record<string, string | undefined>;

const supportedProviders = ["openrouter"] as const satisfies readonly SupportedAIProvider[];

export function resolveAIProviderConfig(env: ProviderEnv = process.env): AIProviderConfig {
  const provider = (env.AI_PROVIDER ?? "openrouter").trim().toLowerCase();

  if (!isSupportedProvider(provider)) {
    throw new ProviderConfigurationError(
      `Unsupported AI_PROVIDER "${safeProviderName(provider)}". Supported providers: ${supportedProviders.join(", ")}.`
    );
  }

  return {
    provider,
    model: env.OPENROUTER_MODEL ?? env.AI_MODEL ?? OPENROUTER_DEFAULT_MODEL,
    apiKey: env.OPENROUTER_API_KEY,
    baseUrl: env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1"
  };
}

export function createAIProvider(config: AIProviderConfig): AIProvider {
  if (config.provider === "openrouter") {
    return new OpenRouterProvider(config);
  }

  throw new ProviderConfigurationError(`Unsupported AI_PROVIDER "${config.provider}". Supported providers: ${supportedProviders.join(", ")}.`);
}

export function createAIProviderFromEnv(env: ProviderEnv = process.env): AIProvider {
  return createAIProvider(resolveAIProviderConfig(env));
}

export function listSupportedProviders(): SupportedAIProvider[] {
  return [...supportedProviders];
}

export function getProviderCapabilities(providerOrConfig: AIProvider | AIProviderConfig): AIProviderCapabilities {
  if ("capabilities" in providerOrConfig && providerOrConfig.capabilities) {
    return providerOrConfig.capabilities;
  }

  if (isProviderConfig(providerOrConfig) && providerOrConfig.provider === "openrouter") {
    return openRouterCapabilities(providerOrConfig.model);
  }

  throw new ProviderConfigurationError(`Unsupported AI_PROVIDER. Supported providers: ${supportedProviders.join(", ")}.`);
}

export function openRouterCapabilities(model: string): AIProviderCapabilities {
  return {
    provider: "openrouter",
    model,
    supportsStrictJsonSchema: true,
    supportsUsage: true,
    supportsRepair: true,
    usageSource: "provider",
    structuredOutputMode: "json_schema"
  };
}

function isSupportedProvider(value: string): value is SupportedAIProvider {
  return supportedProviders.includes(value as SupportedAIProvider);
}

function isProviderConfig(value: AIProvider | AIProviderConfig): value is AIProviderConfig {
  return "provider" in value;
}

function safeProviderName(value: string) {
  if (
    /\b(?:sk|pk|rk|or)-[A-Za-z0-9_-]{12,}\b/.test(value) ||
    /authorization|bearer|api[_-]?key|secret|token/i.test(value)
  ) {
    return "[redacted-provider]";
  }
  return value.slice(0, 64);
}
