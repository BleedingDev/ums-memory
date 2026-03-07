import assert from "node:assert/strict";

import { test } from "@effect-native/bun-test";

import { selectCurationCandidates } from "../../apps/api/src/ace/curation-tiebreaks.ts";

const validationSet = [
  {
    candidateId: "cand-b",
    valid: true,
    evidenceDepth: 1,
    contradictionCount: 0,
    freshnessDays: 0,
  },
  {
    candidateId: "cand-a",
    valid: true,
    evidenceDepth: 1,
    contradictionCount: 0,
    freshnessDays: 0,
  },
] as const;

test("curation tie-breaker is deterministic across input order permutations", () => {
  const first = selectCurationCandidates({
    candidates: [
      {
        candidateId: "cand-b",
        ruleId: "rule-shared",
        statement: "shared",
        confidence: 0.7,
      },
      {
        candidateId: "cand-a",
        ruleId: "rule-shared",
        statement: "shared",
        confidence: 0.7,
      },
    ],
    validations: validationSet,
    existingRules: [],
  });
  const second = selectCurationCandidates({
    candidates: [
      {
        candidateId: "cand-a",
        ruleId: "rule-shared",
        statement: "shared",
        confidence: 0.7,
      },
      {
        candidateId: "cand-b",
        ruleId: "rule-shared",
        statement: "shared",
        confidence: 0.7,
      },
    ],
    validations: validationSet,
    existingRules: [],
  });

  assert.deepEqual(first, second);
  assert.equal(first.winners[0]?.candidateId, "cand-a");
  assert.deepEqual(first.rejected, [
    {
      candidateId: "cand-b",
      ruleId: "rule-shared",
      winnerCandidateId: "cand-a",
      reason: "conflict_lost_tie_break",
    },
  ]);
});

test("curation tie-breaker preserves incumbent winner when objective scores tie", () => {
  const result = selectCurationCandidates({
    candidates: [
      {
        candidateId: "cand-b",
        ruleId: "rule-shared",
        statement: "shared",
        confidence: 0.7,
      },
      {
        candidateId: "cand-a",
        ruleId: "rule-shared",
        statement: "shared",
        confidence: 0.7,
      },
    ],
    validations: validationSet,
    existingRules: [
      {
        ruleId: "rule-shared",
        statement: "shared",
        scope: "global",
        selectedCandidateId: "cand-b",
      },
    ],
  });

  assert.equal(result.winners[0]?.candidateId, "cand-b");
  assert.deepEqual(result.rejected, [
    {
      candidateId: "cand-a",
      ruleId: "rule-shared",
      winnerCandidateId: "cand-b",
      reason: "conflict_lost_tie_break",
    },
  ]);
});
