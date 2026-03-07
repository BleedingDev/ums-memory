import assert from "node:assert/strict";

import { test } from "@effect-native/bun-test";

import { buildCandidateValidations } from "../../apps/api/src/ace/validator.ts";

test("validator returns explicit reason codes for accepted, contradictory, stale, and unsupported candidates", () => {
  const validations = buildCandidateValidations({
    candidates: [
      {
        candidateId: "cand-ok",
        statement: "Prefer source=jira for type=ticket",
        sourceEventId: "evt-fresh",
        sourceEventIds: ["evt-fresh"],
        evidenceEventIds: ["evt-fresh"],
        contradictionEventIds: [],
      },
      {
        candidateId: "cand-contradiction",
        statement: "Prefer source=jira for type=ticket",
        sourceEventId: "evt-fresh",
        sourceEventIds: ["evt-fresh"],
        evidenceEventIds: ["evt-fresh"],
        contradictionEventIds: ["evt-contradiction"],
      },
      {
        candidateId: "cand-stale",
        statement: "Prefer source=jira for type=ticket",
        sourceEventId: "evt-stale",
        sourceEventIds: ["evt-stale"],
        evidenceEventIds: ["evt-stale"],
        contradictionEventIds: [],
      },
      {
        candidateId: "cand-missing",
        statement: "Prefer source=jira for type=ticket",
        sourceEventId: "evt-missing",
        sourceEventIds: ["evt-missing"],
        evidenceEventIds: ["evt-missing"],
        contradictionEventIds: [],
      },
    ],
    events: [
      { eventId: "evt-fresh", timestamp: "2026-03-07T00:00:00.000Z" },
      {
        eventId: "evt-contradiction",
        timestamp: "2026-03-07T00:00:00.000Z",
      },
      { eventId: "evt-stale", timestamp: "2026-01-01T00:00:00.000Z" },
    ],
    evaluatedAt: "2026-03-07T00:00:00.000Z",
    freshnessWarningDays: 14,
    minEvidenceDepth: 1,
  });

  assert.deepEqual(
    validations.map((entry) => ({
      candidateId: entry.candidateId,
      valid: entry.valid,
      reasonCodes: entry.reasonCodes,
    })),
    [
      { candidateId: "cand-ok", valid: true, reasonCodes: ["accepted"] },
      {
        candidateId: "cand-contradiction",
        valid: false,
        reasonCodes: ["contradicting_evidence"],
      },
      {
        candidateId: "cand-stale",
        valid: false,
        reasonCodes: ["stale_evidence"],
      },
      {
        candidateId: "cand-missing",
        valid: false,
        reasonCodes: ["insufficient_evidence_depth"],
      },
    ]
  );
});
