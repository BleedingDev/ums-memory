import test from "node:test";
import assert from "node:assert/strict";
import {
  executeOperation,
  exportStoreSnapshot,
  importStoreSnapshot,
  listOperations,
  resetStore,
  snapshotProfile,
} from "../src/core.mjs";
import { createIdentityGraphEdge, IdentityGraphRelationKind } from "../../../libs/shared/src/entities.js";
import { ErrorCode } from "../../../libs/shared/src/errors.js";

test.beforeEach(() => {
  resetStore();
});

test("core exposes the full required operation surface", () => {
  assert.deepEqual(listOperations(), [
    "ingest",
    "context",
    "reflect",
    "validate",
    "curate",
    "shadow_write",
    "replay_eval",
    "promote",
    "demote",
    "addweight",
    "learner_profile_update",
    "identity_graph_update",
    "misconception_update",
    "curriculum_plan_update",
    "review_schedule_update",
    "policy_decision_update",
    "pain_signal_ingest",
    "failure_signal_ingest",
    "incident_escalation_signal",
    "manual_quarantine_override",
    "curriculum_recommendation",
    "review_schedule_clock",
    "review_set_rebalance",
    "curate_guarded",
    "recall_authorization",
    "tutor_degraded",
    "policy_audit_export",
    "feedback",
    "outcome",
    "audit",
    "export",
    "doctor"
  ]);
});

test("ingest is deterministic for identical request payload", () => {
  const request = {
    storeId: "coding-agent",
    profile: "demo",
    events: [
      { type: "commit", source: "git", content: "fix: normalize ids" },
      { type: "note", source: "chat", content: "remember deterministic output" }
    ]
  };

  const first = executeOperation("ingest", request);
  resetStore();
  const second = executeOperation("ingest", request);

  assert.equal(first.requestDigest, second.requestDigest);
  assert.equal(first.ledgerDigest, second.ledgerDigest);
  assert.equal(first.storeId, "coding-agent");
  assert.deepEqual(first.eventRefs, second.eventRefs);
});

test("shadow candidates and replay evaluations survive export/import round-trips", () => {
  const shadow = executeOperation("shadow_write", {
    profile: "snapshot-shadow",
    statement: "Prefer deterministic adapters with strict contracts.",
    sourceEventIds: ["evt-snapshot-shadow-1"],
    evidenceEventIds: ["evt-snapshot-shadow-1"],
  });
  const candidateId = shadow.applied[0].candidateId;
  const replay = executeOperation("replay_eval", {
    profile: "snapshot-shadow",
    candidateId,
    successRateDelta: 1,
  });

  const snapshot = exportStoreSnapshot();
  resetStore();
  importStoreSnapshot(snapshot);

  const restored = snapshotProfile("snapshot-shadow");
  assert.equal(restored.shadowCandidates.length, 1);
  assert.equal(restored.replayEvaluations.length, 1);
  assert.equal(restored.shadowCandidates[0].candidateId, candidateId);
  assert.equal(restored.replayEvaluations[0].replayEvalId, replay.replayEvalId);

  const replayFromRestoredStore = executeOperation("replay_eval", {
    profile: "snapshot-shadow",
    candidateId,
    replayEvalId: replay.replayEvalId,
    successRateDelta: 1,
  });
  assert.equal(replayFromRestoredStore.action, "noop");
});

test("ums-memory-hpl.2 replay_eval computes score breakdown and canary safety deltas deterministically", () => {
  const storeId = "tenant-hpl2-breakdown";
  const profile = "hpl2-breakdown";
  const shadow = executeOperation("shadow_write", {
    storeId,
    profile,
    statement: "Replay score engine should expose deterministic breakdown and canary signals.",
    sourceEventIds: ["evt-hpl2-breakdown-1"],
    evidenceEventIds: ["evt-hpl2-breakdown-1"],
  });
  const candidateId = shadow.applied[0].candidateId;
  const request = {
    storeId,
    profile,
    candidateId,
    successRateDelta: 0.4,
    reopenRateDelta: 0.05,
    latencyP95DeltaMs: 50,
    tokenCostDelta: 8,
    policyViolationsDelta: 0,
    hallucinationFlagDelta: 0,
    canarySuccessRateDelta: 0.1,
    canaryErrorRateDelta: 0.02,
    canaryLatencyP95DeltaMs: 20,
    canaryPolicyViolationsDelta: 0.01,
    canaryHallucinationFlagDelta: 0,
    gateThreshold: 0,
    evaluatedAt: "2026-03-02T16:00:00.000Z",
  };

  const evaluated = executeOperation("replay_eval", request);
  const replay = executeOperation("replay_eval", {
    ...request,
    replayEvalId: evaluated.replayEvalId,
  });

  assert.equal(evaluated.action, "created");
  assert.equal(replay.action, "noop");
  assert.equal(evaluated.evaluation.scoreBreakdown.total, evaluated.evaluation.netValueScore);
  assert.equal(evaluated.gate.replayRegressionCount, 0);
  assert.equal(evaluated.gate.canaryRegressionCount, 2);
  assert.equal(evaluated.gate.safetyRegressionCount, 2);
  assert.equal(evaluated.gate.severity, "high");
  assert.equal(evaluated.gate.pass, false);
  assert.equal(evaluated.evaluation.safetyDeltas.severity, "high");
});

test("ums-memory-hpl.2 replay_eval thresholds produce critical safety severity and block promote", () => {
  const storeId = "tenant-hpl2-thresholds";
  const profile = "hpl2-thresholds";
  const shadow = executeOperation("shadow_write", {
    storeId,
    profile,
    statement: "Safety threshold regressions must block promotion.",
    sourceEventIds: ["evt-hpl2-thresholds-1"],
    evidenceEventIds: ["evt-hpl2-thresholds-1"],
  });
  const candidateId = shadow.applied[0].candidateId;

  const evaluated = executeOperation("replay_eval", {
    storeId,
    profile,
    candidateId,
    successRateDelta: 0.3,
    policyViolationsDelta: 0.3,
    hallucinationFlagDelta: 0.2,
    canaryPolicyViolationsDelta: 0.4,
    canaryHallucinationFlagDelta: 0.1,
    safetyDeltaThreshold: 0.15,
    canaryDeltaThreshold: 0.05,
    gateThreshold: -100,
    evaluatedAt: "2026-03-02T16:30:00.000Z",
  });

  assert.equal(evaluated.gate.replayRegressionCount, 2);
  assert.equal(evaluated.gate.canaryRegressionCount, 2);
  assert.equal(evaluated.gate.safetyRegressionCount, 4);
  assert.equal(evaluated.gate.severity, "critical");
  assert.equal(evaluated.gate.pass, false);

  assert.throws(
    () =>
      executeOperation("promote", {
        storeId,
        profile,
        candidateId,
      }),
    /promote requires latest replay_eval status pass and no safety regressions/,
  );
});

test("ums-memory-hpl.3 promote succeeds only with passing replay gate and fresh evidence links", () => {
  const storeId = "tenant-hpl3-promote-fresh";
  const profile = "hpl3-promote-fresh";
  const shadow = executeOperation("shadow_write", {
    storeId,
    profile,
    statement: "Promote with fresh evidence links.",
    sourceEventIds: ["evt-hpl3-fresh-1"],
    evidenceEventIds: ["evt-hpl3-fresh-1"],
    createdAt: "2026-03-01T12:00:00.000Z",
    expiresAt: "2026-04-01T12:00:00.000Z",
  });
  const candidateId = shadow.applied[0].candidateId;
  const replay = executeOperation("replay_eval", {
    storeId,
    profile,
    candidateId,
    successRateDelta: 0.8,
    evaluatedAt: "2026-03-01T12:30:00.000Z",
  });
  const promoted = executeOperation("promote", {
    storeId,
    profile,
    candidateId,
    promotedAt: "2026-03-02T13:00:00.000Z",
    freshEvidenceThresholdDays: 14,
  });

  assert.equal(replay.gate.pass, true);
  assert.equal(promoted.action, "promoted");
  assert.equal(promoted.replayEvalId, replay.replayEvalId);
  assert.equal(promoted.observability.replayGatePass, true);
  assert.equal(promoted.observability.freshEvidencePass, true);
  assert.equal(promoted.observability.evidenceNotExpired, true);
  assert.equal(promoted.observability.hasEvidenceLinks, true);
  assert.equal(promoted.observability.freshEvidenceWindowDays, 14);
});

test("ums-memory-hpl.3 promote rejects candidates with expired evidence even after passing replay", () => {
  const storeId = "tenant-hpl3-promote-expired";
  const profile = "hpl3-promote-expired";
  const shadow = executeOperation("shadow_write", {
    storeId,
    profile,
    statement: "Expired evidence should block promotion.",
    sourceEventIds: ["evt-hpl3-expired-1"],
    evidenceEventIds: ["evt-hpl3-expired-1"],
    createdAt: "2026-01-01T12:00:00.000Z",
    expiresAt: "2026-02-01T12:00:00.000Z",
  });
  const candidateId = shadow.applied[0].candidateId;
  executeOperation("replay_eval", {
    storeId,
    profile,
    candidateId,
    successRateDelta: 0.8,
    evaluatedAt: "2026-03-01T12:30:00.000Z",
  });

  assert.throws(
    () =>
      executeOperation("promote", {
        storeId,
        profile,
        candidateId,
        promotedAt: "2026-03-02T13:00:00.000Z",
        freshEvidenceThresholdDays: 14,
      }),
    /promote requires fresh non-expired evidence links/,
  );
});

test("ums-memory-hpl.11 lifecycle operations emit throughput/pass-rate/demotion/latency metrics with trace payloads", () => {
  const storeId = "tenant-hpl11-lifecycle-observability";
  const profile = "hpl11-lifecycle-observability";
  const shadow = executeOperation("shadow_write", {
    storeId,
    profile,
    statement: "Lifecycle observability should emit deterministic metrics and traces.",
    sourceEventIds: ["evt-hpl11-shadow-1"],
    evidenceEventIds: ["evt-hpl11-shadow-1"],
    createdAt: "2026-03-02T14:00:00.000Z",
    expiresAt: "2026-04-02T14:00:00.000Z",
  });
  const candidateId = shadow.applied[0].candidateId;

  assert.equal(shadow.observability.lifecycleMetrics.candidateThroughput.processedCount, 1);
  assert.equal(shadow.observability.lifecycleMetrics.candidateThroughput.mutatedCount, 1);
  assert.equal(shadow.observability.lifecycleMetrics.gatePassRate.totalCount, 0);
  assert.equal(shadow.observability.lifecycleMetrics.demotionReasons.reasonCount, 0);
  assert.equal(
    shadow.observability.lifecycleMetrics.latency.observedLatencyMs,
    shadow.observability.slo.observedLatencyMs,
  );
  assert.equal(shadow.trace.payload.operation, "shadow_write");
  assert.deepEqual(shadow.trace.payload.candidateIds, [candidateId]);
  assert.deepEqual(shadow.trace.payload.metrics, shadow.observability.lifecycleMetrics);
  assert.deepEqual(shadow.trace.payload, shadow.observability.tracePayload);

  const replay = executeOperation("replay_eval", {
    storeId,
    profile,
    candidateId,
    successRateDelta: 0.7,
    evaluatedAt: "2026-03-02T14:10:00.000Z",
  });
  assert.equal(replay.gate.pass, true);
  assert.equal(replay.observability.lifecycleMetrics.gatePassRate.passCount, 1);
  assert.equal(replay.observability.lifecycleMetrics.gatePassRate.totalCount, 1);
  assert.equal(replay.observability.lifecycleMetrics.gatePassRate.rate, 1);
  assert.equal(replay.observability.lifecycleMetrics.candidateThroughput.processedCount, 1);
  assert.equal(
    replay.observability.lifecycleMetrics.latency.observedLatencyMs,
    replay.observability.slo.observedLatencyMs,
  );
  assert.equal(replay.trace.payload.details.gate.pass, true);
  assert.deepEqual(replay.trace.payload.metrics, replay.observability.lifecycleMetrics);
  assert.deepEqual(replay.trace.payload, replay.observability.tracePayload);

  const promoted = executeOperation("promote", {
    storeId,
    profile,
    candidateId,
    promotedAt: "2026-03-02T14:20:00.000Z",
  });
  assert.equal(promoted.action, "promoted");
  assert.equal(promoted.observability.lifecycleMetrics.gatePassRate.rate, 1);
  assert.equal(promoted.observability.lifecycleMetrics.candidateThroughput.mutatedCount, 1);
  assert.equal(promoted.trace.payload.details.ruleAction, promoted.ruleAction);
  assert.deepEqual(promoted.trace.payload.metrics, promoted.observability.lifecycleMetrics);
  assert.deepEqual(promoted.trace.payload, promoted.observability.tracePayload);

  const demoted = executeOperation("demote", {
    storeId,
    profile,
    candidateId,
    force: true,
    reasonCodes: ["manual_override", "policy_regression"],
    demotedAt: "2026-03-02T14:30:00.000Z",
  });
  assert.equal(demoted.action, "demoted");
  assert.deepEqual(demoted.reasonCodes, ["manual_override", "policy_regression"]);
  assert.deepEqual(demoted.observability.lifecycleMetrics.demotionReasons.reasonCodes, [
    "manual_override",
    "policy_regression",
  ]);
  assert.deepEqual(demoted.observability.lifecycleMetrics.demotionReasons.operationEventCounts, {
    manual_override: 1,
    policy_regression: 1,
  });
  assert.deepEqual(demoted.observability.lifecycleMetrics.demotionReasons.operationReasonHistoryCounts, {
    manual_override: 1,
    policy_regression: 1,
  });
  assert.equal(demoted.observability.lifecycleMetrics.demotionReasons.profileCounts.manual_override, 1);
  assert.equal(demoted.observability.lifecycleMetrics.demotionReasons.profileCounts.policy_regression, 1);
  assert.equal(demoted.observability.lifecycleMetrics.candidateThroughput.mutatedCount, 1);
  assert.equal(demoted.trace.payload.details.removedRuleId, demoted.removedRuleId);
  assert.deepEqual(demoted.trace.payload.metrics, demoted.observability.lifecycleMetrics);
  assert.deepEqual(demoted.trace.payload, demoted.observability.tracePayload);
});

test("ums-memory-hpl.11 lifecycle observability remains deterministic across replay-safe noop paths", () => {
  const storeId = "tenant-hpl11-noop-determinism";
  const profile = "hpl11-noop-determinism";
  const shadowRequest = {
    storeId,
    profile,
    statement: "Noop replay should preserve lifecycle trace and metrics deterministically.",
    sourceEventIds: ["evt-hpl11-noop-1"],
    evidenceEventIds: ["evt-hpl11-noop-1"],
    createdAt: "2026-03-02T15:00:00.000Z",
  };
  executeOperation("shadow_write", shadowRequest);
  const shadowNoopA = executeOperation("shadow_write", shadowRequest);
  const shadowNoopB = executeOperation("shadow_write", shadowRequest);
  const candidateId = shadowNoopA.applied[0].candidateId;

  assert.equal(shadowNoopA.applied[0].action, "noop");
  assert.equal(shadowNoopB.applied[0].action, "noop");
  assert.equal(shadowNoopA.trace.traceId, shadowNoopB.trace.traceId);
  assert.deepEqual(shadowNoopA.observability.lifecycleMetrics, shadowNoopB.observability.lifecycleMetrics);
  assert.deepEqual(shadowNoopA.trace.payload, shadowNoopB.trace.payload);

  const replayCreated = executeOperation("replay_eval", {
    storeId,
    profile,
    candidateId,
    successRateDelta: 0.4,
    evaluatedAt: "2026-03-02T15:10:00.000Z",
  });
  const replayNoopRequest = {
    storeId,
    profile,
    candidateId,
    replayEvalId: replayCreated.replayEvalId,
    successRateDelta: 0.4,
    evaluatedAt: "2026-03-02T15:10:00.000Z",
  };
  const replayNoopA = executeOperation("replay_eval", replayNoopRequest);
  const replayNoopB = executeOperation("replay_eval", replayNoopRequest);
  assert.equal(replayNoopA.action, "noop");
  assert.equal(replayNoopB.action, "noop");
  assert.equal(replayNoopA.trace.traceId, replayNoopB.trace.traceId);
  assert.deepEqual(replayNoopA.observability.lifecycleMetrics, replayNoopB.observability.lifecycleMetrics);
  assert.deepEqual(replayNoopA.trace.payload, replayNoopB.trace.payload);

  executeOperation("promote", {
    storeId,
    profile,
    candidateId,
    promotedAt: "2026-03-02T15:20:00.000Z",
  });
  const promoteNoopRequest = {
    storeId,
    profile,
    candidateId,
    promotedAt: "2026-03-02T15:20:00.000Z",
  };
  const promoteNoopA = executeOperation("promote", promoteNoopRequest);
  const promoteNoopB = executeOperation("promote", promoteNoopRequest);
  assert.equal(promoteNoopA.action, "noop");
  assert.equal(promoteNoopB.action, "noop");
  assert.equal(promoteNoopA.trace.traceId, promoteNoopB.trace.traceId);
  assert.deepEqual(promoteNoopA.observability.lifecycleMetrics, promoteNoopB.observability.lifecycleMetrics);
  assert.deepEqual(promoteNoopA.trace.payload, promoteNoopB.trace.payload);

  const demoteNoopRequest = {
    storeId,
    profile,
    candidateId,
    netValueThreshold: -999,
    demotedAt: "2026-03-02T15:30:00.000Z",
  };
  const demoteNoopA = executeOperation("demote", demoteNoopRequest);
  const demoteNoopB = executeOperation("demote", demoteNoopRequest);
  assert.equal(demoteNoopA.action, "noop");
  assert.equal(demoteNoopB.action, "noop");
  assert.equal(demoteNoopA.trace.traceId, demoteNoopB.trace.traceId);
  assert.deepEqual(demoteNoopA.observability.lifecycleMetrics, demoteNoopB.observability.lifecycleMetrics);
  assert.deepEqual(demoteNoopA.trace.payload, demoteNoopB.trace.payload);
});

