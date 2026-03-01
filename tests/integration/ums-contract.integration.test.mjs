import assert from "node:assert/strict";
import test from "node:test";

import {
  executeOperation,
  exportStoreSnapshot,
  importStoreSnapshot,
  resetStore,
  snapshotProfile,
} from "../../apps/api/src/core.mjs";
import { createEngine } from "../support/engine-adapter.mjs";
import { buildSyntheticEvents } from "../support/fixtures.mjs";

test("ums-memory-d6q.1.4: integration contract stays JSON-first, replay-safe, and tenant-isolated", async () => {
  const tenantAEvents = buildSyntheticEvents({
    count: 120,
    space: "tenant-a",
    includeSecrets: true,
    includeUnsafe: true,
  });
  const tenantBEvents = buildSyntheticEvents({
    count: 120,
    space: "tenant-b",
    includeSecrets: false,
    includeUnsafe: false,
  });

  const engine = await createEngine({ seed: "integration-seed" });
  const ingestResult = await engine.ingest([...tenantAEvents, ...tenantBEvents]);
  assert.deepEqual(Object.keys(ingestResult).sort(), ["accepted", "duplicates", "rejected", "stats"]);
  assert.equal(ingestResult.accepted, tenantAEvents.length + tenantBEvents.length);
  assert.equal(ingestResult.duplicates, 0);
  assert.equal(ingestResult.stats.totalEvents, tenantAEvents.length + tenantBEvents.length);

  const recallA = await engine.recall({
    space: "tenant-a",
    query: "tenant boundary policy",
    maxItems: 10,
    tokenBudget: 140,
  });
  const recallB = await engine.recall({
    space: "tenant-b",
    query: "tenant boundary policy",
    maxItems: 10,
    tokenBudget: 140,
  });

  assert.ok(recallA.items.every((item) => item.space === "tenant-a"));
  assert.ok(recallB.items.every((item) => item.space === "tenant-b"));
  assert.ok(recallA.items.every((item) => item.evidence?.episodeId === item.id));
  assert.ok(recallB.items.every((item) => item.evidence?.episodeId === item.id));
  assert.equal(recallA.storeId, "default");
  assert.equal(recallB.storeId, "default");
  assert.deepEqual(Object.keys(recallA.guardrails).sort(), [
    "filteredUnsafe",
    "redactedSecrets",
    "spaceIsolationEnforced",
    "storeIsolationEnforced",
  ]);
  assert.ok(recallA.payloadBytes <= 4096);
  assert.ok(recallB.payloadBytes <= 4096);

  const digestBeforeReplay = engine.stateDigest();
  const replay = await engine.ingest(tenantAEvents);
  assert.equal(replay.accepted, 0);
  assert.equal(replay.duplicates, tenantAEvents.length);
  assert.equal(engine.stateDigest(), digestBeforeReplay);

  const snapshot = engine.exportState();
  const restoredEngine = await createEngine({
    seed: "integration-seed",
    initialState: snapshot,
  });
  assert.equal(restoredEngine.stateDigest(), engine.stateDigest());

  const restoredRecall = await restoredEngine.recall({
    space: "tenant-a",
    query: "tenant boundary policy",
    maxItems: 10,
    tokenBudget: 140,
  });
  assert.deepEqual(restoredRecall.items, recallA.items);
});

