import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import {
  generatePilotKpiDashboard,
  main,
  parseFeedbackEvents,
} from "../../scripts/generate-pilot-kpi-dashboard.mjs";

const SUMMARY_A = Object.freeze({
  schemaVersion: "pilot_rollout_report.v1",
  requestVolume: 10,
  successCount: 9,
  failureCount: 1,
  successRate: 0.9,
  failureRate: 0.1,
  p95LatencyMs: 220,
  latencySampleSize: 10,
  operationHistogram: {
    ingest: 4,
    context: 6,
  },
  failureCodeHistogram: {
    TIMEOUT: 1,
  },
  policyDecisionHistogram: {
    review: 1,
    allow: 9,
  },
  anomalyHistogram: {
    latency_spike: 1,
  },
  teamHistogram: {
    team_alpha: 10,
  },
  projectHistogram: {
    project_x: 10,
  },
  perOperation: {
    context: {
      requestVolume: 6,
      successCount: 5,
      failureCount: 1,
      successRate: 0.833333,
      failureRate: 0.166667,
      p95LatencyMs: 220,
      latencySampleSize: 6,
      failureCodeHistogram: {
        TIMEOUT: 1,
      },
    },
    ingest: {
      requestVolume: 4,
      successCount: 4,
      failureCount: 0,
      successRate: 1,
      failureRate: 0,
      p95LatencyMs: 180,
      latencySampleSize: 4,
      failureCodeHistogram: {},
    },
  },
  invalidEventCount: 0,
  telemetryWindow: {
    start: "2026-03-01T10:00:00.000Z",
    end: "2026-03-01T10:10:00.000Z",
  },
});

const SUMMARY_B = Object.freeze({
  schemaVersion: "pilot_rollout_report.v1",
  requestVolume: 8,
  successCount: 7,
  failureCount: 1,
  successRate: 0.875,
  failureRate: 0.125,
  p95LatencyMs: 260,
  latencySampleSize: 8,
  operationHistogram: {
    retrieval_query: 5,
    context: 3,
  },
  failureCodeHistogram: {
    INTERNAL: 1,
  },
  policyDecisionHistogram: {
    allow: 8,
  },
  anomalyHistogram: {
    recall_drift: 2,
  },
  teamHistogram: {
    team_alpha: 8,
  },
  projectHistogram: {
    project_x: 8,
  },
  perOperation: {
    retrieval_query: {
      requestVolume: 5,
      successCount: 4,
      failureCount: 1,
      successRate: 0.8,
      failureRate: 0.2,
      p95LatencyMs: 260,
      latencySampleSize: 5,
      failureCodeHistogram: {
        INTERNAL: 1,
      },
    },
    context: {
      requestVolume: 3,
      successCount: 3,
      failureCount: 0,
      successRate: 1,
      failureRate: 0,
      p95LatencyMs: 180,
      latencySampleSize: 3,
      failureCodeHistogram: {},
    },
  },
  invalidEventCount: 1,
  telemetryWindow: {
    start: "2026-03-01T10:15:00.000Z",
    end: "2026-03-01T10:30:00.000Z",
  },
});

const FEEDBACK_A = [
  JSON.stringify({
    timestamp: "2026-03-01T10:05:00.000Z",
    category: "quality",
    severity: "medium",
    action: "monitor",
  }),
  JSON.stringify({
    timestamp: "2026-03-01T10:20:00.000Z",
    category: "incident",
    severity: "high",
    action: "rollback",
  }),
  JSON.stringify({
    timestamp: "2026-03-01T10:25:00.000Z",
    category: "ux",
    severity: "low",
    action: "none",
  }),
].join("\n");

const FEEDBACK_B = [
  JSON.stringify({
    timestamp: "2026-03-01T10:25:00.000Z",
    category: "ux",
    severity: "low",
    action: "none",
  }),
  JSON.stringify({
    timestamp: "2026-03-01T10:20:00.000Z",
    category: "incident",
    severity: "high",
    action: "rollback",
  }),
  JSON.stringify({
    timestamp: "2026-03-01T10:05:00.000Z",
    category: "quality",
    severity: "medium",
    action: "monitor",
  }),
].join("\n");

test("pilot KPI dashboard is deterministic across file and feedback ordering", () => {
  const dashboardA = generatePilotKpiDashboard(
    [SUMMARY_A, SUMMARY_B],
    parseFeedbackEvents(FEEDBACK_A),
  );
  const dashboardB = generatePilotKpiDashboard(
    [SUMMARY_B, SUMMARY_A],
    parseFeedbackEvents(FEEDBACK_B),
  );

  assert.deepEqual(dashboardA, dashboardB);
});