test("ums-memory-hpl.11 replay auto-demotion emits demotion trace details and reason metrics", () => {
  const storeId = "tenant-hpl11-auto-demotion-metrics";
  const profile = "hpl11-auto-demotion-metrics";
  const shadow = executeOperation("shadow_write", {
    storeId,
    profile,
    statement: "Auto-demotion traces should include deterministic reason metrics.",
    sourceEventIds: ["evt-hpl11-auto-demotion-1"],
    evidenceEventIds: ["evt-hpl11-auto-demotion-1"],
  });
  const candidateId = shadow.applied[0].candidateId;

  executeOperation("replay_eval", {
    storeId,
    profile,
    candidateId,
    successRateDelta: -0.1,
    evaluatedAt: "2026-03-02T16:00:00.000Z",
  });
  const autoDemoted = executeOperation("replay_eval", {
    storeId,
    profile,
    candidateId,
    successRateDelta: -0.2,
    evaluatedAt: "2026-03-02T16:10:00.000Z",
  });

  assert.equal(autoDemoted.autoDemotion.action, "demoted");
  assert.equal(autoDemoted.trace.payload.details.autoDemotion.action, "demoted");
  assert.deepEqual(autoDemoted.trace.payload.details.autoDemotion.reasonCodes, [
    "sustained_negative_net_value",
  ]);
  assert.deepEqual(autoDemoted.observability.lifecycleMetrics.demotionReasons.reasonCodes, [
    "sustained_negative_net_value",
  ]);
  assert.deepEqual(autoDemoted.observability.lifecycleMetrics.demotionReasons.operationEventCounts, {
    sustained_negative_net_value: 1,
  });
  assert.equal(
    autoDemoted.observability.lifecycleMetrics.demotionReasons.profileCounts.sustained_negative_net_value,
    1,
  );
  assert.deepEqual(autoDemoted.trace.payload.metrics, autoDemoted.observability.lifecycleMetrics);
  assert.deepEqual(autoDemoted.trace.payload, autoDemoted.observability.tracePayload);
});

test("ums-memory-hpl.4 replay_eval auto-demotes on sustained negative net value and remains replay-safe", () => {
  const storeId = "tenant-hpl4-replay-demote";
  const profile = "hpl4-replay-demote";
  const shadow = executeOperation("shadow_write", {
    storeId,
    profile,
    statement: "Sustained negative replay value should demote deterministically.",
    sourceEventIds: ["evt-hpl4-replay-1"],
    evidenceEventIds: ["evt-hpl4-replay-1"],
    createdAt: "2026-03-02T10:00:00.000Z",
    expiresAt: "2026-04-02T10:00:00.000Z",
  });
  const candidateId = shadow.applied[0].candidateId;
  executeOperation("replay_eval", {
    storeId,
    profile,
    candidateId,
    successRateDelta: 0.9,
    evaluatedAt: "2026-03-02T10:10:00.000Z",
  });
  const promoted = executeOperation("promote", {
    storeId,
    profile,
    candidateId,
    promotedAt: "2026-03-02T10:20:00.000Z",
  });
  const promotedRuleId = promoted.rule.ruleId;

  const firstNegativeRequest = {
    storeId,
    profile,
    candidateId,
    successRateDelta: -0.1,
    evaluatedAt: "2026-03-02T11:00:00.000Z",
  };
  const firstNegative = executeOperation("replay_eval", firstNegativeRequest);
  assert.equal(firstNegative.autoDemotion, null);
  assert.equal(firstNegative.observability.negativeNetValueStreak, 1);
  const firstNegativeUpdated = executeOperation("replay_eval", {
    ...firstNegativeRequest,
    replayEvalId: firstNegative.replayEvalId,
    successRateDelta: -0.15,
  });
  assert.equal(firstNegativeUpdated.action, "updated");
  assert.equal(firstNegativeUpdated.autoDemotion, null);
  assert.equal(firstNegativeUpdated.observability.negativeNetValueStreak, 1);

  const secondNegativeRequest = {
    storeId,
    profile,
    candidateId,
    successRateDelta: -0.2,
    evaluatedAt: "2026-03-02T11:30:00.000Z",
  };
  const secondNegative = executeOperation("replay_eval", secondNegativeRequest);
  const secondNegativeReplay = executeOperation("replay_eval", {
    ...secondNegativeRequest,
    replayEvalId: secondNegative.replayEvalId,
  });

  assert.equal(secondNegative.action, "created");
  assert.equal(secondNegative.autoDemotion.action, "demoted");
  assert.equal(secondNegative.autoDemotion.removedRuleId, promotedRuleId);
  assert.equal(secondNegativeReplay.action, "noop");
  assert.equal(secondNegativeReplay.autoDemotion, null);

  const beforeRoundTrip = snapshotProfile(profile, storeId);
  const storedBeforeRoundTrip = beforeRoundTrip.shadowCandidates.find((entry) => entry.candidateId === candidateId);
  assert.ok(storedBeforeRoundTrip);
  assert.equal(storedBeforeRoundTrip.status, "demoted");
  assert.equal(storedBeforeRoundTrip.negativeNetValueStreak, 2);
  assert.deepEqual(storedBeforeRoundTrip.latestDemotionReasonCodes, ["sustained_negative_net_value"]);
  assert.equal(beforeRoundTrip.rules.some((entry) => entry.ruleId === promotedRuleId), false);

  const snapshot = exportStoreSnapshot();
  resetStore();
  importStoreSnapshot(snapshot);
  const restored = snapshotProfile(profile, storeId);
  const restoredCandidate = restored.shadowCandidates.find((entry) => entry.candidateId === candidateId);
  assert.ok(restoredCandidate);
  assert.equal(restoredCandidate.status, "demoted");
  assert.equal(restoredCandidate.negativeNetValueStreak, 2);
  assert.deepEqual(restoredCandidate.latestDemotionReasonCodes, ["sustained_negative_net_value"]);
  assert.equal(restored.rules.some((entry) => entry.ruleId === promotedRuleId), false);
});

test("ums-memory-hpl.4 harmful feedback auto-demotes deterministically and noop replay does not duplicate side effects", () => {
  const storeId = "tenant-hpl4-feedback-demote";
  const profile = "hpl4-feedback-demote";
  const shadow = executeOperation("shadow_write", {
    storeId,
    profile,
    statement: "Explicit harmful feedback should demote candidate and promoted rule.",
    sourceEventIds: ["evt-hpl4-feedback-1"],
    evidenceEventIds: ["evt-hpl4-feedback-1"],
    createdAt: "2026-03-02T12:00:00.000Z",
    expiresAt: "2026-04-02T12:00:00.000Z",
  });
  const candidateId = shadow.applied[0].candidateId;
  executeOperation("replay_eval", {
    storeId,
    profile,
    candidateId,
    successRateDelta: 0.8,
    evaluatedAt: "2026-03-02T12:10:00.000Z",
  });
  const promoted = executeOperation("promote", {
    storeId,
    profile,
    candidateId,
    promotedAt: "2026-03-02T12:20:00.000Z",
  });
  const targetRuleId = promoted.rule.ruleId;
  const harmfulRequest = {
    storeId,
    profile,
    targetRuleId,
    targetCandidateId: candidateId,
    signal: "harmful",
    note: "Operator reported this memory caused regressions.",
    actor: "reviewer-hpl4",
    timestamp: "2026-03-02T12:45:00.000Z",
  };
  const harmful = executeOperation("feedback", harmfulRequest);
  const harmfulReplay = executeOperation("feedback", harmfulRequest);

  assert.equal(harmful.action, "created");
  assert.equal(harmful.autoDemotion.action, "demoted");
  assert.deepEqual(harmful.autoDemotion.demotedCandidateIds, [candidateId]);
  assert.deepEqual(harmful.autoDemotion.removedRuleIds, [targetRuleId]);
  assert.equal(harmfulReplay.action, "noop");
  assert.equal(harmfulReplay.autoDemotion, null);

  const snapshot = snapshotProfile(profile, storeId);
  const storedCandidate = snapshot.shadowCandidates.find((entry) => entry.candidateId === candidateId);
  assert.ok(storedCandidate);
  assert.equal(storedCandidate.status, "demoted");
  assert.deepEqual(storedCandidate.latestDemotionReasonCodes, ["explicit_harmful_feedback"]);
  assert.equal(snapshot.rules.some((entry) => entry.ruleId === targetRuleId), false);
});

test("ums-memory-hpl.4 replay_eval trailing negative streak resets after a positive evaluation", () => {
  const storeId = "tenant-hpl4-replay-streak-reset";
  const profile = "hpl4-replay-streak-reset";
  const shadow = executeOperation("shadow_write", {
    storeId,
    profile,
    statement: "Positive replay evaluations should reset trailing negative streak.",
    sourceEventIds: ["evt-hpl4-streak-reset-1"],
    evidenceEventIds: ["evt-hpl4-streak-reset-1"],
  });
  const candidateId = shadow.applied[0].candidateId;

  const firstNegative = executeOperation("replay_eval", {
    storeId,
    profile,
    candidateId,
    successRateDelta: -0.2,
    evaluatedAt: "2026-03-02T13:00:00.000Z",
  });
  assert.equal(firstNegative.observability.negativeNetValueStreak, 1);

  const positive = executeOperation("replay_eval", {
    storeId,
    profile,
    candidateId,
    successRateDelta: 0.4,
    evaluatedAt: "2026-03-02T13:10:00.000Z",
  });
  assert.equal(positive.observability.negativeNetValueStreak, 0);
  assert.equal(positive.autoDemotion, null);

  const secondNegative = executeOperation("replay_eval", {
    storeId,
    profile,
    candidateId,
    successRateDelta: -0.15,
    evaluatedAt: "2026-03-02T13:20:00.000Z",
  });
  assert.equal(secondNegative.observability.negativeNetValueStreak, 1);
  assert.equal(secondNegative.autoDemotion, null);

  const snapshot = snapshotProfile(profile, storeId);
  const storedCandidate = snapshot.shadowCandidates.find((entry) => entry.candidateId === candidateId);
  assert.ok(storedCandidate);
  assert.equal(storedCandidate.status, "shadow");
  assert.equal(storedCandidate.negativeNetValueStreak, 1);
});

test("shadow_write returns canonical candidate metadata and preserves it on deterministic noop replay", () => {
  const request = {
    storeId: "tenant-shadow-contract",
    profile: "shadow-contract",
    statement: "Prefer deterministic adapters with strict contracts.",
    scope: "workspace",
    confidence: 0.82,
    sourceEventIds: ["evt-shadow-2", "evt-shadow-1"],
    evidenceEventIds: ["evt-shadow-3", "evt-shadow-1"],
    createdAt: "2026-03-01T10:00:00.000Z",
    expiresAt: "2026-04-01T10:00:00.000Z",
  };
  const requiredFields = [
    "candidateId",
    "ruleId",
    "statement",
    "scope",
    "confidence",
    "sourceEventIds",
    "evidenceEventIds",
    "policyException",
    "status",
    "createdAt",
    "updatedAt",
    "expiresAt",
  ];

  const created = executeOperation("shadow_write", request);
  const replay = executeOperation("shadow_write", request);

  assert.equal(created.applied.length, 1);
  assert.equal(replay.applied.length, 1);
  assert.equal(created.applied[0].action, "created");
  assert.equal(replay.applied[0].action, "noop");

  for (const field of requiredFields) {
    assert.equal(Object.prototype.hasOwnProperty.call(created.applied[0], field), true);
    assert.equal(Object.prototype.hasOwnProperty.call(replay.applied[0], field), true);
    assert.deepEqual(replay.applied[0][field], created.applied[0][field]);
  }
});

test("shadow_write rejects requests without source/evidence pointers", () => {
  assert.throws(
    () =>
      executeOperation("shadow_write", {
        storeId: "tenant-shadow-evidence",
        profile: "shadow-evidence",
        statement: "Missing pointers should fail contract validation.",
      }),
    /EVIDENCE_POINTER_CONTRACT_VIOLATION: shadow_write requires at least one sourceEventId or evidenceEventId\./,
  );
});

test("shadow_write updated action emits canonical merged candidate metadata", () => {
  const firstRequest = {
    storeId: "tenant-shadow-update",
    profile: "shadow-update",
    statement: "Keep retrieval payloads deterministic.",
    confidence: 0.55,
    sourceEventIds: ["evt-upd-1", "evt-upd-2"],
    evidenceEventIds: ["evt-upd-1"],
    createdAt: "2026-03-01T09:00:00.000Z",
  };
  const created = executeOperation("shadow_write", firstRequest);
  const candidateId = created.applied[0].candidateId;

  const updated = executeOperation("shadow_write", {
    ...firstRequest,
    candidateId,
    confidence: 0.9,
    sourceEventIds: ["evt-upd-3", "evt-upd-2"],
    evidenceEventIds: ["evt-upd-4"],
    policyException: "manual_override",
    timestamp: "2026-03-02T09:30:00.000Z",
  });

  assert.equal(updated.applied.length, 1);
  assert.equal(updated.applied[0].action, "updated");
  assert.equal(updated.applied[0].candidateId, candidateId);
  assert.deepEqual(updated.applied[0].sourceEventIds, ["evt-upd-1", "evt-upd-2", "evt-upd-3"]);
  assert.deepEqual(updated.applied[0].evidenceEventIds, ["evt-upd-1", "evt-upd-4"]);
  assert.equal(updated.applied[0].confidence, 0.9);
  assert.equal(updated.applied[0].createdAt, "2026-03-01T09:00:00.000Z");
  assert.equal(updated.applied[0].updatedAt, "2026-03-02T09:30:00.000Z");
  assert.deepEqual(updated.applied[0].policyException, {
    code: "manual_override",
    reason: null,
    approvedBy: "unspecified",
    reference: null,
    timestamp: "1970-01-01T00:00:00.000Z",
    metadata: {},
  });

  const snapshot = snapshotProfile("shadow-update", "tenant-shadow-update");
  const stored = snapshot.shadowCandidates.find((candidate) => candidate.candidateId === candidateId);
  assert.ok(stored);
  assert.equal(stored.updatedAt, updated.applied[0].updatedAt);
  assert.deepEqual(stored.sourceEventIds, updated.applied[0].sourceEventIds);
  assert.deepEqual(stored.evidenceEventIds, updated.applied[0].evidenceEventIds);
  assert.equal(stored.confidence, updated.applied[0].confidence);
  assert.deepEqual(stored.policyException, updated.applied[0].policyException);
});

test("shadow_write accepts evidence-only pointers and normalizes source pointers", () => {
  const result = executeOperation("shadow_write", {
    storeId: "tenant-shadow-evidence-only",
    profile: "shadow-evidence-only",
    statement: "Evidence pointers are valid source anchors.",
    evidenceEventIds: ["evt-evidence-2", "evt-evidence-1", "evt-evidence-1"],
  });

  assert.equal(result.applied.length, 1);
  assert.equal(result.applied[0].action, "created");
  assert.deepEqual(result.applied[0].evidenceEventIds, ["evt-evidence-1", "evt-evidence-2"]);
  assert.deepEqual(result.applied[0].sourceEventIds, ["evt-evidence-1", "evt-evidence-2"]);
});

