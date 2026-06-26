import { OpenRouterProvider } from "./openrouter-provider";
import {
  ProviderConfigurationError,
  type AIProvider,
  type AIProviderCapabilities,
  type AIProviderConfig,
  type SupportedAIProvider
} from "./provider";

type ProviderEnv = Record<string, string | undefined>;

const supportedProviders = ["openrouter", "nvidia"] as const satisfies readonly SupportedAIProvider[];

export function resolveAIProviderConfig(env: ProviderEnv = process.env): AIProviderConfig {
  const provider = resolveProvider(env);

  if (!isSupportedProvider(provider)) {
    throw new ProviderConfigurationError(
      `Unsupported AI_PROVIDER "${safeProviderName(provider)}". Supported providers: ${supportedProviders.join(", ")}.`
    );
  }

  return {
    provider,
    model: requiredString(env.AI_MODEL, "AI_MODEL"),
    apiKey: requiredString(env.AI_API_KEY, "AI_API_KEY"),
    baseUrl: requiredString(env.AI_BASE_URL, "AI_BASE_URL"),
    maxRequestsPerMinute: positiveNumberOrUndefined(env.AI_MAX_REQUESTS_PER_MINUTE)
  };
}

export function createAIProvider(config: AIProviderConfig): AIProvider {
  if (config.provider === "openrouter" || config.provider === "nvidia") {
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

  if (isProviderConfig(providerOrConfig) && (providerOrConfig.provider === "openrouter" || providerOrConfig.provider === "nvidia")) {
    return openAiCompatibleCapabilities(providerOrConfig.provider, providerOrConfig.model);
  }

  throw new ProviderConfigurationError(`Unsupported AI_PROVIDER. Supported providers: ${supportedProviders.join(", ")}.`);
}

export function openRouterCapabilities(model: string): AIProviderCapabilities {
  return openAiCompatibleCapabilities("openrouter", model);
}

export function nvidiaCapabilities(model: string): AIProviderCapabilities {
  return openAiCompatibleCapabilities("nvidia", model);
}

function openAiCompatibleCapabilities(provider: SupportedAIProvider, model: string): AIProviderCapabilities {
  return {
    provider,
    model,
    supportsStrictJsonSchema: true,
    supportsUsage: true,
    supportsRepair: true,
    usageSource: "provider",
    structuredOutputMode: "json_schema"
  };
}

function resolveProvider(env: ProviderEnv): SupportedAIProvider {
  const explicit = env.AI_PROVIDER?.trim().toLowerCase();
  if (explicit) {
    return explicit as SupportedAIProvider;
  }

  const baseUrl = env.AI_BASE_URL;
  if (typeof baseUrl === "string" && /integrate\.api\.nvidia\.com/i.test(baseUrl)) {
    return "nvidia";
  }
  return "openrouter";
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

function positiveNumberOrUndefined(value: string | undefined) {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function requiredString(value: string | undefined, envName: "AI_MODEL" | "AI_API_KEY" | "AI_BASE_URL") {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  throw new ProviderConfigurationError(`${envName} is required.`);
}
