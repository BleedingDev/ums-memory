import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import {
  generatePilotRolloutReport,
  main,
  parseTelemetryEvents,
} from "../../scripts/generate-pilot-rollout-report.mjs";

const FIXTURE_EVENTS = Object.freeze([
  {
    timestamp: "2026-03-01T10:00:00.000Z",
    team: "team-alpha",
    project: "project-x",
    operation: "context",
    status: "ok",
    latencyMs: 50,
    policyDecision: "allow",
  },
  {
    timestamp: "2026-03-01T10:00:01.000Z",
    team: "team-alpha",
    project: "project-x",
    operation: "context",
    status: "failed",
    latencyMs: 420,
    errorCode: "TIMEOUT",
    anomalyType: "latency_spike",
  },
  {
    timestamp: "2026-03-01T10:00:02.000Z",
    team: "team-alpha",
    project: "project-x",
    operation: "policy_decision_update",
    outcome: "deny",
    latencyMs: 20,
    policyDecision: "deny",
    anomalyType: "policy_spike",
  },
  {
    timestamp: "2026-03-01T10:00:03.000Z",
    team: "team-alpha",
    project: "project-x",
    operation: "ingest",
    status: "ok",
    durationMs: 100,
    policy: { decision: "review" },
  },
  {
    timestamp: "2026-03-01T10:00:04.000Z",
    team: "team-alpha",
    project: "project-x",
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
  assert.deepEqual(report.teamHistogram, {
    team_alpha: 5,
  });
  assert.deepEqual(report.projectHistogram, {
    project_x: 5,
  });
  assert.equal(report.invalidEventCount, 0);
  assert.deepEqual(report.perOperation, {
    context: {
      requestVolume: 2,
      successCount: 1,
      failureCount: 1,
      successRate: 0.5,
      failureRate: 0.5,
      p95LatencyMs: 420,
      latencySampleSize: 2,
      failureCodeHistogram: { TIMEOUT: 1 },
    },
    ingest: {
      requestVolume: 2,
      successCount: 1,
      failureCount: 1,
      successRate: 0.5,
      failureRate: 0.5,
      p95LatencyMs: 300,
      latencySampleSize: 2,
      failureCodeHistogram: { VALIDATION_ERROR: 1 },
    },
    policy_decision_update: {
      requestVolume: 1,
      successCount: 1,
      failureCount: 0,
      successRate: 1,
      failureRate: 0,
      p95LatencyMs: 20,
      latencySampleSize: 1,
      failureCodeHistogram: {},
    },
  });
  assert.deepEqual(report.telemetryWindow, {
    start: "2026-03-01T10:00:00.000Z",
    end: "2026-03-01T10:00:04.000Z",
  });
});

test("pilot rollout report rejects telemetry events missing required fields", () => {
  assert.throws(
    () =>
      generatePilotRolloutReport([
        {
          timestamp: "2026-03-01T10:00:00.000Z",
          team: "team-alpha",
          project: "project-x",
          operation: "context",
          latencyMs: 10,
        },
      ]),
    /missing outcome indicator/i,
  );

  assert.throws(
    () =>
      generatePilotRolloutReport([
        {
          timestamp: "2026-03-01T10:00:00.000Z",
          project: "project-x",
          operation: "context",
          status: "ok",
          latencyMs: 10,
        },
      ]),
    /missing required field: team/i,
  );

  assert.throws(
    () =>
      generatePilotRolloutReport([
        {
          timestamp: "2026-03-01T10:00:00.000Z",
          team: "team-alpha",
          project: "project-x",
          operation: "context",
          status: "ok",
        },
      ]),
    /latency field/i,
  );
});

test("pilot rollout report main creates parent output directories automatically", async () => {
  const fixtureRoot = await mkdtemp(resolve(tmpdir(), "pilot-rollout-report-"));
  const inputPath = resolve(fixtureRoot, "telemetry.ndjson");
  const outputPath = resolve(fixtureRoot, "nested", "reports", "summary.json");

  try {
    const fixture = `${JSON.stringify(FIXTURE_EVENTS[0])}\n`;
    await writeFile(inputPath, fixture, "utf8");
    const code = await main(["--input", inputPath, "--output", outputPath, "--compact"]);
    assert.equal(code, 0);

    const written = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(written.schemaVersion, "pilot_rollout_report.v1");
    assert.equal(written.requestVolume, 1);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("pilot rollout report main allow-invalid skips malformed NDJSON lines", async () => {
  const fixtureRoot = await mkdtemp(resolve(tmpdir(), "pilot-rollout-report-allow-invalid-"));
  const inputPath = resolve(fixtureRoot, "telemetry.ndjson");
  const outputPath = resolve(fixtureRoot, "summary.json");

  try {
    const fixture = `${JSON.stringify(FIXTURE_EVENTS[0])}\nnot json\n`;
    await writeFile(inputPath, fixture, "utf8");
    const code = await main([
      "--input",
      inputPath,
      "--output",
      outputPath,
      "--compact",
      "--allow-invalid",
    ]);
    assert.equal(code, 0);

    const written = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(written.requestVolume, 1);
    assert.equal(written.invalidEventCount, 1);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("pilot rollout report rejects malformed JSON arrays even in allow-invalid mode", async () => {
  const fixtureRoot = await mkdtemp(resolve(tmpdir(), "pilot-rollout-report-bad-array-"));
  const inputPath = resolve(fixtureRoot, "telemetry.json");

  try {
    await writeFile(inputPath, '[{"ok":true},]', "utf8");
    await assert.rejects(
      () => main(["--input", inputPath, "--allow-invalid"]),
      /Invalid JSON telemetry array/i,
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("pilot rollout report parses numeric status codes and compatible outcome tokens", () => {
  const report = generatePilotRolloutReport([
    {
      timestamp: "2026-03-01T10:00:00.000Z",
      team: "team-alpha",
      project: "project-x",
      operation: "policy_decision_update",
      outcome: "pass",
      latencyMs: 10,
    },
    {
      timestamp: "2026-03-01T10:00:01.000Z",
      team: "team-alpha",
      project: "project-x",
      operation: "policy_decision_update",
      status: "denied",
      latencyMs: 11,
    },
    {
      timestamp: "2026-03-01T10:00:01.500Z",
      team: "team-alpha",
      project: "project-x",
      operation: "policy_decision_update",
      success: "success",
      latencyMs: 11,
    },
    {
      timestamp: "2026-03-01T10:00:02.000Z",
      team: "team-alpha",
      project: "project-x",
      operation: "recall_authorization",
      status: "not_found",
      latencyMs: 12,
    },
    {
      timestamp: "2026-03-01T10:00:03.000Z",
      team: "team-alpha",
      project: "project-x",
      operation: "context",
      status: 500,
      latencyMs: 13,
      failureCode: "INTERNAL",
    },
    {
      timestamp: "2026-03-01T10:00:03.100Z",
      team: "team-alpha",
      project: "project-x",
      operation: "context",
      status: 1,
      latencyMs: 12,
    },
    {
      timestamp: "2026-03-01T10:00:03.200Z",
      team: "team-alpha",
      project: "project-x",
      operation: "context",
      status: 0,
      latencyMs: 12,
      failureCode: "ZERO_STATUS",
    },
  ]);

  assert.equal(report.requestVolume, 7);
  assert.equal(report.successCount, 5);
  assert.equal(report.failureCount, 2);
  assert.deepEqual(report.failureCodeHistogram, { INTERNAL: 1, ZERO_STATUS: 1 });
});

test("pilot rollout report rejects ambiguous timestamp formats", () => {
  assert.throws(
    () =>
      generatePilotRolloutReport([
        {
          timestamp: "2026-03-01 10:00:00",
          team: "team-alpha",
          project: "project-x",
          operation: "context",
          status: "ok",
          latencyMs: 10,
        },
      ]),
    /missing required field: timestamp/i,
  );
});

test("pilot rollout report allow-invalid mode skips malformed events and reports invalid count", () => {
  const ndjson = [
    JSON.stringify({
      timestamp: "2026-03-01T10:00:00.000Z",
      team: "team-alpha",
      project: "project-x",
      operation: "context",
      status: "ok",
      latencyMs: 10,
    }),
    "this is not json",
    JSON.stringify({
      timestamp: "2026-03-01T10:00:01.000Z",
      team: "team-alpha",
      project: "project-x",
      operation: "context",
      latencyMs: 10,
    }),
  ].join("\n");
  const parsed = parseTelemetryEvents(ndjson, { allowInvalid: true });
  const report = generatePilotRolloutReport(parsed, { allowInvalid: true });

  assert.equal(report.requestVolume, 1);
  assert.equal(report.invalidEventCount, 2);
  assert.equal(report.successCount, 1);
  assert.equal(report.failureCount, 0);
});

test("pilot rollout report preserves parsed invalid counts in default mode", () => {
  const parsed = parseTelemetryEvents(
    [
      FIXTURE_EVENTS[0],
      "invalid-entry",
    ],
    { allowInvalid: true },
  );
  const report = generatePilotRolloutReport(parsed);

  assert.equal(report.requestVolume, 1);
  assert.equal(report.invalidEventCount, 1);
});