test("ums-memory-hpl.5 addweight adjusts candidate influence with audit trace and deterministic replay", () => {
  const storeId = "tenant-addweight";
  const profile = "addweight-profile";
  const shadow = executeOperation("shadow_write", {
    storeId,
    profile,
    statement: "Keep release workflows deterministic with evidence-backed commands.",
    confidence: 0.6,
    sourceEventIds: ["evt-addweight-shadow-1"],
    evidenceEventIds: ["evt-addweight-shadow-1"],
    createdAt: "2026-03-01T12:00:00.000Z",
  });
  const candidateId = shadow.applied[0].candidateId;
  executeOperation("replay_eval", {
    storeId,
    profile,
    candidateId,
    successRateDelta: 1,
    evaluatedAt: "2026-03-01T12:30:00.000Z",
  });
  executeOperation("promote", {
    storeId,
    profile,
    candidateId,
    promotedAt: "2026-03-01T13:00:00.000Z",
  });
  const request = {
    storeId,
    profile,
    candidateId,
    delta: 0.2,
    reason: "Human reviewer validated this guidance in production incidents.",
    actor: "reviewer-1",
    sourceEventIds: ["evt-addweight-shadow-1", "evt-addweight-shadow-2"],
    evidenceEventIds: ["evt-addweight-shadow-2"],
    timestamp: "2026-03-02T09:00:00.000Z",
    metadata: {
      ticketId: "OPS-42",
    },
  };

  const adjusted = executeOperation("addweight", request);
  const replay = executeOperation("addweight", request);

  assert.equal(adjusted.action, "adjusted");
  assert.equal(replay.action, "noop");
  assert.equal(adjusted.candidate.candidateId, candidateId);
  assert.equal(adjusted.candidate.confidence, 0.8);
  assert.equal(adjusted.adjustment.previousConfidence, 0.6);
  assert.equal(adjusted.adjustment.nextConfidence, 0.8);
  assert.equal(adjusted.adjustment.appliedDelta, 0.2);
  assert.equal(adjusted.ruleAction, "updated");
  assert.equal(replay.policyAuditEventId, adjusted.policyAuditEventId);
  assert.equal(replay.adjustment.adjustmentId, adjusted.adjustment.adjustmentId);
  assert.equal(replay.candidate.confidence, adjusted.candidate.confidence);

  const snapshot = snapshotProfile(profile, storeId);
  const storedCandidate = snapshot.shadowCandidates.find((entry) => entry.candidateId === candidateId);
  assert.ok(storedCandidate);
  assert.equal(storedCandidate.confidence, 0.8);
  assert.equal(storedCandidate.updatedAt, "2026-03-02T09:00:00.000Z");
  assert.equal(storedCandidate.metadata.latestWeightAdjustment.adjustmentId, adjusted.adjustment.adjustmentId);
  assert.equal(
    storedCandidate.metadata.latestWeightAdjustment.reason,
    "Human reviewer validated this guidance in production incidents.",
  );
  assert.equal(storedCandidate.metadata.latestWeightAdjustment.actor, "reviewer-1");
  assert.deepEqual(storedCandidate.metadata.latestWeightAdjustment.sourceEventIds, [
    "evt-addweight-shadow-1",
    "evt-addweight-shadow-2",
  ]);
  assert.deepEqual(storedCandidate.metadata.latestWeightAdjustment.evidenceEventIds, ["evt-addweight-shadow-2"]);
  assert.deepEqual(storedCandidate.metadata.latestWeightAdjustment.metadata, { ticketId: "OPS-42" });
  const storedRule = snapshot.rules.find((entry) => entry.ruleId === storedCandidate.ruleId);
  assert.ok(storedRule);
  assert.equal(storedRule.confidence, 0.8);

  const auditEntry = snapshot.policyAuditTrail.find((entry) => entry.auditEventId === adjusted.policyAuditEventId);
  assert.ok(auditEntry);
  assert.equal(auditEntry.operation, "addweight");
  assert.equal(auditEntry.details.adjustmentId, adjusted.adjustment.adjustmentId);
  assert.equal(auditEntry.details.candidateId, candidateId);
  assert.equal(auditEntry.details.reason, "Human reviewer validated this guidance in production incidents.");
  assert.equal(auditEntry.details.actor, "reviewer-1");
  assert.deepEqual(auditEntry.reasonCodes, ["addweight_manual", "human_weight_increase"]);
});

test("ums-memory-hpl.5 addweight rejects adjustmentId collisions with mismatched payload", () => {
  const storeId = "tenant-addweight-collision";
  const profile = "addweight-collision";
  const created = executeOperation("shadow_write", {
    storeId,
    profile,
    statement: "Keep memory promotion gated by replay metrics.",
    sourceEventIds: ["evt-addweight-collision-1"],
    evidenceEventIds: ["evt-addweight-collision-1"],
  });
  const candidateId = created.applied[0].candidateId;
  const request = {
    storeId,
    profile,
    candidateId,
    adjustmentId: "manual-adjustment-1",
    delta: 0.12,
    reason: "Confirmed in manual review.",
    actor: "reviewer-2",
    timestamp: "2026-03-02T10:00:00.000Z",
  };
  executeOperation("addweight", request);

  assert.throws(
    () =>
      executeOperation("addweight", {
        ...request,
        delta: -0.25,
      }),
    /addweight adjustmentId already exists with a different payload/,
  );
});

test("ums-memory-hpl.5 addweight replay stays idempotent after policy audit export/import rotation", () => {
  const storeId = "tenant-addweight-replay";
  const profile = "addweight-replay";
  const created = executeOperation("shadow_write", {
    storeId,
    profile,
    statement: "Replay-safe human weighting should survive audit trail truncation.",
    confidence: 0.5,
    sourceEventIds: ["evt-addweight-replay-1"],
    evidenceEventIds: ["evt-addweight-replay-1"],
  });
  const candidateId = created.applied[0].candidateId;
  const request = {
    storeId,
    profile,
    candidateId,
    adjustmentId: "manual-adjustment-replay-1",
    delta: 0.18,
    reason: "Validated by postmortem follow-up.",
    actor: "reviewer-4",
    timestamp: "2026-03-02T11:00:00.000Z",
  };
  const first = executeOperation("addweight", request);

  const snapshot = exportStoreSnapshot();
  const profileEntries = snapshot.stores[storeId]?.profiles ?? {};
  const [profileKey] = Object.keys(profileEntries).sort();
  assert.ok(profileKey);
  profileEntries[profileKey].policyAuditTrail = [];
  importStoreSnapshot(snapshot);

  const replay = executeOperation("addweight", request);
  assert.equal(replay.action, "noop");
  assert.equal(replay.policyAuditEventId, first.policyAuditEventId);

  const restored = snapshotProfile(profile, storeId);
  const storedCandidate = restored.shadowCandidates.find((entry) => entry.candidateId === candidateId);
  assert.ok(storedCandidate);
  assert.equal(storedCandidate.confidence, 0.68);
});

test("ums-memory-hpl.5 addweight enforces bounded delta and non-empty reason contracts", () => {
  const storeId = "tenant-addweight-contract";
  const profile = "addweight-contract";
  const created = executeOperation("shadow_write", {
    storeId,
    profile,
    statement: "Contract checks should reject invalid manual weighting requests.",
    sourceEventIds: ["evt-addweight-contract-1"],
    evidenceEventIds: ["evt-addweight-contract-1"],
  });
  const candidateId = created.applied[0].candidateId;

  assert.throws(
    () =>
      executeOperation("addweight", {
        storeId,
        profile,
        candidateId,
        delta: 1.5,
        reason: "Too large delta should fail.",
      }),
    /addweight requires numeric delta in \[-1, 1\]/,
  );
  assert.throws(
    () =>
      executeOperation("addweight", {
        storeId,
        profile,
        candidateId,
        delta: 0.1,
        reason: "   ",
      }),
    /addweight requires a non-empty reason/,
  );
});

test("ums-memory-hpl.5 /addweight alias resolves to addweight operation", () => {
  const storeId = "tenant-addweight-alias";
  const profile = "addweight-alias";
  const created = executeOperation("shadow_write", {
    storeId,
    profile,
    statement: "Alias coverage for human weighting endpoint.",
    confidence: 0.45,
    sourceEventIds: ["evt-addweight-alias-1"],
    evidenceEventIds: ["evt-addweight-alias-1"],
  });
  const candidateId = created.applied[0].candidateId;

  const result = executeOperation("/addweight", {
    storeId,
    profile,
    candidateId,
    delta: 0.2,
    reason: "Manual override from incident postmortem.",
    actor: "reviewer-3",
  });

  assert.equal(result.action, "adjusted");
  assert.equal(result.candidate.candidateId, candidateId);
  assert.equal(result.candidate.confidence, 0.65);
});

test("ums-memory-hpl.6 feedback ingestion maps helpful and harmful signals into utility metadata deterministically", () => {
  const storeId = "tenant-hpl6-feedback";
  const profile = "hpl6-feedback";
  const shadow = executeOperation("shadow_write", {
    storeId,
    profile,
    statement: "Feedback utility mapping should remain deterministic.",
    confidence: 0.55,
    sourceEventIds: ["evt-hpl6-feedback-1"],
    evidenceEventIds: ["evt-hpl6-feedback-1"],
    createdAt: "2026-03-02T12:00:00.000Z",
  });
  const candidateId = shadow.applied[0].candidateId;
  executeOperation("replay_eval", {
    storeId,
    profile,
    candidateId,
    successRateDelta: 1,
    evaluatedAt: "2026-03-02T12:10:00.000Z",
  });
  const promoted = executeOperation("promote", {
    storeId,
    profile,
    candidateId,
    promotedAt: "2026-03-02T12:20:00.000Z",
  });
  const targetRuleId = promoted.rule.ruleId;

  const helpfulRequest = {
    storeId,
    profile,
    targetRuleId,
    targetCandidateId: candidateId,
    signal: "helpful",
    note: "Human reviewer confirmed the rule improved outcomes.",
    actor: "reviewer-feedback",
    timestamp: "2026-03-02T13:00:00.000Z",
  };
  const helpful = executeOperation("feedback", helpfulRequest);
  const helpfulReplay = executeOperation("feedback", helpfulRequest);

  assert.equal(helpful.action, "created");
  assert.equal(helpfulReplay.action, "noop");
  assert.equal(helpful.mapping.updatedRuleIds.length, 1);
  assert.equal(helpful.mapping.updatedCandidateIds.length, 1);
  assert.equal(helpful.policyAuditEventId, helpfulReplay.policyAuditEventId);

  const harmful = executeOperation("feedback", {
    ...helpfulRequest,
    signal: "harmful",
    note: "Follow-up run exposed regressions.",
    timestamp: "2026-03-02T13:30:00.000Z",
  });
  assert.equal(harmful.action, "created");
  assert.equal(harmful.mapping.updatedRuleIds.length, 1);
  assert.equal(harmful.mapping.updatedCandidateIds.length, 1);
  assert.equal(harmful.autoDemotion.action, "demoted");
  assert.deepEqual(harmful.autoDemotion.removedRuleIds, [targetRuleId]);

  const snapshot = snapshotProfile(profile, storeId);
  const storedRule = snapshot.rules.find((entry) => entry.ruleId === targetRuleId);
  assert.equal(storedRule, undefined);

  const storedCandidate = snapshot.shadowCandidates.find((entry) => entry.candidateId === candidateId);
  assert.ok(storedCandidate);
  assert.equal(storedCandidate.status, "demoted");
  assert.equal(storedCandidate.metadata.utilitySignal.source, "feedback");
  assert.equal(storedCandidate.metadata.utilitySignal.signalType, "harmful");
  assert.equal(storedCandidate.metadata.utilitySignal.score, 0.44);
});

test("ums-memory-hpl.6 outcome ingestion maps success/failure to utility signals with replay safety", () => {
  const storeId = "tenant-hpl6-outcome";
  const profile = "hpl6-outcome";
  const shadow = executeOperation("shadow_write", {
    storeId,
    profile,
    statement: "Outcome mapping should update utility consistently.",
    confidence: 0.5,
    sourceEventIds: ["evt-hpl6-outcome-1"],
    evidenceEventIds: ["evt-hpl6-outcome-1"],
  });
  const candidateId = shadow.applied[0].candidateId;
  executeOperation("replay_eval", {
    storeId,
    profile,
    candidateId,
    successRateDelta: 1,
  });
  const promoted = executeOperation("promote", {
    storeId,
    profile,
    candidateId,
  });
  const targetRuleId = promoted.rule.ruleId;

  const request = {
    storeId,
    profile,
    task: "triage release incident",
    outcome: "failure",
    usedRuleIds: [targetRuleId],
    actor: "oncall",
    timestamp: "2026-03-02T14:00:00.000Z",
  };
  const created = executeOperation("outcome", request);
  const replay = executeOperation("outcome", request);

  assert.equal(created.action, "created");
  assert.equal(replay.action, "noop");
  assert.equal(created.mapping.updatedRuleIds.length, 1);
  assert.equal(created.mapping.updatedCandidateIds.length, 1);
  assert.equal(created.policyAuditEventId, replay.policyAuditEventId);
  assert.deepEqual(created.usedRuleIds, [targetRuleId]);

  const snapshot = snapshotProfile(profile, storeId);
  const storedRule = snapshot.rules.find((entry) => entry.ruleId === targetRuleId);
  assert.ok(storedRule);
  assert.equal(storedRule.utilitySignalSource, "outcome_failure");
  assert.equal(storedRule.utilityScore, 0.3);
  const storedCandidate = snapshot.shadowCandidates.find((entry) => entry.candidateId === candidateId);
  assert.ok(storedCandidate);
  assert.equal(storedCandidate.metadata.utilitySignal.source, "outcome_failure");
  assert.equal(storedCandidate.metadata.utilitySignal.score, 0.3);
});

test("ums-memory-hpl.6 feedback supports candidate-only utility mapping without a rule target", () => {
  const storeId = "tenant-hpl6-candidate-only";
  const profile = "hpl6-candidate-only";
  const created = executeOperation("shadow_write", {
    storeId,
    profile,
    statement: "Candidate-only mapping should still update utility metadata.",
    sourceEventIds: ["evt-hpl6-candidate-only-1"],
    evidenceEventIds: ["evt-hpl6-candidate-only-1"],
  });
  const candidateId = created.applied[0].candidateId;

  const mapped = executeOperation("feedback", {
    storeId,
    profile,
    targetCandidateId: candidateId,
    signal: "helpful",
    note: "No promoted rule exists yet.",
    actor: "reviewer-candidate-only",
    timestamp: "2026-03-02T14:30:00.000Z",
  });

  assert.equal(mapped.action, "created");
  assert.deepEqual(mapped.mapping.updatedRuleIds, []);
  assert.deepEqual(mapped.mapping.updatedCandidateIds, [candidateId]);
  const snapshot = snapshotProfile(profile, storeId);
  const storedCandidate = snapshot.shadowCandidates.find((entry) => entry.candidateId === candidateId);
  assert.ok(storedCandidate);
  assert.equal(storedCandidate.metadata.utilitySignal.score, 0.62);
});

test("ums-memory-hpl.6 legacy overlength feedback/outcome snapshots import leniently", () => {
  const storeId = "tenant-hpl6-legacy-import";
  const longNote = "n".repeat(700);
  const longActor = "a".repeat(200);
  const longTask = "t".repeat(400);
  const longRuleId = "r".repeat(400);
  importStoreSnapshot({
    stores: {
      [storeId]: {
        profiles: {
          legacy: {
            feedback: [
              {
                feedbackId: "feedback-legacy-1",
                targetRuleId: "rule-legacy-1",
                signal: "helpful",
                note: longNote,
                actor: longActor,
                recordedAt: "2026-03-02T15:00:00.000Z",
              },
            ],
            outcomes: [
              {
                outcomeId: "outcome-legacy-1",
                task: longTask,
                outcome: "failure",
                usedRuleIds: [longRuleId],
                actor: longActor,
                recordedAt: "2026-03-02T15:10:00.000Z",
              },
            ],
          },
        },
      },
    },
  });

  const snapshot = snapshotProfile("legacy", storeId);
  assert.equal(snapshot.feedback.length, 1);
  assert.equal(snapshot.feedback[0].note.length, 512);
  assert.equal(snapshot.feedback[0].actor.length, 128);
  assert.equal(snapshot.outcomes.length, 1);
  assert.equal(snapshot.outcomes[0].task.length, 128);
  assert.equal(snapshot.outcomes[0].usedRuleIds[0].length, 256);
});

