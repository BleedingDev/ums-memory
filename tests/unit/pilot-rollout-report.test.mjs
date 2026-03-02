import assert from "node:assert/strict";
import test from "node:test";

import {
  generatePilotRolloutReport,
  parseTelemetryEvents,
} from "../../scripts/generate-pilot-rollout-report.mjs";

const FIXTURE_EVENTS = Object.freeze([
  {
    timestamp: "2026-03-01T10:00:00.000Z",
    operation: "context",
    status: "ok",
    latencyMs: 50,
    policyDecision: "allow",
  },
  {
    timestamp: "2026-03-01T10:00:01.000Z",
    operation: "context",
    status: "failed",
    latencyMs: 420,
    errorCode: "TIMEOUT",
    anomalyType: "latency_spike",
  },
  {
    timestamp: "2026-03-01T10:00:02.000Z",
    operation: "policy_decision_update",
    outcome: "deny",
    latencyMs: 20,
    policyDecision: "deny",
    anomalyType: "policy_spike",
  },
  {
    timestamp: "2026-03-01T10:00:03.000Z",
    operation: "ingest",
    status: "ok",
    durationMs: 100,
    policy: { decision: "review" },
  },
  {
    timestamp: "2026-03-01T10:00:04.000Z",
    operation: "ingest",
    success: false,
    latency_ms: 300,
    failureCode: "VALIDATION_ERROR",
  },
]);

test("pilot rollout report is deterministic for equivalent telemetry payloads", () => {
  const jsonArrayInput = JSON.stringify(FIXTURE_EVENTS);
  const ndjsonInput = [...FIXTURE_EVENTS]
    .reverse()
    .map((event) => JSON.stringify(event))
    .join("\n");

  const fromArray = generatePilotRolloutReport(parseTelemetryEvents(jsonArrayInput));
  const fromNdjson = generatePilotRolloutReport(parseTelemetryEvents(ndjsonInput));

  assert.deepEqual(fromArray, fromNdjson);
});

test("pilot rollout report schema includes required KPI fields", () => {
  const report = generatePilotRolloutReport(FIXTURE_EVENTS);

  assert.equal(report.schemaVersion, "pilot_rollout_report.v1");
  assert.equal(report.requestVolume, 5);
  assert.equal(report.successCount, 3);
  assert.equal(report.failureCount, 2);
  assert.equal(report.successRate, 0.6);
  assert.equal(report.failureRate, 0.4);
  assert.equal(report.p95LatencyMs, 420);
  assert.equal(report.latencySampleSize, 5);

  assert.deepEqual(report.operationHistogram, {
    context: 2,
    ingest: 2,
    policy_decision_update: 1,
  });
  assert.deepEqual(report.failureCodeHistogram, {
    TIMEOUT: 1,
    VALIDATION_ERROR: 1,
  });
  assert.deepEqual(report.policyDecisionHistogram, {
    allow: 1,
    deny: 1,
    review: 1,
  });
  assert.deepEqual(report.anomalyHistogram, {
    latency_spike: 1,
    policy_spike: 1,
  });
  assert.deepEqual(report.telemetryWindow, {
    start: "2026-03-01T10:00:00.000Z",
    end: "2026-03-01T10:00:04.000Z",
  });
});
