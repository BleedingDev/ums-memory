import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { createEngine, getEngineInfo } from "../tests/support/engine-adapter.mjs";
import { buildSyntheticEvents, buildSyntheticQueries, percentile } from "../tests/support/fixtures.mjs";

const config = Object.freeze({
  events: Number.parseInt(process.env.UMS_BENCH_EVENTS || "2000", 10),
  queries: Number.parseInt(process.env.UMS_BENCH_QUERIES || "300", 10),
  maxItems: Number.parseInt(process.env.UMS_BENCH_MAX_ITEMS || "10", 10),
  tokenBudget: Number.parseInt(process.env.UMS_BENCH_TOKEN_BUDGET || "220", 10),
});

const thresholds = Object.freeze({
  ingestP95Ms: Number.parseFloat(process.env.UMS_BENCH_THRESHOLD_INGEST_P95_MS || "2.5"),
  replayP95Ms: Number.parseFloat(process.env.UMS_BENCH_THRESHOLD_REPLAY_P95_MS || "2.5"),
  recallP95Ms: Number.parseFloat(process.env.UMS_BENCH_THRESHOLD_RECALL_P95_MS || "8.0"),
  recallPayloadMaxBytes: Number.parseInt(
    process.env.UMS_BENCH_THRESHOLD_RECALL_PAYLOAD_MAX_BYTES || "4096",
    10
  ),
});

function round(number) {
  return Number(number.toFixed(4));
}

function summarize(values) {
  return {
    p50: round(percentile(values, 50)),
    p95: round(percentile(values, 95)),
    max: round(percentile(values, 100)),
  };
}

function toPayloadBytes(recallResult) {
  if (typeof recallResult?.payloadBytes === "number") {
    return recallResult.payloadBytes;
  }
  return Buffer.byteLength(JSON.stringify(recallResult?.items ?? recallResult ?? []), "utf8");
}

function renderMarkdown(report) {
  const gateRows = Object.entries(report.gates)
    .map(([name, status]) => `| ${name} | ${status ? "pass" : "fail"} |`)
    .join("\n");

  return [
    "# UMS Phase 1/2 Latency Baseline",
    "",
    `Generated at: ${report.generatedAt}`,
    `Implementation: ${report.implementation.source}#${report.implementation.exportName}`,
    "",
    "## Workload",
    `- events: ${report.config.events}`,
    `- queries: ${report.config.queries}`,
    `- recall maxItems: ${report.config.maxItems}`,
    `- recall tokenBudget: ${report.config.tokenBudget}`,
    "",
    "## Metrics",
    "| metric | p50 | p95 | max |",
    "| --- | ---: | ---: | ---: |",
    `| ingest (ms) | ${report.metrics.ingestMs.p50} | ${report.metrics.ingestMs.p95} | ${report.metrics.ingestMs.max} |`,
    `| replay (ms) | ${report.metrics.replayMs.p50} | ${report.metrics.replayMs.p95} | ${report.metrics.replayMs.max} |`,
    `| recall (ms) | ${report.metrics.recallMs.p50} | ${report.metrics.recallMs.p95} | ${report.metrics.recallMs.max} |`,
    `| recall payload bytes | ${report.metrics.recallPayloadBytes.p50} | ${report.metrics.recallPayloadBytes.p95} | ${report.metrics.recallPayloadBytes.max} |`,
    "",
    "## Guardrail Gates",
    "| gate | status |",
    "| --- | --- |",
    gateRows,
    "",
  ].join("\n");
}

const implementation = await getEngineInfo();
const engine = await createEngine({ seed: "benchmark-seed" });

const events = buildSyntheticEvents({
  count: config.events,
  space: "bench-space",
  includeSecrets: true,
  includeUnsafe: true,
  intervalMs: 1_000,
});

const ingestMs = [];
const replayMs = [];
const recallMs = [];
const recallPayloadBytes = [];
let replayDuplicates = 0;

for (const event of events) {
  const started = performance.now();
  await engine.ingest(event);
  ingestMs.push(performance.now() - started);
}

for (const event of events) {
  const started = performance.now();
  const result = await engine.ingest(event);
  replayMs.push(performance.now() - started);
  replayDuplicates += Number(result?.duplicates || 0);
}

const queries = buildSyntheticQueries(config.queries);
for (const query of queries) {
  const started = performance.now();
  const recall = await engine.recall({
    space: "bench-space",
    query,
    maxItems: config.maxItems,
    tokenBudget: config.tokenBudget,
  });
  recallMs.push(performance.now() - started);
  recallPayloadBytes.push(toPayloadBytes(recall));
}

const metrics = {
  ingestMs: summarize(ingestMs),
  replayMs: summarize(replayMs),
  recallMs: summarize(recallMs),
  recallPayloadBytes: summarize(recallPayloadBytes),
  replayDuplicatesCaptured: replayDuplicates,
};

const gates = {
  ingestP95WithinThreshold: metrics.ingestMs.p95 <= thresholds.ingestP95Ms,
  replayP95WithinThreshold: metrics.replayMs.p95 <= thresholds.replayP95Ms,
  recallP95WithinThreshold: metrics.recallMs.p95 <= thresholds.recallP95Ms,
  recallPayloadMaxWithinThreshold:
    metrics.recallPayloadBytes.max <= thresholds.recallPayloadMaxBytes,
  replayCapturedAllDuplicates: replayDuplicates === config.events,
};

const report = {
  generatedAt: new Date().toISOString(),
  implementation,
  config,
  thresholds,
  metrics,
  gates,
};

const outputDir = resolve(process.cwd(), "docs/performance");
mkdirSync(outputDir, { recursive: true });
const jsonPath = resolve(outputDir, "phase1-phase2-latency-baseline.json");
const mdPath = resolve(outputDir, "phase1-phase2-latency-baseline.md");

writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
writeFileSync(mdPath, `${renderMarkdown(report)}\n`, "utf8");

console.log(`Wrote benchmark report: ${jsonPath}`);
console.log(`Wrote benchmark summary: ${mdPath}`);

if (Object.values(gates).some((status) => status === false)) {
  console.error("One or more benchmark guardrail gates failed.");
  process.exitCode = 1;
}