test("ums-memory-d6q.1.13/ums-memory-d6q.1.9: codex+claude normalization paths stay replay-safe with guardrail and SLO fields", async () => {
  const engine = await createEngine({ seed: "integration-agent-normalization-seed" });
  const payload = [
    {
      storeId: "agent-transfer",
      space: "handoff",
      platform: "codex-cli",
      conversations: [
        {
          id: "codex-session-1",
          messages: [
            {
              id: "codex-user-1",
              role: "user",
              createdAt: "2026-02-28T09:00:00.000Z",
              content: { text: "Track conflict resolution history for learner profiles" },
            },
            {
              id: "codex-assistant-1",
              role: "assistant",
              createdAt: "2026-02-28T09:01:00.000Z",
              message: "Current view should stay deterministic with replay-safe digests.",
            },
          ],
        },
      ],
    },
    {
      storeId: "agent-transfer",
      space: "handoff",
      platform: "claude-code",
      conversations: [
        {
          id: "claude-session-1",
          messages: [
            {
              id: "claude-user-1",
              role: "user",
              createdAt: "2026-02-28T10:00:00.000Z",
              text: "Normalize evidence pointers across codex and claude handoffs.",
            },
            {
              id: "claude-assistant-1",
              role: "assistant",
              createdAt: "2026-02-28T10:01:00.000Z",
              body: "Policy exception path requires provenance and explicit reason codes.",
            },
          ],
        },
      ],
    },
  ];

  const first = await engine.ingest(payload);
  assert.equal(first.accepted, 4);
  assert.equal(first.duplicates, 0);

  const replay = await engine.ingest(payload);
  assert.equal(replay.accepted, 0);
  assert.equal(replay.duplicates, 4);

  const recall = await engine.recall({
    storeId: "agent-transfer",
    space: "handoff",
    query: "deterministic replay-safe policy exception provenance",
    maxItems: 10,
    tokenBudget: 320,
  });

  assert.ok(recall.items.length > 0);
  assert.ok(recall.items.every((item) => item.evidence?.episodeId === item.id));
  assert.ok(recall.estimatedTokens <= recall.tokenBudget);
  assert.ok(recall.payloadBytes > 0);
  assert.equal(typeof recall.truncated, "boolean");
  assert.deepEqual(Object.keys(recall.guardrails).sort(), [
    "filteredUnsafe",
    "redactedSecrets",
    "spaceIsolationEnforced",
    "storeIsolationEnforced",
  ]);

  const snapshot = engine.exportState();
  const transferStore = snapshot.stores.find((entry) => entry.storeId === "agent-transfer");
  assert.ok(transferStore);
  assert.equal(transferStore.totals.eventCount, 4);
  const handoffSpace = transferStore.spaces.find((entry) => entry.space === "handoff");
  assert.ok(handoffSpace);
  assert.ok(handoffSpace.events.some((event) => event.metadata?.platform === "codex-cli"));
  assert.ok(handoffSpace.events.some((event) => event.metadata?.platform === "claude-code"));
});

