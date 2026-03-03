import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import {
  main,
  validateVectorRetrievalEvaluation,
} from "../../scripts/validate-vector-retrieval-evaluation.ts";

const REQUIRED_HEADINGS = Object.freeze([
  "## Purpose",
  "## Scope",
  "## Current Baseline (Must Remain Stable)",
  "## Deterministic Fallback Contract",
  "## Proposed Effect Service Contracts",
  "## Replay and Evaluation Gates",
  "## Rollout Plan",
  "## Explicit Non-Goals",
]);

const REQUIRED_PHRASES = Object.freeze([
  "bead `ums-memory-dd2.3`",
  "vector retrieval is optional",
  "deterministic fallback",
  "strict TypeScript + Effect",
  "SQLite remains the source of truth",
  "replay evaluation",
]);

const REQUIRED_CONTENT_LINES = Object.freeze([
  "retrieval.vector.fallback.timeout",
  "semantic recall improvement >= 8%",
  "deterministic mismatch rate == 0",
  "fallback success rate >= 99.9%",
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
    "# Optional Vector Retrieval Extension Evaluation",
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
    "docs/runbooks/vector-retrieval-extension-evaluation.md"
  );
  await mkdir(resolve(runbookPath, ".."), { recursive: true });
  await writeFile(runbookPath, markdown, "utf8");
  return runbookPath;
}

test("vector retrieval runbook validation passes when required headings and phrases exist", async () => {
  const projectRoot = await mkdtemp(resolve(tmpdir(), "vector-eval-pass-"));

  try {
    const runbookPath = await writeRunbook(projectRoot, makeRunbookContent());
    const result = await validateVectorRetrievalEvaluation({ runbookPath });

    assert.equal(result.ok, true);
    assert.deepEqual(result.missingHeadings, []);
    assert.deepEqual(result.missingPhrases, []);
    assert.deepEqual(result.missingContentRules, []);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("vector retrieval runbook validation fails on missing required heading", async () => {
  const projectRoot = await mkdtemp(resolve(tmpdir(), "vector-eval-heading-"));

  try {
    const missingHeading = "## Replay and Evaluation Gates";
    const runbookPath = await writeRunbook(
      projectRoot,
      makeRunbookContent({ dropHeading: missingHeading })
    );
    const result = await validateVectorRetrievalEvaluation({ runbookPath });

    assert.equal(result.ok, false);
    assert.deepEqual(result.missingHeadings, [missingHeading]);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("vector retrieval runbook validation fails on missing required phrase", async () => {
  const projectRoot = await mkdtemp(resolve(tmpdir(), "vector-eval-phrase-"));

  try {
    const missingPhrase = "replay evaluation";
    const runbookPath = await writeRunbook(
      projectRoot,
      makeRunbookContent({ dropPhrase: missingPhrase })
    );
    const result = await validateVectorRetrievalEvaluation({ runbookPath });

    assert.equal(result.ok, false);
    assert.deepEqual(result.missingPhrases, [missingPhrase]);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("vector retrieval runbook validation fails on missing required content rule", async () => {
  const projectRoot = await mkdtemp(resolve(tmpdir(), "vector-eval-content-"));

  try {
    const runbookPath = await writeRunbook(
      projectRoot,
      makeRunbookContent({
        dropContentLine: "semantic recall improvement >= 8%",
      })
    );
    const result = await validateVectorRetrievalEvaluation({ runbookPath });

    assert.equal(result.ok, false);
    assert.deepEqual(result.missingContentRules, ["go-metric-semantic-recall"]);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("vector retrieval runbook validation CLI main returns failure on any arguments", async () => {
  const code = await main(["--does-not-exist"]);
  assert.equal(code, 1);
});
