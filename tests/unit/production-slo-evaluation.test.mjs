import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import {
  evaluateProductionSlos,
  main,
} from "../../scripts/evaluate-production-slos.mjs";

const EVALUATED_AT = "2026-03-02T18:30:00Z";

const DASHBOARD_PASS_A = Object.freeze({
  schemaVersion: "pilot_kpi_dashboard.v1",
  adoption: {
    requestVolume: 1200,
    successCount: 1195,
    failureCount: 5,
    successRate: 0.995833,
    failureRate: 0.004167,
  },
  quality: {
    p95LatencyMs: 220,
    p95LatencyEstimateMs: 215,
    anomalyHistogram: {
      recall_drift: 2,
      policy_spike: 1,
    },
    policyDecisionHistogram: {
      allow: 1170,
      review: 20,
      deny: 10,
    },
  },
  incidentRate: {
    incidentCount: 1,
    incidentsPer1kRequests: 0.833333,
  },
  recallQuality: {
    recallRequestVolume: 500,
    recallFailureCount: 15,
    recallFailureRate: 0.03,
  },
});

const DASHBOARD_PASS_B = Object.freeze({
  schemaVersion: "pilot_kpi_dashboard.v1",
  adoption: {
    requestVolume: 800,
    successCount: 798,
    failureCount: 2,
    successRate: 0.9975,
    failureRate: 0.0025,
  },
  quality: {
    p95LatencyMs: 240,
    p95LatencyEstimateMs: 236,
    anomalyHistogram: {
      latency_spike: 2,
    },
    policyDecisionHistogram: {
      allow: 790,
      review: 10,
    },
  },
  incidentRate: {
    incidentCount: 1,
    incidentsPer1kRequests: 1.25,
  },
  recallQuality: {
    recallRequestVolume: 300,
    recallFailureCount: 9,
    recallFailureRate: 0.03,
  },
});

const DASHBOARD_FAIL = Object.freeze({
  schemaVersion: "pilot_kpi_dashboard.v1",
  adoption: {
    requestVolume: 1000,
    successCount: 960,
    failureCount: 40,
    successRate: 0.96,
    failureRate: 0.04,
  },
  quality: {
    p95LatencyMs: 420,
    p95LatencyEstimateMs: 415,
    anomalyHistogram: {
      recall_drift: 15,
      policy_spike: 12,
    },
    policyDecisionHistogram: {
      allow: 700,
      review: 200,
      deny: 100,
    },
  },
  incidentRate: {
    incidentCount: 8,
    incidentsPer1kRequests: 8,
  },
  recallQuality: {
    recallRequestVolume: 400,
    recallFailureCount: 120,
    recallFailureRate: 0.3,
  },
});

const TUNING_FIXTURE = Object.freeze({
  schemaVersion: "pilot_ranking_decay_tuning.v1",
  guardrails: {
    maxFailureRate: 0.006,
    maxRecallFailureRate: 0.05,
    maxP95LatencyMs: 260,
    maxIncidentsPer1kRequests: 2.5,
    maxAnomaliesPer1kRequests: 5,
    maxPolicyReviewRate: 0.08,
    abortOnRollbackSignal: true,
  },
});

test("production SLO evaluation is deterministic across equivalent dashboard ordering", () => {
  const resultA = evaluateProductionSlos(
    [DASHBOARD_PASS_A, DASHBOARD_PASS_B],
    {
      evaluatedAt: EVALUATED_AT,
      dashboardSources: ["z-day-2.json", "a-day-1.json"],
    },
  );
  const resultB = evaluateProductionSlos(
    [DASHBOARD_PASS_B, DASHBOARD_PASS_A],
    {
      evaluatedAt: EVALUATED_AT,
      dashboardSources: ["a-day-1.json", "z-day-2.json"],
    },
  );

  assert.deepEqual(resultA, resultB);
  assert.equal(JSON.stringify(resultA), JSON.stringify(resultB));
});

test("production SLO evaluation returns pass verdict for healthy metrics", () => {
  const result = evaluateProductionSlos([DASHBOARD_PASS_A, DASHBOARD_PASS_B], {
    evaluatedAt: EVALUATED_AT,
  });

  assert.equal(result.verdict, "pass");
  assert.deepEqual(result.failedObjectives, []);
  assert.equal(result.measurements.requestVolume, 2000);
  assert.equal(result.measurements.successRate, 0.9965);
  assert.equal(result.measurements.p95LatencyMs, 240);
  assert.equal(result.actionPlan[0].objective, "all");
});