test("ums-memory-d6q.1.8: integration replay for learner profile + identity graph stays deterministic across snapshot restore", () => {
  resetStore();
  const profileRequest = {
    storeId: "tenant-lane-a",
    profile: "learner-lane",
    learnerId: "learner-901",
    identityRefs: [{ namespace: "email", value: "lane@example.com", isPrimary: true }],
    evidenceEventIds: ["evt-profile-1"],
    codex: {
      learning_goals: ["graph"],
      interests: ["algorithms"],
      misconceptions: ["off-by-one"],
      confidence: 0.6,
      evidenceEventIds: ["evt-profile-codex"],
      timestamp: "2026-03-01T09:00:00.000Z",
    },
    claude: {
      goals: ["dp"],
      interestTags: ["algorithms"],
      misconceptionIds: ["off-by-one"],
      confidenceScore: 0.7,
      evidenceEventIds: ["evt-profile-claude"],
      timestamp: "2026-03-01T09:01:00.000Z",
    },
  };

  const profileCreated = executeOperation("learner_profile_update", profileRequest);
  const profileReplay = executeOperation("learner_profile_update", {
    ...profileRequest,
    evidenceEventIds: ["evt-profile-1"],
    codex: {
      ...profileRequest.codex,
      learning_goals: ["graph"],
    },
  });

  assert.equal(profileCreated.action, "created");
  assert.equal(profileReplay.action, "noop");
  assert.equal(profileCreated.profileId, profileReplay.profileId);
  assert.equal(profileCreated.profileDigest, profileReplay.profileDigest);
  assert.equal(profileCreated.observability.sourceSignalCount, 2);
  assert.equal(profileCreated.observability.slo.targetP95Ms, 45);
  assert.equal(profileCreated.observability.slo.replaySafe, true);

  const edgeRequest = {
    storeId: "tenant-lane-a",
    profile: "learner-lane",
    profileId: profileCreated.profileId,
    relation: "misconception_of",
    fromRef: { namespace: "misconception", value: "off-by-one" },
    toRef: { namespace: "learner", value: "learner-901" },
    evidenceEventIds: ["evt-edge-1"],
  };

  const edgeCreated = executeOperation("identity_graph_update", edgeRequest);
  const edgeReplay = executeOperation("identity_graph_update", {
    ...edgeRequest,
    evidenceEventIds: ["evt-edge-1"],
  });

  assert.equal(edgeCreated.action, "created");
  assert.equal(edgeReplay.action, "noop");
  assert.equal(edgeCreated.edgeId, edgeReplay.edgeId);
  assert.equal(edgeCreated.edgeDigest, edgeReplay.edgeDigest);
  assert.equal(edgeCreated.observability.sourceSignalCount, 0);
  assert.equal(edgeCreated.observability.slo.targetP95Ms, 40);
  assert.equal(edgeCreated.observability.slo.replaySafe, true);

  const beforeSnapshot = snapshotProfile("learner-lane", "tenant-lane-a");
  assert.equal(beforeSnapshot.learnerProfiles.length, 1);
  assert.equal(beforeSnapshot.identityGraphEdges.length, 1);

  const exported = exportStoreSnapshot();
  resetStore();
  importStoreSnapshot(exported);

  const afterImport = snapshotProfile("learner-lane", "tenant-lane-a");
  assert.deepEqual(afterImport.learnerProfiles, beforeSnapshot.learnerProfiles);
  assert.deepEqual(afterImport.identityGraphEdges, beforeSnapshot.identityGraphEdges);

  const profileReplayAfterImport = executeOperation("learner_profile_update", profileRequest);
  const edgeReplayAfterImport = executeOperation("identity_graph_update", edgeRequest);
  assert.equal(profileReplayAfterImport.action, "noop");
  assert.equal(profileReplayAfterImport.profileDigest, profileCreated.profileDigest);
  assert.equal(edgeReplayAfterImport.action, "noop");
  assert.equal(edgeReplayAfterImport.edgeDigest, edgeCreated.edgeDigest);

  executeOperation("learner_profile_update", {
    ...profileRequest,
    storeId: "tenant-lane-b",
  });
  assert.equal(snapshotProfile("learner-lane", "tenant-lane-a").learnerProfiles.length, 1);
  assert.equal(snapshotProfile("learner-lane", "tenant-lane-b").learnerProfiles.length, 1);
});

test("ums-memory-d6q.2.8: integration/replay misconception lane is idempotent, isolated, and observability-rich", () => {
  resetStore();
  const baseRequest = {
    storeId: "tenant-mis-lane-a",
    profile: "learner-mis-lane",
    misconceptionKey: "off-by-one",
    signal: "harmful",
    signalId: "sig-explicit-downvote",
    evidenceEventIds: ["evt-mis-2", "evt-mis-1"],
    metadata: {
      source: "explicit-feedback",
      explanation: "Learner reported the answer as wrong.",
    },
  };
  const resolvedRequest = {
    ...baseRequest,
    signal: "correction",
    signalId: "sig-correction-followup",
    evidenceEventIds: ["evt-mis-3"],
    metadata: {
      source: "followup-fix",
      explanation: "Correction event from retry success.",
    },
  };

  const created = executeOperation("misconception_update", baseRequest);
  const replay = executeOperation("misconception_update", {
    ...baseRequest,
    evidenceEventIds: ["evt-mis-1", "evt-mis-2"],
  });
  const resolved = executeOperation("misconception_update", resolvedRequest);

  assert.equal(created.action, "created");
  assert.equal(replay.action, "noop");
  assert.equal(resolved.action, "updated");
  assert.equal(resolved.record.status, "resolved");
  assert.equal(resolved.observability.signalCount, 2);
  assert.equal(resolved.observability.evidenceCount, 3);
  assert.equal(resolved.observability.storeIsolationEnforced, true);
  assert.equal(resolved.observability.slo.replaySafe, true);

  const beforeExport = snapshotProfile("learner-mis-lane", "tenant-mis-lane-a").misconceptions;
  const exported = exportStoreSnapshot();
  resetStore();
  importStoreSnapshot(exported);
  assert.deepEqual(snapshotProfile("learner-mis-lane", "tenant-mis-lane-a").misconceptions, beforeExport);

  const replayAfterImport = executeOperation("misconception_update", resolvedRequest);
  assert.equal(replayAfterImport.action, "noop");
  assert.equal(replayAfterImport.recordDigest, resolved.recordDigest);

  const isolated = executeOperation("misconception_update", {
    ...baseRequest,
    storeId: "tenant-mis-lane-b",
    signalId: "sig-explicit-downvote-b",
    evidenceEventIds: ["evt-mis-b-1"],
  });
  assert.notEqual(isolated.misconceptionId, created.misconceptionId);
  assert.equal(snapshotProfile("learner-mis-lane", "tenant-mis-lane-a").misconceptions.length, 1);
  assert.equal(snapshotProfile("learner-mis-lane", "tenant-mis-lane-b").misconceptions.length, 1);
});

