import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { test } from "@effect-native/bun-test";

import {
  generateRankingDecayTuning,
  main,
} from "../../scripts/generate-ranking-decay-tuning.ts";

const SUMMARY_A = Object.freeze({
  schemaVersion: "pilot_rollout_report.v1",
  requestVolume: 100,
  successCount: 97,
  failureCount: 3,
  successRate: 0.97,
  failureRate: 0.03,
  p95LatencyMs: 290,
  latencySampleSize: 100,
  operationHistogram: {
    context: 60,
    ingest: 40,
  },
  failureCodeHistogram: {
    TIMEOUT: 2,
    INTERNAL: 1,
  },
  policyDecisionHistogram: {
    allow: 95,
    review: 3,
    deny: 2,
  },
  anomalyHistogram: {
    latency_spike: 2,
  },
  teamHistogram: {
    team_alpha: 100,
  },
  projectHistogram: {
    project_x: 100,
  },
  perOperation: {
    context: {
      requestVolume: 60,
      successCount: 58,
      failureCount: 2,
      successRate: 0.966667,
      failureRate: 0.033333,
      p95LatencyMs: 290,
      latencySampleSize: 60,
      failureCodeHistogram: {
        TIMEOUT: 2,
      },
    },
    ingest: {
      requestVolume: 40,
      successCount: 39,
      failureCount: 1,
      successRate: 0.975,
      failureRate: 0.025,
      p95LatencyMs: 210,
      latencySampleSize: 40,
      failureCodeHistogram: {
        INTERNAL: 1,
      },
    },
  },
  invalidEventCount: 0,
  telemetryWindow: {
    start: "2026-03-01T10:00:00.000Z",
    end: "2026-03-01T10:59:59.000Z",
  },
});

const SUMMARY_B = Object.freeze({
  schemaVersion: "pilot_rollout_report.v1",
  requestVolume: 80,
  successCount: 78,
  failureCount: 2,
  successRate: 0.975,
  failureRate: 0.025,
  p95LatencyMs: 320,
  latencySampleSize: 80,
  operationHistogram: {
    retrieval_query: 50,
    ingest: 30,
  },
  failureCodeHistogram: {
    INTERNAL: 2,
  },
  policyDecisionHistogram: {
    allow: 76,
    review: 2,
    deny: 2,
  },
  anomalyHistogram: {
    recall_drift: 1,
  },
  teamHistogram: {
    team_alpha: 80,
  },
  projectHistogram: {
    project_x: 80,
  },
  perOperation: {
    retrieval_query: {
      requestVolume: 50,
      successCount: 48,
      failureCount: 2,
      successRate: 0.96,
      failureRate: 0.04,
      p95LatencyMs: 320,
      latencySampleSize: 50,
      failureCodeHistogram: {
        INTERNAL: 2,
      },
    },
    ingest: {
      requestVolume: 30,
      successCount: 30,
      failureCount: 0,
      successRate: 1,
      failureRate: 0,
      p95LatencyMs: 200,
      latencySampleSize: 30,
      failureCodeHistogram: {},
    },
  },
  invalidEventCount: 0,
  telemetryWindow: {
    start: "2026-03-01T11:00:00.000Z",
    end: "2026-03-01T11:59:59.000Z",
  },
});

const DASHBOARD_A = Object.freeze({
  schemaVersion: "pilot_kpi_dashboard.v1",
  adoption: {
    requestVolume: 180,
    failureRate: 0.03,
  },
  quality: {
    p95LatencyMs: 320,
    p95LatencyEstimateMs: 303.333,
  },
  incidentRate: {
    incidentCount: 2,
    rollbackIncidentCount: 0,
    incidentsPer1kRequests: 11.111111,
  },
  recallQuality: {
    recallFailureRate: 0.04,
    qualityFeedbackCount: 2,
  },
  usefulness: {
    feedbackCount: 3,
    highSeverityCount: 1,
  },
});

