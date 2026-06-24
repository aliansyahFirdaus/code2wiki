#!/bin/zsh
set -euo pipefail

cd /Users/aliansyahfirdaus/Downloads/code2wiki

set -a
source apps/web/.env.local
set +a

model="${1:-${MODEL:-${OPENROUTER_MODEL:-${AI_MODEL:-}}}}"
base_url="${2:-${BASE_URL:-${OPENROUTER_BASE_URL:-https://openrouter.ai/api/v1}}}"

if [[ -z "${OPENROUTER_API_KEY:-}" ]]; then
  echo "FAIL: OPENROUTER_API_KEY is empty"
  exit 1
fi

if [[ -z "$model" ]]; then
  echo "FAIL: model is empty"
  exit 1
fi

payload="$(mktemp)"
response=".codex/last-structured-output-response.json"

node - "$payload" "$model" <<'NODE'
const fs = require("node:fs");
const [file, model] = process.argv.slice(2);

const blockSchema = {
  type: "object",
  additionalProperties: false,
  required: ["type"],
  properties: {
    type: {
      type: "string",
      enum: ["title", "heading", "paragraph", "statement", "callout", "open_question", "related_page", "divider"],
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
    children: { type: "array", items: { $ref: "#/$defs/block" } },
  },
};

const pageGroup = {
  pageKey: "payroll.vessel-bonus",
  title: "Payroll Vessel Bonus",
  facts: [{
    id: "fact_manual_1",
    repositoryRole: "FRONTEND",
    repositoryFullName: "aliansyahFirdaus/omnia-clone",
    tag: "v1.0.7",
    commitSha: "17e37cb452f2",
    factKind: "UI_BEHAVIOR",
    text: "Users can open Vessel Bonus from the Payroll list, choose a month, and review crew payroll values before recalculating payroll.",
    evidenceIds: ["ev_manual_1"],
    confidence: 0.9,
  }],
  evidence: [{
    id: "ev_manual_1",
    repositoryRole: "FRONTEND",
    repositoryFullName: "aliansyahFirdaus/omnia-clone",
    tag: "v1.0.7",
    commitSha: "17e37cb452f2",
    filePath: "src/app/payroll/page.tsx",
    startLine: 10,
    endLine: 80,
    sourceKind: "UI_FLOW",
    summary: "The Payroll screen lists vessels. Opening Vessel Bonus shows month selection, crew data, payroll values, and a recalculation action.",
    githubUrl: "https://example.com/src/app/payroll/page.tsx#L10-L80",
  }],
};

const payload = {
  model,
  temperature: 0,
  provider: { require_parameters: true },
  response_format: {
    type: "json_schema",
    json_schema: {
      name: "product_wiki_output",
      strict: true,
      schema: {
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
                blocks: { type: "array", items: { $ref: "#/$defs/block" } },
              },
            },
          },
        },
        $defs: { block: blockSchema },
      },
    },
  },
  messages: [
    {
      role: "system",
      content: [
        "Return ONLY one JSON object.",
        "The top-level object MUST have exactly this shape: {\"pages\":[...]}",
        "Never use top-level keys such as wikiBlocks, blocks, documents, data, result, or output.",
        "Each page MUST contain pageKey, title, and blocks.",
        "Each block MUST contain type.",
        "Use block.type, never blockType.",
        "For sourced behavior, use type=\"statement\", text, and evidenceIds.",
        "Use evidenceIds as an array of strings, never evidenceReferences.",
        "Use only evidenceIds that were provided in the input.",
        "If unsure, return an open_question block that still follows the schema.",
        "Valid minimal example:",
        "{\"pages\":[{\"pageKey\":\"payroll.vessel-bonus\",\"title\":\"Payroll Vessel Bonus\",\"blocks\":[{\"type\":\"title\",\"text\":\"Payroll Vessel Bonus\"},{\"type\":\"statement\",\"text\":\"Users can review Vessel Bonus payroll values before recalculating payroll.\",\"evidenceIds\":[\"ev_manual_1\"],\"confidence\":0.9}]}]}"
      ].join("\\n"),
    },
    {
      role: "user",
      content: JSON.stringify({
        generationRunId: "manual-check",
        allowedPageKeys: ["payroll.vessel-bonus"],
        pageGroups: [pageGroup],
      }),
    },
  ],
};

fs.writeFileSync(file, JSON.stringify(payload));
NODE

echo "base_url=$base_url"
echo "model=$model"

curl -sS "${base_url%/}/chat/completions" \
  -H "Authorization: Bearer ${OPENROUTER_API_KEY}" \
  -H "Content-Type: application/json" \
  --data @"$payload" > "$response"

node - "$response" <<'NODE'
const fs = require("node:fs");
const responsePath = process.argv[2];
const body = JSON.parse(fs.readFileSync(responsePath, "utf8"));
if (body.error) {
  console.log(`FAIL: provider error: ${body.error.message || JSON.stringify(body.error)}`);
  process.exit(0);
}

const content = body.choices?.[0]?.message?.content;
if (typeof content !== "string") {
  console.log("FAIL: missing message.content");
  process.exit(0);
}

let output;
try {
  output = JSON.parse(content);
} catch {
  console.log("FAIL: message.content is not JSON");
  console.log(content.slice(0, 800));
  process.exit(0);
}

const page = output.pages?.[0];
const block = page?.blocks?.[0];
const ok =
  Array.isArray(output.pages) &&
  typeof page?.pageKey === "string" &&
  typeof page?.title === "string" &&
  Array.isArray(page?.blocks) &&
  typeof block?.type === "string";

if (!ok) {
  console.log("FAIL: JSON returned, but not ProductWiki schema");
  console.log(JSON.stringify(output, null, 2).slice(0, 1600));
  process.exit(0);
}

console.log("PASS: response follows ProductWiki JSON schema");
console.log(JSON.stringify({ pageKey: page.pageKey, title: page.title, firstBlock: block }, null, 2).slice(0, 1600));
NODE

echo "raw_response=$response"