test("ums-memory-d6q.3.8: integration/replay curriculum lane keeps deterministic ranking and explanation payloads", () => {
  resetStore();
  const requestA = {
    storeId: "tenant-cur-lane-a",
    profile: "learner-cur-lane",
    objectiveId: "objective-recursion",
    recommendationRank: 3,
    status: "proposed",
    evidenceEventIds: ["evt-cur-1"],
    provenanceSignalIds: ["sig-cur-1"],
    metadata: {
      explanation: {
        summary: "Prioritize recursion drills from misconception evidence.",
        rationaleSteps: ["trace failing base-case", "practice dry-runs"],
      },
    },
  };
  const requestB = {
    storeId: "tenant-cur-lane-a",
    profile: "learner-cur-lane",
    objectiveId: "objective-dp",
    recommendationRank: 1,
    status: "proposed",
    evidenceEventIds: ["evt-cur-2"],
    provenanceSignalIds: ["sig-cur-2"],
    metadata: {
      explanation: {
        summary: "High-confidence DP objective from recent correction.",
      },
    },
  };

  const createdA = executeOperation("curriculum_plan_update", requestA);
  const createdB = executeOperation("curriculum_plan_update", requestB);
  const updatedA = executeOperation("curriculum_plan_update", {
    ...requestA,
    planItemId: createdA.planItemId,
    recommendationRank: 2,
    status: "committed",
    evidenceEventIds: ["evt-cur-1", "evt-cur-3"],
    provenanceSignalIds: ["sig-cur-1", "sig-cur-3"],
    metadata: {
      explanation: {
        summary: "Recursion is still important but rank below DP objective.",
        rationaleSteps: ["retain targeted practice", "defer until after DP refresher"],
      },
    },
  });
  const replayA = executeOperation("curriculum_plan_update", {
    ...requestA,
    planItemId: createdA.planItemId,
    recommendationRank: 2,
    status: "committed",
    evidenceEventIds: ["evt-cur-3", "evt-cur-1"],
    provenanceSignalIds: ["sig-cur-3", "sig-cur-1"],
    metadata: {
      explanation: {
        summary: "Recursion is still important but rank below DP objective.",
        rationaleSteps: ["retain targeted practice", "defer until after DP refresher"],
      },
    },
  });

  assert.equal(createdA.action, "created");
  assert.equal(createdB.action, "created");
  assert.equal(updatedA.action, "updated");
  assert.equal(replayA.action, "noop");
  assert.equal(updatedA.planItem.recommendationRank, 2);
  assert.equal(updatedA.observability.boundedRecommendationRank, 2);
  assert.equal(updatedA.observability.provenanceCount, 2);
  assert.equal(updatedA.observability.slo.replaySafe, true);
  assert.equal(updatedA.planItem.metadata.explanation.summary, "Recursion is still important but rank below DP objective.");

  const rankedObjectives = snapshotProfile("learner-cur-lane", "tenant-cur-lane-a").curriculumPlanItems
    .slice()
    .sort((left, right) => left.recommendationRank - right.recommendationRank || left.objectiveId.localeCompare(right.objectiveId))
    .map((item) => ({ objectiveId: item.objectiveId, recommendationRank: item.recommendationRank }));
  assert.deepEqual(rankedObjectives, [
    { objectiveId: "objective-dp", recommendationRank: 1 },
    { objectiveId: "objective-recursion", recommendationRank: 2 },
  ]);

  const exported = exportStoreSnapshot();
  resetStore();
  importStoreSnapshot(exported);
  const replayAfterImport = executeOperation("curriculum_plan_update", {
    ...requestA,
    planItemId: createdA.planItemId,
    recommendationRank: 2,
    status: "committed",
    evidenceEventIds: ["evt-cur-1", "evt-cur-3"],
    provenanceSignalIds: ["sig-cur-1", "sig-cur-3"],
    metadata: {
      explanation: {
        summary: "Recursion is still important but rank below DP objective.",
        rationaleSteps: ["retain targeted practice", "defer until after DP refresher"],
      },
    },
  });
  assert.equal(replayAfterImport.action, "noop");
  assert.equal(replayAfterImport.planDigest, updatedA.planDigest);

  executeOperation("curriculum_plan_update", {
    ...requestA,
    storeId: "tenant-cur-lane-b",
  });
  assert.equal(snapshotProfile("learner-cur-lane", "tenant-cur-lane-a").curriculumPlanItems.length, 2);
  assert.equal(snapshotProfile("learner-cur-lane", "tenant-cur-lane-b").curriculumPlanItems.length, 1);
});

