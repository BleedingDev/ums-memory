import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const KEY_SCOPE_PHRASES = Object.freeze([
  "Personalization Safety and Policy Controls",
  "trust boundaries",
  "privacy controls",
  "anti-overfitting safeguards",
  "Scope Mapping from PLAN.md P3",
  "In Scope",
  "Non-Goals",
  "Acceptance Criteria",
  "Backend Boundaries",
]);

const REQUIRED_P3_IDS = Object.freeze([
  "ums-memory-d6q",
  "ums-memory-d6q.5",
  "ums-memory-d6q.5.1",
]);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("ADR-0006 documents P3 safety/policy key phrases, backend boundary, and bead IDs", () => {
  const adrPath = new URL(
    "../../docs/adr/0006-p3-personalization-safety-scope.md",
    import.meta.url,
  );
  const adr = readFileSync(adrPath, "utf8");

  for (const phrase of KEY_SCOPE_PHRASES) {
    assert.match(adr, new RegExp(escapeRegExp(phrase), "i"));
  }

  assert.match(adr, /backend-only/i);
  assert.match(adr, /out of scope per ADR-0001/i);
  assert.match(adr, /backend API\/CLI\/MCP endpoints only/i);

  for (const id of REQUIRED_P3_IDS) {
    assert.match(adr, new RegExp(`\\b${escapeRegExp(id)}\\b`));
  }
});
