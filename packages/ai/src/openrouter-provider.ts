import {
  StructuredOutputUnsupportedError,
  type AIProvider,
  type AIProviderCapabilities,
  type AIProviderConfig,
  type GenerateProductWikiResult,
  type GenerateProductWikiInput,
  type GenerateProductWikiRepairInput,
  type ProviderUsage
} from "./provider";
import { buildProductWikiMessages, buildProductWikiRepairMessages } from "./product-wiki-prompts";

export const OPENROUTER_DEFAULT_MODEL = "nvidia/nemotron-3-ultra-550b-a55b:free";
const RATE_LIMIT_WINDOW_MS = 60_000;
const requestStartTimes: number[] = [];
let rateLimitMutex = Promise.resolve();

const productWikiJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["pages"],
  properties: {
    pages: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["pageKey", "title", "blocks"],
        properties: {
          pageKey: { type: "string" },
          title: { type: "string" },
          blocks: {
            type: "array",
            items: { $ref: "#/$defs/block" }
          }
        }
      }
    }
  },
  $defs: {
    block: {
      type: "object",
      additionalProperties: false,
      required: ["type"],
      properties: {
        type: {
          type: "string",
          enum: ["title", "heading", "paragraph", "statement", "callout", "open_question", "related_page", "divider"]
        },
        text: { type: "string" },
        level: { type: "number" },
        confidence: { type: "number" },
        evidenceIds: { type: "array", items: { type: "string" } },
        question: { type: "string" },
        reason: { type: "string" },
        relatedEvidenceIds: { type: "array", items: { type: "string" } },
        tone: { type: "string" },
        pageId: { type: "string" },
        title: { type: "string" },
        children: { type: "array", items: { $ref: "#/$defs/block" } }
      }
    }
  }
} as const;

export class OpenRouterProvider implements AIProvider {
  readonly capabilities: AIProviderCapabilities;

  constructor(private readonly config?: AIProviderConfig) {
    const provider = config?.provider ?? "openrouter";
    this.capabilities = {
      provider,
      model: config?.model ?? OPENROUTER_DEFAULT_MODEL,
      supportsStrictJsonSchema: true,
      supportsUsage: true,
      supportsRepair: true,
      usageSource: "provider",
      structuredOutputMode: "json_schema"
    };
  }

  async generateProductWiki(
    input: GenerateProductWikiInput,
    repair?: GenerateProductWikiRepairInput,
    options?: { signal?: AbortSignal }
  ): Promise<GenerateProductWikiResult> {
    const provider = this.config?.provider ?? "openrouter";
    const apiKey = this.config?.apiKey;
    const model = this.config?.model ?? OPENROUTER_DEFAULT_MODEL;
    const baseUrl = this.config?.baseUrl;
    const maxRequestsPerMinute = this.config?.maxRequestsPerMinute ?? null;

    if (!apiKey) {
      throw new Error("AI_API_KEY is required.");
    }
    if (!baseUrl) {
      throw new Error("AI_BASE_URL is required.");
    }

    const messages = repair
      ? buildProductWikiRepairMessages(input, repair.invalidOutput, repair.validationErrors)
      : buildProductWikiMessages(input);
    const inputCharCount = messages.reduce((total, message) => total + message.content.length, 0);

    await waitForRateLimit(maxRequestsPerMinute);

    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      signal: options?.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        ...(provider === "openrouter"
          ? {
              provider: {
                require_parameters: true
              }
            }
          : {}),
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "product_wiki_output",
            strict: true,
            schema: productWikiJsonSchema
          }
        },
        messages
      })
    });

    const bodyText = await response.text();

    if (!response.ok) {
      if (isStructuredOutputUnsupported(response.status, bodyText)) {
        throw new StructuredOutputUnsupportedError();
      }
      throw new Error(`OpenRouter request failed with status ${response.status}.`);
    }

    const body = parseJson(bodyText);
    const content = body?.choices?.[0]?.message?.content;

    if (typeof content !== "string") {
      throw new Error("OpenRouter response did not include message content.");
    }

    return {
      output: parseJsonOrString(content),
      usage: sanitizedUsage({ body, provider, model, inputCharCount, outputCharCount: content.length })
    };
  }
}

async function waitForRateLimit(maxRequestsPerMinute: number | null) {
  if (!maxRequestsPerMinute || maxRequestsPerMinute < 1) {
    return;
  }

  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  const previous = rateLimitMutex;
  rateLimitMutex = previous.then(() => next);
  await previous;

  try {
    for (;;) {
      const now = Date.now();
      while (requestStartTimes.length > 0 && now - requestStartTimes[0] >= RATE_LIMIT_WINDOW_MS) {
        requestStartTimes.shift();
      }
      if (requestStartTimes.length < maxRequestsPerMinute) {
        requestStartTimes.push(now);
        return;
      }
      const waitMs = RATE_LIMIT_WINDOW_MS - (now - requestStartTimes[0]);
      await sleep(waitMs);
    }
  } finally {
    release();
  }
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function parseJson(value: string) {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error("OpenRouter response was not valid JSON.");
  }
}

function parseJsonOrString(value: string) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function isStructuredOutputUnsupported(status: number, body: string) {
  if (/Unsupported parameter\(s\):\s*`provider`/i.test(body)) {
    return false;
  }
  return (
    status === 400 &&
    /response_format|json_schema|structured|require_parameters|unsupported|not support|parameters/i.test(body)
  );
}

function sanitizedUsage(input: { body: unknown; provider: "openrouter" | "nvidia"; model: string; inputCharCount: number; outputCharCount: number }): ProviderUsage {
  const usage = isRecord(input.body) && isRecord(input.body.usage) ? input.body.usage : {};
  return {
    provider: input.provider,
    model: input.model,
    promptTokenEstimate: Math.ceil(input.inputCharCount / 4),
    promptTokens: numberOrNull(usage.prompt_tokens),
    completionTokens: numberOrNull(usage.completion_tokens),
    totalTokens: numberOrNull(usage.total_tokens),
    inputCharCount: input.inputCharCount,
    outputCharCount: input.outputCharCount
  };
}

function numberOrNull(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function resetOpenRouterRateLimitForTests() {
  requestStartTimes.length = 0;
  rateLimitMutex = Promise.resolve();
}
