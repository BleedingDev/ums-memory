import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { test } from "@effect-native/bun-test";
import { Effect } from "effect";

const POLICY_PATH = path.resolve(
  process.cwd(),
  "docs/runbooks/eval-dataset-maintenance-policy.md"
);

const REQUIRED_HEADINGS = Object.freeze([
  "## Purpose",
  "## Scope",
  "## Lean Corpus Budgets",
  "## Change Control",
  "## Holdout Isolation",
  "## Determinism Rules",
  "## CI Gate Impact",
  "## Audit Trail",
  "## Rejection Rules",
]);

const REQUIRED_REFERENCES = Object.freeze([
  "tests/fixtures/eval/golden-replay",
  "tests/fixtures/eval/adapter-conformance",
  "tests/fixtures/eval/grounded-holdout",
  "scripts/eval-golden-replay.ts",
  "scripts/eval-adapter-conformance.ts",
  "scripts/eval-grounded-recall.ts",
  "tests/unit/eval-script-contracts.test.ts",
  "tests/unit/eval-dataset-policy.test.ts",
  "bun run eval:lean",
  "bun run ci:verify",
  "verify job",
  "owner review",
  "tuningAllowed: false",
  "malformed-empty-content",
  "malformed-unsupported-source",
  "one replay fixture per supported adapter",
  "10 fixtures total",
  "at most 5 holdout cases",
  "more than 3 net-new fixtures",
]);

const REQUIRED_REJECTIONS = Object.freeze([
  "unbounded corpus growth",
  "tuningAllowed: true",
  "live network",
  "wall-clock",
  "optional in release flow",
  "supported-adapter contract change",
  "@effect-native/bun-test",
  "node:test",
  "Vitest",
  "npm wrappers",
]);

const readPolicy = () =>
  Effect.runSync(Effect.sync(() => readFileSync(POLICY_PATH, "utf8")));

test("ums-memory-jny.5: eval dataset policy covers the required lean-governance sections", () => {
  const policy = readPolicy();

  for (const heading of REQUIRED_HEADINGS) {
    assert.match(
      policy,
      new RegExp(heading.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"),
      `Missing required policy heading: ${heading}`
    );
  }
});

test("ums-memory-jny.5: eval dataset policy references bounded corpora, gate commands, and review ownership", () => {
  const policy = readPolicy();

  for (const reference of REQUIRED_REFERENCES) {
    assert.match(
      policy,
      new RegExp(reference.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "iu"),
      `Missing required policy reference: ${reference}`
    );
  }
});

test("ums-memory-jny.5: eval dataset policy rejects scope creep, holdout reuse, and nondeterministic inputs", () => {
  const policy = readPolicy();

  for (const rejectionRule of REQUIRED_REJECTIONS) {
    assert.match(
      policy,
      new RegExp(rejectionRule.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "iu"),
      `Missing required rejection guardrail: ${rejectionRule}`
    );
  }
});
