import {
  StructuredOutputUnsupportedError,
  type AIProvider,
  type GenerateProductWikiInput,
  type GenerateProductWikiRepairInput
} from "./provider";

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
  async generateProductWiki(input: GenerateProductWikiInput, repair?: GenerateProductWikiRepairInput): Promise<unknown> {
    const apiKey = process.env.OPENROUTER_API_KEY;
    const model = process.env.OPENROUTER_MODEL;
    const baseUrl = process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";

    if (!apiKey) {
      throw new Error("OPENROUTER_API_KEY is required.");
    }
    if (!model) {
      throw new Error("OPENROUTER_MODEL is required.");
    }

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
        messages: [
          {
            role: "system",
            content:
              "Generate only structured ProductWikiBlock JSON. Use only provided pageKeys and evidence IDs. Do not output markdown or prose."
          },
          {
            role: "user",
            content: JSON.stringify({
              task: repair
                ? "Repair the previous output so it satisfies the schema and validation errors."
                : "Generate product wiki pages from these deterministic facts and evidence.",
              generationRunId: input.generationRunId,
              allowedPageKeys: input.pageGroups.map((group) => group.pageKey),
              pageGroups: input.pageGroups,
              invalidOutput: repair?.invalidOutput,
              validationErrors: repair?.validationErrors
            })
          }
        ]
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

    return parseJsonOrString(content);
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
