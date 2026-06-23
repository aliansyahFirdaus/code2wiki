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
    this.capabilities = {
      provider: "openrouter",
      model: config?.model ?? process.env.OPENROUTER_MODEL ?? process.env.AI_MODEL ?? OPENROUTER_DEFAULT_MODEL,
      supportsStrictJsonSchema: true,
      supportsUsage: true,
      supportsRepair: true,
      usageSource: "provider",
      structuredOutputMode: "json_schema"
    };
  }

  async generateProductWiki(input: GenerateProductWikiInput, repair?: GenerateProductWikiRepairInput): Promise<GenerateProductWikiResult> {
    const apiKey = this.config?.apiKey ?? process.env.OPENROUTER_API_KEY;
    const model = this.config?.model ?? process.env.OPENROUTER_MODEL ?? process.env.AI_MODEL ?? OPENROUTER_DEFAULT_MODEL;
    const baseUrl = this.config?.baseUrl ?? process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";

    if (!apiKey) {
      throw new Error("OPENROUTER_API_KEY is required.");
    }

    const messages = repair
      ? buildProductWikiRepairMessages(input, repair.invalidOutput, repair.validationErrors)
      : buildProductWikiMessages(input);
    const inputCharCount = messages.reduce((total, message) => total + message.content.length, 0);

    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        provider: {
          require_parameters: true
        },
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
      usage: sanitizedUsage({ body, model, inputCharCount, outputCharCount: content.length })
    };
  }
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
  return (
    status === 400 &&
    /response_format|json_schema|structured|require_parameters|unsupported|not support|parameters/i.test(body)
  );
}

function sanitizedUsage(input: { body: unknown; model: string; inputCharCount: number; outputCharCount: number }): ProviderUsage {
  const usage = isRecord(input.body) && isRecord(input.body.usage) ? input.body.usage : {};
  return {
    provider: "openrouter",
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
