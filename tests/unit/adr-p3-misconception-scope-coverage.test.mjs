import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const KEY_SCOPE_PHRASES = Object.freeze([
  "Misconception tracking via feedback loops",
  "feedback as a \"pain signal\"",
  "harmful-weight increments",
  "anti-pattern inversion",
  "decay acceleration",
  "memory-driven curriculum planning",
  "spaced repetition",
]);

const REQUIRED_BEAD_IDS = Object.freeze([
  "ums-memory-d6q",
  "ums-memory-d6q.2",
  "ums-memory-d6q.2.1",
]);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("ADR-0003 captures misconception scope, backend-only boundary, and bead lineage", () => {
  const adrPath = new URL(
    "../../docs/adr/0003-p3-misconception-tracking-scope.md",
    import.meta.url,
  );
  const adr = readFileSync(adrPath, "utf8");

  for (const phrase of KEY_SCOPE_PHRASES) {
    assert.match(adr, new RegExp(escapeRegExp(phrase), "i"));
  }

  assert.match(adr, /backend-only/i);
  assert.match(adr, /frontend tutoring experiences/i);
  assert.match(adr, /Out of Scope/i);

  for (const beadId of REQUIRED_BEAD_IDS) {
    assert.match(adr, new RegExp(`\\b${escapeRegExp(beadId)}\\b`));
  }
});
