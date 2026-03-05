import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { executeOperation, resetStore } from "../src/core.ts";
import { executeOperationWithSharedState } from "../src/persistence.ts";
import {
  createSupervisedWorkerService,
  runBackgroundWorkerCycle,
  startSupervisedWorkerService,
} from "../src/worker-runtime.ts";

async function withTempStateFile<T>(
  fn: (params: {
    readonly tempDir: string;
    readonly stateFile: string;
  }) => Promise<T>
): Promise<T> {
  const tempDir = await mkdtemp(resolve(tmpdir(), "ums-worker-runtime-"));
  const stateFile = resolve(tempDir, "worker-state.json");
  try {
    return await fn({ tempDir, stateFile });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function waitForPhase(service: any, expectedPhase: any, timeoutMs = 5000) {
  return new Promise((resolvePromise, rejectPromise) => {
    const startedAt = Date.now();
    const interval = setInterval(() => {
      const snapshot = service.status();
      if (snapshot.phase === expectedPhase) {
        clearInterval(interval);
        resolvePromise(snapshot);
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        clearInterval(interval);
        rejectPromise(
          new Error(
            `Timed out waiting for phase ${expectedPhase}. Current phase: ${snapshot.phase}`
          )
        );
      }
    }, 20);
    if (typeof interval.unref === "function") {
      interval.unref();
    }
  });
}

function delay(ms: any) {
  return new Promise<void>((resolvePromise) => {
    const timer = setTimeout(resolvePromise, ms);
    if (typeof timer.unref === "function") {
      timer.unref();
    }
  });
}

function createSyntheticCycleSummary(startedAt = "2026-03-02T00:00:00.000Z") {
  return {
    startedAt,
    completedAt: "2026-03-02T00:00:00.010Z",
    durationMs: 10,
    stateFile: null,
    profileCount: 0,
    replayEvalMaxPerProfile: 0,
    reviewScheduleClock: {
      attempted: 0,
      succeeded: 0,
      failed: 0,
    },
    replayEval: {
      candidatesSeen: 0,
      skippedByLimit: 0,
      attempted: 0,
      succeeded: 0,
      failed: 0,
    },
    doctor: {
      attempted: 0,
      succeeded: 0,
      failed: 0,
    },
    errorCount: 0,
    errorOverflowCount: 0,
    errors: [],
  };
}

test.beforeEach(() => {
  resetStore();
});

test.after(() => {
  resetStore();
});

test("worker cycle executes review/replay/doctor with real shared state and returns deterministic summary counts", async () => {
  await withTempStateFile(async ({ stateFile }) => {
    const storeId = "worker-cycle-store";
    const profile = "worker-cycle-profile";

    await executeOperationWithSharedState({
      operation: "shadow_write",
      stateFile,
      executor: () =>
        executeOperation("shadow_write", {
          storeId,
          profile,
          candidateId: "cand-worker-cycle-1",
          statement:
            "Keep replay evaluations deterministic in background cycles.",
          sourceEventIds: ["evt-worker-cycle-1"],
          evidenceEventIds: ["evt-worker-cycle-1"],
          status: "shadow",
          createdAt: "2026-03-01T00:00:00.000Z",
          updatedAt: "2026-03-01T00:00:00.000Z",
          expiresAt: "2026-12-01T00:00:00.000Z",
        }),
    });

    const summary = await runBackgroundWorkerCycle({
      stateFile,
      timestamp: "2026-03-02T00:00:00.000Z",
      replayEvalMaxPerProfile: 2,
      maxErrorEntries: 8,
    });

    assert.equal(summary.profileCount, 2);
    assert.equal(summary.reviewScheduleClock.attempted, 2);
    assert.equal(summary.reviewScheduleClock.succeeded, 2);
    assert.equal(summary.reviewScheduleClock.failed, 0);
    assert.equal(summary.replayEval.candidatesSeen, 2);
    assert.equal(summary.replayEval.skippedByLimit, 0);
    assert.equal(summary.replayEval.attempted, 2);
    assert.equal(summary.replayEval.succeeded, 2);
    assert.equal(summary.replayEval.failed, 0);
    assert.equal(summary.doctor.attempted, 2);
    assert.equal(summary.doctor.succeeded, 2);
    assert.equal(summary.doctor.failed, 0);
    assert.equal(summary.errorCount, 0);
    assert.equal(summary.errorOverflowCount, 0);
    assert.deepEqual(summary.errors, []);

    const snapshot = JSON.parse(await readFile(stateFile, "utf8"));
    const storeProfiles = snapshot?.stores?.[storeId]?.profiles ?? {};
    const profileKeys = Object.keys(storeProfiles);
    assert.equal(profileKeys.length, 2);
    assert.equal(profileKeys.includes(profile), true);
    assert.equal(profileKeys.includes("__store_default__"), true);
    const profileState = storeProfiles[profile];
    assert.ok(profileState);
    assert.equal(Array.isArray(profileState.replayEvaluations), true);
    assert.equal(profileState.replayEvaluations.length, 1);
    assert.equal(storeProfiles.__store_default__?.replayEvaluations?.length, 1);
  });
});

test("worker cycle derives replay_eval deltas from outcomes and feedback instead of zero-default metrics", async () => {
  const replayEvalRequests: Array<Record<string, unknown>> = [];
  const summary = await runBackgroundWorkerCycle({
    timestamp: "2026-03-02T00:00:00.000Z",
    replayEvalMaxPerProfile: 5,
    maxErrorEntries: 8,
    loadSnapshot: async () => ({
      stores: {
        "worker-autopilot-store": {
          profiles: {
            "worker-autopilot-profile": {
              shadowCandidates: [
                {
                  candidateId: "cand-worker-autopilot-1",
                  ruleId: "rule-worker-autopilot-1",
                  status: "shadow",
                  confidence: 0.9,
                },
              ],
              replayEvaluations: [
                {
                  candidateId: "cand-worker-autopilot-1",
                  evaluatedAt: "2026-02-28T00:00:00.000Z",
                },
              ],
              outcomes: [
                {
                  outcome: "success",
                  usedRuleIds: ["rule-worker-autopilot-1"],
                  recordedAt: "2026-03-01T00:00:00.000Z",
                },
                {
                  outcome: "success",
                  usedRuleIds: ["rule-worker-autopilot-1"],
                  recordedAt: "2026-03-01T00:05:00.000Z",
                },
                {
                  outcome: "failure",
                  usedRuleIds: ["rule-worker-autopilot-other"],
                  recordedAt: "2026-03-01T00:10:00.000Z",
                },
                {
                  outcome: "failure",
                  usedRuleIds: ["rule-worker-autopilot-other"],
                  recordedAt: "2026-03-01T00:15:00.000Z",
                },
              ],
              feedback: [
                {
                  signal: "helpful",
                  targetRuleId: "rule-worker-autopilot-1",
                  recordedAt: "2026-03-01T00:03:00.000Z",
                },
                {
                  signal: "harmful",
                  targetRuleId: "rule-worker-autopilot-other",
                  recordedAt: "2026-03-01T00:12:00.000Z",
                },
              ],
            },
          },
        },
      },
    }),
    runOperation: async ({ operation, requestBody }) => {
      if (operation === "replay_eval") {
        replayEvalRequests.push(
          requestBody as unknown as Record<string, unknown>
        );
      }
      return {};
    },
  });

  assert.equal(summary.profileCount, 1);
  assert.equal(summary.replayEval.attempted, 1);
  assert.equal(summary.replayEval.succeeded, 1);
  assert.equal(summary.replayEval.failed, 0);
  assert.equal(replayEvalRequests.length, 1);

  const replayEvalRequest = replayEvalRequests[0];
  assert.ok(replayEvalRequest);
  assert.equal(replayEvalRequest["candidateId"], "cand-worker-autopilot-1");
  assert.equal(replayEvalRequest["successRateDelta"], 0.5);
  assert.equal(replayEvalRequest["reopenRateDelta"], -0.5);
  assert.equal(replayEvalRequest["policyViolationsDelta"], 0);
  assert.equal(replayEvalRequest["hallucinationFlagDelta"], 0);
  assert.equal(replayEvalRequest["canarySuccessRateDelta"], 0.25);
  assert.equal(replayEvalRequest["canaryErrorRateDelta"], -0.5);
  assert.equal(replayEvalRequest["canaryPolicyViolationsDelta"], 0);
  assert.equal(replayEvalRequest["canaryHallucinationFlagDelta"], 0);

  const metadata = replayEvalRequest["metadata"] as Record<string, unknown>;
  assert.equal(metadata["source"], "worker_outcome_autopilot");
  assert.equal(metadata["observedGlobalOutcomes"], 4);
  assert.equal(metadata["observedCandidateOutcomes"], 2);
  assert.equal(metadata["observedGlobalFeedback"], 2);
  assert.equal(metadata["observedCandidateFeedback"], 1);
  assert.equal(metadata["candidateRuleId"], "rule-worker-autopilot-1");
});

test("supervised worker service starts, runs cycles, and stops cleanly", async () => {
  await withTempStateFile(async ({ stateFile }) => {
    const { service, cycleCount } = await startSupervisedWorkerService({
      stateFile,
      intervalMs: 40,
      restartDelayMs: 20,
      restartLimit: 0,
      captureProcessSignals: false,
    });

    try {
      assert.ok(cycleCount >= 1);
      const running = service.status();
      assert.equal(running.phase, "running");
      assert.ok(running.cycleCount >= 1);
      await delay(90);
      const afterDelay = service.status();
      assert.ok(afterDelay.cycleCount >= running.cycleCount);
    } finally {
      await service.stop();
    }

    const stopped = service.status();
    assert.equal(stopped.phase, "stopped");
    assert.ok(stopped.stoppedAt);
  });
});

test("supervised worker fails fast before first successful cycle when startup cycle exhausts restart budget", async () => {
  await withTempStateFile(async ({ stateFile }) => {
    await writeFile(stateFile, "{not-valid-json", "utf8");
    const service = createSupervisedWorkerService({
      stateFile,
      intervalMs: 30,
      restartDelayMs: 20,
      restartLimit: 0,
      captureProcessSignals: false,
    });

    try {
      await service.start();
      await assert.rejects(service.ready(), /State file is not valid JSON/);
      const failed = await waitForPhase(service, "failed");
      assert.equal((failed as any).phase, "failed");
      assert.equal((failed as any).cycleCount, 0);
      assert.match(
        (failed as any).lastError ?? "",
        /State file is not valid JSON/
      );
    } finally {
      await service.stop();
    }
  });
});

test("worker failure after readiness transitions to failed with restartLimit=0 without deferred completion noise", async () => {
  let invocationCount = 0;
  const service = createSupervisedWorkerService({
    intervalMs: 20,
    restartDelayMs: 10,
    restartLimit: 0,
    captureProcessSignals: false,
    runCycle: async () => {
      invocationCount += 1;
      if (invocationCount === 1) {
        return createSyntheticCycleSummary();
      }
      throw new Error("cycle failure after readiness");
    },
  });

  try {
    await service.start();
    await service.ready();
    const failed = await waitForPhase(service, "failed");
    assert.equal(invocationCount, 2);
    assert.equal((failed as any).phase, "failed");
    assert.match(
      (failed as any).lastError ?? "",
      /cycle failure after readiness/
    );
    assert.doesNotMatch(
      (failed as any).lastError ?? "",
      /Deferred already completed/
    );
  } finally {
    await service.stop();
  }
});

test("supervised worker recovers from transient cycle failure within restart budget", async () => {
  let invocationCount = 0;
  const service = createSupervisedWorkerService({
    intervalMs: 20,
    restartDelayMs: 10,
    restartLimit: 1,
    captureProcessSignals: false,
    runCycle: async () => {
      invocationCount += 1;
      if (invocationCount === 1) {
        throw new Error("transient cycle failure");
      }
      return createSyntheticCycleSummary("2026-03-03T00:00:00.000Z");
    },
  });

  try {
    await service.start();
    const readiness = await service.ready();
    assert.ok(readiness.cycleCount >= 1);
    await waitForPhase(service, "running");
    const running = service.status();
    assert.ok(invocationCount >= 2);
    assert.equal(running.phase, "running");
    assert.equal(running.restartCount, 1);
    assert.ok(running.cycleCount >= 1);
  } finally {
    await service.stop();
  }
});
