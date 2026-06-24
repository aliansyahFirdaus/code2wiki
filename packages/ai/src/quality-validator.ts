import type { ProductWikiBlock, ProductWikiOutput } from "@code2wiki/document";

export type QualitySeverity = "ERROR" | "WARN";
export type QualityGateResult = "PASS" | "WARN" | "FAIL";

export type QualityIssue = {
  code: string;
  severity: QualitySeverity;
  message: string;
  pageKey?: string;
  blockStableKey?: string;
};

export type QualityMetric = {
  name: string;
  value: number;
};

export type QualityReport = {
  gateResult: QualityGateResult;
  issues: QualityIssue[];
  metrics: QualityMetric[];
};

export type QualityEvidence = {
  id: string;
  generationRunId: string;
  repositoryRole: "FRONTEND" | "BACKEND";
  userFacingText?: string | null;
};

export type ValidateQualityInput = {
  generationRunId: string;
  allowedPageKeys: string[];
  evidence: QualityEvidence[];
  output: ProductWikiOutput | null;
};

export function validateQuality(input: ValidateQualityInput): QualityReport {
  const issues: QualityIssue[] = [];
  const metrics = new Map<string, number>();
  const allowedPageKeys = new Set(input.allowedPageKeys);
  const evidenceById = new Map(input.evidence.map((item) => [item.id, item]));

  if (!input.output?.pages.length) {
    issues.push(error("NO_VALID_MODEL_OUTPUT", "No valid model output."));
    return report(issues, [{ name: "pageCount", value: 0 }]);
  }

  const pageKeys = new Set(input.output.pages.map((page) => page.pageKey));
  let blockCount = 0;
  let statementCount = 0;
  let usedEvidenceCount = 0;
  let openQuestionCount = 0;
  let needsReviewCount = 0;
  let frontendCited = false;
  let backendCited = false;
  const statementTexts = new Map<string, string>();

  for (const page of input.output.pages) {
    if (!allowedPageKeys.has(page.pageKey)) {
      issues.push(error("INVENTED_PAGE_KEY", `Invented pageKey: ${page.pageKey}`, page.pageKey));
    }
    if (page.blocks.length === 0) {
      issues.push(error("EMPTY_PAGE", `Page has no blocks: ${page.pageKey}`, page.pageKey));
    }

    for (const block of flatten(page.blocks)) {
      blockCount += 1;
      if (block.reviewState === "NEEDS_REVIEW") needsReviewCount += 1;
      if (block.type === "open_question") openQuestionCount += 1;

      for (const leak of leakIssues(blockText(block), page.pageKey, block.stableKey)) {
        issues.push(leak);
      }
      const citedEvidenceText = "evidenceIds" in block ? (block.evidenceIds ?? []).map((id) => evidenceById.get(id)?.userFacingText ?? "").join(" ") : "";
      for (const leak of technicalProseIssues(blockText(block), citedEvidenceText, page.pageKey, block.stableKey)) {
        issues.push(leak);
      }

      if (block.type === "statement") {
        statementCount += 1;
        const normalizedText = block.text.trim().toLowerCase();
        const firstStableKey = statementTexts.get(normalizedText);
        if (firstStableKey) {
          issues.push(warn("DUPLICATE_STATEMENT_TEXT", `Duplicate statement text also appears at ${firstStableKey}.`, page.pageKey, block.stableKey));
        } else {
          statementTexts.set(normalizedText, block.stableKey);
        }
        if (block.text.length > 500) issues.push(warn("VERY_LONG_STATEMENT", "Statement is very long.", page.pageKey, block.stableKey));
        if (isVague(block.text)) issues.push(warn("VAGUE_STATEMENT", "Statement uses vague wording.", page.pageKey, block.stableKey));

        if (block.evidenceIds.length === 0) {
          issues.push(error("CODE_STATEMENT_WITHOUT_VALID_EVIDENCE", "CODE statement has no evidence IDs.", page.pageKey, block.stableKey));
        }
        for (const evidenceId of block.evidenceIds) {
          const evidence = evidenceById.get(evidenceId);
          if (!evidence) {
            issues.push(error("CODE_STATEMENT_WITHOUT_VALID_EVIDENCE", `Unknown evidence ID: ${evidenceId}`, page.pageKey, block.stableKey));
            continue;
          }
          if (evidence.generationRunId !== input.generationRunId) {
            issues.push(error("EVIDENCE_NOT_SAME_GENERATION", `Evidence ID is not from this generation: ${evidenceId}`, page.pageKey, block.stableKey));
          }
          if (evidence.repositoryRole === "FRONTEND") frontendCited = true;
          if (evidence.repositoryRole === "BACKEND") backendCited = true;
          usedEvidenceCount += 1;
        }
      }

      if ((block.type === "paragraph" || block.type === "callout") && behaviorClaim(block.text) && (block.evidenceIds?.length ?? 0) === 0) {
        issues.push(warn("BEHAVIOR_CLAIM_WITHOUT_EVIDENCE", "Paragraph or callout behavior claim has no evidence.", page.pageKey, block.stableKey));
      }

      if (block.type === "related_page" && !pageKeys.has(block.pageId)) {
        issues.push(error("UNSUPPORTED_RELATED_PAGE", `Related page is not supported: ${block.pageId}`, page.pageKey, block.stableKey));
      }
    }
  }

  const rolesInContext = new Set(input.evidence.map((item) => item.repositoryRole));
  if (rolesInContext.has("FRONTEND") && rolesInContext.has("BACKEND") && statementCount > 0 && (!frontendCited || !backendCited)) {
    issues.push(warn("ONE_ROLE_CITED_WITH_FE_BE_CONTEXT", "Frontend and backend context exist, but output cites only one role."));
  }
  if (statementCount < 2) issues.push(warn("LOW_STATEMENT_COUNT", "Low statement count."));
  if (blockCount > 0 && openQuestionCount / blockCount > 0.4) issues.push(warn("HIGH_OPEN_QUESTION_RATIO", "High open_question ratio."));
  if (blockCount > 0 && needsReviewCount / blockCount > 0.4) issues.push(warn("HIGH_NEEDS_REVIEW_RATIO", "High NEEDS_REVIEW ratio."));
  if (input.evidence.length > 0 && usedEvidenceCount / input.evidence.length < 0.25) issues.push(warn("LOW_EVIDENCE_USAGE", "Low evidence usage."));

  metrics.set("pageCount", input.output.pages.length);
  metrics.set("blockCount", blockCount);
  metrics.set("statementCount", statementCount);
  metrics.set("usedEvidenceCount", usedEvidenceCount);
  metrics.set("openQuestionRatio", blockCount ? openQuestionCount / blockCount : 0);
  metrics.set("needsReviewRatio", blockCount ? needsReviewCount / blockCount : 0);
  metrics.set("evidenceUsageRatio", input.evidence.length ? usedEvidenceCount / input.evidence.length : 0);

  return report(issues, [...metrics.entries()].map(([name, value]) => ({ name, value })));
}