test("production SLO evaluation records tuning guardrail metadata deterministically", () => {
  const result = evaluateProductionSlos([DASHBOARD_PASS_A], {
    evaluatedAt: EVALUATED_AT,
    tuningRecommendation: TUNING_FIXTURE,
    tuningSource: "fixtures/tuning.json",
  });

  assert.equal(result.inputs.tuningProvided, true);
  assert.equal(result.inputs.tuningSchemaVersion, "pilot_ranking_decay_tuning.v1");
  assert.equal(result.inputs.tuningSource, "fixtures/tuning.json");

  assert.equal(result.thresholds.successRate.source, "baseline_and_tuning_guardrails");
  assert.equal(result.thresholds.failureRate.source, "baseline_and_tuning_guardrails");
  assert.equal(result.thresholds.p95LatencyMs.source, "baseline_and_tuning_guardrails");
  assert.equal(result.thresholds.incidentsPer1kRequests.source, "baseline_and_tuning_guardrails");
  assert.equal(result.thresholds.recallFailureRate.source, "baseline_and_tuning_guardrails");
  assert.equal(result.thresholds.anomaliesPer1kRequests.source, "baseline_and_tuning_guardrails");
  assert.equal(result.thresholds.policyReviewRate.source, "baseline_and_tuning_guardrails");

  assert.equal(result.thresholds.successRate.tuningDerivedFromMaxFailureRate, 0.006);
  assert.equal(result.thresholds.failureRate.tuning, 0.006);
  assert.equal(result.thresholds.p95LatencyMs.tuning, 260);
  assert.equal(result.thresholds.incidentsPer1kRequests.tuning, 2.5);
  assert.equal(result.thresholds.recallFailureRate.tuning, 0.05);
  assert.equal(result.thresholds.anomaliesPer1kRequests.tuning, 5);
  assert.equal(result.thresholds.policyReviewRate.tuning, 0.08);
});

test("production SLO evaluation returns fail verdict with failed objective details", () => {
  const result = evaluateProductionSlos([DASHBOARD_FAIL], {
    evaluatedAt: EVALUATED_AT,
  });

  assert.equal(result.verdict, "fail");
  assert.equal(result.failedObjectives.length, 7);

  const failureRateFailure = result.failedObjectives.find(
    (objective) => objective.objective === "failureRate",
  );
  assert.deepEqual(failureRateFailure, {
    objective: "failureRate",
    description: "Global failure rate",
    operator: "<=",
    threshold: 0.005,
    actual: 0.04,
    reason: "threshold_breach",
  });

  const recallFailure = result.failedObjectives.find(
    (objective) => objective.objective === "recallFailureRate",
  );
  assert.equal(recallFailure?.actual, 0.3);
  assert.equal(result.actionPlan.length, result.failedObjectives.length);
});

test("production SLO evaluation rejects malformed dashboard contracts", () => {
  assert.throws(
    () =>
      evaluateProductionSlos(
        [
          {
            schemaVersion: "pilot_kpi_dashboard.v1",
            adoption: {
              requestVolume: 10,
            },
            quality: {},
            incidentRate: {},
            recallQuality: {},
          },
        ],
        { evaluatedAt: EVALUATED_AT },
      ),
    /missing required field: dashboards\[0\]\.adoption\.successCount/i,
  );
});

test("production SLO evaluation accepts RFC3339 timestamps with fractional seconds", () => {
  const result = evaluateProductionSlos([DASHBOARD_PASS_A], {
    evaluatedAt: "2026-03-02T18:30:00.12Z",
  });

  assert.equal(result.evaluatedAt, "2026-03-02T18:30:00.120Z");
});

test("production SLO evaluation CLI writes compact output file", async () => {
  const fixtureRoot = await mkdtemp(resolve(tmpdir(), "production-slo-evaluation-cli-"));
  const dashboardPath = resolve(fixtureRoot, "dashboard.json");
  const tuningPath = resolve(fixtureRoot, "tuning.json");
  const outputPath = resolve(fixtureRoot, "nested", "production-slo-evaluation.json");

  try {
    await writeFile(dashboardPath, `${JSON.stringify(DASHBOARD_PASS_A)}\n`, "utf8");
    await writeFile(tuningPath, `${JSON.stringify(TUNING_FIXTURE)}\n`, "utf8");

    const code = await main([
      "--dashboard",
      dashboardPath,
      "--tuning",
      tuningPath,
      "--evaluated-at",
      "2026-03-02T22:00:00Z",
      "--output",
      outputPath,
      "--compact",
    ]);
    assert.equal(code, 0);

    const rawOutput = await readFile(outputPath, "utf8");
    const parsed = JSON.parse(rawOutput);
    assert.equal(rawOutput.includes("\n  "), false);
    assert.equal(parsed.schemaVersion, "production_slo_evaluation.v1");
    assert.equal(parsed.evaluatedAt, "2026-03-02T22:00:00.000Z");
    assert.equal(parsed.inputs.tuningProvided, true);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("production SLO evaluation CLI returns exit code 2 on failed objectives", async () => {
  const fixtureRoot = await mkdtemp(resolve(tmpdir(), "production-slo-evaluation-cli-fail-"));
  const dashboardPath = resolve(fixtureRoot, "dashboard-fail.json");
  const outputPath = resolve(fixtureRoot, "slo-fail.json");

  try {
    await writeFile(dashboardPath, `${JSON.stringify(DASHBOARD_FAIL)}\n`, "utf8");
    const code = await main([
      "--dashboard",
      dashboardPath,
      "--evaluated-at",
      "2026-03-02T22:00:00Z",
      "--output",
      outputPath,
      "--compact",
    ]);
    assert.equal(code, 2);

    const rawOutput = await readFile(outputPath, "utf8");
    const parsed = JSON.parse(rawOutput);
    assert.equal(parsed.verdict, "fail");
    assert.equal(parsed.failedObjectives.length > 0, true);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
