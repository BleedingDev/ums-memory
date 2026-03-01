import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const REQUIRED_PLAN_PHRASES = Object.freeze([
  "Learner profiles",
  "Misconception tracking via feedback loops",
  "Memory-driven curriculum planning (spaced repetition, interests)",
]);

const REQUIRED_SCOPE_PHRASES = Object.freeze([
  "Curriculum planner ingestion APIs for memory signals",
  "Deterministic planner state transitions",
  "Recommendation query endpoint",
  "Local-first persistence for planner state",
  "Backend contract docs for upstream/downstream beads",
]);

const REQUIRED_BEAD_IDS = Object.freeze([
  "ums-memory-d6q",
  "ums-memory-d6q.3",
  "ums-memory-d6q.3.1",
]);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("ADR-0004 maps P3 curriculum planner scope and enforces backend boundary", () => {
  const adrPath = new URL(
    "../../docs/adr/0004-p3-curriculum-planner-scope.md",
    import.meta.url,
  );
  const adr = readFileSync(adrPath, "utf8");

  for (const phrase of REQUIRED_PLAN_PHRASES) {
    assert.match(adr, new RegExp(escapeRegExp(phrase), "i"));
  }

  for (const phrase of REQUIRED_SCOPE_PHRASES) {
    assert.match(adr, new RegExp(escapeRegExp(phrase), "i"));
  }

  assert.match(adr, /## Scope/);
  assert.match(adr, /## Non-Goals/);
  assert.match(adr, /## Acceptance Criteria/);
  assert.match(adr, /## Backend Boundaries/);

  assert.match(adr, /backend-only/i);
  assert.match(adr, /out of scope per ADR-0001 backend-only delivery/i);
  assert.match(
    adr,
    /no frontend runtime or client-side compute participates in planner decisions/i,
  );

  for (const id of REQUIRED_BEAD_IDS) {
    assert.match(adr, new RegExp(`\\b${escapeRegExp(id)}\\b`));
  }
});
