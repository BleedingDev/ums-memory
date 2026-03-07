import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { test } from "@effect-native/bun-test";
import { Effect } from "effect";

interface PackageJson {
  readonly scripts?: Record<string, string>;
  readonly dependencies?: Record<string, string>;
}

const PACKAGE_JSON_PATH = path.resolve(process.cwd(), "package.json");
const RUNBOOK_PATH = path.resolve(
  process.cwd(),
  "docs/runbooks/ci-gates-effect-ts-cutover.md"
);

const REQUIRED_LEAF_EVAL_SCRIPTS = Object.freeze({
  "eval:golden-replay": "bun scripts/eval-golden-replay.ts --json",
  "eval:adapter-conformance": "bun scripts/eval-adapter-conformance.ts --json",
  "eval:grounded-recall": "bun scripts/eval-grounded-recall.ts --json",
});

const REQUIRED_CI_SEQUENCE = Object.freeze([
  "bun run quality:ts",
  "bun run test",
  "bun run eval:lean",
  "bun run test:sfe",
  "bun run build:sfe:single",
]);

const REQUIRED_RUNBOOK_HEADINGS = Object.freeze([
  "## Required Gate Sequence",
  "## Policy Checks to Enforce",
  "## Eval Regression Contract",
  "## Runtime Shim Policy",
  "## Current Status",
  "## Ownership and Escalation",
]);

const REQUIRED_RUNBOOK_REFERENCES = Object.freeze([
  "bun run eval:lean",
  "bun run ci:verify",
  ".github/workflows/ci.yml",
  "scripts/eval-golden-replay.ts",
  "scripts/eval-adapter-conformance.ts",
  "scripts/eval-grounded-recall.ts",
  "non-zero exit code",
  "validate:effect-beta-pin",
  "@effect-native/bun-test",
  "node:test",
  "Vitest",
  "npm wrappers",
]);

const readText = (filePath: string) =>
  Effect.runSync(Effect.sync(() => readFileSync(filePath, "utf8")));

const readPackageJson = (): PackageJson =>
  Effect.runSync(
    Effect.sync(
      () => JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8")) as PackageJson
    )
  );

const splitPipeline = (command: string) =>
  command
    .split("&&")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

test("ums-memory-jny.4: eval package scripts stay wired into the release gate with fail-fast ordering", () => {
  const packageJson = readPackageJson();
  const scripts = packageJson.scripts ?? {};

  for (const [scriptName, expectedCommand] of Object.entries(
    REQUIRED_LEAF_EVAL_SCRIPTS
  )) {
    assert.equal(
      scripts[scriptName],
      expectedCommand,
      `Expected ${scriptName} to remain machine-readable and Bun-backed.`
    );
  }

  assert.deepEqual(splitPipeline(scripts["eval:lean"] ?? ""), [
    "bun run eval:golden-replay",
    "bun run eval:adapter-conformance",
    "bun run eval:grounded-recall",
  ]);
  assert.deepEqual(
    splitPipeline(scripts["ci:verify"] ?? ""),
    REQUIRED_CI_SEQUENCE
  );
  assert.ok(
    !/\|\|\s*true/u.test(scripts["eval:lean"] ?? "") &&
      !/\|\|\s*true/u.test(scripts["ci:verify"] ?? ""),
    "Eval commands must never be optional in release flow."
  );
  assert.match(
    packageJson.dependencies?.["effect"] ?? "",
    /^4\.0\.0-beta\.\d+$/u
  );
});

test("ums-memory-jny.4: CI cutover runbook documents the lean eval contract and Bun plus Effect v4 test surface", () => {
  const runbook = readText(RUNBOOK_PATH);

  for (const heading of REQUIRED_RUNBOOK_HEADINGS) {
    assert.match(
      runbook,
      new RegExp(heading.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"),
      `Missing required runbook heading: ${heading}`
    );
  }

  for (const reference of REQUIRED_RUNBOOK_REFERENCES) {
    assert.match(
      runbook,
      new RegExp(reference.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "iu"),
      `Missing required runbook reference: ${reference}`
    );
  }
});
