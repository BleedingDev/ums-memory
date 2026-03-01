import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { executeOperation, resetStore } from "../src/core.mjs";

const PROFILE = "bench";
const STORE_ID = "bench-store";
const ITERATIONS = Number.parseInt(process.env.UMS_BENCH_ITERATIONS ?? "300", 10);
const VOLUMES = String(process.env.UMS_BENCH_SCHEDULE_VOLUMES ?? "64,128,256")
  .split(",")
  .map((entry) => Number.parseInt(entry.trim(), 10))
  .filter((entry) => Number.isFinite(entry) && entry > 0)
  .sort((left, right) => left - right);
const NEAR_CONSTANT_RATIO_THRESHOLD = Number.parseFloat(
  process.env.UMS_BENCH_NEAR_CONSTANT_RATIO_THRESHOLD ?? "4.0",
);
const UPDATE_P95_THRESHOLD_MS = Number.parseFloat(
  process.env.UMS_BENCH_SCHEDULE_UPDATE_P95_THRESHOLD_MS ?? "0.8",
);
const CLOCK_P95_THRESHOLD_MS = Number.parseFloat(
  process.env.UMS_BENCH_SCHEDULE_CLOCK_P95_THRESHOLD_MS ?? "3.8",
);
const REBALANCE_P95_THRESHOLD_MS = Number.parseFloat(
  process.env.UMS_BENCH_SCHEDULE_REBALANCE_P95_THRESHOLD_MS ?? "4.5",
);

function round(value, digits = 6) {
  return Number(value.toFixed(digits));
}

function benchThroughput(name, fn) {
  const start = process.hrtime.bigint();
  for (let i = 0; i < ITERATIONS; i += 1) {
    fn(i);
  }
  const elapsedNs = process.hrtime.bigint() - start;
  const elapsedMs = Number(elapsedNs) / 1e6;
  const opsPerSec = (ITERATIONS / elapsedMs) * 1000;
  return {
    operation: name,
    iterations: ITERATIONS,
    elapsedMs: round(elapsedMs, 3),
    opsPerSec: round(opsPerSec, 2),
  };
}

