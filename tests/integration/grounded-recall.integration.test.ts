import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { test } from "@effect-native/bun-test";
import { Schema } from "effect";

import { GroundedAnswerCitationSchema } from "../../libs/shared/src/effect/contracts/services.js";
import {
  DEFAULT_HOLDOUT_FIXTURE_DIR,
  evaluateGroundedRecall,
  main,
} from "../../scripts/eval-grounded-recall.ts";

const isGroundedAnswerCitation = Schema.is(GroundedAnswerCitationSchema);

test("ums-memory-jny.3: grounded holdout corpus passes with full recall and citation integrity", async () => {
  const result = await evaluateGroundedRecall();

  assert.equal(result.ok, true);
  assert.equal(result.fixtureDirectory, DEFAULT_HOLDOUT_FIXTURE_DIR);
  assert.equal(result.summary.totalCases, 3);
  assert.equal(result.summary.passedCases, 3);
  assert.equal(result.summary.failedCases, 0);
  assert.equal(result.summary.expectedMemoryIds, 5);
  assert.equal(result.summary.matchedMemoryIds, 5);
  assert.equal(result.summary.expectedCitations, 5);
  assert.equal(result.summary.matchedCitations, 5);
  assert.equal(result.summary.recallRate, 1);
  assert.equal(result.summary.citationIntegrityRate, 1);
  assert.deepEqual(result.reasonCodes, []);

  for (const evaluation of result.cases) {
    assert.equal(evaluation.ok, true);
    assert.deepEqual(evaluation.missingMemoryIds, []);
    assert.deepEqual(evaluation.missingCitations, []);
    assert.ok(evaluation.actualCitations.length >= 1);
    assert.ok(
      evaluation.actualCitations.every((citation) =>
        isGroundedAnswerCitation(citation)
      )
    );
  }
});

test("ums-memory-jny.3: grounded holdout runner rejects fixtures marked for tuning reuse", async () => {
  const tempRoot = await mkdtemp(resolve(tmpdir(), "grounded-holdout-reuse-"));

  try {
    const fixtureDir = resolve(tempRoot, "fixtures");
    await mkdir(fixtureDir, { recursive: true });
    await writeFile(
      resolve(fixtureDir, "reuse-case.json"),
      JSON.stringify(
        {
          schemaVersion: "grounded_holdout_case.v1",
          caseId: "holdout-reuse-rejected",
          usage: {
            split: "holdout",
            tuningAllowed: true,
            ownerBeadId: "ums-memory-jny.3",
          },
          objective: "grounded_recall_citation_integrity",
          description:
            "Holdout fixtures must never be flagged as reusable for tuning.",
          seed: "grounded-holdout-reuse",
          request: {
            storeId: "eval-grounded",
            space: "policy",
            query: "How do we keep holdout data out of tuning?",
            maxItems: 3,
            tokenBudget: 160,
          },
          dataset: {
            events: [
              {
                id: "memory-holdout-ban",
                storeId: "eval-grounded",
                space: "policy",
                source: "policy",
                timestamp: "2026-03-02T10:00:00.000Z",
                content:
                  "Set tuningAllowed to false for every holdout case so regression runners reject training reuse immediately.",
                tags: ["holdout", "policy"],
                metadata: {
                  role: "assistant",
                  conversationId: "holdout-reuse-1",
                },
              },
            ],
          },
          expect: {
            citations: [
              {
                memoryId: "memory-holdout-ban",
                source: "policy",
                quote:
                  "tuningAllowed to false for every holdout case so regression runners reject training reuse immediately",
              },
            ],
            minRecallRate: 1,
            minCitationIntegrityRate: 1,
          },
        },
        null,
        2
      ) + "\n",
      "utf8"
    );

    const result = await evaluateGroundedRecall({ fixtureDir });

    assert.equal(result.ok, false);
    assert.equal(result.summary.totalCases, 1);
    assert.equal(result.summary.failedCases, 1);
    assert.deepEqual(result.reasonCodes, ["HOLDOUT_TUNING_REUSE"]);
    assert.deepEqual(result.cases[0]?.reasonCodes, ["HOLDOUT_TUNING_REUSE"]);

    const code = await main(["--fixture-dir", fixtureDir, "--json"]);
    assert.equal(code, 1);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
