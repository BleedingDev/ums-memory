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
    "learner_profile_update",
    "identity_graph_update",
    "misconception_update",
    "curriculum_plan_update",
    "review_schedule_update",
    "policy_decision_update",
    "pain_signal_ingest",
    "failure_signal_ingest",
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
