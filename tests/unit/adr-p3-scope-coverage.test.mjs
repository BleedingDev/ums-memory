import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const KEY_SCOPE_PHRASES = Object.freeze([
  "Learner profile ingestion APIs",
  "identity graph construction",
  "Curriculum planning hooks",
  "Local-first persistence layers",
  "Contract artifacts for other backend beads",
]);

const REQUIRED_P3_IDS = Object.freeze([
  "ums-memory-d6q",
  "ums-memory-d6q.1",
  "ums-memory-d6q.1.1",
]);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("ADR-0002 documents scope phrases, frontend boundary, and P3 ids", () => {
  const adrPath = new URL(
    "../../docs/adr/0002-p3-learner-profile-identity-graph-scope.md",
    import.meta.url,
  );
  const adr = readFileSync(adrPath, "utf8");

  for (const phrase of KEY_SCOPE_PHRASES) {
    assert.match(adr, new RegExp(escapeRegExp(phrase), "i"));
  }

  assert.match(adr, /UI product surfaces/i);
  assert.match(adr, /out of scope per ADR-0001/i);

  for (const id of REQUIRED_P3_IDS) {
    assert.match(adr, new RegExp(`\\b${escapeRegExp(id)}\\b`));
  }
});
