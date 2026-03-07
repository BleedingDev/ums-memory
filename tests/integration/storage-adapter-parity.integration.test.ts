import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import path from "node:path";

import { test } from "@effect-native/bun-test";

import { evaluateStorageParityCorpus } from "../../scripts/eval-storage-parity.ts";

test("ums-memory-onf.4: storage parity corpus runner stays within deterministic thresholds", async () => {
  const fixtureDir = path.resolve(
    process.cwd(),
    "tests/fixtures/storage-parity"
  );
  const fixtureFiles = (await readdir(fixtureDir))
    .filter((entry) => entry.endsWith(".json"))
    .sort((left, right) => left.localeCompare(right));
  const result = await evaluateStorageParityCorpus({ fixtureDir });

  assert.equal(result.schemaVersion, "storage_parity_evaluation.v1");
  assert.equal(
    result.fixtureDir.endsWith("tests/fixtures/storage-parity"),
    true
  );
  assert.equal(result.fixtureCount, fixtureFiles.length);
  assert.equal(result.fixtureCount > 0, true);
  assert.equal(result.failures.length, 0);
  assert.equal(result.ok, true);
  assert.equal(result.results.length, fixtureFiles.length);

  const waivedFixture = result.results.find(
    (fixture) => fixture.fixtureId === "waived-version-divergence"
  );
  assert.ok(waivedFixture);
  assert.equal(waivedFixture.ok, true);
  assert.equal(waivedFixture.mismatchCount, 0);
  assert.equal(waivedFixture.waivedMismatchCount, 1);
  assert.deepEqual(waivedFixture.mismatchReasonCodes, [
    "version_field_divergence",
  ]);
});
