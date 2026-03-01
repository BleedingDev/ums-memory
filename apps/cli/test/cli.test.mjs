import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { resetStore } from "../../api/src/core.mjs";

const CLI_PATH = resolve(process.cwd(), "apps/cli/src/index.mjs");

function runCli(args, stdin = "") {
  return new Promise((resolvePromise) => {
    const proc = spawn(process.execPath, [CLI_PATH, ...args], {
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    proc.on("close", (code) => {
      resolvePromise({ code, stdout, stderr });
    });
    if (stdin) {
      proc.stdin.write(stdin);
    }
    proc.stdin.end();
  });
}

test.beforeEach(() => {
  resetStore();
});

test("cli maps ingest command to shared operation core", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "ums-cli-test-"));
  const stateFile = resolve(tempDir, "state.json");
  try {
    const ingest = await runCli([
      "ingest",
      "--state-file",
      stateFile,
      "--input",
      JSON.stringify({
        profile: "cli-test",
        events: [{ type: "note", source: "cli", content: "wire same core" }]
      })
    ]);
    assert.equal(ingest.code, 0);
    const ingestBody = JSON.parse(ingest.stdout);
    assert.equal(ingestBody.ok, true);
    assert.equal(ingestBody.data.operation, "ingest");
    assert.equal(ingestBody.data.accepted, 1);

    const context = await runCli([
      "context",
      "--state-file",
      stateFile,
      "--input",
      "{\"profile\":\"cli-test\",\"query\":\"wire\"}"
    ]);
    assert.equal(context.code, 0);
    const contextBody = JSON.parse(context.stdout);
    assert.equal(contextBody.ok, true);
    assert.equal(contextBody.data.operation, "context");
    assert.equal(contextBody.data.matches.length, 1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("cli supports stdin json input", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "ums-cli-test-"));
  const stateFile = resolve(tempDir, "state.json");
  try {
    const ingest = await runCli(
      ["ingest", "--state-file", stateFile],
      JSON.stringify({
        profile: "stdin-test",
        events: [{ type: "task", source: "stdin", content: "stdin payload" }]
      })
    );
    assert.equal(ingest.code, 0);
    const body = JSON.parse(ingest.stdout);
    assert.equal(body.ok, true);
    assert.equal(body.data.profile, "stdin-test");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("cli store-id flag isolates memories across stores", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "ums-cli-test-"));
  const stateFile = resolve(tempDir, "state.json");

  try {
    const jiraIngest = await runCli([
      "ingest",
      "--state-file",
      stateFile,
      "--store-id",
      "jira-history",
      "--input",
      JSON.stringify({
        profile: "shared-profile",
        events: [{ type: "ticket", source: "jira", content: "jira only note" }],
      }),
    ]);
    assert.equal(jiraIngest.code, 0);

    const codingIngest = await runCli([
      "ingest",
      "--state-file",
      stateFile,
      "--store-id",
      "coding-agent",
      "--input",
      JSON.stringify({
        profile: "shared-profile",
        events: [{ type: "note", source: "codex", content: "coding only note" }],
      }),
    ]);
    assert.equal(codingIngest.code, 0);

    const jiraContext = await runCli([
      "context",
      "--state-file",
      stateFile,
      "--store-id",
      "jira-history",
      "--input",
      JSON.stringify({ profile: "shared-profile", query: "coding only note" }),
    ]);
    const jiraBody = JSON.parse(jiraContext.stdout);
    assert.equal(jiraBody.ok, true);
    assert.equal(jiraBody.data.matches.length, 0);

    const codingContext = await runCli([
      "context",
      "--state-file",
      stateFile,
      "--store-id",
      "coding-agent",
      "--input",
      JSON.stringify({ profile: "shared-profile", query: "jira only note" }),
    ]);
    const codingBody = JSON.parse(codingContext.stdout);
    assert.equal(codingBody.ok, true);
    assert.equal(codingBody.data.matches.length, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ums-memory-d6q.1.4 cli routes learner profile + identity graph updates with replay-safe ids", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "ums-cli-test-"));
  const stateFile = resolve(tempDir, "state.json");

  try {
    const profileCreate = await runCli([
      "learner_profile_update",
      "--state-file",
      stateFile,
      "--store-id",
      "tenant-cli",
      "--input",
      JSON.stringify({
        profile: "learner-cli",
        learnerId: "learner-88",
        identityRefs: [{ namespace: "email", value: "learner88@example.com", isPrimary: true }],
        goals: ["graph", "dp"],
        evidenceEventIds: ["ep-profile-cli-1"],
      }),
    ]);
    assert.equal(profileCreate.code, 0);
    const profileCreateBody = JSON.parse(profileCreate.stdout);
    assert.equal(profileCreateBody.ok, true);
    assert.equal(profileCreateBody.data.operation, "learner_profile_update");
    assert.equal(profileCreateBody.data.action, "created");

    const profileReplay = await runCli([
      "learner_profile_update",
      "--state-file",
      stateFile,
      "--store-id",
      "tenant-cli",
      "--input",
      JSON.stringify({
        profile: "learner-cli",
        learnerId: "learner-88",
        identityRefs: [{ namespace: "email", value: "learner88@example.com", isPrimary: true }],
        goals: ["dp", "graph"],
        evidenceEventIds: ["ep-profile-cli-1"],
      }),
    ]);
    assert.equal(profileReplay.code, 0);
    const profileReplayBody = JSON.parse(profileReplay.stdout);
    assert.equal(profileReplayBody.ok, true);
    assert.equal(profileReplayBody.data.action, "noop");
    assert.equal(profileReplayBody.data.profileId, profileCreateBody.data.profileId);

    const edgeCreate = await runCli([
      "identity_graph_update",
      "--state-file",
      stateFile,
      "--store-id",
      "tenant-cli",
      "--input",
      JSON.stringify({
        profile: "learner-cli",
        profileId: profileCreateBody.data.profileId,
        relation: "misconception_of",
        fromRef: { namespace: "misconception", value: "off-by-one" },
        toRef: { namespace: "learner", value: "learner-88" },
        evidenceEventIds: ["ep-2", "ep-1", "ep-1"],
      }),
    ]);
    assert.equal(edgeCreate.code, 0);
    const edgeCreateBody = JSON.parse(edgeCreate.stdout);
    assert.equal(edgeCreateBody.ok, true);
    assert.equal(edgeCreateBody.data.operation, "identity_graph_update");
    assert.equal(edgeCreateBody.data.action, "created");

    const edgeReplay = await runCli([
      "identity_graph_update",
      "--state-file",
      stateFile,
      "--store-id",
      "tenant-cli",
      "--input",
      JSON.stringify({
        profile: "learner-cli",
        profileId: profileCreateBody.data.profileId,
        relation: "misconception_of",
        fromRef: { namespace: "misconception", value: "off-by-one" },
        toRef: { namespace: "learner", value: "learner-88" },
        evidenceEventIds: ["ep-1", "ep-2"],
      }),
    ]);
    assert.equal(edgeReplay.code, 0);
    const edgeReplayBody = JSON.parse(edgeReplay.stdout);
    assert.equal(edgeReplayBody.ok, true);
    assert.equal(edgeReplayBody.data.action, "noop");
    assert.equal(edgeReplayBody.data.edgeId, edgeCreateBody.data.edgeId);

    const edgeOtherStore = await runCli([
      "identity_graph_update",
      "--state-file",
      stateFile,
      "--store-id",
      "tenant-cli-b",
      "--input",
      JSON.stringify({
        profile: "learner-cli",
        profileId: profileCreateBody.data.profileId,
        relation: "misconception_of",
        fromRef: { namespace: "misconception", value: "off-by-one" },
        toRef: { namespace: "learner", value: "learner-88" },
      }),
    ]);
    assert.equal(edgeOtherStore.code, 0);
    const edgeOtherStoreBody = JSON.parse(edgeOtherStore.stdout);
    assert.equal(edgeOtherStoreBody.ok, true);
    assert.equal(edgeOtherStoreBody.data.action, "created");
    assert.notEqual(edgeOtherStoreBody.data.edgeId, edgeCreateBody.data.edgeId);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ums-memory-d6q.2.4/3.4/4.4/5.4 cli routes deterministic P3 contract handlers", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "ums-cli-test-"));
  const stateFile = resolve(tempDir, "state.json");

  try {
    const misconception = await runCli([
      "misconception_update",
      "--state-file",
      stateFile,
      "--store-id",
      "tenant-p3-cli",
      "--input",
      JSON.stringify({
        profile: "learner-p3-cli",
        misconceptionKey: "off-by-one",
        signal: "harmful",
        evidenceEventIds: ["ep-1"],
      }),
    ]);
    assert.equal(misconception.code, 0);
    const misconceptionBody = JSON.parse(misconception.stdout);
    assert.equal(misconceptionBody.ok, true);
    assert.equal(misconceptionBody.data.operation, "misconception_update");
    assert.equal(misconceptionBody.data.action, "created");

    const curriculum = await runCli([
      "curriculum_plan_update",
      "--state-file",
      stateFile,
      "--store-id",
      "tenant-p3-cli",
      "--input",
      JSON.stringify({
        profile: "learner-p3-cli",
        objectiveId: "objective-1",
        recommendationRank: 2,
        evidenceEventIds: ["ep-2"],
        provenanceSignalIds: ["sig-1"],
      }),
    ]);
    assert.equal(curriculum.code, 0);
    const curriculumBody = JSON.parse(curriculum.stdout);
    assert.equal(curriculumBody.ok, true);
    assert.equal(curriculumBody.data.operation, "curriculum_plan_update");
    assert.equal(curriculumBody.data.action, "created");

    const review = await runCli([
      "review_schedule_update",
      "--state-file",
      stateFile,
      "--store-id",
      "tenant-p3-cli",
      "--input",
      JSON.stringify({
        profile: "learner-p3-cli",
        targetId: "rule-1",
        dueAt: "2026-03-01T12:00:00.000Z",
        sourceEventIds: ["evt-1"],
      }),
    ]);
    assert.equal(review.code, 0);
    const reviewBody = JSON.parse(review.stdout);
    assert.equal(reviewBody.ok, true);
    assert.equal(reviewBody.data.operation, "review_schedule_update");
    assert.equal(reviewBody.data.action, "created");

    const policy = await runCli([
      "policy_decision_update",
      "--state-file",
      stateFile,
      "--store-id",
      "tenant-p3-cli",
      "--input",
      JSON.stringify({
        profile: "learner-p3-cli",
        policyKey: "safe-guidance",
        outcome: "deny",
        reasonCodes: ["safety-risk"],
        provenanceEventIds: ["evt-policy-1"],
      }),
    ]);
    assert.equal(policy.code, 0);
    const policyBody = JSON.parse(policy.stdout);
    assert.equal(policyBody.ok, true);
    assert.equal(policyBody.data.operation, "policy_decision_update");
    assert.equal(policyBody.data.action, "created");
    assert.equal(policyBody.data.observability.denied, true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ums-memory-d6q.1.11/ums-memory-d6q.1.9 cli rejects missing evidence pointers and returns policy exception observability", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "ums-cli-test-"));
  const stateFile = resolve(tempDir, "state.json");

  try {
    const rejected = await runCli([
      "misconception_update",
      "--state-file",
      stateFile,
      "--store-id",
      "tenant-cli-guardrail",
      "--input",
      JSON.stringify({
        profile: "learner-cli-guardrail",
        misconceptionKey: "missing-evidence-pointer",
        signal: "harmful",
      }),
    ]);
    assert.equal(rejected.code, 1);
    const rejectedBody = JSON.parse(rejected.stderr);
    assert.equal(rejectedBody.ok, false);
    assert.equal(rejectedBody.error.code, "CLI_ERROR");
    assert.match(rejectedBody.error.message, /evidenceeventid/i);

    const policy = await runCli([
      "policy_decision_update",
      "--state-file",
      stateFile,
      "--store-id",
      "tenant-cli-guardrail",
      "--input",
      JSON.stringify({
        profile: "learner-cli-guardrail",
        policyKey: "evidence-pointer-contract",
        outcome: "review",
        reasonCodes: ["policy-exception-evidence-pointer-waiver"],
        provenanceEventIds: ["evt-policy-waiver-cli-1"],
        metadata: {
          exceptionKind: "evidence-pointer-waiver",
          ticketId: "waiver-cli-1",
        },
      }),
    ]);
    assert.equal(policy.code, 0);
    const policyBody = JSON.parse(policy.stdout);
    assert.equal(policyBody.ok, true);
    assert.equal(policyBody.data.operation, "policy_decision_update");
    assert.equal(policyBody.data.decision.outcome, "review");
    assert.equal(policyBody.data.observability.denied, false);
    assert.equal(policyBody.data.observability.reasonCodeCount, 1);
    assert.equal(policyBody.data.observability.provenanceCount, 1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ums-memory-d6q.2.6/ums-memory-d6q.3.6/ums-memory-d6q.4.6/ums-memory-d6q.5.6 cli guardrails reject invalid domain payloads", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "ums-cli-test-"));
  const stateFile = resolve(tempDir, "state.json");

  const guardrailCases = [
    {
      operation: "misconception_update",
      payload: {
        profile: "learner-cli-guardrails",
        misconceptionKey: "missing-evidence",
        signal: "harmful",
      },
      messagePattern: /evidenceeventid/i,
    },
    {
      operation: "curriculum_plan_update",
      payload: {
        profile: "learner-cli-guardrails",
        objectiveId: "objective-without-evidence",
      },
      messagePattern: /evidenceeventid/i,
    },
    {
      operation: "review_schedule_update",
      payload: {
        profile: "learner-cli-guardrails",
        targetId: "rule-without-source-events",
        dueAt: "2026-03-11T00:00:00.000Z",
      },
      messagePattern: /sourceeventid/i,
    },
    {
      operation: "policy_decision_update",
      payload: {
        profile: "learner-cli-guardrails",
        policyKey: "deny-without-reason-codes",
        outcome: "deny",
        provenanceEventIds: ["evt-cli-pol-1"],
      },
      messagePattern: /reasoncodes/i,
    },
  ];

  try {
    for (const entry of guardrailCases) {
      const result = await runCli([
        entry.operation,
        "--state-file",
        stateFile,
        "--store-id",
        "tenant-cli-guardrails",
        "--input",
        JSON.stringify(entry.payload),
      ]);
      assert.equal(result.code, 1);
      const body = JSON.parse(result.stderr);
      assert.equal(body.ok, false);
      assert.equal(body.error.code, "CLI_ERROR");
      assert.match(body.error.message, entry.messagePattern);
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ums-memory-d6q.2.7/ums-memory-d6q.2.9/ums-memory-d6q.3.7/ums-memory-d6q.3.9/ums-memory-d6q.4.7/ums-memory-d6q.4.9/ums-memory-d6q.5.7/ums-memory-d6q.5.9 cli positive domain paths include observability fields", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "ums-cli-test-"));
  const stateFile = resolve(tempDir, "state.json");

  try {
    const misconception = await runCli([
      "misconception_update",
      "--state-file",
      stateFile,
      "--store-id",
      "tenant-cli-positive",
      "--input",
      JSON.stringify({
        profile: "learner-cli-positive",
        misconceptionKey: "array-bound-check",
        signal: "harmful",
        signalId: "sig-cli-1",
        evidenceEventIds: ["evt-cli-m-1", "evt-cli-m-2"],
      }),
    ]);
    assert.equal(misconception.code, 0);
    const misconceptionBody = JSON.parse(misconception.stdout);
    assert.equal(misconceptionBody.ok, true);
    assert.equal(misconceptionBody.data.action, "created");
    assert.equal(misconceptionBody.data.observability.evidenceCount, 2);
    assert.equal(misconceptionBody.data.observability.signalCount, 1);
    assert.equal(misconceptionBody.data.deterministic, true);
    assert.ok(misconceptionBody.data.requestDigest.length > 10);

    const curriculum = await runCli([
      "curriculum_plan_update",
      "--state-file",
      stateFile,
      "--store-id",
      "tenant-cli-positive",
      "--input",
      JSON.stringify({
        profile: "learner-cli-positive",
        objectiveId: "objective-cli-positive",
        recommendationRank: 2,
        evidenceEventIds: ["evt-cli-c-1"],
        provenanceSignalIds: ["sig-cli-1", "sig-cli-2"],
      }),
    ]);
    assert.equal(curriculum.code, 0);
    const curriculumBody = JSON.parse(curriculum.stdout);
    assert.equal(curriculumBody.ok, true);
    assert.equal(curriculumBody.data.action, "created");
    assert.equal(curriculumBody.data.observability.evidenceCount, 1);
    assert.equal(curriculumBody.data.observability.provenanceCount, 2);
    assert.equal(curriculumBody.data.observability.boundedRecommendationRank, 2);
    assert.equal(curriculumBody.data.deterministic, true);
    assert.ok(curriculumBody.data.requestDigest.length > 10);

    const review = await runCli([
      "review_schedule_update",
      "--state-file",
      stateFile,
      "--store-id",
      "tenant-cli-positive",
      "--input",
      JSON.stringify({
        profile: "learner-cli-positive",
        targetId: "rule-cli-positive",
        dueAt: "2026-03-12T00:00:00.000Z",
        sourceEventIds: ["evt-cli-r-1", "evt-cli-r-2"],
      }),
    ]);
    assert.equal(review.code, 0);
    const reviewBody = JSON.parse(review.stdout);
    assert.equal(reviewBody.ok, true);
    assert.equal(reviewBody.data.action, "created");
    assert.equal(reviewBody.data.observability.dueAt, "2026-03-12T00:00:00.000Z");
    assert.equal(reviewBody.data.observability.sourceEventCount, 2);
    assert.equal(reviewBody.data.observability.storeIsolationEnforced, true);
    assert.equal(reviewBody.data.deterministic, true);
    assert.ok(reviewBody.data.requestDigest.length > 10);

    const policy = await runCli([
      "policy_decision_update",
      "--state-file",
      stateFile,
      "--store-id",
      "tenant-cli-positive",
      "--input",
      JSON.stringify({
        profile: "learner-cli-positive",
        policyKey: "policy-cli-positive",
        outcome: "deny",
        reasonCodes: ["safety-risk"],
        provenanceEventIds: ["evt-cli-p-1"],
      }),
    ]);
    assert.equal(policy.code, 0);
    const policyBody = JSON.parse(policy.stdout);
    assert.equal(policyBody.ok, true);
    assert.equal(policyBody.data.action, "created");
    assert.equal(policyBody.data.observability.denied, true);
    assert.equal(policyBody.data.observability.reasonCodeCount, 1);
    assert.equal(policyBody.data.observability.provenanceCount, 1);
    assert.equal(policyBody.data.deterministic, true);
    assert.ok(policyBody.data.requestDigest.length > 10);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ums-memory-d6q.2.11/ums-memory-d6q.2.12/ums-memory-d6q.4.11/ums-memory-d6q.4.12 cli feature payloads remain replay-safe and observable", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "ums-cli-test-"));
  const stateFile = resolve(tempDir, "state.json");

  try {
    const outcome = await runCli([
      "outcome",
      "--state-file",
      stateFile,
      "--store-id",
      "tenant-cli-feature",
      "--input",
      JSON.stringify({
        profile: "learner-cli-feature",
        task: "regression-test-failure",
        outcome: "failure",
        usedRuleIds: ["rule-cli-1"],
      }),
    ]);
    assert.equal(outcome.code, 0);
    const outcomeBody = JSON.parse(outcome.stdout);
    assert.equal(outcomeBody.ok, true);

    const explicitMisconception = await runCli([
      "misconception_update",
      "--state-file",
      stateFile,
      "--store-id",
      "tenant-cli-feature",
      "--input",
      JSON.stringify({
        profile: "learner-cli-feature",
        misconceptionKey: "boundary-check",
        signal: "harmful",
        signalId: "sig-cli-explicit-1",
        evidenceEventIds: ["evt-cli-explicit-1"],
        metadata: {
          feedbackType: "thumbs-down",
          source: "human-review",
        },
      }),
    ]);
    assert.equal(explicitMisconception.code, 0);
    const explicitBody = JSON.parse(explicitMisconception.stdout);
    assert.equal(explicitBody.ok, true);
    assert.equal(explicitBody.data.action, "created");
    assert.equal(explicitBody.data.observability.signalCount, 1);

    const implicitMisconception = await runCli([
      "misconception_update",
      "--state-file",
      stateFile,
      "--store-id",
      "tenant-cli-feature",
      "--input",
      JSON.stringify({
        profile: "learner-cli-feature",
        misconceptionKey: "boundary-check",
        signal: "harmful",
        signalId: "sig-cli-implicit-failure-1",
        evidenceEventIds: [outcomeBody.data.outcomeId],
        metadata: {
          mappingSource: "outcome_failure",
          mappedOutcomeId: outcomeBody.data.outcomeId,
          mappedAt: "2026-03-01T12:30:00.000Z",
        },
      }),
    ]);
    assert.equal(implicitMisconception.code, 0);
    const implicitBody = JSON.parse(implicitMisconception.stdout);
    assert.equal(implicitBody.ok, true);
    assert.equal(implicitBody.data.action, "updated");
    assert.equal(implicitBody.data.observability.signalCount, 2);
    assert.equal(implicitBody.data.record.metadata.mappedOutcomeId, outcomeBody.data.outcomeId);

    const implicitReplay = await runCli([
      "misconception_update",
      "--state-file",
      stateFile,
      "--store-id",
      "tenant-cli-feature",
      "--input",
      JSON.stringify({
        profile: "learner-cli-feature",
        misconceptionKey: "boundary-check",
        signal: "harmful",
        signalId: "sig-cli-implicit-failure-1",
        evidenceEventIds: [outcomeBody.data.outcomeId],
        metadata: {
          mappingSource: "outcome_failure",
          mappedOutcomeId: outcomeBody.data.outcomeId,
          mappedAt: "2026-03-01T12:30:00.000Z",
        },
      }),
    ]);
    assert.equal(implicitReplay.code, 0);
    const implicitReplayBody = JSON.parse(implicitReplay.stdout);
    assert.equal(implicitReplayBody.ok, true);
    assert.equal(implicitReplayBody.data.action, "noop");

    const schedule = await runCli([
      "review_schedule_update",
      "--state-file",
      stateFile,
      "--store-id",
      "tenant-cli-feature",
      "--input",
      JSON.stringify({
        profile: "learner-cli-feature",
        targetId: "rule-cli-feature",
        dueAt: "2026-03-26T00:00:00.000Z",
        sourceEventIds: ["evt-cli-srs-2", "evt-cli-srs-1"],
        metadata: {
          interactionClock: { tick: 4, lastInteractionAt: "2026-03-25T23:30:00.000Z" },
          sleepClock: { window: "nightly", nextConsolidationAt: "2026-03-26T02:30:00.000Z" },
          activeSet: { limit: 3, size: 2, strategy: "lru" },
          archive: { tier: "warm", tiers: ["hot", "warm", "cold"] },
        },
      }),
    ]);
    assert.equal(schedule.code, 0);
    const scheduleBody = JSON.parse(schedule.stdout);
    assert.equal(scheduleBody.ok, true);
    assert.equal(scheduleBody.data.action, "created");
    assert.equal(scheduleBody.data.scheduleEntry.metadata.interactionClock.tick, 4);
    assert.equal(scheduleBody.data.scheduleEntry.metadata.archive.tier, "warm");

    const scheduleReplay = await runCli([
      "review_schedule_update",
      "--state-file",
      stateFile,
      "--store-id",
      "tenant-cli-feature",
      "--input",
      JSON.stringify({
        profile: "learner-cli-feature",
        targetId: "rule-cli-feature",
        dueAt: "2026-03-26T00:00:00.000Z",
        sourceEventIds: ["evt-cli-srs-1", "evt-cli-srs-2"],
        metadata: {
          interactionClock: { tick: 4, lastInteractionAt: "2026-03-25T23:30:00.000Z" },
          sleepClock: { window: "nightly", nextConsolidationAt: "2026-03-26T02:30:00.000Z" },
          activeSet: { limit: 3, size: 2, strategy: "lru" },
          archive: { tier: "warm", tiers: ["hot", "warm", "cold"] },
        },
      }),
    ]);
    assert.equal(scheduleReplay.code, 0);
    const scheduleReplayBody = JSON.parse(scheduleReplay.stdout);
    assert.equal(scheduleReplayBody.ok, true);
    assert.equal(scheduleReplayBody.data.action, "noop");
    assert.equal(scheduleReplayBody.data.observability.sourceEventCount, 2);
    assert.equal(scheduleReplayBody.data.observability.slo.replaySafe, true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