test("ums-memory-hpl.7 incident escalation signals quarantine critical failures and remain replay-safe", () => {
  const storeId = "tenant-hpl7-critical";
  const profile = "hpl7-critical";
  const shadow = executeOperation("shadow_write", {
    storeId,
    profile,
    statement: "Escalated incidents should quarantine this memory immediately.",
    sourceEventIds: ["evt-hpl7-shadow-1"],
    evidenceEventIds: ["evt-hpl7-shadow-1"],
    createdAt: "2026-03-02T17:00:00.000Z",
    expiresAt: "2026-04-02T17:00:00.000Z",
  });
  const candidateId = shadow.applied[0].candidateId;
  executeOperation("replay_eval", {
    storeId,
    profile,
    candidateId,
    successRateDelta: 0.9,
    evaluatedAt: "2026-03-02T17:10:00.000Z",
  });
  const promoted = executeOperation("promote", {
    storeId,
    profile,
    candidateId,
    promotedAt: "2026-03-02T17:20:00.000Z",
  });
  const ruleId = promoted.rule.ruleId;
  const request = {
    storeId,
    profile,
    escalationSignalId: "esc-hpl7-critical-1",
    incidentRef: "inc-hpl7-critical",
    escalationType: "runtime_error",
    severity: "critical",
    reasonCodes: ["production_incident", "memory_quarantine_required"],
    targetCandidateIds: [candidateId],
    targetRuleIds: [ruleId],
    evidenceEventIds: ["evt-hpl7-incident-1"],
    sourceEventIds: ["evt-hpl7-incident-2"],
    timestamp: "2026-03-02T18:00:00.000Z",
  };

  const first = executeOperation("incident_escalation_signal", request);
  const firstSnapshot = snapshotProfile(profile, storeId);
  const firstCandidate = firstSnapshot.shadowCandidates.find((entry) => entry.candidateId === candidateId);

  assert.equal(first.action, "created");
  assert.equal(first.quarantine.required, true);
  assert.equal(first.quarantine.triggered, true);
  assert.equal(first.quarantine.changed, true);
  assert.deepEqual(first.quarantine.demotedCandidateIds, [candidateId]);
  assert.deepEqual(first.quarantine.quarantinedRuleIds, [ruleId]);
  assert.ok(firstCandidate);
  assert.equal(firstCandidate.status, "demoted");
  assert.equal(firstSnapshot.rules.some((entry) => entry.ruleId === ruleId), false);

  const auditCountAfterFirst = firstSnapshot.policyAuditTrail.length;
  const second = executeOperation("incident_escalation_signal", request);
  const secondSnapshot = snapshotProfile(profile, storeId);

  assert.equal(second.action, "noop");
  assert.equal(second.policyAuditEventId, first.policyAuditEventId);
  assert.equal(second.quarantine.required, true);
  assert.equal(second.quarantine.triggered, true);
  assert.equal(second.quarantine.changed, false);
  assert.deepEqual(second.quarantine.demotedCandidateIds, []);
  assert.deepEqual(second.quarantine.alreadyQuarantinedCandidateIds, [candidateId]);
  assert.deepEqual(second.quarantine.quarantinedRuleIds, []);
  assert.equal(second.observability.replaySafe, true);
  assert.equal(secondSnapshot.policyAuditTrail.length, auditCountAfterFirst);
});

test("ums-memory-hpl.7 non-severe escalation records signal without immediate quarantine and supports alias route", () => {
  const storeId = "tenant-hpl7-high";
  const profile = "hpl7-high";
  const shadow = executeOperation("shadow_write", {
    storeId,
    profile,
    statement: "High severity signals should be review-only unless marked severe/critical.",
    sourceEventIds: ["evt-hpl7-high-shadow-1"],
    evidenceEventIds: ["evt-hpl7-high-shadow-1"],
    createdAt: "2026-03-02T19:00:00.000Z",
    expiresAt: "2026-04-02T19:00:00.000Z",
  });
  const candidateId = shadow.applied[0].candidateId;
  executeOperation("replay_eval", {
    storeId,
    profile,
    candidateId,
    successRateDelta: 0.8,
    evaluatedAt: "2026-03-02T19:10:00.000Z",
  });
  const promoted = executeOperation("promote", {
    storeId,
    profile,
    candidateId,
    promotedAt: "2026-03-02T19:20:00.000Z",
  });
  const ruleId = promoted.rule.ruleId;

  const escalation = executeOperation("incident_escalation_ingest", {
    storeId,
    profile,
    escalationSignalId: "esc-hpl7-high-1",
    incidentRef: "inc-hpl7-high",
    escalationType: "regression",
    severity: "high",
    targetCandidateIds: [candidateId],
    targetRuleIds: [ruleId],
    evidenceEventIds: ["evt-hpl7-high-incident-1"],
    sourceEventIds: ["evt-hpl7-high-incident-2"],
    timestamp: "2026-03-02T19:30:00.000Z",
  });
  const snapshot = snapshotProfile(profile, storeId);
  const candidate = snapshot.shadowCandidates.find((entry) => entry.candidateId === candidateId);

  assert.equal(escalation.operation, "incident_escalation_signal");
  assert.equal(escalation.action, "created");
  assert.equal(escalation.quarantine.required, false);
  assert.equal(escalation.quarantine.triggered, false);
  assert.equal(escalation.quarantine.changed, false);
  assert.deepEqual(escalation.quarantine.demotedCandidateIds, []);
  assert.deepEqual(escalation.quarantine.quarantinedRuleIds, []);
  assert.equal(escalation.observability.immediateQuarantineTriggered, false);
  assert.ok(candidate);
  assert.equal(candidate.status, "promoted");
  assert.equal(snapshot.rules.some((entry) => entry.ruleId === ruleId), true);
});

test("ums-memory-hpl.7 incident escalation enforces evidence pointer contract", () => {
  assert.throws(
    () =>
      executeOperation("incident_escalation_signal", {
        storeId: "tenant-hpl7-contract",
        profile: "hpl7-contract",
        escalationSignalId: "esc-hpl7-contract-1",
        severity: "critical",
        targetCandidateIds: ["cand-hpl7-contract-1"],
      }),
    /incident_escalation_signal requires at least one evidenceEventId/,
  );
});

test("ums-memory-hpl.7 incident escalation quarantines orphaned promoted rules directly and remains replay-safe", () => {
  const storeId = "tenant-hpl7-orphan-rule";
  const profile = "hpl7-orphan-rule";
  const ruleId = "rule-hpl7-orphan-1";
  importStoreSnapshot({
    stores: {
      [storeId]: {
        profiles: {
          [profile]: {
            rules: [
              {
                ruleId,
                statement: "Orphan promoted rules should still be directly quarantinable.",
                confidence: 0.78,
                scope: "global",
                sourceEventIds: ["evt-hpl7-orphan-shadow-1"],
                evidenceEventIds: ["evt-hpl7-orphan-shadow-1"],
                promotedFromCandidateId: "cand-hpl7-missing",
                promotedByReplayEvalId: "reval-hpl7-missing",
                promotedAt: "2026-03-02T20:00:00.000Z",
                updatedAt: "2026-03-02T20:00:00.000Z",
              },
            ],
          },
        },
      },
    },
  });

  const request = {
    storeId,
    profile,
    escalationSignalId: "esc-hpl7-orphan-rule-1",
    incidentRef: "inc-hpl7-orphan-rule",
    escalationType: "runtime_error",
    severity: "critical",
    reasonCodes: ["production_incident"],
    targetRuleIds: [ruleId],
    evidenceEventIds: ["evt-hpl7-orphan-incident-1"],
    sourceEventIds: ["evt-hpl7-orphan-incident-2"],
    timestamp: "2026-03-02T20:05:00.000Z",
  };

  const first = executeOperation("incident_escalation_signal", request);
  const firstSnapshot = snapshotProfile(profile, storeId);
  assert.equal(first.action, "created");
  assert.equal(first.quarantine.changed, true);
  assert.deepEqual(first.quarantine.demotedCandidateIds, []);
  assert.deepEqual(first.quarantine.quarantinedRuleIds, [ruleId]);
  assert.equal(first.quarantine.ruleActions.find((entry) => entry.ruleId === ruleId)?.action, "quarantined");
  assert.equal(firstSnapshot.rules.some((entry) => entry.ruleId === ruleId), false);

  const auditCountAfterFirst = firstSnapshot.policyAuditTrail.length;
  const second = executeOperation("incident_escalation_signal", request);
  const secondSnapshot = snapshotProfile(profile, storeId);
  assert.equal(second.action, "noop");
  assert.equal(second.quarantine.changed, false);
  assert.deepEqual(second.quarantine.quarantinedRuleIds, []);
  assert.deepEqual(second.quarantine.missingRuleIds, [ruleId]);
  assert.equal(secondSnapshot.policyAuditTrail.length, auditCountAfterFirst);
});

test("ums-memory-hpl.9 manual override controls enforce contracts for targets, actor, and reasons", () => {
  assert.throws(
    () =>
      executeOperation("manual_quarantine_override", {
        storeId: "tenant-hpl9-contracts",
        profile: "hpl9-contracts",
        action: "suppress",
        actor: "oncall-operator",
        reasonCodes: ["manual_safety_intervention"],
      }),
    /manual_quarantine_override requires at least one targetCandidateId or targetRuleId/,
  );
  assert.throws(
    () =>
      executeOperation("manual_quarantine_override", {
        storeId: "tenant-hpl9-contracts",
        profile: "hpl9-contracts",
        action: "suppress",
        targetCandidateIds: ["cand-hpl9-contracts-1"],
        reasonCodes: ["manual_safety_intervention"],
      }),
    /manual_quarantine_override requires actor/,
  );
  assert.throws(
    () =>
      executeOperation("manual_quarantine_override", {
        storeId: "tenant-hpl9-contracts",
        profile: "hpl9-contracts",
        action: "promote",
        actor: "oncall-operator",
        targetCandidateIds: ["cand-hpl9-contracts-1"],
      }),
    /manual_quarantine_override requires reasonCodes or a reason/,
  );
});

test("ums-memory-hpl.9 manual override controls support emergency promote and suppress flows with replay-safe auditability", () => {
  const storeId = "tenant-hpl9-manual";
  const profile = "hpl9-manual";
  const shadow = executeOperation("shadow_write", {
    storeId,
    profile,
    statement: "Manual override should recover this candidate even without replay gate pass.",
    sourceEventIds: ["evt-hpl9-shadow-1"],
    evidenceEventIds: ["evt-hpl9-shadow-1"],
    createdAt: "2026-03-02T21:00:00.000Z",
    expiresAt: "2026-04-02T21:00:00.000Z",
  });
  const candidateId = shadow.applied[0].candidateId;

  const promoteRequest = {
    storeId,
    profile,
    overrideControlId: "movr-hpl9-promote-1",
    action: "promote",
    actor: "oncall-operator",
    reasonCodes: ["false_positive_quarantine"],
    reason: "Restore candidate while incident triage is ongoing.",
    targetCandidateIds: [candidateId],
    evidenceEventIds: ["evt-hpl9-promote-1"],
    sourceEventIds: ["evt-hpl9-promote-2"],
    timestamp: "2026-03-02T21:10:00.000Z",
  };

  const promoteFirst = executeOperation("manual_override_control", promoteRequest);
  const afterPromote = snapshotProfile(profile, storeId);
  const promotedCandidate = afterPromote.shadowCandidates.find((entry) => entry.candidateId === candidateId);
  assert.equal(promoteFirst.operation, "manual_quarantine_override");
  assert.equal(promoteFirst.action, "created");
  assert.equal(promoteFirst.override.action, "promote");
  assert.equal(promoteFirst.override.changed, true);
  assert.deepEqual(promoteFirst.override.promotedCandidateIds, [candidateId]);
  assert.equal(promoteFirst.override.promotedRuleIds.length, 1);
  assert.ok(promotedCandidate);
  assert.equal(promotedCandidate.status, "promoted");
  const promotedRuleId = promoteFirst.override.promotedRuleIds[0];
  assert.equal(afterPromote.rules.some((entry) => entry.ruleId === promotedRuleId), true);

  const promoteAuditCount = afterPromote.policyAuditTrail.length;
  const promoteReplay = executeOperation("manual_quarantine_override", promoteRequest);
  const afterPromoteReplay = snapshotProfile(profile, storeId);
  assert.equal(promoteReplay.action, "noop");
  assert.equal(promoteReplay.override.changed, false);
  assert.deepEqual(promoteReplay.override.promotedCandidateIds, []);
  assert.equal(afterPromoteReplay.policyAuditTrail.length, promoteAuditCount);

  const suppressRequest = {
    storeId,
    profile,
    overrideControlId: "movr-hpl9-suppress-1",
    action: "suppress",
    actor: "oncall-operator",
    reasonCodes: ["emergency_suppress"],
    reason: "Suppress candidate after production incident.",
    targetRuleIds: [promotedRuleId],
    evidenceEventIds: ["evt-hpl9-suppress-1"],
    sourceEventIds: ["evt-hpl9-suppress-2"],
    timestamp: "2026-03-02T21:20:00.000Z",
  };

  const suppressFirst = executeOperation("quarantine_override_control", suppressRequest);
  const afterSuppress = snapshotProfile(profile, storeId);
  const suppressedCandidate = afterSuppress.shadowCandidates.find((entry) => entry.candidateId === candidateId);
  assert.equal(suppressFirst.operation, "manual_quarantine_override");
  assert.equal(suppressFirst.action, "created");
  assert.equal(suppressFirst.override.action, "suppress");
  assert.equal(suppressFirst.override.changed, true);
  assert.deepEqual(suppressFirst.override.demotedCandidateIds, [candidateId]);
  assert.deepEqual(suppressFirst.override.quarantinedRuleIds, [promotedRuleId]);
  assert.ok(suppressedCandidate);
  assert.equal(suppressedCandidate.status, "demoted");
  assert.equal(afterSuppress.rules.some((entry) => entry.ruleId === promotedRuleId), false);

  const suppressAuditCount = afterSuppress.policyAuditTrail.length;
  const suppressReplay = executeOperation("manual_quarantine_override", suppressRequest);
  const afterSuppressReplay = snapshotProfile(profile, storeId);
  assert.equal(suppressReplay.action, "noop");
  assert.equal(suppressReplay.override.changed, false);
  assert.deepEqual(suppressReplay.override.alreadyQuarantinedCandidateIds, [candidateId]);
  assert.deepEqual(suppressReplay.override.missingRuleIds, [promotedRuleId]);
  assert.equal(afterSuppressReplay.policyAuditTrail.length, suppressAuditCount);
});

test("context and curate operate on shared profile state", () => {
  executeOperation("ingest", {
    profile: "demo",
    events: [{ type: "ticket", source: "jira", content: "Always include acceptance criteria." }]
  });
  const reflected = executeOperation("reflect", { profile: "demo", maxCandidates: 1 });
  const curated = executeOperation("curate", {
    profile: "demo",
    candidates: reflected.candidates
  });
  const context = executeOperation("context", {
    profile: "demo",
    query: "acceptance"
  });

  assert.equal(curated.applied.length, 1);
  assert.equal(context.matches.length, 1);
  assert.equal(snapshotProfile("demo").rules.length, 1);
});

test("store isolation prevents cross-store state bleed", () => {
  executeOperation("ingest", {
    storeId: "jira-history",
    profile: "ops",
    events: [{ type: "ticket", source: "jira", content: "jira-only evidence" }],
  });
  executeOperation("ingest", {
    storeId: "coding-agent",
    profile: "ops",
    events: [{ type: "note", source: "codex", content: "coding-only evidence" }],
  });

  const jiraContext = executeOperation("context", {
    storeId: "jira-history",
    profile: "ops",
    query: "coding-only",
  });
  const codingContext = executeOperation("context", {
    storeId: "coding-agent",
    profile: "ops",
    query: "jira-only",
  });

  assert.equal(jiraContext.matches.length, 0);
  assert.equal(codingContext.matches.length, 0);
  assert.equal(snapshotProfile("ops", "jira-history").events.length, 1);
  assert.equal(snapshotProfile("ops", "coding-agent").events.length, 1);
});

test("ums-memory-d6q.1.4 learner_profile_update deterministic IDs and replay-safe behavior", () => {
  const request = {
    storeId: "tenant-a",
    profile: "learner-alpha",
    learnerId: "learner-42",
    identityRefs: [
      { namespace: "email", value: "learner@example.com" },
      { namespace: "agent", value: "codex", isPrimary: true }
    ],
    goals: ["graph", "dp", "graph"],
    interestTags: ["algorithms"],
    misconceptionIds: ["off-by-one"],
    evidenceEventIds: ["ep-profile-1"],
    metadata: { source: "unit-test" }
  };

  const first = executeOperation("learner_profile_update", request);
  const replay = executeOperation("learner_profile_update", {
    ...request,
    goals: ["dp", "graph"],
    identityRefs: [
      { namespace: "agent", value: "codex", isPrimary: true },
      { namespace: "email", value: "learner@example.com" }
    ]
  });

  assert.equal(first.action, "created");
  assert.equal(replay.action, "noop");
  assert.equal(first.profileId, replay.profileId);
  assert.equal(first.profileDigest, replay.profileDigest);
  assert.equal(replay.totalProfiles, 1);

  const snapshot = snapshotProfile("learner-alpha", "tenant-a");
  assert.equal(snapshot.learnerProfiles.length, 1);
  assert.equal(snapshot.learnerProfiles[0].profileId, first.profileId);

  resetStore();
  const replayFromCleanStore = executeOperation("learner_profile_update", request);
  assert.equal(replayFromCleanStore.profileId, first.profileId);
  assert.equal(replayFromCleanStore.profileDigest, first.profileDigest);
});

