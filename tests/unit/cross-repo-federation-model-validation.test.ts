import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { test } from "@effect-native/bun-test";

import {
  main,
  validateCrossRepoFederationModel,
} from "../../scripts/validate-cross-repo-federation-model.ts";

const REQUIRED_HEADINGS = Object.freeze([
  "## Purpose",
  "## Scope",
  "## Baseline Constraints (Must Hold)",
  "## Federation Topology",
  "## Policy Enforcement Model",
  "## Deterministic Retrieval and Conflict Rules",
  "## Operations, Deployment, and Monitoring",
  "## Rollout Plan",
  "## Go/No-Go Metrics",
  "## Explicit Non-Goals",
]);

const REQUIRED_PHRASES = Object.freeze([
  "bead `ums-memory-dd2.4`",
  "common, project, job_role, user",
  "policy enforcement",
  "tenant isolation",
  "Better Auth",
  "strict TypeScript + Effect",
  "compose-first",
  "SQLite",
]);

const REQUIRED_CONTENT_LINES = Object.freeze([
  "federation.share.denied",
  "cross-tenant leak incidents == 0",
  "federated retrieval p95 latency delta <= 20%",
  "policy decision cache ttl <= 60s",
  "highest-precedence scope candidate wins",
]);

function makeRunbookContent({
  dropHeading = null,
  dropPhrase = null,
  dropContentLine = null,
}: {
  readonly dropHeading?: string | null;
  readonly dropPhrase?: string | null;
  readonly dropContentLine?: string | null;
} = {}) {
  const headingLines = REQUIRED_HEADINGS.filter(
    (heading) => heading !== dropHeading
  );
  const phraseLines = REQUIRED_PHRASES.filter(
    (phrase) => phrase !== dropPhrase
  );
  const contentLines = REQUIRED_CONTENT_LINES.filter(
    (line) => line !== dropContentLine
  );

  return [
    "# Cross-Repo Memory Federation Model",
    "",
    ...headingLines.map((heading) => `${heading}\n\nPlaceholder section.`),
    "",
    "## Signals",
    ...phraseLines.map((phrase) => `- ${phrase}`),
    "",
    "## Guardrails",
    ...contentLines.map((line) => `- ${line}`),
    "",
  ].join("\n");
}

async function writeRunbook(projectRoot: string, markdown: string) {
  const runbookPath = resolve(
    projectRoot,
    "docs/runbooks/cross-repo-memory-federation-model.md"
  );
  await mkdir(resolve(runbookPath, ".."), { recursive: true });
  await writeFile(runbookPath, markdown, "utf8");
  return runbookPath;
}

test("cross-repo federation runbook validation passes when required headings and phrases exist", async () => {
  const projectRoot = await mkdtemp(
    resolve(tmpdir(), "federation-model-pass-")
  );

  try {
    const runbookPath = await writeRunbook(projectRoot, makeRunbookContent());
    const result = await validateCrossRepoFederationModel({ runbookPath });

    assert.equal(result.ok, true);
    assert.deepEqual(result.missingHeadings, []);
    assert.deepEqual(result.missingPhrases, []);
    assert.deepEqual(result.missingContentRules, []);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("cross-repo federation runbook validation fails on missing required heading", async () => {
  const projectRoot = await mkdtemp(
    resolve(tmpdir(), "federation-model-heading-")
  );

  try {
    const missingHeading = "## Policy Enforcement Model";
    const runbookPath = await writeRunbook(
      projectRoot,
      makeRunbookContent({ dropHeading: missingHeading })
    );
    const result = await validateCrossRepoFederationModel({ runbookPath });

    assert.equal(result.ok, false);
    assert.deepEqual(result.missingHeadings, [missingHeading]);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("cross-repo federation runbook validation fails on missing required phrase", async () => {
  const projectRoot = await mkdtemp(
    resolve(tmpdir(), "federation-model-phrase-")
  );

  try {
    const missingPhrase = "tenant isolation";
    const runbookPath = await writeRunbook(
      projectRoot,
      makeRunbookContent({ dropPhrase: missingPhrase })
    );
    const result = await validateCrossRepoFederationModel({ runbookPath });

    assert.equal(result.ok, false);
    assert.deepEqual(result.missingPhrases, [missingPhrase]);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("cross-repo federation runbook validation fails on missing content guardrail", async () => {
  const projectRoot = await mkdtemp(
    resolve(tmpdir(), "federation-model-content-")
  );

  try {
    const runbookPath = await writeRunbook(
      projectRoot,
      makeRunbookContent({
        dropContentLine: "cross-tenant leak incidents == 0",
      })
    );
    const result = await validateCrossRepoFederationModel({ runbookPath });

    assert.equal(result.ok, false);
    assert.deepEqual(result.missingContentRules, ["cross-tenant-leak-zero"]);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("cross-repo federation runbook validation CLI main returns failure on any arguments", async () => {
  const code = await main(["--does-not-exist"]);
  assert.equal(code, 1);
});