test("ums-memory-d6q.4.8: integration/replay scheduler lane preserves deterministic clocks, queue metadata, and isolation", () => {
  resetStore();
  const baseRequest = {
    storeId: "tenant-srs-lane-a",
    profile: "learner-srs-lane",
    targetId: "rule-recursion-review",
    dueAt: "2026-03-20T00:00:00.000Z",
    sourceEventIds: ["evt-srs-2", "evt-srs-1"],
    evidenceEventIds: ["evt-srs-e-1"],
    metadata: {
      interactionClock: { tick: 1, lastInteractionAt: "2026-03-19T23:50:00.000Z" },
      sleepClock: { window: "nightly", nextConsolidationAt: "2026-03-20T03:00:00.000Z" },
    },
  };

  const created = executeOperation("review_schedule_update", baseRequest);
  const replay = executeOperation("review_schedule_update", {
    ...baseRequest,
    sourceEventIds: ["evt-srs-1", "evt-srs-2"],
  });
  const updatedRequest = {
    ...baseRequest,
    scheduleEntryId: created.scheduleEntryId,
    status: "due",
    repetition: 2,
    intervalDays: 3,
    sourceEventIds: ["evt-srs-1", "evt-srs-2", "evt-srs-3"],
    metadata: {
      interactionClock: { tick: 2, lastInteractionAt: "2026-03-20T00:00:00.000Z" },
      sleepClock: { window: "nightly", nextConsolidationAt: "2026-03-20T04:00:00.000Z" },
      archive: { tier: "warm", archivedEntryIds: [created.scheduleEntryId] },
    },
  };
  const updated = executeOperation("review_schedule_update", updatedRequest);

  assert.equal(created.action, "created");
  assert.equal(replay.action, "noop");
  assert.equal(updated.action, "updated");
  assert.equal(updated.observability.sourceEventCount, 3);
  assert.equal(updated.observability.storeIsolationEnforced, true);
  assert.equal(updated.observability.slo.replaySafe, true);
  assert.equal(updated.scheduleEntry.metadata.interactionClock.tick, 2);
  assert.equal(updated.scheduleEntry.metadata.sleepClock.window, "nightly");
  assert.equal(updated.scheduleEntry.metadata.archive.tier, "warm");

  const beforeExport = snapshotProfile("learner-srs-lane", "tenant-srs-lane-a").reviewScheduleEntries;
  const exported = exportStoreSnapshot();
  resetStore();
  importStoreSnapshot(exported);
  assert.deepEqual(snapshotProfile("learner-srs-lane", "tenant-srs-lane-a").reviewScheduleEntries, beforeExport);

  const replayAfterImport = executeOperation("review_schedule_update", updatedRequest);
  assert.equal(replayAfterImport.action, "noop");
  assert.equal(replayAfterImport.scheduleDigest, updated.scheduleDigest);

  executeOperation("review_schedule_update", {
    ...baseRequest,
    storeId: "tenant-srs-lane-b",
    sourceEventIds: ["evt-srs-b-1"],
  });
  assert.equal(snapshotProfile("learner-srs-lane", "tenant-srs-lane-a").reviewScheduleEntries.length, 1);
  assert.equal(snapshotProfile("learner-srs-lane", "tenant-srs-lane-b").reviewScheduleEntries.length, 1);
});