const SUMMARY_STRESSED = Object.freeze({
  schemaVersion: "pilot_rollout_report.v1",
  requestVolume: 120,
  successCount: 95,
  failureCount: 25,
  successRate: 0.791667,
  failureRate: 0.208333,
  p95LatencyMs: 480,
  latencySampleSize: 120,
  operationHistogram: {
    context: 90,
    ingest: 30,
  },
  failureCodeHistogram: {
    TIMEOUT: 15,
    INTERNAL: 10,
  },
  policyDecisionHistogram: {
    allow: 80,
    review: 25,
    deny: 15,
  },
  anomalyHistogram: {
    recall_drift: 20,
    policy_spike: 5,
  },
  teamHistogram: {
    team_alpha: 120,
  },
  projectHistogram: {
    project_x: 120,
  },
  perOperation: {
    context: {
      requestVolume: 90,
      successCount: 65,
      failureCount: 25,
      successRate: 0.722222,
      failureRate: 0.277778,
      p95LatencyMs: 500,
      latencySampleSize: 90,
      failureCodeHistogram: {
        TIMEOUT: 15,
        INTERNAL: 10,
      },
    },
    ingest: {
      requestVolume: 30,
      successCount: 30,
      failureCount: 0,
      successRate: 1,
      failureRate: 0,
      p95LatencyMs: 200,
      latencySampleSize: 30,
      failureCodeHistogram: {},
    },
  },
  invalidEventCount: 0,
  telemetryWindow: {
    start: "2026-03-02T10:00:00.000Z",
    end: "2026-03-02T11:00:00.000Z",
  },
});

const DASHBOARD_STRESSED = Object.freeze({
  schemaVersion: "pilot_kpi_dashboard.v1",
  adoption: {
    requestVolume: 120,
    failureRate: 0.208333,
  },
  quality: {
    p95LatencyMs: 480,
    p95LatencyEstimateMs: 480,
  },
  incidentRate: {
    incidentCount: 4,
    rollbackIncidentCount: 2,
    incidentsPer1kRequests: 33.333333,
  },
  recallQuality: {
    recallFailureRate: 0.277778,
    qualityFeedbackCount: 4,
  },
  usefulness: {
    feedbackCount: 6,
    highSeverityCount: 4,
  },
});

test("pilot ranking/decay tuning is deterministic across equivalent input ordering", () => {
  const feedbackA = [
    { category: "incident", severity: "high", action: "rollback" },
    { category: "quality", severity: "medium", action: "monitor" },
    { category: "ux", severity: "low", action: "none" },
  ];
  const feedbackB = [...feedbackA].reverse();

  const tuningA = generateRankingDecayTuning([SUMMARY_A, SUMMARY_B], {
    dashboards: [DASHBOARD_A],
    feedbackRecords: feedbackA,
  });
  const tuningB = generateRankingDecayTuning([SUMMARY_B, SUMMARY_A], {
    dashboards: [DASHBOARD_A],
    feedbackRecords: feedbackB,
  });

  assert.deepEqual(tuningA, tuningB);
  assert.equal(JSON.stringify(tuningA), JSON.stringify(tuningB));
});

test("pilot ranking/decay tuning includes required schema sections and fields", () => {
  const tuning = generateRankingDecayTuning([SUMMARY_A], {
    dashboards: [DASHBOARD_A],
    feedbackRecords: [{ category: "quality", severity: "low", action: "none" }],
  });

  assert.equal(tuning.schemaVersion, "pilot_ranking_decay_tuning.v1");
  assert.deepEqual(Object.keys(tuning), [
    "schemaVersion",
    "baseline",
    "observedMetrics",
    "recommendedRankingWeights",
    "recommendedDecayPolicy",
    "guardrails",
    "rationale",
  ]);
  assert.deepEqual(Object.keys(tuning.recommendedRankingWeights), [
    "recency",
    "semanticSimilarity",
    "reliability",
    "policySafety",
  ]);
  assert.equal(typeof tuning.observedMetrics.failureRate, "number");
  assert.equal(typeof tuning.guardrails.maxFailureRate, "number");
  assert.equal(Array.isArray(tuning.rationale.reasonCodes), true);
  assert.equal(tuning.rationale.reasonCodes.length > 0, true);
});

