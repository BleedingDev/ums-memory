import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";

import {
  createEngine,
  getEngineInfo,
} from "../tests/support/engine-adapter.ts";
import {
  buildSyntheticEvents,
  buildSyntheticQueries,
  percentile,
} from "../tests/support/fixtures.ts";

const config = Object.freeze({
  events: Number.parseInt(process.env["UMS_BENCH_EVENTS"] || "2000", 10),
  queries: Number.parseInt(process.env["UMS_BENCH_QUERIES"] || "300", 10),
  maxItems: Number.parseInt(process.env["UMS_BENCH_MAX_ITEMS"] || "10", 10),
  tokenBudget: Number.parseInt(
    process.env["UMS_BENCH_TOKEN_BUDGET"] || "220",
    10
  ),
  stores: String(process.env["UMS_BENCH_STORES"] || "coding-agent,jira-history")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean),
});

const thresholds = Object.freeze({
  ingestP95Ms: Number.parseFloat(
    process.env["UMS_BENCH_THRESHOLD_INGEST_P95_MS"] || "2.5"
  ),
  replayP95Ms: Number.parseFloat(
    process.env["UMS_BENCH_THRESHOLD_REPLAY_P95_MS"] || "2.5"
  ),
  recallP95Ms: Number.parseFloat(
    process.env["UMS_BENCH_THRESHOLD_RECALL_P95_MS"] || "8.0"
  ),
  recallPayloadMaxBytes: Number.parseInt(
    process.env["UMS_BENCH_THRESHOLD_RECALL_PAYLOAD_MAX_BYTES"] || "4096",
    10
  ),
});

function round(number: any) {
  return Number(number.toFixed(4));
}

function summarize(values: any) {
  return {
    p50: round(percentile(values, 50)),
    p95: round(percentile(values, 95)),
    max: round(percentile(values, 100)),
  };
}

function toPayloadBytes(recallResult: any) {
  if (typeof recallResult?.payloadBytes === "number") {
    return recallResult.payloadBytes;
  }
  return Buffer.byteLength(
    JSON.stringify(recallResult?.items ?? recallResult ?? []),
    "utf8"
  );
}

function collectGateFailures(gates: any) {
  return Object.values(gates).some((value) => value === false);
}

function renderMarkdown(report: any) {
  const gateRows = Object.entries(report.gates)
    .map(([name, status]) => `| ${name} | ${status ? "pass" : "fail"} |`)
    .join("\n");

  const perStoreRows = Object.entries(report.metrics.byStore)
    .map(([storeId, metrics]) => {
      return [
        `### Store: ${storeId}`,
        "",
        "| metric | p50 | p95 | max |",
        "| --- | ---: | ---: | ---: |",
        `| ingest (ms) | ${(metrics as any).ingestMs.p50} | ${(metrics as any).ingestMs.p95} | ${(metrics as any).ingestMs.max} |`,
        `| replay (ms) | ${(metrics as any).replayMs.p50} | ${(metrics as any).replayMs.p95} | ${(metrics as any).replayMs.max} |`,
        `| recall (ms) | ${(metrics as any).recallMs.p50} | ${(metrics as any).recallMs.p95} | ${(metrics as any).recallMs.max} |`,
        `| recall payload bytes | ${(metrics as any).recallPayloadBytes.p50} | ${(metrics as any).recallPayloadBytes.p95} | ${(metrics as any).recallPayloadBytes.max} |`,
        "",
      ].join("\n");
    })
    .join("\n");

  const perStoreGateRows = Object.entries(report.gatesByStore)
    .flatMap(([storeId, storeGates]) => {
      if (storeGates === null || typeof storeGates !== "object") {
        return [];
      }
      return Object.entries(storeGates as Record<string, boolean>).map(
        ([name, status]) =>
          `| ${storeId} | ${name} | ${status ? "pass" : "fail"} |`
      );
    })
    .join("\n");

  return [
    "# UMS Phase 1/2 Latency Baseline",
    "",
    `Generated at: ${report.generatedAt}`,
    `Implementation: ${report.implementation.source}#${report.implementation.exportName}`,
    "",
    "## Workload",
    `- stores: ${report.config.stores.join(", ")}`,
    `- events per store: ${report.config.events}`,
    `- queries per store: ${report.config.queries}`,
    `- recall maxItems: ${report.config.maxItems}`,
    `- recall tokenBudget: ${report.config.tokenBudget}`,
    "",
    "## Aggregated Metrics",
    "| metric | p50 | p95 | max |",
    "| --- | ---: | ---: | ---: |",
    `| ingest (ms) | ${report.metrics.ingestMs.p50} | ${report.metrics.ingestMs.p95} | ${report.metrics.ingestMs.max} |`,
    `| replay (ms) | ${report.metrics.replayMs.p50} | ${report.metrics.replayMs.p95} | ${report.metrics.replayMs.max} |`,
    `| recall (ms) | ${report.metrics.recallMs.p50} | ${report.metrics.recallMs.p95} | ${report.metrics.recallMs.max} |`,
    `| recall payload bytes | ${report.metrics.recallPayloadBytes.p50} | ${report.metrics.recallPayloadBytes.p95} | ${report.metrics.recallPayloadBytes.max} |`,
    "",
    "## Per-Store Metrics",
    perStoreRows,
    "## Aggregated Guardrail Gates",
    "| gate | status |",
    "| --- | --- |",
    gateRows,
    "",
    "## Per-Store Guardrail Gates",
    "| store | gate | status |",
    "| --- | --- | --- |",
    perStoreGateRows,
    "",
  ].join("\n");
}

