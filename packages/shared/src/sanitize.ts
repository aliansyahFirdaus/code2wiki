const SECRET_PATTERNS = [
  /sk-or-v1-[A-Za-z0-9_-]+/g,
  /ghs_[A-Za-z0-9_]+/g,
  /ghu_[A-Za-z0-9_]+/g,
  /github_pat_[A-Za-z0-9_]+/g,
  /Bearer\s+[A-Za-z0-9._-]+/gi,
  /authorization:\s*[^\s,}]+/gi,
  /GITHUB_APP_PRIVATE_KEY=[^\s]+/gi,
  /GITHUB_WEBHOOK_SECRET=[^\s]+/gi,
  /OPENROUTER_API_KEY=[^\s]+/gi,
  /https:\/\/[^/\s@]+:[^@\s]+@github\.com/gi
];

export function sanitizeErrorText(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value ?? "Unknown error.");
  return SECRET_PATTERNS.reduce((text, pattern) => text.replace(pattern, "[redacted]"), message).slice(0, 1000);
}

export function sanitizeJson<T>(value: T): T {
  if (typeof value === "string") {
    return sanitizeErrorText(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeJson(item)) as T;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeJson(item)])) as T;
  }
  return value;
}