test("pilot ranking/decay tuning rejects malformed summary and dashboard inputs", async () => {
  assert.throws(
    () =>
      generateRankingDecayTuning([
        {
          schemaVersion: "wrong.v1",
          requestVolume: 1,
          successCount: 1,
          failureCount: 0,
        },
      ]),
    /schemaVersion must equal "pilot_rollout_report\.v1"/i
  );

  const fixtureRoot = await mkdtemp(
    resolve(tmpdir(), "pilot-ranking-tuning-malformed-")
  );
  const summaryPath = resolve(fixtureRoot, "summary.json");
  const dashboardPath = resolve(fixtureRoot, "dashboard.json");

  try {
    await writeFile(summaryPath, `${JSON.stringify(SUMMARY_A)}\n`, "utf8");
    await writeFile(
      dashboardPath,
      '{"schemaVersion":"pilot_kpi_dashboard.v1",',
      "utf8"
    );

    await assert.rejects(
      () => main(["--input", summaryPath, "--dashboard", dashboardPath]),
      /Invalid dashboard JSON/i
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("pilot ranking/decay tuning heuristics shift from baseline under recall failures and incidents", () => {
  const healthy = generateRankingDecayTuning([SUMMARY_A], {
    dashboards: [DASHBOARD_A],
    feedbackRecords: [{ category: "quality", severity: "low", action: "none" }],
  });
  const stressed = generateRankingDecayTuning([SUMMARY_STRESSED], {
    dashboards: [DASHBOARD_STRESSED],
    feedbackRecords: [
      { category: "incident", severity: "high", action: "rollback" },
      { category: "incident", severity: "high", action: "rollback" },
      { category: "quality", severity: "high", action: "hotfix" },
    ],
  });

  assert.equal(
    stressed.recommendedRankingWeights["reliability"] >
      stressed.baseline.rankingWeights["reliability"],
    true
  );
  assert.equal(
    stressed.recommendedRankingWeights["policySafety"] >
      stressed.baseline.rankingWeights["policySafety"],
    true
  );
  assert.equal(
    stressed.recommendedDecayPolicy.halfLifeDays <
      stressed.baseline.decayPolicy.halfLifeDays,
    true
  );
  assert.equal(
    stressed.recommendedRankingWeights["reliability"] >
      healthy.recommendedRankingWeights["reliability"],
    true
  );
  assert.equal(stressed.guardrails.abortOnRollbackSignal, true);
  assert.equal(stressed.guardrails.rollbackSignalDetected, true);
});

test("pilot ranking/decay tuning supports optional dashboard input", () => {
  const tuning = generateRankingDecayTuning([SUMMARY_A], {
    feedbackRecords: [{ category: "quality", severity: "low", action: "none" }],
  });

  assert.equal(tuning.observedMetrics.dashboardCount, 0);
  assert.equal(tuning.observedMetrics.requestVolume, SUMMARY_A.requestVolume);
  assert.equal(tuning.observedMetrics.failureRate, SUMMARY_A.failureRate);
  assert.equal(tuning.guardrails.abortOnRollbackSignal, true);
  assert.equal(tuning.guardrails.rollbackSignalDetected, false);
});

test("pilot ranking/decay tuning main writes compact output with feedback NDJSON", async () => {
  const fixtureRoot = await mkdtemp(
    resolve(tmpdir(), "pilot-ranking-tuning-cli-")
  );
  const summaryPath = resolve(fixtureRoot, "summary.json");
  const dashboardPath = resolve(fixtureRoot, "dashboard.json");
  const feedbackPath = resolve(fixtureRoot, "feedback.ndjson");
  const outputPath = resolve(fixtureRoot, "nested", "tuning.json");

  try {
    await writeFile(summaryPath, `${JSON.stringify(SUMMARY_A)}\n`, "utf8");
    await writeFile(dashboardPath, `${JSON.stringify(DASHBOARD_A)}\n`, "utf8");
    await writeFile(
      feedbackPath,
      `${JSON.stringify({ category: "incident", severity: "high", action: "rollback", timestamp: "2026-03-01T10:20:00.000Z" })}\n`,
      "utf8"
    );

    const code = await main([
      "--input",
      summaryPath,
      "--dashboard",
      dashboardPath,
      "--feedback",
      feedbackPath,
      "--compact",
      "--output",
      outputPath,
    ]);
    assert.equal(code, 0);

    const rawOutput = await readFile(outputPath, "utf8");
    const tuning = JSON.parse(rawOutput);
    assert.equal(rawOutput.includes("\n  "), false);
    assert.equal(tuning.schemaVersion, "pilot_ranking_decay_tuning.v1");
    assert.equal(tuning.guardrails.rollbackSignalDetected, true);
    assert.equal(tuning.guardrails.abortOnRollbackSignal, true);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
