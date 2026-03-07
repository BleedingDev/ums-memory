import assert from "node:assert/strict";

import { test } from "@effect-native/bun-test";

import {
  extractSanitizedSourceContent,
  sanitizeSourceContent,
} from "../../ums/src/source-redaction.ts";

test("source redaction sanitizes secret-bearing plain text deterministically", () => {
  const redacted = sanitizeSourceContent(
    "api_key=secret123 Bearer abcdefghijklmnop sk-1234567890abcdefgh"
  );

  assert.equal(redacted.includes("secret123"), false);
  assert.equal(redacted.includes("abcdefghijklmnop"), false);
  assert.equal(redacted.includes("sk-1234567890abcdefgh"), false);
  assert.equal(redacted.includes("[REDACTED_SECRET]"), true);
});

test("source redaction extracts and sanitizes structured content without leaking nested secrets", () => {
  const redacted = extractSanitizedSourceContent({
    prompt: "Summarize incident context",
    nested: {
      message: 'authorization="Bearer very-secret-token"',
      details: [{ summary: "password=hunter2" }],
    },
  });

  assert.equal(redacted.includes("very-secret-token"), false);
  assert.equal(redacted.includes("hunter2"), false);
  assert.equal(redacted.includes("Summarize incident context"), true);
});