function report(issues: QualityIssue[], metrics: QualityMetric[]): QualityReport {
  return {
    gateResult: issues.some((issue) => issue.severity === "ERROR") ? "FAIL" : issues.some((issue) => issue.severity === "WARN") ? "WARN" : "PASS",
    issues,
    metrics
  };
}

function flatten(blocks: ProductWikiBlock[]): ProductWikiBlock[] {
  return blocks.flatMap((block) => [block, ...(block.children ? flatten(block.children) : [])]);
}

function leakIssues(text: string, pageKey: string, blockStableKey: string): QualityIssue[] {
  const patterns: Array<[string, RegExp, string]> = [
    ["LOCAL_PATH_LEAK", /(?:\/Users\/|\/private\/tmp\/|[A-Z]:\\Users\\)/i, "Local path leak."],
    ["SECRET_TOKEN_LEAK", /\b(?:sk-or-v1|sk|pk|rk|or)-[A-Za-z0-9_-]{12,}\b/i, "Secret or token leak."],
    ["AUTHORIZATION_BEARER_LEAK", /Authorization\s*:\s*Bearer\s+[A-Za-z0-9._-]+|Bearer\s+[A-Za-z0-9._-]{12,}/i, "Authorization or Bearer leak."],
    ["RAW_ENV_ASSIGNMENT_LEAK", /\b[A-Z][A-Z0-9_]{2,}\s*=\s*[^,\s"'`]+/, "Raw env assignment leak."],
    ["PROVIDER_METADATA_LEAK", /\b(?:x-openrouter|x-ratelimit|cf-ray|set-cookie|raw provider metadata)\b/i, "Provider metadata or header-like leak."]
  ];
  return patterns.filter(([, pattern]) => pattern.test(text)).map(([code, , message]) => error(code, message, pageKey, blockStableKey));
}

function technicalProseIssues(text: string, citedEvidenceText: string, pageKey: string, blockStableKey: string): QualityIssue[] {
  const terms = [
    "api",
    "endpoint",
    "handler",
    "sql",
    "database",
    "frontend",
    "backend",
    "component",
    "route",
    "function",
    "schema"
  ];
  const pattern = new RegExp(`\\b(?:${terms.join("|")})\\b`, "i");
  const leakedTerms = text.match(new RegExp(`\\b(?:${terms.join("|")})\\b`, "gi")) ?? [];
  const disallowedTerms = leakedTerms.filter((term) => !new RegExp(`\\b${escapeRegExp(term)}\\b`, "i").test(citedEvidenceText));
  return pattern.test(text) && disallowedTerms.length > 0
    ? [warn("TECHNICAL_PROSE_LEAK", "User-facing wiki text contains implementation terminology.", pageKey, blockStableKey)]
    : [];
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function blockText(block: ProductWikiBlock) {
  if ("text" in block) return block.text;
  if (block.type === "open_question") return `${block.question} ${block.reason}`;
  if (block.type === "related_page") return `${block.pageId} ${block.title}`;
  return "";
}

function behaviorClaim(text: string) {
  return /\b(?:can|must|requires?|allows?|prevents?|redirects?|submits?|saves?|deletes?|updates?|validates?)\b/i.test(text);
}

function isVague(text: string) {
  return /\b(?:various|some|maybe|probably|etc\.?|things|stuff)\b/i.test(text);
}

function error(code: string, message: string, pageKey?: string, blockStableKey?: string): QualityIssue {
  return { code, severity: "ERROR", message, pageKey, blockStableKey };
}

function warn(code: string, message: string, pageKey?: string, blockStableKey?: string): QualityIssue {
  return { code, severity: "WARN", message, pageKey, blockStableKey };
}