test("ums-memory-d6q.1.4 identity_graph_update deterministic IDs and replay-safe behavior", () => {
  const profileResponse = executeOperation("learner_profile_update", {
    storeId: "tenant-a",
    profile: "learner-alpha",
    learnerId: "learner-42",
    identityRefs: [{ namespace: "email", value: "learner@example.com", isPrimary: true }],
    evidenceEventIds: ["ep-profile-seed"],
  });

  const edgeRequest = {
    storeId: "tenant-a",
    profile: "learner-alpha",
    profileId: profileResponse.profileId,
    relation: "misconception_of",
    fromRef: { namespace: "misconception", value: "off-by-one" },
    toRef: { namespace: "learner", value: "learner-42" },
    evidenceEventIds: ["ep-2", "ep-1", "ep-1"],
    metadata: { source: "unit-test" }
  };

  const first = executeOperation("identity_graph_update", edgeRequest);
  const replay = executeOperation("identity_graph_update", {
    ...edgeRequest,
    evidenceEventIds: ["ep-1", "ep-2"]
  });

  assert.equal(first.action, "created");
  assert.equal(replay.action, "noop");
  assert.equal(first.edgeId, replay.edgeId);
  assert.equal(first.edgeDigest, replay.edgeDigest);
  assert.equal(replay.totalEdges, 1);
  assert.deepEqual(replay.identityGraphDelta.evidenceEventIds, ["ep-1", "ep-2"]);

  executeOperation("identity_graph_update", {
    ...edgeRequest,
    storeId: "tenant-b"
  });

  const tenantA = snapshotProfile("learner-alpha", "tenant-a");
  const tenantB = snapshotProfile("learner-alpha", "tenant-b");
  assert.equal(tenantA.identityGraphEdges.length, 1);
  assert.equal(tenantB.identityGraphEdges.length, 1);
});

test("ums-memory-d6q.1.5 core service increments profile version and preserves identity provenance", () => {
  const created = executeOperation("learner_profile_update", {
    storeId: "tenant-svc",
    profile: "learner-svc",
    learnerId: "learner-500",
    identityRefs: [{ namespace: "email", value: "svc@example.com", isPrimary: true }],
    goals: ["graphs"],
    evidenceEventIds: ["ep-svc-profile-1"],
    metadata: { origin: "initial" },
  });
  const updated = executeOperation("learner_profile_update", {
    storeId: "tenant-svc",
    profile: "learner-svc",
    learnerId: "learner-500",
    profileId: created.profileId,
    identityRefs: [{ namespace: "email", value: "svc@example.com", isPrimary: true }],
    goals: ["graphs", "dp"],
    evidenceEventIds: ["ep-svc-profile-2"],
    metadata: { origin: "update" },
  });
  const edge = executeOperation("identity_graph_update", {
    storeId: "tenant-svc",
    profile: "learner-svc",
    profileId: created.profileId,
    relation: "goal_of",
    fromRef: { namespace: "goal", value: "dp" },
    toRef: { namespace: "learner", value: "learner-500" },
    evidenceEventIds: ["ep-svc-1"],
  });

  assert.equal(created.action, "created");
  assert.equal(updated.action, "updated");
  assert.equal(updated.profileModel.version, 2);
  assert.equal(edge.action, "created");
  assert.ok(edge.edgeDigest.length > 12);
  const snapshot = snapshotProfile("learner-svc", "tenant-svc");
  assert.equal(snapshot.learnerProfiles.length, 1);
  assert.equal(snapshot.identityGraphEdges.length, 1);
});

test("ums-memory-d6q.2.4 misconception_update is deterministic, replay-safe, and telemetry-rich", () => {
  const base = {
    storeId: "tenant-mis",
    profile: "learner-mis",
    misconceptionKey: "off-by-one",
    signal: "harmful",
    evidenceEventIds: ["ep-2", "ep-1", "ep-1"],
    metadata: { source: "feedback" },
  };
  const created = executeOperation("misconception_update", base);
  const replay = executeOperation("misconception_update", {
    ...base,
    evidenceEventIds: ["ep-1", "ep-2"],
  });
  const resolved = executeOperation("misconception_update", {
    ...base,
    signal: "correction",
    signalId: "correction-1",
    evidenceEventIds: ["ep-9"],
  });

  assert.equal(created.action, "created");
  assert.equal(replay.action, "noop");
  assert.equal(created.misconceptionId, replay.misconceptionId);
  assert.equal(resolved.action, "updated");
  assert.equal(resolved.record.correctionSignalCount, 1);
  assert.equal(resolved.observability.storeIsolationEnforced, true);
});

test("ums-memory-d6q.3.4 curriculum_plan_update enforces evidence-backed idempotent planning", () => {
  const base = {
    storeId: "tenant-cur",
    profile: "learner-cur",
    objectiveId: "objective-graph-dp",
    recommendationRank: 4,
    evidenceEventIds: ["ep-a", "ep-b"],
    sourceMisconceptionIds: ["off-by-one"],
    provenanceSignalIds: ["sig-1"],
  };
  const created = executeOperation("curriculum_plan_update", base);
  const replay = executeOperation("curriculum_plan_update", {
    ...base,
    recommendationRank: 4,
    evidenceEventIds: ["ep-b", "ep-a"],
  });
  const upgraded = executeOperation("curriculum_plan_update", {
    ...base,
    planItemId: created.planItemId,
    recommendationRank: 1,
    interestTags: ["algorithms"],
    provenanceSignalIds: ["sig-2"],
  });

  assert.equal(created.action, "created");
  assert.equal(replay.action, "noop");
  assert.equal(upgraded.action, "updated");
  assert.equal(upgraded.planItem.recommendationRank, 1);
  assert.deepEqual(upgraded.planItem.provenanceSignalIds, ["sig-1", "sig-2"]);
});

test("ums-memory-d6q.4.4 review_schedule_update supports deterministic due-state transitions", () => {
  const base = {
    storeId: "tenant-srs",
    profile: "learner-srs",
    targetId: "rule-123",
    dueAt: "2026-03-01T12:00:00.000Z",
    sourceEventIds: ["evt-1"],
    evidenceEventIds: ["ep-1"],
  };
  const created = executeOperation("review_schedule_update", base);
  const replay = executeOperation("review_schedule_update", {
    ...base,
    sourceEventIds: ["evt-1"],
  });
  const completed = executeOperation("review_schedule_update", {
    ...base,
    scheduleEntryId: created.scheduleEntryId,
    status: "completed",
    repetition: 2,
    sourceEventIds: ["evt-1", "evt-2"],
  });

  assert.equal(created.action, "created");
  assert.equal(replay.action, "noop");
  assert.equal(completed.action, "updated");
  assert.equal(completed.scheduleEntry.status, "completed");
  assert.equal(completed.scheduleEntry.repetition, 2);
  assert.deepEqual(completed.scheduleEntry.sourceEventIds, ["evt-1", "evt-2"]);
});

test("ums-memory-d6q.5.4 policy_decision_update enforces policy checks and deterministic merges", () => {
  assert.throws(
    () =>
      executeOperation("policy_decision_update", {
        storeId: "tenant-pol",
        profile: "learner-pol",
        policyKey: "safety-output",
        outcome: "deny",
        provenanceEventIds: ["evt-pol-1"],
      }),
    /reasonCodes/i,
  );

  const created = executeOperation("policy_decision_update", {
    storeId: "tenant-pol",
    profile: "learner-pol",
    policyKey: "safety-output",
    outcome: "review",
    reasonCodes: ["insufficient-evidence"],
    provenanceEventIds: ["evt-pol-1"],
  });
  const denied = executeOperation("policy_decision_update", {
    storeId: "tenant-pol",
    profile: "learner-pol",
    policyKey: "safety-output",
    decisionId: created.decisionId,
    outcome: "deny",
    reasonCodes: ["safety-risk"],
    provenanceEventIds: ["evt-pol-2"],
  });
  const replay = executeOperation("policy_decision_update", {
    storeId: "tenant-pol",
    profile: "learner-pol",
    policyKey: "safety-output",
    decisionId: created.decisionId,
    outcome: "deny",
    reasonCodes: ["insufficient-evidence", "safety-risk"],
    provenanceEventIds: ["evt-pol-1", "evt-pol-2"],
  });

  assert.equal(created.action, "created");
  assert.equal(denied.action, "updated");
  assert.equal(denied.decision.outcome, "deny");
  assert.equal(replay.action, "noop");
  assert.equal(replay.observability.denied, true);
  assert.deepEqual(replay.decision.provenanceEventIds, ["evt-pol-1", "evt-pol-2"]);
});

test("ums-memory-d6q.2.5 core service drives misconception lifecycle with deterministic transitions", () => {
  const created = executeOperation("misconception_update", {
    storeId: "tenant-svc-mis",
    profile: "learner-svc-mis",
    misconceptionKey: "loop-invariant",
    signal: "harmful",
    signalId: "sig-h-1",
    evidenceEventIds: ["ep-1"],
  });
  const corrected = executeOperation("misconception_update", {
    storeId: "tenant-svc-mis",
    profile: "learner-svc-mis",
    misconceptionKey: "loop-invariant",
    signal: "correction",
    signalId: "sig-c-1",
    evidenceEventIds: ["ep-2"],
  });

  assert.equal(created.action, "created");
  assert.equal(corrected.action, "updated");
  assert.equal(corrected.record.status, "resolved");
  assert.equal(corrected.record.harmfulSignalCount, 1);
  assert.equal(corrected.record.correctionSignalCount, 1);
  assert.deepEqual(corrected.record.sourceSignalIds, ["sig-c-1", "sig-h-1"]);
});

test("ums-memory-d6q.3.5 core service orchestrates curriculum updates with provenance-rich no-op detection", () => {
  const created = executeOperation("curriculum_plan_update", {
    storeId: "tenant-svc-cur",
    profile: "learner-svc-cur",
    objectiveId: "objective-greedy",
    recommendationRank: 3,
    evidenceEventIds: ["ep-1"],
    provenanceSignalIds: ["sig-a"],
  });
  const updated = executeOperation("curriculum_plan_update", {
    storeId: "tenant-svc-cur",
    profile: "learner-svc-cur",
    objectiveId: "objective-greedy",
    planItemId: created.planItemId,
    status: "committed",
    recommendationRank: 1,
    evidenceEventIds: ["ep-2"],
    provenanceSignalIds: ["sig-b"],
  });
  const replay = executeOperation("curriculum_plan_update", {
    storeId: "tenant-svc-cur",
    profile: "learner-svc-cur",
    objectiveId: "objective-greedy",
    planItemId: created.planItemId,
    status: "committed",
    recommendationRank: 1,
    evidenceEventIds: ["ep-1", "ep-2"],
    provenanceSignalIds: ["sig-a", "sig-b"],
  });

  assert.equal(created.action, "created");
  assert.equal(updated.action, "updated");
  assert.equal(updated.planItem.status, "committed");
  assert.deepEqual(updated.planItem.provenanceSignalIds, ["sig-a", "sig-b"]);
  assert.equal(replay.action, "noop");
});

test("ums-memory-d6q.4.5 core service tracks review schedule state progression deterministically", () => {
  const created = executeOperation("review_schedule_update", {
    storeId: "tenant-svc-srs",
    profile: "learner-svc-srs",
    targetId: "rule-500",
    dueAt: "2026-03-02T00:00:00.000Z",
    sourceEventIds: ["evt-1"],
  });
  const due = executeOperation("review_schedule_update", {
    storeId: "tenant-svc-srs",
    profile: "learner-svc-srs",
    targetId: "rule-500",
    scheduleEntryId: created.scheduleEntryId,
    status: "due",
    repetition: 1,
    sourceEventIds: ["evt-1", "evt-2"],
  });
  const completed = executeOperation("review_schedule_update", {
    storeId: "tenant-svc-srs",
    profile: "learner-svc-srs",
    targetId: "rule-500",
    scheduleEntryId: created.scheduleEntryId,
    status: "completed",
    repetition: 2,
    sourceEventIds: ["evt-1", "evt-2", "evt-3"],
  });

  assert.equal(created.action, "created");
  assert.equal(due.action, "updated");
  assert.equal(completed.action, "updated");
  assert.equal(completed.scheduleEntry.status, "completed");
  assert.equal(completed.scheduleEntry.repetition, 2);
  assert.deepEqual(completed.scheduleEntry.sourceEventIds, ["evt-1", "evt-2", "evt-3"]);
});

test("ums-memory-d6q.5.5 core service applies deterministic policy severity precedence and replay safety", () => {
  const review = executeOperation("policy_decision_update", {
    storeId: "tenant-svc-pol",
    profile: "learner-svc-pol",
    policyKey: "anti-overfitting",
    outcome: "review",
    reasonCodes: ["insufficient-evidence"],
    provenanceEventIds: ["evt-a"],
  });
  const deny = executeOperation("policy_decision_update", {
    storeId: "tenant-svc-pol",
    profile: "learner-svc-pol",
    policyKey: "anti-overfitting",
    decisionId: review.decisionId,
    outcome: "deny",
    reasonCodes: ["policy-blocked"],
    provenanceEventIds: ["evt-b"],
  });
  const replay = executeOperation("policy_decision_update", {
    storeId: "tenant-svc-pol",
    profile: "learner-svc-pol",
    policyKey: "anti-overfitting",
    decisionId: review.decisionId,
    outcome: "deny",
    reasonCodes: ["insufficient-evidence", "policy-blocked"],
    provenanceEventIds: ["evt-a", "evt-b"],
  });

  assert.equal(review.action, "created");
  assert.equal(deny.action, "updated");
  assert.equal(deny.decision.outcome, "deny");
  assert.equal(replay.action, "noop");
  assert.deepEqual(replay.decision.reasonCodes, ["insufficient-evidence", "policy-blocked"]);
});

test("ums-memory-d6q.1.11 core enforces evidence-pointer rejection and supports policy exception path", () => {
  assert.throws(
    () =>
      executeOperation("misconception_update", {
        storeId: "tenant-evidence",
        profile: "learner-evidence",
        misconceptionKey: "pointer-required",
        signal: "harmful",
      }),
    /requires at least one evidenceEventId/i,
  );

  const policyException = executeOperation("policy_decision_update", {
    storeId: "tenant-evidence",
    profile: "learner-evidence",
    policyKey: "evidence-pointer-contract",
    outcome: "review",
    reasonCodes: ["policy-exception-evidence-pointer-waiver"],
    provenanceEventIds: ["evt-policy-waiver-1"],
    metadata: {
      exceptionKind: "evidence-pointer-waiver",
      waiverTicketId: "waiver-001",
    },
  });

  assert.equal(policyException.action, "created");
  assert.equal(policyException.decision.outcome, "review");
  assert.deepEqual(policyException.decision.reasonCodes, ["policy-exception-evidence-pointer-waiver"]);
  assert.deepEqual(policyException.decision.provenanceEventIds, ["evt-policy-waiver-1"]);
  assert.equal(policyException.observability.denied, false);
  assert.equal(policyException.observability.reasonCodeCount, 1);
  assert.equal(policyException.observability.provenanceCount, 1);
});

