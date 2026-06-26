import { generationDebugEvents, getDb } from "@code2wiki/db";

type Severity = "INFO" | "WARN" | "ERROR";

const REDACTED_KEY = /(prompt|body|provider|raw|secret|token|auth|header|cookie|password|apikey|api_key)/i;
const MAX_DEPTH = 5;
const MAX_STRING = 300;
const MAX_ARRAY = 200;
const MAX_KEYS = 40;

export async function emitDebugEvent(input: {
  generationRunId: string;
  stage: string;
  eventType: string;
  message: string;
  severity?: Severity;
  payload?: Record<string, unknown>;
}) {
  try {
    await getDb().insert(generationDebugEvents).values({
      id: crypto.randomUUID(),
      generationRunId: input.generationRunId,
      stage: input.stage,
      eventType: input.eventType,
      severity: input.severity ?? "INFO",
      message: input.message,
      payloadJson: sanitizeDebugPayload(input.payload ?? {})
    });
  } catch (error) {
    console.warn("debug event write failed", error instanceof Error ? error.message : "UNKNOWN_ERROR");
  }
}

export function sanitizeDebugPayload(value: unknown): Record<string, unknown> {
  const sanitized = sanitizeValue(value, 0);
  return sanitized && typeof sanitized === "object" && !Array.isArray(sanitized) ? sanitized as Record<string, unknown> : {};
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return "[truncated]";
  if (typeof value === "string") return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}...` : value;
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY).map((item) => sanitizeValue(item, depth + 1));
  if (!value || typeof value !== "object") return String(value);

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, MAX_KEYS)
      .map(([key, item]) => [key, REDACTED_KEY.test(key) ? "[redacted]" : sanitizeValue(item, depth + 1)])
  );
}
