import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { test } from "@effect-native/bun-test";
import { Effect } from "effect";

const RUNBOOK_PATH = path.resolve(
  process.cwd(),
  "docs/runbooks/federation-go-no-go-decision.md"
);

const REQUIRED_SECTIONS = Object.freeze([
  "## Purpose",
  "## Blocking Status",
  "## Prerequisite Matrix",
  "## Required Command Gates",
  "## Machine-Check Rules",
  "## No-Go Conditions",
  "## Go Decision Record",
  "## Current Decision",
]);

const REQUIRED_REFERENCES = Object.freeze([
  "ums-memory-thq",
  "ums-memory-jny",
  "ums-memory-onf",
  "ums-memory-6nq.1",
  "bun run quality:ts",
  "bun run test",
  "bun run ci:verify",
  "tests/unit/federation-start-gate.test.ts",
  "tests/integration/federation-shadow-eval.integration.test.ts",
  "tests/integration/federation-canary-policy.integration.test.ts",
  "tests/integration/federation-ga-readiness.integration.test.ts",
  "Decision: NO-GO",
  "Cross-tenant federation remains forbidden even after `GO`.",
]);

const readRunbook = () =>
  Effect.runSync(Effect.sync(() => readFileSync(RUNBOOK_PATH, "utf8")));

test("ums-memory-6nq.1: federation start gate runbook is machine-checkable and blocked by default", () => {
  const runbook = readRunbook();

  for (const section of REQUIRED_SECTIONS) {
    assert.match(
      runbook,
      new RegExp(section.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"),
      `Missing required start-gate section: ${section}`
    );
  }

  for (const reference of REQUIRED_REFERENCES) {
    assert.match(
      runbook,
      new RegExp(reference.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"),
      `Missing required start-gate reference: ${reference}`
    );
  }
});