test("ums-memory-d6q.1.12 timeline lineage stays intact while current view resolves conflicts deterministically", () => {
  const created = executeOperation("curriculum_plan_update", {
    storeId: "tenant-timeline",
    profile: "learner-timeline",
    objectiveId: "objective-chronology",
    status: "proposed",
    recommendationRank: 4,
    dueAt: "2026-03-01T00:00:00.000Z",
    evidenceEventIds: ["ep-1"],
    provenanceSignalIds: ["sig-1"],
  });
  const blocked = executeOperation("curriculum_plan_update", {
    storeId: "tenant-timeline",
    profile: "learner-timeline",
    objectiveId: "objective-chronology",
    planItemId: created.planItemId,
    status: "blocked",
    recommendationRank: 3,
    dueAt: "2026-03-03T00:00:00.000Z",
    evidenceEventIds: ["ep-2"],
    provenanceSignalIds: ["sig-2"],
  });
  const conflicting = executeOperation("curriculum_plan_update", {
    storeId: "tenant-timeline",
    profile: "learner-timeline",
    objectiveId: "objective-chronology",
    planItemId: created.planItemId,
    status: "proposed",
    recommendationRank: 1,
    dueAt: "2026-03-05T00:00:00.000Z",
    evidenceEventIds: ["ep-3"],
    provenanceSignalIds: ["sig-3"],
  });
  const replay = executeOperation("curriculum_plan_update", {
    storeId: "tenant-timeline",
    profile: "learner-timeline",
    objectiveId: "objective-chronology",
    planItemId: created.planItemId,
    status: "blocked",
    recommendationRank: 1,
    dueAt: conflicting.planItem.dueAt,
    evidenceEventIds: ["ep-3", "ep-2", "ep-1"],
    provenanceSignalIds: ["sig-3", "sig-2", "sig-1"],
  });

  assert.equal(created.action, "created");
  assert.equal(blocked.action, "updated");
  assert.equal(conflicting.action, "updated");
  assert.equal(conflicting.planItem.status, "blocked");
  assert.equal(conflicting.planItem.recommendationRank, 1);
  assert.deepEqual(conflicting.planItem.evidenceEventIds, ["ep-1", "ep-2", "ep-3"]);
  assert.deepEqual(conflicting.planItem.provenanceSignalIds, ["sig-1", "sig-2", "sig-3"]);
  assert.equal(replay.action, "noop");
  assert.equal(replay.planDigest, conflicting.planDigest);
});

test("ums-memory-d6q.1.6/ums-memory-d6q.1.7 guardrails fail invalid identity relation and evidence combinations", () => {
  assert.throws(
    () =>
      createIdentityGraphEdge({
        spaceId: "tenant-guardrails",
        profileId: "lp_guardrails",
        relation: "unsupported_relation",
        fromRef: { namespace: "agent", value: "codex:session-9" },
        toRef: { namespace: "learner", value: "learner-guardrails" },
        createdAt: "2026-03-01T00:00:00.000Z",
      }),
    (error) => error?.code === ErrorCode.VALIDATION_FAILED,
  );

  assert.throws(
    () =>
      createIdentityGraphEdge({
        spaceId: "tenant-guardrails",
        profileId: "lp_guardrails",
        relation: IdentityGraphRelationKind.MISCONCEPTION_OF,
        fromRef: { namespace: "misconception", value: "off-by-one" },
        toRef: { namespace: "learner", value: "learner-guardrails" },
        createdAt: "2026-03-01T00:00:00.000Z",
      }),
    (error) => error?.code === ErrorCode.EVIDENCE_REQUIRED,
  );

  assert.throws(
    () =>
      createIdentityGraphEdge({
        spaceId: "tenant-guardrails",
        profileId: "lp_guardrails",
        relation: IdentityGraphRelationKind.EVIDENCE_OF,
        fromRef: { namespace: "claim", value: "claim-1" },
        toRef: { namespace: "learner", value: "learner-guardrails" },
        createdAt: "2026-03-01T00:00:00.000Z",
      }),
    (error) => error?.code === ErrorCode.EVIDENCE_REQUIRED,
  );
});

test("ums-memory-d6q.1.9 core returns observability and SLO-facing fields for personalization operations", () => {
  const misconception = executeOperation("misconception_update", {
    storeId: "tenant-observability",
    profile: "learner-observability",
    misconceptionKey: "loop-guard",
    signal: "harmful",
    evidenceEventIds: ["ep-obs-1", "ep-obs-2"],
    signalId: "sig-obs-1",
  });
  const curriculum = executeOperation("curriculum_plan_update", {
    storeId: "tenant-observability",
    profile: "learner-observability",
    objectiveId: "objective-observability",
    recommendationRank: 2,
    evidenceEventIds: ["ep-obs-2"],
    provenanceSignalIds: ["sig-obs-1", "sig-obs-2"],
  });
  const review = executeOperation("review_schedule_update", {
    storeId: "tenant-observability",
    profile: "learner-observability",
    targetId: "rule-observability",
    dueAt: "2026-03-06T00:00:00.000Z",
    sourceEventIds: ["evt-obs-1", "evt-obs-2"],
    evidenceEventIds: ["ep-obs-2"],
  });
  const policy = executeOperation("policy_decision_update", {
    storeId: "tenant-observability",
    profile: "learner-observability",
    policyKey: "observability-slo",
    outcome: "deny",
    reasonCodes: ["policy-threshold-breach"],
    provenanceEventIds: ["evt-policy-obs-1"],
    evidenceEventIds: ["ep-obs-2"],
  });

  assert.equal(misconception.deterministic, true);
  assert.ok(misconception.requestDigest.length >= 12);
  assert.equal(misconception.observability.evidenceCount, 2);
  assert.equal(misconception.observability.signalCount, 1);
  assert.equal(misconception.observability.storeIsolationEnforced, true);

  assert.equal(curriculum.observability.evidenceCount, 1);
  assert.equal(curriculum.observability.provenanceCount, 2);
  assert.equal(curriculum.observability.boundedRecommendationRank, 2);

  assert.equal(review.observability.sourceEventCount, 2);
  assert.equal(review.observability.dueAt, "2026-03-06T00:00:00.000Z");
  assert.equal(review.observability.storeIsolationEnforced, true);

  assert.equal(policy.observability.denied, true);
  assert.equal(policy.observability.reasonCodeCount, 1);
  assert.equal(policy.observability.provenanceCount, 1);
});

test("ums-memory-d6q.2.6/ums-memory-d6q.2.7/ums-memory-d6q.2.9 misconception_update guardrails, positive path, and observability", () => {
  assert.throws(
    () =>
      executeOperation("misconception_update", {
        storeId: "tenant-d6q2",
        profile: "learner-d6q2",
        misconceptionKey: "evidence-required",
        signal: "harmful",
      }),
    /requires at least one evidenceeventid/i,
  );

  const created = executeOperation("misconception_update", {
    storeId: "tenant-d6q2",
    profile: "learner-d6q2",
    misconceptionKey: "recurrence-error",
    signal: "harmful",
    signalId: "sig-harmful-1",
    evidenceEventIds: ["evt-m-1"],
  });
  const replay = executeOperation("misconception_update", {
    storeId: "tenant-d6q2",
    profile: "learner-d6q2",
    misconceptionKey: "recurrence-error",
    signal: "harmful",
    signalId: "sig-harmful-1",
    evidenceEventIds: ["evt-m-1"],
  });
  const corrected = executeOperation("misconception_update", {
    storeId: "tenant-d6q2",
    profile: "learner-d6q2",
    misconceptionKey: "recurrence-error",
    signal: "correction",
    signalId: "sig-correction-1",
    evidenceEventIds: ["evt-m-2"],
  });

  assert.equal(created.action, "created");
  assert.equal(replay.action, "noop");
  assert.equal(corrected.action, "updated");
  assert.equal(corrected.record.status, "resolved");
  assert.equal(corrected.observability.evidenceCount, 2);
  assert.equal(corrected.observability.signalCount, 2);
  assert.equal(corrected.observability.storeIsolationEnforced, true);
  assert.equal(corrected.deterministic, true);
  assert.ok(corrected.requestDigest.length > 10);
});

test("ums-memory-d6q.3.6/ums-memory-d6q.3.7/ums-memory-d6q.3.9 curriculum_plan_update guardrails, positive path, and observability", () => {
  assert.throws(
    () =>
      executeOperation("curriculum_plan_update", {
        storeId: "tenant-d6q3",
        profile: "learner-d6q3",
        objectiveId: "objective-evidence-required",
        recommendationRank: 2,
      }),
    /requires at least one evidenceeventid/i,
  );

  const created = executeOperation("curriculum_plan_update", {
    storeId: "tenant-d6q3",
    profile: "learner-d6q3",
    objectiveId: "objective-graph-dp",
    recommendationRank: 4,
    evidenceEventIds: ["evt-c-1"],
    provenanceSignalIds: ["sig-c-1"],
  });
  const updated = executeOperation("curriculum_plan_update", {
    storeId: "tenant-d6q3",
    profile: "learner-d6q3",
    objectiveId: "objective-graph-dp",
    planItemId: created.planItemId,
    status: "committed",
    recommendationRank: 1,
    evidenceEventIds: ["evt-c-2"],
    provenanceSignalIds: ["sig-c-2"],
  });
  const replay = executeOperation("curriculum_plan_update", {
    storeId: "tenant-d6q3",
    profile: "learner-d6q3",
    objectiveId: "objective-graph-dp",
    planItemId: created.planItemId,
    status: "committed",
    recommendationRank: 1,
    evidenceEventIds: ["evt-c-1", "evt-c-2"],
    provenanceSignalIds: ["sig-c-1", "sig-c-2"],
  });

  assert.equal(created.action, "created");
  assert.equal(updated.action, "updated");
  assert.equal(replay.action, "noop");
  assert.equal(updated.planItem.status, "committed");
  assert.equal(updated.observability.evidenceCount, 2);
  assert.equal(updated.observability.provenanceCount, 2);
  assert.equal(updated.observability.boundedRecommendationRank, 1);
  assert.equal(updated.deterministic, true);
  assert.ok(updated.requestDigest.length > 10);
});

test("ums-memory-d6q.4.6/ums-memory-d6q.4.7/ums-memory-d6q.4.9 review_schedule_update guardrails, positive path, and observability", () => {
  assert.throws(
    () =>
      executeOperation("review_schedule_update", {
        storeId: "tenant-d6q4",
        profile: "learner-d6q4",
        targetId: "rule-guardrail",
        dueAt: "2026-03-08T00:00:00.000Z",
      }),
    /requires at least one sourceeventid/i,
  );

  const created = executeOperation("review_schedule_update", {
    storeId: "tenant-d6q4",
    profile: "learner-d6q4",
    targetId: "rule-guardrail",
    dueAt: "2026-03-08T00:00:00.000Z",
    sourceEventIds: ["evt-r-1"],
    evidenceEventIds: ["evt-r-e-1"],
  });
  const updated = executeOperation("review_schedule_update", {
    storeId: "tenant-d6q4",
    profile: "learner-d6q4",
    targetId: "rule-guardrail",
    scheduleEntryId: created.scheduleEntryId,
    status: "due",
    repetition: 2,
    dueAt: "2026-03-08T00:00:00.000Z",
    sourceEventIds: ["evt-r-1", "evt-r-2"],
    evidenceEventIds: ["evt-r-e-1"],
  });
  const replay = executeOperation("review_schedule_update", {
    storeId: "tenant-d6q4",
    profile: "learner-d6q4",
    targetId: "rule-guardrail",
    scheduleEntryId: created.scheduleEntryId,
    status: "due",
    repetition: 2,
    dueAt: "2026-03-08T00:00:00.000Z",
    sourceEventIds: ["evt-r-1", "evt-r-2"],
    evidenceEventIds: ["evt-r-e-1"],
  });

  assert.equal(created.action, "created");
  assert.equal(updated.action, "updated");
  assert.equal(replay.action, "noop");
  assert.equal(updated.observability.dueAt, "2026-03-08T00:00:00.000Z");
  assert.equal(updated.observability.sourceEventCount, 2);
  assert.equal(updated.observability.storeIsolationEnforced, true);
  assert.equal(updated.deterministic, true);
  assert.ok(updated.requestDigest.length > 10);
});

test("ums-memory-d6q.5.6/ums-memory-d6q.5.7/ums-memory-d6q.5.9 policy_decision_update guardrails, positive path, and observability", () => {
  assert.throws(
    () =>
      executeOperation("policy_decision_update", {
        storeId: "tenant-d6q5",
        profile: "learner-d6q5",
        policyKey: "safety-thresholds",
        outcome: "deny",
        provenanceEventIds: ["evt-p-1"],
      }),
    /reasoncodes/i,
  );
  assert.throws(
    () =>
      executeOperation("policy_decision_update", {
        storeId: "tenant-d6q5",
        profile: "learner-d6q5",
        policyKey: "safety-thresholds",
        outcome: "review",
        reasonCodes: ["needs-review"],
      }),
    /provenanceeventids/i,
  );

  const reviewed = executeOperation("policy_decision_update", {
    storeId: "tenant-d6q5",
    profile: "learner-d6q5",
    policyKey: "safety-thresholds",
    outcome: "review",
    reasonCodes: ["needs-review"],
    provenanceEventIds: ["evt-p-1"],
  });
  const denied = executeOperation("policy_decision_update", {
    storeId: "tenant-d6q5",
    profile: "learner-d6q5",
    policyKey: "safety-thresholds",
    decisionId: reviewed.decisionId,
    outcome: "deny",
    reasonCodes: ["threshold-breach"],
    provenanceEventIds: ["evt-p-2"],
  });
  const replay = executeOperation("policy_decision_update", {
    storeId: "tenant-d6q5",
    profile: "learner-d6q5",
    policyKey: "safety-thresholds",
    decisionId: reviewed.decisionId,
    outcome: "deny",
    reasonCodes: ["needs-review", "threshold-breach"],
    provenanceEventIds: ["evt-p-1", "evt-p-2"],
  });

  assert.equal(reviewed.action, "created");
  assert.equal(denied.action, "updated");
  assert.equal(replay.action, "noop");
  assert.equal(replay.decision.outcome, "deny");
  assert.equal(replay.observability.denied, true);
  assert.equal(replay.observability.reasonCodeCount, 2);
  assert.equal(replay.observability.provenanceCount, 2);
  assert.equal(replay.deterministic, true);
  assert.ok(replay.requestDigest.length > 10);
});

test("ums-memory-d6q.2.11 explicit feedback pain-signal ingestion stays first-class and replay-safe", () => {
  const created = executeOperation("misconception_update", {
    storeId: "tenant-d6q2-11",
    profile: "learner-d6q2-11",
    misconceptionKey: "pointer-arithmetic",
    signal: "harmful",
    signalId: "sig-explicit-thumbs-down-1",
    evidenceEventIds: ["evt-explicit-2", "evt-explicit-1"],
    metadata: {
      feedbackType: "thumbs-down",
      source: "human-review",
      explanation: "Learner marked the generated answer as wrong.",
    },
  });
  const replay = executeOperation("misconception_update", {
    storeId: "tenant-d6q2-11",
    profile: "learner-d6q2-11",
    misconceptionKey: "pointer-arithmetic",
    signal: "harmful",
    signalId: "sig-explicit-thumbs-down-1",
    evidenceEventIds: ["evt-explicit-1", "evt-explicit-2"],
    metadata: {
      feedbackType: "thumbs-down",
      source: "human-review",
      explanation: "Learner marked the generated answer as wrong.",
    },
  });

  assert.equal(created.action, "created");
  assert.equal(replay.action, "noop");
  assert.equal(replay.record.harmfulSignalCount, 1);
  assert.deepEqual(replay.record.sourceSignalIds, ["sig-explicit-thumbs-down-1"]);
  assert.equal(replay.record.metadata.feedbackType, "thumbs-down");
  assert.equal(replay.observability.evidenceCount, 2);
  assert.equal(replay.observability.signalCount, 1);
  assert.equal(replay.observability.slo.replaySafe, true);
});

test("ums-memory-d6q.2.12 implicit failure signal ingestion from outcomes is transparent, auditable, and replay-safe", () => {
  const outcome = executeOperation("outcome", {
    storeId: "tenant-d6q2-12",
    profile: "learner-d6q2-12",
    task: "graph regression",
    outcome: "failure",
    usedRuleIds: ["rule-graph-base-case"],
  });
  const mapped = executeOperation("misconception_update", {
    storeId: "tenant-d6q2-12",
    profile: "learner-d6q2-12",
    misconceptionKey: "graph-base-case",
    signal: "harmful",
    signalId: "sig-implicit-failure-1",
    evidenceEventIds: [outcome.outcomeId],
    metadata: {
      mappingSource: "outcome_failure",
      mappedOutcomeId: outcome.outcomeId,
      mappedAt: "2026-03-01T12:00:00.000Z",
      severity: "high",
    },
  });
  const replay = executeOperation("misconception_update", {
    storeId: "tenant-d6q2-12",
    profile: "learner-d6q2-12",
    misconceptionKey: "graph-base-case",
    signal: "harmful",
    signalId: "sig-implicit-failure-1",
    evidenceEventIds: [outcome.outcomeId],
    metadata: {
      mappingSource: "outcome_failure",
      mappedOutcomeId: outcome.outcomeId,
      mappedAt: "2026-03-01T12:00:00.000Z",
      severity: "high",
    },
  });

  assert.equal(mapped.action, "created");
  assert.equal(replay.action, "noop");
  assert.equal(replay.record.metadata.mappingSource, "outcome_failure");
  assert.equal(replay.record.metadata.mappedOutcomeId, outcome.outcomeId);
  assert.equal(replay.record.metadata.mappedAt, "2026-03-01T12:00:00.000Z");
  assert.deepEqual(replay.record.evidenceEventIds, [outcome.outcomeId]);
  assert.equal(replay.observability.evidenceCount, 1);
  assert.equal(replay.observability.slo.replaySafe, true);
});

