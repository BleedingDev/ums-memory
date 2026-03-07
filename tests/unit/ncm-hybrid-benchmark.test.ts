import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { test } from "@effect-native/bun-test";

interface BenchmarkReport {
  readonly schemaVersion: string;
  readonly baseline: {
    readonly scenarioCount: number;
    readonly meanWeight: number;
  };
  readonly hybrid: {
    readonly scenarioCount: number;
    readonly meanWeight: number;
  };
  readonly deltas: {
    readonly meanWeightDelta: number;
  };
  readonly scenarios: readonly {
    readonly scenarioId: string;
    readonly baselineWeight: number;
    readonly hybridWeight: number;
    readonly netDelta: number;
    readonly action: "decay" | "reheat" | "stable";
  }[];
}

const loadBenchmarkModule = async (): Promise<{
  runCassVsNcmHybridBenchmark: () => Promise<BenchmarkReport>;
}> => {
  const moduleUrl = pathToFileURL(
    resolve(process.cwd(), "scripts/benchmark-cass-vs-ncm-hybrid.ts")
  ).href;
  const imported = (await import(moduleUrl)) as any;
  const moduleRecord = imported as {
    readonly runCassVsNcmHybridBenchmark?: any;
  };
  if (typeof moduleRecord.runCassVsNcmHybridBenchmark !== "function") {
    throw new Error(
      "benchmark-cass-vs-ncm-hybrid.ts must export runCassVsNcmHybridBenchmark()."
    );
  }
  return {
    runCassVsNcmHybridBenchmark:
      moduleRecord.runCassVsNcmHybridBenchmark as () => Promise<BenchmarkReport>,
  };
};

test("ums-memory-2i1.5: CASS-only vs NCM-hybrid benchmark report is deterministic", async () => {
  const module = await loadBenchmarkModule();
  const first = await module.runCassVsNcmHybridBenchmark();
  const second = await module.runCassVsNcmHybridBenchmark();

  assert.deepEqual(first, second);
  assert.equal(first.schemaVersion, "ncm_hybrid_benchmark.v1");
  assert.equal(first.baseline.scenarioCount, first.hybrid.scenarioCount);
  assert.equal(first.scenarios.length, first.hybrid.scenarioCount);
  assert.equal(Number.isFinite(first.deltas.meanWeightDelta), true);
  assert.equal(
    first.scenarios.every(
      (entry) =>
        entry.hybridWeight >= 0 &&
        entry.hybridWeight <= 1 &&
        entry.baselineWeight >= 0 &&
        entry.baselineWeight <= 1
    ),
    true
  );
});
