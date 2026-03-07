import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { test } from "@effect-native/bun-test";

import {
  executeRuntimeOperation,
  loadRuntimeStoreSnapshot,
} from "../../apps/api/src/runtime-service.ts";
import { runBackgroundWorkerCycle } from "../../apps/api/src/worker-runtime.ts";

const FIXTURE_DIR = resolve(process.cwd(), "tests/fixtures/runtime-parity");

interface RuntimeParityOperationFixture {
  readonly operation: string;
  readonly request: Record<string, unknown>;
}

interface RuntimeParityWorkerFixture {
  readonly timestamp: string;
  readonly replayEvalMaxPerProfile: number;
  readonly maxErrorEntries: number;
}

interface RuntimeParityFixture {
  readonly name: string;
  readonly operations: readonly RuntimeParityOperationFixture[];
  readonly worker?: RuntimeParityWorkerFixture;
}

const readFixture = async (filePath: string): Promise<RuntimeParityFixture> =>
  JSON.parse(await readFile(filePath, "utf8")) as RuntimeParityFixture;

const sortRecord = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(sortRecord);
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>) as Array<
      [string, unknown]
    >;
    return Object.fromEntries(
      entries
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, sortRecord(nested)])
    );
  }
  return value;
};

const normalizeOperationResult = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(normalizeOperationResult);
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>) as Array<
      [string, unknown]
    >;
    return Object.fromEntries(
      entries
        .filter(([key]) => key !== "trace" && key !== "observability")
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]): [string, unknown] => [
          key,
          normalizeOperationResult(nested),
        ])
    );
  }
  return value;
};

const normalizeWorkerSummary = (
  value: Awaited<ReturnType<typeof runBackgroundWorkerCycle>>
) =>
  sortRecord({
    profileCount: value.profileCount,
    replayEvalMaxPerProfile: value.replayEvalMaxPerProfile,
    reviewScheduleClock: value.reviewScheduleClock,
    replayEval: value.replayEval,
    doctor: value.doctor,
    errorCount: value.errorCount,
    errorOverflowCount: value.errorOverflowCount,
    errors: value.errors,
  });

const substituteRequestPlaceholders = (
  value: unknown,
  ruleIdsByCandidateId: Map<string, string>
): unknown => {
  if (Array.isArray(value)) {
    return value.map((entry) =>
      substituteRequestPlaceholders(entry, ruleIdsByCandidateId)
    );
  }
  if (typeof value === "string" && value.startsWith("$rule:")) {
    const candidateId = value.slice("$rule:".length);
    const ruleId = ruleIdsByCandidateId.get(candidateId);
    if (!ruleId) {
      throw new Error(
        `Runtime parity fixture references unresolved candidate rule placeholder '${value}'.`
      );
    }
    return ruleId;
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
        key,
        substituteRequestPlaceholders(nested, ruleIdsByCandidateId),
      ])
    );
  }
  return value;
};

const runScenario = async (input: {
  readonly fixture: RuntimeParityFixture;
  readonly stateFile: string;
}) => {
  const normalizedResults: unknown[] = [];
  const ruleIdsByCandidateId = new Map<string, string>();

  for (const step of input.fixture.operations) {
    const result = await executeRuntimeOperation({
      operation: step.operation,
      stateFile: input.stateFile,
      requestBody: substituteRequestPlaceholders(
        structuredClone(step.request),
        ruleIdsByCandidateId
      ),
    });
    normalizedResults.push(normalizeOperationResult(result));

    if (
      result !== null &&
      typeof result === "object" &&
      Array.isArray((result as { applied?: unknown[] }).applied)
    ) {
      for (const appliedEntry of (result as { applied: unknown[] }).applied) {
        if (
          appliedEntry !== null &&
          typeof appliedEntry === "object" &&
          typeof (appliedEntry as { candidateId?: unknown }).candidateId ===
            "string" &&
          typeof (appliedEntry as { ruleId?: unknown }).ruleId === "string"
        ) {
          ruleIdsByCandidateId.set(
            (appliedEntry as { candidateId: string }).candidateId,
            (appliedEntry as { ruleId: string }).ruleId
          );
        }
      }
    }
  }

  const snapshot = await loadRuntimeStoreSnapshot({
    stateFile: input.stateFile,
  });
  const workerSummary = input.fixture.worker
    ? normalizeWorkerSummary(
        await runBackgroundWorkerCycle({
          stateFile: input.stateFile,
          timestamp: input.fixture.worker.timestamp,
          replayEvalMaxPerProfile: input.fixture.worker.replayEvalMaxPerProfile,
          maxErrorEntries: input.fixture.worker.maxErrorEntries,
        })
      )
    : null;
  const snapshotAfterWorker =
    input.fixture.worker !== undefined
      ? await loadRuntimeStoreSnapshot({ stateFile: input.stateFile })
      : snapshot;

  return {
    results: sortRecord(normalizedResults),
    snapshot: sortRecord(snapshot),
    workerSummary,
    snapshotAfterWorker: sortRecord(snapshotAfterWorker),
  };
};

const fixtureFiles = (await readdir(FIXTURE_DIR))
  .filter((entry) => entry.endsWith(".json"))
  .sort((left, right) => left.localeCompare(right));

for (const fixtureFile of fixtureFiles) {
  test(`ums-memory-2dc.6: runtime parity fixture ${fixtureFile} preserves legacy and unified semantics`, async () => {
    const fixture = await readFixture(resolve(FIXTURE_DIR, fixtureFile));
    const tempDir = await mkdtemp(resolve(tmpdir(), "ums-runtime-parity-"));
    const legacyStateFile = resolve(tempDir, ".ums-state.json");
    const unifiedStateFile = resolve(tempDir, "runtime-state");

    try {
      const legacy = await runScenario({
        fixture,
        stateFile: legacyStateFile,
      });
      const unified = await runScenario({
        fixture,
        stateFile: unifiedStateFile,
      });

      assert.deepEqual(unified.results, legacy.results, fixture.name);
      assert.deepEqual(unified.snapshot, legacy.snapshot, fixture.name);
      assert.deepEqual(
        unified.workerSummary,
        legacy.workerSummary,
        fixture.name
      );
      assert.deepEqual(
        unified.snapshotAfterWorker,
        legacy.snapshotAfterWorker,
        fixture.name
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
}