const implementation = await getEngineInfo();
const engine = await createEngine({ seed: "benchmark-seed" });
const queries = buildSyntheticQueries(config.queries);

const ingestMs: any[] = [];
const replayMs: any[] = [];
const recallMs: any[] = [];
const recallPayloadBytes: any[] = [];
let replayDuplicates = 0;

const byStore: Record<string, any> = {};
const duplicatesByStore: Record<string, any> = {};

for (let storeIndex = 0; storeIndex < config.stores.length; storeIndex += 1) {
  const storeId = config.stores[storeIndex];
  if (storeId === undefined) {
    continue;
  }
  const space = `bench-space-${storeIndex + 1}`;
  const events = buildSyntheticEvents({
    count: config.events,
    space,
    includeSecrets: true,
    includeUnsafe: true,
    intervalMs: 1_000,
  }).map((event) => ({
    ...event,
    storeId,
    source: storeId.includes("jira") ? "jira" : event.source,
  }));

  const ingestPerStore: any[] = [];
  const replayPerStore: any[] = [];
  const recallPerStore: any[] = [];
  const payloadPerStore: any[] = [];
  let replayDuplicatesPerStore = 0;

  for (const event of events) {
    const started = performance.now();
    await engine.ingest(event);
    const elapsed = performance.now() - started;
    ingestPerStore.push(elapsed);
    ingestMs.push(elapsed);
  }

  for (const event of events) {
    const started = performance.now();
    const result = await engine.ingest(event);
    const elapsed = performance.now() - started;
    replayPerStore.push(elapsed);
    replayMs.push(elapsed);
    const dupes =
      result !== null &&
      typeof result === "object" &&
      "duplicates" in result &&
      typeof (result as { duplicates?: unknown }).duplicates === "number"
        ? (result as { duplicates: number }).duplicates
        : 0;
    replayDuplicatesPerStore += dupes;
    replayDuplicates += dupes;
  }

  for (const query of queries) {
    const started = performance.now();
    const recall = await engine.recall({
      storeId,
      space,
      query,
      maxItems: config.maxItems,
      tokenBudget: config.tokenBudget,
    });
    const elapsed = performance.now() - started;
    recallPerStore.push(elapsed);
    recallMs.push(elapsed);
    const bytes = toPayloadBytes(recall);
    payloadPerStore.push(bytes);
    recallPayloadBytes.push(bytes);
  }

  byStore[storeId] = {
    ingestMs: summarize(ingestPerStore),
    replayMs: summarize(replayPerStore),
    recallMs: summarize(recallPerStore),
    recallPayloadBytes: summarize(payloadPerStore),
    replayDuplicatesCaptured: replayDuplicatesPerStore,
  };
  duplicatesByStore[storeId] = replayDuplicatesPerStore;
}

const metrics = {
  ingestMs: summarize(ingestMs),
  replayMs: summarize(replayMs),
  recallMs: summarize(recallMs),
  recallPayloadBytes: summarize(recallPayloadBytes),
  replayDuplicatesCaptured: replayDuplicates,
  byStore,
};

const gates = {
  ingestP95WithinThreshold: metrics.ingestMs.p95 <= thresholds.ingestP95Ms,
  replayP95WithinThreshold: metrics.replayMs.p95 <= thresholds.replayP95Ms,
  recallP95WithinThreshold: metrics.recallMs.p95 <= thresholds.recallP95Ms,
  recallPayloadMaxWithinThreshold:
    metrics.recallPayloadBytes.max <= thresholds.recallPayloadMaxBytes,
  replayCapturedAllDuplicates:
    replayDuplicates === config.events * config.stores.length,
};

const gatesByStore: Record<string, any> = {};
for (const storeId of Object.keys(byStore).sort()) {
  const storeMetrics = byStore[storeId];
  gatesByStore[storeId] = {
    ingestP95WithinThreshold:
      storeMetrics.ingestMs.p95 <= thresholds.ingestP95Ms,
    replayP95WithinThreshold:
      storeMetrics.replayMs.p95 <= thresholds.replayP95Ms,
    recallP95WithinThreshold:
      storeMetrics.recallMs.p95 <= thresholds.recallP95Ms,
    recallPayloadMaxWithinThreshold:
      storeMetrics.recallPayloadBytes.max <= thresholds.recallPayloadMaxBytes,
    replayCapturedAllDuplicates: duplicatesByStore[storeId] === config.events,
  };
}

const report = {
  generatedAt: new Date().toISOString(),
  implementation,
  config,
  thresholds,
  metrics,
  gates,
  gatesByStore,
};

const outputDir = resolve(process.cwd(), "docs/performance");
mkdirSync(outputDir, { recursive: true });
const jsonPath = resolve(outputDir, "phase1-phase2-latency-baseline.json");
const mdPath = resolve(outputDir, "phase1-phase2-latency-baseline.md");

writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
writeFileSync(mdPath, `${renderMarkdown(report)}\n`, "utf8");

console.log(`Wrote benchmark report: ${jsonPath}`);
console.log(`Wrote benchmark summary: ${mdPath}`);

if (
  collectGateFailures(gates) ||
  Object.values(gatesByStore).some((storeGates) =>
    collectGateFailures(storeGates)
  )
) {
  console.error("One or more benchmark guardrail gates failed.");
  process.exitCode = 1;
}
