import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const KEY_SCOPE_PHRASES = Object.freeze([
  "Learner profiles",
  "Misconception tracking via feedback loops",
  "Memory-driven curriculum planning (spaced repetition, interests)",
  "Spaced Repetition",
  "Review Scheduling",
]);

const REQUIRED_BEAD_IDS = Object.freeze([
  "ums-memory-d6q",
  "ums-memory-d6q.4",
  "ums-memory-d6q.4.1",
]);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("ADR-0005 documents P3 key phrases, backend-only boundary, and bead IDs", () => {
  const adrPath = new URL(
    "../../docs/adr/0005-p3-spaced-repetition-scope.md",
    import.meta.url,
  );
  const adr = readFileSync(adrPath, "utf8");

  for (const phrase of KEY_SCOPE_PHRASES) {
    assert.match(adr, new RegExp(escapeRegExp(phrase), "i"));
  }

  assert.match(adr, /backend-only/i);
  assert.match(adr, /out of scope per ADR-0001/i);
  assert.match(adr, /No frontend screens/i);

  for (const id of REQUIRED_BEAD_IDS) {
    assert.match(adr, new RegExp(`\\b${escapeRegExp(id)}\\b`));
  }
});