test("ums-memory-d6q.3.11 curriculum recommendations preserve deterministic ranking with explanation fields", () => {
  const createRequest = {
    storeId: "tenant-d6q3-11",
    profile: "learner-d6q3-11",
    objectiveId: "objective-graphs",
    recommendationRank: 4,
    status: "proposed",
    evidenceEventIds: ["evt-cur-exp-1"],
    provenanceSignalIds: ["sig-cur-exp-1"],
    metadata: {
      explanation: {
        summary: "Start with graph fundamentals before optimization.",
        rationaleSteps: ["use misconception evidence", "prioritize highest-gap objective"],
      },
    },
  };
  const created = executeOperation("curriculum_plan_update", createRequest);
  const promoteRequest = {
    ...createRequest,
    planItemId: created.planItemId,
    recommendationRank: 1,
    status: "committed",
    evidenceEventIds: ["evt-cur-exp-1", "evt-cur-exp-2"],
    provenanceSignalIds: ["sig-cur-exp-1", "sig-cur-exp-2"],
    metadata: {
      explanation: {
        summary: "Graph fundamentals are now top priority from evidence-backed ranking.",
        rationaleSteps: ["collect evidence pointers", "rank by urgency and confidence"],
      },
    },
  };
  const promoted = executeOperation("curriculum_plan_update", promoteRequest);
  const replay = executeOperation("curriculum_plan_update", {
    ...promoteRequest,
    evidenceEventIds: ["evt-cur-exp-2", "evt-cur-exp-1"],
    provenanceSignalIds: ["sig-cur-exp-2", "sig-cur-exp-1"],
  });

  assert.equal(created.action, "created");
  assert.equal(promoted.action, "updated");
  assert.equal(replay.action, "noop");
  assert.equal(promoted.planItem.recommendationRank, 1);
  assert.equal(promoted.observability.boundedRecommendationRank, 1);
  assert.equal(promoted.observability.evidenceCount, 2);
  assert.equal(promoted.observability.provenanceCount, 2);
  assert.equal(promoted.planItem.metadata.explanation.summary, "Graph fundamentals are now top priority from evidence-backed ranking.");
  assert.equal(promoted.observability.slo.replaySafe, true);

  const deterministicDigest = promoted.planDigest;
  resetStore();
  const recreated = executeOperation("curriculum_plan_update", createRequest);
  const reprioritized = executeOperation("curriculum_plan_update", {
    ...promoteRequest,
    planItemId: recreated.planItemId,
  });
  assert.equal(reprioritized.planDigest, deterministicDigest);
});

test("ums-memory-d6q.4.11 review scheduler keeps interaction-clock and sleep-clock metadata deterministic", () => {
  const created = executeOperation("review_schedule_update", {
    storeId: "tenant-d6q4-11",
    profile: "learner-d6q4-11",
    targetId: "rule-clocked",
    dueAt: "2026-03-21T00:00:00.000Z",
    sourceEventIds: ["evt-clock-2", "evt-clock-1"],
    metadata: {
      interactionClock: { tick: 1, lastInteractionAt: "2026-03-20T23:00:00.000Z" },
      sleepClock: { window: "nightly", nextConsolidationAt: "2026-03-21T03:00:00.000Z" },
    },
  });
  const replay = executeOperation("review_schedule_update", {
    storeId: "tenant-d6q4-11",
    profile: "learner-d6q4-11",
    targetId: "rule-clocked",
    sourceEventIds: ["evt-clock-1", "evt-clock-2"],
    dueAt: "2026-03-21T00:00:00.000Z",
    metadata: {
      interactionClock: { tick: 1, lastInteractionAt: "2026-03-20T23:00:00.000Z" },
      sleepClock: { window: "nightly", nextConsolidationAt: "2026-03-21T03:00:00.000Z" },
    },
  });

  assert.equal(created.action, "created");
  assert.equal(replay.action, "noop");
  assert.equal(replay.scheduleEntry.metadata.interactionClock.tick, 1);
  assert.equal(replay.scheduleEntry.metadata.sleepClock.window, "nightly");
  assert.equal(replay.observability.sourceEventCount, 2);
  assert.equal(replay.observability.slo.replaySafe, true);
});

test("ums-memory-d6q.4.12 scheduler preserves bounded active-set and archival-tier payload paths on replay", () => {
  const created = executeOperation("review_schedule_update", {
    storeId: "tenant-d6q4-12",
    profile: "learner-d6q4-12",
    targetId: "rule-queue-bounds",
    dueAt: "2026-03-22T00:00:00.000Z",
    sourceEventIds: ["evt-queue-1"],
    metadata: {
      activeSet: { limit: 2, size: 1, strategy: "lru" },
      archive: { tier: "hot", tiers: ["hot", "warm", "cold"] },
    },
  });
  const updated = executeOperation("review_schedule_update", {
    storeId: "tenant-d6q4-12",
    profile: "learner-d6q4-12",
    targetId: "rule-queue-bounds",
    scheduleEntryId: created.scheduleEntryId,
    status: "completed",
    repetition: 1,
    sourceEventIds: ["evt-queue-1", "evt-queue-2"],
    dueAt: "2026-03-22T00:00:00.000Z",
    metadata: {
      activeSet: { limit: 2, size: 2, strategy: "lru" },
      archive: {
        tier: "warm",
        tiers: ["hot", "warm", "cold"],
        archivedEntryIds: [created.scheduleEntryId],
      },
    },
  });
  const replay = executeOperation("review_schedule_update", {
    storeId: "tenant-d6q4-12",
    profile: "learner-d6q4-12",
    targetId: "rule-queue-bounds",
    scheduleEntryId: created.scheduleEntryId,
    status: "completed",
    repetition: 1,
    sourceEventIds: ["evt-queue-2", "evt-queue-1"],
    dueAt: "2026-03-22T00:00:00.000Z",
    metadata: {
      activeSet: { limit: 2, size: 2, strategy: "lru" },
      archive: {
        tier: "warm",
        tiers: ["hot", "warm", "cold"],
        archivedEntryIds: [created.scheduleEntryId],
      },
    },
  });

  assert.equal(created.action, "created");
  assert.equal(updated.action, "updated");
  assert.equal(replay.action, "noop");
  assert.equal(replay.scheduleEntry.metadata.activeSet.limit, 2);
  assert.equal(replay.scheduleEntry.metadata.archive.tier, "warm");
  assert.deepEqual(replay.scheduleEntry.metadata.archive.tiers, ["hot", "warm", "cold"]);
  assert.equal(replay.observability.sourceEventCount, 2);
  assert.equal(replay.observability.slo.replaySafe, true);
});

test("ums-memory-d6q.5.11 policy decisions quarantine prompt-injection paths deterministically", () => {
  const created = executeOperation("policy_decision_update", {
    storeId: "tenant-d6q5-11",
    profile: "learner-d6q5-11",
    policyKey: "prompt-injection-protection",
    outcome: "deny",
    reasonCodes: ["prompt-injection-detected"],
    provenanceEventIds: ["evt-pol-sec-1"],
    metadata: {
      security: {
        promptInjectionDetected: true,
        quarantined: true,
        pattern: "ignore previous instructions",
      },
    },
  });
  const replay = executeOperation("policy_decision_update", {
    storeId: "tenant-d6q5-11",
    profile: "learner-d6q5-11",
    policyKey: "prompt-injection-protection",
    outcome: "deny",
    reasonCodes: ["prompt-injection-detected"],
    provenanceEventIds: ["evt-pol-sec-1"],
    metadata: {
      security: {
        promptInjectionDetected: true,
        quarantined: true,
        pattern: "ignore previous instructions",
      },
    },
  });

  assert.equal(created.action, "created");
  assert.equal(replay.action, "noop");
  assert.equal(replay.observability.denied, true);
  assert.equal(replay.decision.metadata.security.quarantined, true);
  assert.equal(replay.observability.slo.replaySafe, true);
});

test("ums-memory-d6q.5.12 cross-space allowlist payload remains deterministic and tenant-isolated", () => {
  const denied = executeOperation("policy_decision_update", {
    storeId: "tenant-d6q5-12-a",
    profile: "learner-d6q5-12",
    policyKey: "cross-space-recall",
    outcome: "deny",
    reasonCodes: ["allowlist-denied"],
    provenanceEventIds: ["evt-pol-allow-1"],
    metadata: {
      allowlist: {
        requestedSpace: "tenant-d6q5-12-b",
        allowedSpaces: ["tenant-d6q5-12-a"],
        authorized: false,
      },
    },
  });
  const replay = executeOperation("policy_decision_update", {
    storeId: "tenant-d6q5-12-a",
    profile: "learner-d6q5-12",
    policyKey: "cross-space-recall",
    outcome: "deny",
    reasonCodes: ["allowlist-denied"],
    provenanceEventIds: ["evt-pol-allow-1"],
    metadata: {
      allowlist: {
        requestedSpace: "tenant-d6q5-12-b",
        allowedSpaces: ["tenant-d6q5-12-a"],
        authorized: false,
      },
    },
  });
  executeOperation("policy_decision_update", {
    storeId: "tenant-d6q5-12-b",
    profile: "learner-d6q5-12",
    policyKey: "cross-space-recall",
    outcome: "review",
    reasonCodes: ["allowlist-review"],
    provenanceEventIds: ["evt-pol-allow-b-1"],
    metadata: {
      allowlist: {
        requestedSpace: "tenant-d6q5-12-a",
        allowedSpaces: ["tenant-d6q5-12-b"],
        authorized: false,
      },
    },
  });

  assert.equal(denied.action, "created");
  assert.equal(replay.action, "noop");
  assert.equal(replay.decision.metadata.allowlist.authorized, false);
  assert.equal(replay.observability.denied, true);
  assert.equal(snapshotProfile("learner-d6q5-12", "tenant-d6q5-12-a").policyDecisions.length, 1);
  assert.equal(snapshotProfile("learner-d6q5-12", "tenant-d6q5-12-b").policyDecisions.length, 1);
});

test("ums-memory-d6q.5.13 degraded-mode tutoring payload exposes capability flags and replay-safe semantics", () => {
  const review = executeOperation("policy_decision_update", {
    storeId: "tenant-d6q5-13",
    profile: "learner-d6q5-13",
    policyKey: "degraded-personalization",
    outcome: "review",
    reasonCodes: ["degraded-mode-active"],
    provenanceEventIds: ["evt-pol-degraded-1"],
    metadata: {
      degraded: {
        enabled: true,
        reason: "llm_and_index_unavailable",
        capabilities: {
          llm: false,
          index: false,
          memoryOnly: true,
        },
      },
    },
  });
  const replay = executeOperation("policy_decision_update", {
    storeId: "tenant-d6q5-13",
    profile: "learner-d6q5-13",
    policyKey: "degraded-personalization",
    outcome: "review",
    reasonCodes: ["degraded-mode-active"],
    provenanceEventIds: ["evt-pol-degraded-1"],
    metadata: {
      degraded: {
        enabled: true,
        reason: "llm_and_index_unavailable",
        capabilities: {
          llm: false,
          index: false,
          memoryOnly: true,
        },
      },
    },
  });

  assert.equal(review.action, "created");
  assert.equal(replay.action, "noop");
  assert.equal(replay.observability.denied, false);
  assert.equal(replay.decision.metadata.degraded.enabled, true);
  assert.equal(replay.decision.metadata.degraded.capabilities.memoryOnly, true);
  assert.equal(replay.observability.slo.replaySafe, true);
});

test("ums-memory-d6q.5.14 policy audit/export path preserves traceability checklist payloads", () => {
  const decision = executeOperation("policy_decision_update", {
    storeId: "tenant-d6q5-14",
    profile: "learner-d6q5-14",
    policyKey: "policy-audit-export",
    outcome: "review",
    reasonCodes: ["manual-audit-required"],
    provenanceEventIds: ["evt-pol-audit-1"],
    metadata: {
      audit: {
        decisionTraceId: "trace-audit-001",
        checklist: ["capture-snapshot", "notify-incident-commander", "prepare-rollback"],
      },
    },
  });
  const audit = executeOperation("audit", {
    storeId: "tenant-d6q5-14",
    profile: "learner-d6q5-14",
  });
  const exported = executeOperation("export", {
    storeId: "tenant-d6q5-14",
    profile: "learner-d6q5-14",
    format: "playbook",
  });

  assert.equal(decision.action, "created");
  assert.equal(audit.operation, "audit");
  assert.equal(audit.deterministic, true);
  assert.ok(audit.checks.some((check) => check.name === "duplicate_rules"));
  assert.equal(exported.format, "playbook");
  assert.equal(exported.playbook.storeId, "tenant-d6q5-14");
  assert.equal(snapshotProfile("learner-d6q5-14", "tenant-d6q5-14").policyDecisions[0].metadata.audit.decisionTraceId, "trace-audit-001");
});

test("ums-memory-d6q.2.13 harmful accumulation inverts unstable guidance with accelerated deterministic decay", () => {
  const base = {
    storeId: "tenant-d6q2-13",
    profile: "learner-d6q2-13",
    misconceptionKey: "unsafe-loop-rewrite",
    signal: "harmful",
  };
  const first = executeOperation("misconception_update", {
    ...base,
    signalId: "sig-h1",
    evidenceEventIds: ["evt-h1"],
  });
  const second = executeOperation("misconception_update", {
    ...base,
    signalId: "sig-h2",
    evidenceEventIds: ["evt-h2"],
  });
  const third = executeOperation("misconception_update", {
    ...base,
    signalId: "sig-h3",
    evidenceEventIds: ["evt-h3"],
  });
  const replay = executeOperation("misconception_update", {
    ...base,
    signalId: "sig-h3",
    evidenceEventIds: ["evt-h3"],
  });

  const stageThreeAntiPattern = third.record.antiPatterns.find((entry) => entry.threshold === 3);
  assert.equal(first.action, "created");
  assert.equal(second.action, "updated");
  assert.equal(third.action, "updated");
  assert.equal(third.record.harmfulSignalCount, 3);
  assert.equal(third.record.confidenceDecay.stage, 3);
  assert.equal(third.record.confidenceDecay.accelerated, true);
  assert.equal(third.record.confidenceDecay.appliedDelta, -0.32);
  assert.equal(third.record.confidence, 0.05);
  assert.ok(stageThreeAntiPattern);
  assert.deepEqual(stageThreeAntiPattern.evidenceEventIds, ["evt-h1", "evt-h2", "evt-h3"]);
  assert.equal(third.observability.antiPatternCount >= 2, true);
  assert.equal(third.observability.antiPatternEvidenceCount, 3);
  assert.equal(replay.action, "noop");
});

test("ums-memory-d6q.2.14 context recall exposes bounded deterministic misconception chronology notes", () => {
  const base = {
    storeId: "tenant-d6q2-14",
    profile: "learner-d6q2-14",
    misconceptionKey: "unsafe-pointer-cast",
  };
  executeOperation("misconception_update", {
    ...base,
    signal: "harmful",
    signalId: "sig-chron-1",
    evidenceEventIds: ["evt-chron-1"],
    updatedAt: "2026-03-01T00:00:00.000Z",
  });
  executeOperation("misconception_update", {
    ...base,
    signal: "correction",
    signalId: "sig-chron-2",
    evidenceEventIds: ["evt-chron-2"],
    updatedAt: "2026-03-02T00:00:00.000Z",
  });
  executeOperation("misconception_update", {
    ...base,
    signal: "harmful",
    signalId: "sig-chron-3",
    evidenceEventIds: ["evt-chron-3"],
    updatedAt: "2026-03-03T00:00:00.000Z",
  });

  const bounded = executeOperation("context", {
    storeId: "tenant-d6q2-14",
    profile: "learner-d6q2-14",
    query: "unsafe-pointer",
    misconceptionChronologyLimit: 1,
  });
  const full = executeOperation("context", {
    storeId: "tenant-d6q2-14",
    profile: "learner-d6q2-14",
    query: "unsafe-pointer",
    misconceptionChronologyLimit: 5,
  });
  const replay = executeOperation("context", {
    storeId: "tenant-d6q2-14",
    profile: "learner-d6q2-14",
    query: "unsafe-pointer",
    misconceptionChronologyLimit: 5,
  });

  assert.equal(bounded.misconceptionChronology.limit, 1);
  assert.equal(bounded.misconceptionChronology.notes.length, 1);
  assert.equal(bounded.misconceptionChronology.bounded, true);
  assert.equal(Array.isArray(bounded.misconceptionChronology.formatting), true);
  assert.equal(full.misconceptionChronology.notes.length >= 2, true);
  assert.equal(full.misconceptionChronology.notes.every((note) => note.misconceptionKey === "unsafe-pointer-cast"), true);
  for (let index = 1; index < full.misconceptionChronology.notes.length; index += 1) {
    assert.equal(
      full.misconceptionChronology.notes[index - 1].timestamp <= full.misconceptionChronology.notes[index].timestamp,
      true,
    );
  }
  assert.deepEqual(replay.misconceptionChronology, full.misconceptionChronology);
});