function percentile(values, p) {
  if (!Array.isArray(values) || values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function summarizeLatency(values) {
  return {
    p50Ms: round(percentile(values, 50), 4),
    p95Ms: round(percentile(values, 95), 4),
    maxMs: round(percentile(values, 100), 4),
  };
}

function measure(fn) {
  const started = process.hrtime.bigint();
  fn();
  const elapsedNs = process.hrtime.bigint() - started;
  return Number(elapsedNs) / 1e6;
}

function makeIsoAtOffset(baseIso, offsetMinutes) {
  const baseMs = Date.parse(baseIso);
  return new Date(baseMs + offsetMinutes * 60 * 1000).toISOString();
}

function seedScheduleEntries(volume, baseIso) {
  for (let index = 0; index < volume; index += 1) {
    executeOperation("review_schedule_update", {
      storeId: STORE_ID,
      profile: PROFILE,
      scheduleEntryId: `srs_${volume}_${index}`,
      targetId: `target_${index}`,
      status: index % 3 === 0 ? "due" : "scheduled",
      dueAt: makeIsoAtOffset(baseIso, index),
      sourceEventIds: [`evt_seed_${volume}_${index}`],
      evidenceEventIds: [`evt_seed_${volume}_${index}`],
      timestamp: makeIsoAtOffset(baseIso, index),
    });
  }
}

function runSchedulingVolumeBenchmark(volume) {
  resetStore();
  const baseIso = "2026-03-01T00:00:00.000Z";
  const rebalanceActiveLimit = Math.min(128, Math.max(16, Math.floor(volume / 2)));
  seedScheduleEntries(volume, baseIso);
  executeOperation("review_set_rebalance", {
    storeId: STORE_ID,
    profile: PROFILE,
    activeLimit: rebalanceActiveLimit,
    timestamp: baseIso,
  });
  const updateLatencies = [];
  const clockLatencies = [];
  const rebalanceLatencies = [];
  for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
    const targetIndex = iteration % volume;
    const timestamp = makeIsoAtOffset(baseIso, volume + iteration);
    updateLatencies.push(
      measure(() => {
        executeOperation("review_schedule_update", {
          storeId: STORE_ID,
          profile: PROFILE,
          scheduleEntryId: `srs_${volume}_${targetIndex}`,
          targetId: `target_${targetIndex}`,
          status: iteration % 2 === 0 ? "due" : "scheduled",
          repetition: iteration % 5,
          intervalDays: 1 + (iteration % 7),
          dueAt: makeIsoAtOffset(timestamp, iteration % 11),
          sourceEventIds: [`evt_mut_${volume}_${targetIndex}`],
          evidenceEventIds: [`evt_mut_${volume}_${targetIndex}`],
          timestamp,
        });
      }),
    );
    clockLatencies.push(
      measure(() => {
        executeOperation("review_schedule_clock", {
          storeId: STORE_ID,
          profile: PROFILE,
          mode: "auto",
          interactionIncrement: 1,
          noveltyWriteLoad: iteration % 4,
          noveltyWriteThreshold: 8,
          fatigueThreshold: 10,
          timestamp,
        });
      }),
    );
    rebalanceLatencies.push(
      measure(() => {
        executeOperation("review_set_rebalance", {
          storeId: STORE_ID,
          profile: PROFILE,
          activeLimit: rebalanceActiveLimit,
          timestamp,
        });
      }),
    );
  }
  return {
    volume,
    iterations: ITERATIONS,
    updateLatency: summarizeLatency(updateLatencies),
    clockLatency: summarizeLatency(clockLatencies),
    rebalanceLatency: summarizeLatency(rebalanceLatencies),
  };
}

function computeNearConstantGate(volumeResults, key) {
  const p95Values = volumeResults.map((entry) => entry[key].p95Ms);
  const minP95 = Math.min(...p95Values);
  const maxP95 = Math.max(...p95Values);
  if (!Number.isFinite(minP95) || minP95 <= 0) {
    return {
      pass: false,
      ratio: null,
    };
  }
  const ratio = maxP95 / minP95;
  return {
    pass: ratio <= NEAR_CONSTANT_RATIO_THRESHOLD,
    ratio: round(ratio, 4),
  };
}

function renderMarkdown(report) {
  const volumeRows = report.schedulingVolumeResults
    .map(
      (entry) =>
        `| ${entry.volume} | ${entry.updateLatency.p95Ms} | ${entry.clockLatency.p95Ms} | ${entry.rebalanceLatency.p95Ms} |`,
    )
    .join("\n");
  const gateRows = Object.entries(report.gates)
    .map(([name, gate]) => `| ${name} | ${gate.pass ? "pass" : "fail"} | ${gate.details} |`)
    .join("\n");
  return [
    "# Phase 3 Scheduling Latency Gate",
    "",
    `Generated at: ${report.generatedAt}`,
    `Iterations: ${report.config.iterations}`,
    `Volumes: ${report.config.volumes.join(", ")}`,
    "",
    "## Scheduling p95 Latency vs Volume",
    "| volume | review_schedule_update p95 (ms) | review_schedule_clock p95 (ms) | review_set_rebalance p95 (ms) |",
    "| ---: | ---: | ---: | ---: |",
    volumeRows,
    "",
    "## Guardrail Gates",
    "| gate | status | details |",
    "| --- | --- | --- |",
    gateRows,
    "",
  ].join("\n");
}

function nowVersionStamp() {
  return new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
}

resetStore();
executeOperation("ingest", {
  storeId: STORE_ID,
  profile: PROFILE,
  events: Array.from({ length: 50 }, (_, index) => ({
    type: "note",
    source: "bench",
    content: `seed event ${index}`,
  })),
});

const throughputResults = [
  benchThroughput("context", (index) => {
    executeOperation("context", {
      storeId: STORE_ID,
      profile: PROFILE,
      query: index % 2 === 0 ? "seed" : "event",
      limit: 5,
    });
  }),
  benchThroughput("reflect", () => {
    executeOperation("reflect", {
      storeId: STORE_ID,
      profile: PROFILE,
      maxCandidates: 3,
    });
  }),
  benchThroughput("doctor", () => {
    executeOperation("doctor", {
      storeId: STORE_ID,
      profile: PROFILE,
    });
  }),
];

const schedulingVolumeResults = VOLUMES.map(runSchedulingVolumeBenchmark);
const updateNearConstant = computeNearConstantGate(schedulingVolumeResults, "updateLatency");
const clockNearConstant = computeNearConstantGate(schedulingVolumeResults, "clockLatency");
const rebalanceNearConstant = computeNearConstantGate(schedulingVolumeResults, "rebalanceLatency");
const peakVolume = schedulingVolumeResults[schedulingVolumeResults.length - 1];
const gates = {
  reviewScheduleUpdateNearConstant: {
    pass: updateNearConstant.pass,
    details: `p95 ratio=${updateNearConstant.ratio} threshold<=${NEAR_CONSTANT_RATIO_THRESHOLD}`,
  },
  reviewScheduleClockNearConstant: {
    pass: clockNearConstant.pass,
    details: `p95 ratio=${clockNearConstant.ratio} threshold<=${NEAR_CONSTANT_RATIO_THRESHOLD}`,
  },
  reviewSetRebalanceNearConstant: {
    pass: rebalanceNearConstant.pass,
    details: `p95 ratio=${rebalanceNearConstant.ratio} threshold<=${NEAR_CONSTANT_RATIO_THRESHOLD}`,
  },
  reviewScheduleUpdateP95Threshold: {
    pass: peakVolume.updateLatency.p95Ms <= UPDATE_P95_THRESHOLD_MS,
    details: `peak p95=${peakVolume.updateLatency.p95Ms}ms threshold<=${UPDATE_P95_THRESHOLD_MS}ms`,
  },
  reviewScheduleClockP95Threshold: {
    pass: peakVolume.clockLatency.p95Ms <= CLOCK_P95_THRESHOLD_MS,
    details: `peak p95=${peakVolume.clockLatency.p95Ms}ms threshold<=${CLOCK_P95_THRESHOLD_MS}ms`,
  },
  reviewSetRebalanceP95Threshold: {
    pass: peakVolume.rebalanceLatency.p95Ms <= REBALANCE_P95_THRESHOLD_MS,
    details: `peak p95=${peakVolume.rebalanceLatency.p95Ms}ms threshold<=${REBALANCE_P95_THRESHOLD_MS}ms`,
  },
};

const report = {
  ok: Object.values(gates).every((gate) => gate.pass),
  generatedAt: new Date().toISOString(),
  config: {
    iterations: ITERATIONS,
    volumes: VOLUMES,
    nearConstantRatioThreshold: NEAR_CONSTANT_RATIO_THRESHOLD,
    p95ThresholdsMs: {
      reviewScheduleUpdate: UPDATE_P95_THRESHOLD_MS,
      reviewScheduleClock: CLOCK_P95_THRESHOLD_MS,
      reviewSetRebalance: REBALANCE_P95_THRESHOLD_MS,
    },
  },
  throughputResults,
  schedulingVolumeResults,
  gates,
};

const outputDir = resolve(process.cwd(), "docs/performance");
mkdirSync(outputDir, { recursive: true });
const version = nowVersionStamp();
const versionedJsonPath = resolve(outputDir, `phase3-review-scheduling-latency-gate.${version}.json`);
const latestJsonPath = resolve(outputDir, "phase3-review-scheduling-latency-gate.latest.json");
const versionedMdPath = resolve(outputDir, `phase3-review-scheduling-latency-gate.${version}.md`);
const latestMdPath = resolve(outputDir, "phase3-review-scheduling-latency-gate.latest.md");

writeFileSync(versionedJsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
writeFileSync(latestJsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
writeFileSync(versionedMdPath, `${renderMarkdown(report)}\n`, "utf8");
writeFileSync(latestMdPath, `${renderMarkdown(report)}\n`, "utf8");

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`Wrote benchmark report: ${versionedJsonPath}\n`);
process.stdout.write(`Wrote benchmark report: ${latestJsonPath}\n`);
process.stdout.write(`Wrote benchmark summary: ${versionedMdPath}\n`);
process.stdout.write(`Wrote benchmark summary: ${latestMdPath}\n`);

if (!report.ok) {
  process.exitCode = 1;
}