test("ums-memory-d6q.5.8: integration/replay policy lane enforces deterministic security and audit payload lineage", () => {
  resetStore();
  const initial = executeOperation("policy_decision_update", {
    storeId: "tenant-policy-lane-a",
    profile: "learner-policy-lane",
    policyKey: "personalization-safety",
    outcome: "review",
    reasonCodes: ["manual-review-required"],
    provenanceEventIds: ["evt-pol-1"],
    metadata: {
      security: { promptInjectionDetected: false, quarantined: false },
      allowlist: { requestedSpace: "space-b", authorized: false, allowedSpaces: ["space-a"] },
      degraded: { enabled: false, capabilities: { llm: true, index: true } },
      audit: { decisionTraceId: "trace-pol-1", checklist: ["incident-response"] },
    },
  });
  const deniedRequest = {
    storeId: "tenant-policy-lane-a",
    profile: "learner-policy-lane",
    policyKey: "personalization-safety",
    decisionId: initial.decisionId,
    outcome: "deny",
    reasonCodes: ["allowlist-denied", "prompt-injection-detected"],
    provenanceEventIds: ["evt-pol-2", "evt-pol-1"],
    metadata: {
      security: { promptInjectionDetected: true, quarantined: true },
      allowlist: { requestedSpace: "space-b", authorized: false, allowedSpaces: ["space-a"] },
      degraded: { enabled: true, reason: "index_unavailable", capabilities: { llm: false, index: false } },
      audit: { decisionTraceId: "trace-pol-1", checklist: ["incident-response", "rollback"] },
    },
  };
  const denied = executeOperation("policy_decision_update", deniedRequest);
  const replay = executeOperation("policy_decision_update", {
    ...deniedRequest,
    reasonCodes: ["prompt-injection-detected", "allowlist-denied"],
    provenanceEventIds: ["evt-pol-1", "evt-pol-2"],
  });

  assert.equal(initial.action, "created");
  assert.equal(denied.action, "updated");
  assert.equal(replay.action, "noop");
  assert.equal(replay.observability.denied, true);
  assert.equal(replay.observability.reasonCodeCount, 3);
  assert.equal(replay.observability.provenanceCount, 2);
  assert.equal(replay.observability.slo.replaySafe, true);
  assert.equal(replay.decision.metadata.security.quarantined, true);
  assert.equal(replay.decision.metadata.allowlist.authorized, false);
  assert.equal(replay.decision.metadata.degraded.enabled, true);
  assert.deepEqual(replay.decision.metadata.audit.checklist, ["incident-response", "rollback"]);

  const audit = executeOperation("audit", {
    storeId: "tenant-policy-lane-a",
    profile: "learner-policy-lane",
  });
  assert.equal(audit.operation, "audit");
  assert.equal(audit.deterministic, true);
  assert.ok(audit.checks.some((check) => check.name === "events_present"));
  assert.ok(audit.checks.some((check) => check.name === "duplicate_rules"));

  const exported = exportStoreSnapshot();
  resetStore();
  importStoreSnapshot(exported);
  const replayAfterImport = executeOperation("policy_decision_update", deniedRequest);
  assert.equal(replayAfterImport.action, "noop");
  assert.equal(replayAfterImport.decisionDigest, denied.decisionDigest);

  const isolated = executeOperation("policy_decision_update", {
    ...deniedRequest,
    storeId: "tenant-policy-lane-b",
    decisionId: undefined,
    provenanceEventIds: ["evt-pol-b-1"],
  });
  assert.notEqual(isolated.decisionId, denied.decisionId);
  assert.equal(snapshotProfile("learner-policy-lane", "tenant-policy-lane-a").policyDecisions.length, 1);
  assert.equal(snapshotProfile("learner-policy-lane", "tenant-policy-lane-b").policyDecisions.length, 1);
});
