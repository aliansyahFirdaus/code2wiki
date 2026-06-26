import { afterEach, describe, expect, it, vi } from "vitest";

import { OpenRouterProvider, resetOpenRouterRateLimitForTests } from "./openrouter-provider";
import type { GenerateProductWikiInput } from "./provider";
import { buildProductWikiMessages, buildProductWikiRepairMessages } from "./product-wiki-prompts";

describe("product wiki prompts", () => {
  afterEach(() => {
    vi.useRealTimers();
    resetOpenRouterRateLimitForTests();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("includes evidence policy and valid-ID wording", () => {
    const text = messageText(buildProductWikiMessages(input()));

    expect(text).toContain("statement blocks require valid provided evidenceIds");
    expect(text).toContain("Every CODE statement must use valid provided evidenceIds");
    expect(text).toContain("Use same-run provided IDs only");
  });

  it("forbids markdown canonical output", () => {
    const text = messageText(buildProductWikiMessages(input()));

    expect(text).toContain("Return ONLY one JSON object");
    expect(text).toContain("Do not output markdown");
    expect(text).toContain("no markdown");
  });

  it("spells out the ProductWiki JSON shape for weak schema providers", () => {
    const text = messageText(buildProductWikiMessages(input()));

    expect(text).toContain("top-level object MUST use exactly this shape");
    expect(text).toContain("Never use top-level keys such as wikiBlocks");
    expect(text).toContain("Each block MUST contain type");
    expect(text).toContain("Use block.type, never blockType");
    expect(text).toContain("Use evidenceIds as an array of strings, never evidenceReferences");
    expect(text).toContain("Valid minimal example");
  });

  it("forbids invented evidence IDs", () => {
    const text = messageText(buildProductWikiMessages(input()));

    expect(text).toContain("Never invent evidence IDs");
    expect(text).toContain("Use only allowed pageKeys and provided evidence IDs");
  });

  it("instructs weak or low-confidence support to be omitted or open_question", () => {
    const text = messageText(buildProductWikiMessages(input()));

    expect(text).toContain("Weak, incomplete, ambiguous, or low-confidence support must be omitted or written as open_question");
    expect(text).toContain("If support is weak, low-confidence, incomplete, or ambiguous");
  });

  it("enforces non-technical product story wording", () => {
    const text = messageText(buildProductWikiMessages(input()));

    expect(text).toContain("Write user-facing product stories, not implementation explanations");
    expect(text).toContain("Write product knowledge, not implementation trivia");
    expect(text).toContain("Write complete product docs, not terse bullet dumps");
    expect(text).toContain("Make the page read like a clear feature story");
    expect(text).toContain("Do not use technical implementation terms");
    expect(text).toContain("Prefer flows, business rules, validations, permissions, side effects, error states, and dependencies over code trivia");
    expect(text).not.toContain("API contracts");
  });

  it("instructs attached concepts and bilingual page groups", () => {
    const text = messageText(buildProductWikiMessages(input({ languages: ["id", "en"], attachedConcept: { conceptKey: "status-filter" } })));

    expect(text).toContain("attachedConcept");
    expect(text).toContain("place that evidence inside the relevant section");
    expect(text).toContain("languages exactly [\"id\",\"en\"]");
    expect(text).toContain("ID:");
    expect(text).toContain("EN:");
    expect(text).toContain("\"languages\":[\"id\",\"en\"]");
  });

  it("includes the internal module template", () => {
    const text = messageText(buildProductWikiMessages(input()));

    expect(text).toContain("internal module template");
    expect(text).toContain("Ringkasan");
    expect(text).toContain("Siapa Yang Menggunakan Modul Ini");
    expect(text).toContain("Alur Kerja Utama");
    expect(text).toContain("Yang Perlu Dicek Jika Ada Masalah");
  });

  it("repair prompt forbids new claims", () => {
    const text = messageText(buildProductWikiRepairMessages(input(), { pages: [] }, ["missing evidence"]));

    expect(text).toContain("repair_product_wiki_json");
    expect(text).toContain("JSON Repair");
    expect(text).toContain("Do not introduce new claims");
    expect(text).toContain("Repair JSON only");
    expect(text).toContain("Restore missing internal module structure");
  });

  it("forbids and redacts local paths, secrets, tokens, env values, and provider metadata", () => {
    const text = messageText(buildProductWikiMessages(inputWithUnsafeStrings()));

    expect(text).toContain("Do not expose local paths, secrets, tokens, env values, Authorization headers, provider metadata");
    expect(text).not.toContain("/private/tmp");
    expect(text).not.toContain("/Users/");
    expect(text).not.toContain("sk-or-v1-secretsecret");
    expect(text).not.toContain("Authorization: Bearer live-token");
    expect(text).not.toContain("OPENROUTER_API_KEY=secret");
    expect(text).not.toContain("raw provider metadata: leak");
  });

  it("creates stable message payload text for the same input", () => {
    const first = buildProductWikiMessages(input());
    const second = buildProductWikiMessages(input());

    expect(first).toEqual(second);
    expect(first[1].content).toBe(second[1].content);
  });

  it("OpenRouterProvider keeps strict JSON response_format schema", async () => {
    const fetchMock = mockFetch();
    await provider().generateProductWiki(input());
    const body = requestBody(fetchMock);

    expect(body.response_format).toMatchObject({
      type: "json_schema",
      json_schema: {
        name: "product_wiki_output",
        strict: true
      }
    });
    expect(body.response_format.json_schema.schema.properties.pages.items.properties.blocks.items).toEqual({ $ref: "#/$defs/block" });
    expect(body.provider).toEqual({ require_parameters: true });
    expect(body.temperature).toBe(0);
  });

  it("NVIDIA requests omit OpenRouter-only provider parameters", async () => {
    const fetchMock = mockFetch();

    await provider({ provider: "nvidia" }).generateProductWiki(input());
    const body = requestBody(fetchMock);

    expect(body.provider).toBeUndefined();
    expect(body.response_format?.type).toBe("json_schema");
  });

  it("OpenRouterProvider sends one generation call and one optional repair call per invocation", async () => {
    const fetchMock = mockFetch();
    const openRouterProvider = provider();

    await openRouterProvider.generateProductWiki(input());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(requestBody(fetchMock).messages[1].content).task).toBe("generate_product_wiki");

    fetchMock.mockClear();
    await openRouterProvider.generateProductWiki(input(), { invalidOutput: { pages: [] }, validationErrors: ["CODE statement is missing valid evidence"] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(requestBody(fetchMock).messages[1].content).task).toBe("repair_product_wiki_json");
  });

  it("OpenRouterProvider returns parsed output and sanitized usage", async () => {
    const fetchMock = mockFetch();
    const result = await provider().generateProductWiki(input());

    expect(result.output).toEqual({ pages: [] });
    expect(result.usage).toMatchObject({
      provider: "openrouter",
      model: "test-model",
      promptTokens: 11,
      completionTokens: 7,
      totalTokens: 18,
      outputCharCount: JSON.stringify({ pages: [] }).length
    });
    expect(Object.keys(result.usage).sort()).toEqual([
      "completionTokens",
      "inputCharCount",
      "model",
      "outputCharCount",
      "promptTokenEstimate",
      "promptTokens",
      "provider",
      "totalTokens"
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("OpenRouterProvider accepts resolved config", async () => {
    const fetchMock = mockFetch();

    await new OpenRouterProvider({
      provider: "openrouter",
      model: "config-model",
      apiKey: "config-key",
      baseUrl: "https://openrouter.example/api/v1/"
    }).generateProductWiki(input());

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://openrouter.example/api/v1/chat/completions");
    expect(init?.headers).toMatchObject({ Authorization: "Bearer config-key" });
    expect(requestBody(fetchMock).model).toBe("config-model");
  });

  it("OpenRouterProvider can throttle requests per minute", async () => {
    vi.useFakeTimers();
    const fetchMock = mockFetch();
    const openRouterProvider = provider({ maxRequestsPerMinute: 1 });

    await openRouterProvider.generateProductWiki(input());
    const secondCall = openRouterProvider.generateProductWiki(input());

    await vi.advanceTimersByTimeAsync(59_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    await secondCall;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

function messageText(messages: ReturnType<typeof buildProductWikiMessages>) {
  return messages.map((message) => message.content).join("\n");
}

function input(pageGroupOverrides: Partial<GenerateProductWikiInput["pageGroups"][number]> = {}): GenerateProductWikiInput {
  return {
    generationRunId: "run-1",
    pageGroups: [
      {
        pageKey: "crew.add",
        title: "Add Crew",
        ...pageGroupOverrides,
        facts: [
          {
            id: "fact-1",
            repositoryRole: "FRONTEND",
            repositoryFullName: "acme/web",
            tag: "v1",
            commitSha: "sha-fe",
            factKind: "FORM_FIELD",
            text: "Crew add form requires a name before submit.",
            evidenceIds: ["ev-1"],
            confidence: 0.95
          }
        ],
        evidence: [
          {
            id: "ev-1",
            repositoryRole: "FRONTEND",
            repositoryFullName: "acme/web",
            tag: "v1",
            commitSha: "sha-fe",
            filePath: "app/crew/add/page.tsx",
            startLine: 10,
            endLine: 12,
            sourceKind: "VALIDATION",
            summary: "Name is required.",
            githubUrl: "https://github.com/acme/web/blob/sha/app/crew/add/page.tsx#L10-L12"
          }
        ]
      }
    ]
  };
}

function inputWithUnsafeStrings(): GenerateProductWikiInput {
  const value = input();
  return {
    ...value,
    pageGroups: [
      {
        ...value.pageGroups[0],
        facts: [
          {
            ...value.pageGroups[0].facts[0],
            text: "Leaked /private/tmp/checkout/app/page.tsx sk-or-v1-secretsecret OPENROUTER_API_KEY=secret raw provider metadata: leak"
          }
        ],
        evidence: [
          {
            ...value.pageGroups[0].evidence[0],
            filePath: "/Users/me/project/app/crew/add/page.tsx",
            summary: "Authorization: Bearer live-token"
          }
        ]
      }
    ]
  };
}

function provider(overrides: Partial<ConstructorParameters<typeof OpenRouterProvider>[0]> = {}) {
  return new OpenRouterProvider({
    provider: "openrouter",
    apiKey: "test-key",
    model: "test-model",
    baseUrl: "https://openrouter.example/api/v1",
    ...overrides
  });
}

function mockFetch() {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: vi.fn().mockResolvedValue(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ pages: [] }) } }],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18, raw_provider_field: "ignored" },
      raw_headers: { authorization: "Bearer secret" }
    }))
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function requestBody(fetchMock: ReturnType<typeof mockFetch>) {
  const [, init] = fetchMock.mock.calls[0];
  return JSON.parse(String(init?.body));
}