test("ums-memory-d6q.3.12 curriculum recommendations include deterministic freshness and decay warnings with configurable thresholds", () => {
  executeOperation("curriculum_plan_update", {
    storeId: "tenant-d6q3-12",
    profile: "learner-d6q3-12",
    objectiveId: "objective-stale-sorting",
    recommendationRank: 2,
    evidenceEventIds: ["evt-cur-1"],
    provenanceSignalIds: ["sig-cur-1"],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-05T00:00:00.000Z",
    dueAt: "2026-01-06T00:00:00.000Z",
  });

  const result = executeOperation("curriculum_recommendation", {
    storeId: "tenant-d6q3-12",
    profile: "learner-d6q3-12",
    referenceAt: "2026-03-01T00:00:00.000Z",
    freshnessWarningDays: 14,
    decayWarningDays: 30,
    maxRecommendations: 3,
  });
  const replay = executeOperation("curriculum_recommendation", {
    storeId: "tenant-d6q3-12",
    profile: "learner-d6q3-12",
    referenceAt: "2026-03-01T00:00:00.000Z",
    freshnessWarningDays: 14,
    decayWarningDays: 30,
    maxRecommendations: 3,
  });

  assert.equal(result.recommendationCount, 1);
  assert.equal(result.recommendations[0].freshness.stale, true);
  assert.equal(result.recommendations[0].freshness.decayed, true);
  assert.deepEqual(result.recommendations[0].freshness.warningCodes, ["decay_warning", "freshness_warning"]);
  assert.equal(result.recommendations[0].freshness.freshnessWarningDays, 14);
  assert.equal(result.recommendations[0].freshness.decayWarningDays, 30);
  assert.deepEqual(replay.recommendations[0].freshness, result.recommendations[0].freshness);
});

test("ums-memory-d6q.3.13 curriculum recommendations expose conflict chronology notes in deterministic order and profile scope", () => {
  const created = executeOperation("curriculum_plan_update", {
    storeId: "tenant-d6q3-13",
    profile: "learner-d6q3-13",
    objectiveId: "objective-conflict-path",
    recommendationRank: 4,
    evidenceEventIds: ["evt-conflict-1"],
    provenanceSignalIds: ["sig-conflict-1"],
    updatedAt: "2026-03-01T00:00:00.000Z",
  });
  executeOperation("curriculum_plan_update", {
    storeId: "tenant-d6q3-13",
    profile: "learner-d6q3-13",
    planItemId: created.planItemId,
    objectiveId: "objective-conflict-path",
    status: "committed",
    recommendationRank: 2,
    evidenceEventIds: ["evt-conflict-2"],
    provenanceSignalIds: ["sig-conflict-2"],
    updatedAt: "2026-03-02T00:00:00.000Z",
  });
  executeOperation("curriculum_plan_update", {
    storeId: "tenant-d6q3-13",
    profile: "learner-d6q3-13",
    planItemId: created.planItemId,
    objectiveId: "objective-conflict-path",
    status: "blocked",
    recommendationRank: 1,
    evidenceEventIds: ["evt-conflict-3"],
    provenanceSignalIds: ["sig-conflict-3"],
    updatedAt: "2026-03-03T00:00:00.000Z",
  });
  executeOperation("curriculum_plan_update", {
    storeId: "tenant-d6q3-13",
    profile: "foreign-profile",
    objectiveId: "objective-foreign-scope",
    recommendationRank: 1,
    evidenceEventIds: ["evt-foreign-1"],
    provenanceSignalIds: ["sig-foreign-1"],
    updatedAt: "2026-03-02T00:00:00.000Z",
  });

  const recommendation = executeOperation("curriculum_recommendation", {
    storeId: "tenant-d6q3-13",
    profile: "learner-d6q3-13",
    includeBlocked: true,
    maxConflictNotes: 10,
    referenceAt: "2026-03-04T00:00:00.000Z",
  });
  const notes = recommendation.conflictChronology.notes;

  assert.equal(notes.length >= 2, true);
  assert.equal(notes.every((note) => note.profileId === created.planItem.profileId), true);
  assert.equal(notes.some((note) => note.objectiveId === "objective-foreign-scope"), false);
  for (let index = 1; index < notes.length; index += 1) {
    assert.equal(notes[index - 1].timestamp <= notes[index].timestamp, true);
  }
});

test("ums-memory-d6q.3.14 curriculum ranking blends interest and mastery weights while respecting token budgets", () => {
  executeOperation("learner_profile_update", {
    storeId: "tenant-d6q3-14",
    profile: "learner-d6q3-14",
    learnerId: "learner-314",
    interestTags: ["graphs"],
    evidenceEventIds: ["evt-profile-1"],
  });
  const misconception = executeOperation("misconception_update", {
    storeId: "tenant-d6q3-14",
    profile: "learner-d6q3-14",
    misconceptionKey: "dp-boundary",
    signal: "harmful",
    signalId: "sig-mastery-1",
    evidenceEventIds: ["evt-mastery-1"],
  });
  executeOperation("curriculum_plan_update", {
    storeId: "tenant-d6q3-14",
    profile: "learner-d6q3-14",
    objectiveId: "objective-interest-graphs",
    recommendationRank: 3,
    evidenceEventIds: ["evt-cur-i-1"],
    interestTags: ["graphs"],
    provenanceSignalIds: ["sig-cur-i-1"],
  });
  executeOperation("curriculum_plan_update", {
    storeId: "tenant-d6q3-14",
    profile: "learner-d6q3-14",
    objectiveId: "objective-mastery-gap",
    recommendationRank: 3,
    evidenceEventIds: ["evt-cur-m-1"],
    sourceMisconceptionIds: [misconception.misconceptionId],
    provenanceSignalIds: ["sig-cur-m-1"],
  });

  const interestHeavy = executeOperation("curriculum_recommendation", {
    storeId: "tenant-d6q3-14",
    profile: "learner-d6q3-14",
    maxRecommendations: 2,
    tokenBudget: 400,
    rankingWeights: {
      interest: 0.9,
      masteryGap: 0.05,
      due: 0.03,
      evidence: 0.02,
    },
  });
  const masteryHeavy = executeOperation("curriculum_recommendation", {
    storeId: "tenant-d6q3-14",
    profile: "learner-d6q3-14",
    maxRecommendations: 2,
    tokenBudget: 400,
    rankingWeights: {
      interest: 0.05,
      masteryGap: 0.9,
      due: 0.03,
      evidence: 0.02,
    },
  });
  const budgetBounded = executeOperation("curriculum_recommendation", {
    storeId: "tenant-d6q3-14",
    profile: "learner-d6q3-14",
    maxRecommendations: 2,
    tokenBudget: 30,
    rankingWeights: {
      interest: 0.5,
      masteryGap: 0.4,
      due: 0.05,
      evidence: 0.05,
    },
  });

  assert.equal(interestHeavy.recommendations[0].objectiveId, "objective-interest-graphs");
  assert.equal(masteryHeavy.recommendations[0].objectiveId, "objective-mastery-gap");
  assert.equal(budgetBounded.recommendationCount <= 2, true);
  assert.equal(budgetBounded.observability.tokensConsumed <= 30, true);
  assert.equal(budgetBounded.observability.boundedByTokenBudget, true);
});

test("ums-memory-d6q.4.13 scheduler consolidates deterministically when novelty-write threshold is crossed", () => {
  const tick = executeOperation("review_schedule_clock", {
    storeId: "tenant-d6q4-13",
    profile: "learner-d6q4-13",
    mode: "auto",
    noveltyWriteLoad: 5,
    noveltyWriteThreshold: 3,
    fatigueThreshold: 100,
    timestamp: "2026-03-20T00:00:00.000Z",
  });

  assert.equal(tick.consolidationTriggered, true);
  assert.equal(tick.consolidationCause, "novelty_write_threshold");
  assert.equal(tick.clocks.noveltyWriteLoad, 0);
  assert.equal(tick.clocks.lastConsolidationCause, "novelty_write_threshold");
  assert.equal(tick.observability.consolidationCause, "novelty_write_threshold");
  assert.equal(tick.observability.fatigueThreshold, 100);
  assert.equal(tick.observability.noveltyWriteThreshold, 3);
});

test("ums-memory-hpl.8 review_schedule_clock applies deterministic candidate confidence decay and is replay-safe for identical ticks", () => {
  const storeId = "tenant-hpl8-decay";
  const profile = "hpl8-decay";
  const shadow = executeOperation("shadow_write", {
    storeId,
    profile,
    statement: "Temporal decay should be deterministic across scheduler ticks.",
    confidence: 0.8,
    sourceEventIds: ["evt-hpl8-decay-1"],
    evidenceEventIds: ["evt-hpl8-decay-1"],
    createdAt: "2026-03-01T00:00:00.000Z",
    expiresAt: "2026-04-01T00:00:00.000Z",
  });
  const candidateId = shadow.applied[0].candidateId;
  const request = {
    storeId,
    profile,
    mode: "interaction",
    interactionIncrement: 0,
    fatigueThreshold: 100,
    noveltyWriteThreshold: 100,
    timestamp: "2026-03-11T00:00:00.000Z",
  };

  const first = executeOperation("review_schedule_clock", request);
  const firstSnapshot = snapshotProfile(profile, storeId);
  const firstCandidate = firstSnapshot.shadowCandidates.find((entry) => entry.candidateId === candidateId);
  const second = executeOperation("review_schedule_clock", request);
  const secondSnapshot = snapshotProfile(profile, storeId);
  const secondCandidate = secondSnapshot.shadowCandidates.find((entry) => entry.candidateId === candidateId);
  const expectedConfidence = Math.round(Math.max(0.05, 0.8 * 0.99 ** 10) * 1_000_000) / 1_000_000;

  assert.ok(firstCandidate);
  assert.equal(first.candidateMaintenance.decayAppliedCount, 1);
  assert.equal(first.candidateMaintenance.decayCursorAdvancedCount, 1);
  assert.deepEqual(first.candidateMaintenance.decayedCandidateIds, [candidateId]);
  assert.equal(first.candidateMaintenance.demotedCount, 0);
  assert.equal(first.observability.candidateMaintenance.decayAppliedCount, 1);
  assert.equal(firstCandidate.confidence, expectedConfidence);
  assert.equal(firstCandidate.lastTemporalDecayAt, "2026-03-11T00:00:00.000Z");
  assert.equal(firstCandidate.temporalDecayTickCount, 1);
  assert.equal(firstCandidate.temporalDecayDaysAccumulated, 10);

  assert.equal(second.action, "noop");
  assert.ok(secondCandidate);
  assert.equal(second.candidateMaintenance.decayAppliedCount, 0);
  assert.equal(second.candidateMaintenance.decayCursorAdvancedCount, 0);
  assert.deepEqual(second.candidateMaintenance.decayedCandidateIds, []);
  assert.equal(secondCandidate.confidence, expectedConfidence);
  assert.equal(secondCandidate.temporalDecayTickCount, 1);
  assert.equal(secondCandidate.temporalDecayDaysAccumulated, 10);
});

test("ums-memory-hpl.8 review_schedule_clock demotes expired candidates with explicit reason code without deleting candidate data", () => {
  const storeId = "tenant-hpl8-expiry";
  const profile = "hpl8-expiry";
  const shadow = executeOperation("shadow_write", {
    storeId,
    profile,
    statement: "Expired candidates should be demoted and retained for auditability.",
    confidence: 0.7,
    sourceEventIds: ["evt-hpl8-expiry-1"],
    evidenceEventIds: ["evt-hpl8-expiry-1"],
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-10T00:00:00.000Z",
  });
  const candidateId = shadow.applied[0].candidateId;
  const request = {
    storeId,
    profile,
    mode: "interaction",
    interactionIncrement: 0,
    fatigueThreshold: 100,
    noveltyWriteThreshold: 100,
    timestamp: "2026-02-01T00:00:00.000Z",
  };

  const first = executeOperation("review_schedule_clock", request);
  const second = executeOperation("review_schedule_clock", request);
  const snapshot = snapshotProfile(profile, storeId);
  const candidate = snapshot.shadowCandidates.find((entry) => entry.candidateId === candidateId);

  assert.equal(first.candidateMaintenance.expiredCount, 1);
  assert.equal(first.candidateMaintenance.demotedCount, 1);
  assert.deepEqual(first.candidateMaintenance.reasonCodes, ["candidate_expired"]);
  assert.deepEqual(first.candidateMaintenance.demotedCandidateIds, [candidateId]);
  assert.equal(first.observability.candidateMaintenance.demotedCount, 1);

  assert.ok(candidate);
  assert.equal(snapshot.shadowCandidates.length, 1);
  assert.equal(candidate.status, "demoted");
  assert.equal(candidate.demotedAt, "2026-02-01T00:00:00.000Z");
  assert.deepEqual(candidate.latestDemotionReasonCodes, ["candidate_expired"]);

  assert.equal(second.action, "noop");
  assert.equal(second.candidateMaintenance.demotedCount, 0);
  assert.deepEqual(second.candidateMaintenance.demotedCandidateIds, []);
});

test("ums-memory-hpl.8 review_schedule_clock does not expire promoted candidates or remove promoted rules", () => {
  const storeId = "tenant-hpl8-promoted-preserved";
  const profile = "hpl8-promoted-preserved";
  const shadow = executeOperation("shadow_write", {
    storeId,
    profile,
    statement: "Promoted rules should not be auto-demoted by shadow expiry maintenance.",
    confidence: 0.72,
    sourceEventIds: ["evt-hpl8-promoted-1"],
    evidenceEventIds: ["evt-hpl8-promoted-1"],
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-10T00:00:00.000Z",
  });
  const candidateId = shadow.applied[0].candidateId;
  executeOperation("replay_eval", {
    storeId,
    profile,
    candidateId,
    successRateDelta: 0.8,
    evaluatedAt: "2026-01-02T00:00:00.000Z",
  });
  const promoted = executeOperation("promote", {
    storeId,
    profile,
    candidateId,
    promotedAt: "2026-01-03T00:00:00.000Z",
  });
  const ruleId = promoted.rule.ruleId;

  const tick = executeOperation("review_schedule_clock", {
    storeId,
    profile,
    mode: "interaction",
    interactionIncrement: 0,
    fatigueThreshold: 100,
    noveltyWriteThreshold: 100,
    timestamp: "2026-02-01T00:00:00.000Z",
  });
  const snapshot = snapshotProfile(profile, storeId);
  const candidate = snapshot.shadowCandidates.find((entry) => entry.candidateId === candidateId);
  const rule = snapshot.rules.find((entry) => entry.ruleId === ruleId);

  assert.equal(tick.candidateMaintenance.demotedCount, 0);
  assert.equal(tick.candidateMaintenance.decayAppliedCount, 0);
  assert.equal(tick.candidateMaintenance.expiredCount, 1);
  assert.ok(candidate);
  assert.equal(candidate.status, "promoted");
  assert.equal(candidate.demotedAt, null);
  assert.ok(rule);
});

test("ums-memory-d6q.4.13 scheduler triggers consolidation when configurable fatigue threshold is exceeded", () => {
  const first = executeOperation("review_schedule_clock", {
    storeId: "tenant-d6q4-13-fatigue",
    profile: "learner-d6q4-13-fatigue",
    mode: "interaction",
    interactionIncrement: 1,
    fatigueThreshold: 3,
    timestamp: "2026-03-20T00:00:00.000Z",
  });
  const second = executeOperation("review_schedule_clock", {
    storeId: "tenant-d6q4-13-fatigue",
    profile: "learner-d6q4-13-fatigue",
    mode: "interaction",
    interactionIncrement: 1,
    fatigueThreshold: 3,
    timestamp: "2026-03-20T00:01:00.000Z",
  });
  const third = executeOperation("review_schedule_clock", {
    storeId: "tenant-d6q4-13-fatigue",
    profile: "learner-d6q4-13-fatigue",
    mode: "interaction",
    interactionIncrement: 1,
    fatigueThreshold: 3,
    timestamp: "2026-03-20T00:02:00.000Z",
  });

  assert.equal(first.consolidationTriggered, false);
  assert.equal(second.consolidationTriggered, false);
  assert.equal(third.consolidationTriggered, true);
  assert.equal(third.consolidationCause, "fatigue_threshold");
  assert.equal(third.observability.fatigueThreshold, 3);
  assert.equal(third.clocks.lastConsolidationCause, "fatigue_threshold");
});