test("pilot KPI dashboard includes required schema sections", () => {
  const dashboard = generatePilotKpiDashboard([SUMMARY_A], parseFeedbackEvents(FEEDBACK_A));

  assert.equal(dashboard.schemaVersion, "pilot_kpi_dashboard.v1");
  assert.deepEqual(Object.keys(dashboard), [
    "schemaVersion",
    "adoption",
    "quality",
    "usefulness",
    "incidentRate",
    "recallQuality",
    "telemetryWindow",
  ]);
  assert.deepEqual(dashboard.adoption.operationHistogram, {
    context: 6,
    ingest: 4,
  });
  assert.deepEqual(dashboard.quality.failureCodeHistogram, {
    TIMEOUT: 1,
  });
  assert.equal(dashboard.quality.p95LatencyMs, 220);
  assert.equal(dashboard.quality.p95LatencyEstimateMs, 220);
  assert.equal(dashboard.incidentRate.incidentCount, 1);
  assert.equal(dashboard.recallQuality.recallRequestVolume, 6);
  assert.deepEqual(dashboard.recallQuality.recallFailureCodeHistogram, {
    TIMEOUT: 1,
  });
  assert.equal(dashboard.telemetryWindow.start, "2026-03-01T10:00:00.000Z");
  assert.equal(dashboard.telemetryWindow.end, "2026-03-01T10:10:00.000Z");
  assert.equal(dashboard.telemetryWindow.feedbackStart, "2026-03-01T10:05:00.000Z");
  assert.equal(dashboard.telemetryWindow.feedbackEnd, "2026-03-01T10:25:00.000Z");
});

test("pilot KPI dashboard quality p95 is conservative max with explicit weighted estimate", () => {
  const dashboard = generatePilotKpiDashboard([SUMMARY_A, SUMMARY_B], parseFeedbackEvents(FEEDBACK_A));

  assert.equal(dashboard.quality.p95LatencyMs, 260);
  assert.equal(dashboard.quality.maxP95LatencyMs, 260);
  assert.equal(dashboard.quality.p95LatencyEstimateMs, 237.778);
});

test("pilot KPI dashboard rejects malformed summary inputs", () => {
  assert.throws(
    () =>
      generatePilotKpiDashboard([
        {
          schemaVersion: "pilot_rollout_report.v1",
          successCount: 1,
          failureCount: 0,
        },
      ]),
    /missing required field: summaries\[0\]\.requestVolume/i,
  );

  assert.throws(
    () =>
      generatePilotKpiDashboard([
        {
          ...SUMMARY_A,
          schemaVersion: "wrong.v1",
        },
      ]),
    /schemaVersion must equal "pilot_rollout_report\.v1"/i,
  );
});

test("pilot KPI dashboard main supports allow-invalid feedback skipping with compact output", async () => {
  const fixtureRoot = await mkdtemp(resolve(tmpdir(), "pilot-kpi-dashboard-"));
  const summaryPath = resolve(fixtureRoot, "summary.json");
  const feedbackPath = resolve(fixtureRoot, "feedback.ndjson");
  const outputPath = resolve(fixtureRoot, "nested", "reports", "dashboard.json");

  try {
    await writeFile(summaryPath, `${JSON.stringify(SUMMARY_A)}\n`, "utf8");
    await writeFile(
      feedbackPath,
      [
        JSON.stringify({
          timestamp: "2026-03-01T10:05:00.000Z",
          category: "quality",
          severity: "low",
          action: "none",
        }),
        "this is not json",
        JSON.stringify({
          timestamp: "2026-03-01T10:06:00.000Z",
          severity: "low",
          action: "none",
        }),
      ].join("\n"),
      "utf8",
    );

    const code = await main([
      "--input",
      summaryPath,
      "--feedback",
      feedbackPath,
      "--allow-invalid",
      "--compact",
      "--output",
      outputPath,
    ]);
    assert.equal(code, 0);

    const rawOutput = await readFile(outputPath, "utf8");
    const dashboard = JSON.parse(rawOutput);
    assert.equal(dashboard.usefulness.feedbackCount, 1);
    assert.equal(dashboard.usefulness.invalidFeedbackCount, 2);
    assert.equal(dashboard.usefulness.highSeverityCount, 0);
    assert.equal(rawOutput.includes("\n  "), false);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
