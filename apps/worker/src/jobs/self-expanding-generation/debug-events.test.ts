import { describe, expect, it } from "vitest";

import { sanitizeDebugPayload } from "./debug-events";

describe("debug event payload sanitizer", () => {
  it("redacts prompt provider bodies and secrets", () => {
    expect(
      sanitizeDebugPayload({
        prompt: "raw prompt",
        providerBody: { messages: ["secret"] },
        authorizationHeader: "Bearer token",
        cookie: "session",
        nested: { apiKey: "key", ok: "value" }
      })
    ).toEqual({
      prompt: "[redacted]",
      providerBody: "[redacted]",
      authorizationHeader: "[redacted]",
      cookie: "[redacted]",
      nested: { apiKey: "[redacted]", ok: "value" }
    });
  });
});
