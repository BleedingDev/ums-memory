import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { test } from "@effect-native/bun-test";

import {
  generateIngestionValidationSummary,
  main,
} from "../../scripts/validate-ingestion.ts";

test("validate-ingestion deterministic summary is stable in check mode", async () => {
  const first = await generateIngestionValidationSummary({ mode: "check" });
  const second = await generateIngestionValidationSummary({ mode: "check" });

  assert.deepEqual(second, first);
  assert.equal(first.sources.mode, "deterministic");
  assert.equal(first.schemaVersion, "ingestion_validation_summary.v2");
});

test("validate-ingestion CLI check mode succeeds when baseline matches fixture summary", async () => {
  const projectRoot = await mkdtemp(
    resolve(tmpdir(), "validate-ingestion-ok-")
  );
  const baselinePath = resolve(projectRoot, "baseline.json");

  try {
    const baseline = await generateIngestionValidationSummary({
      mode: "check",
    });
    await writeFile(
      baselinePath,
      `${JSON.stringify(baseline, null, 2)}\n`,
      "utf8"
    );

    const code = await main(["--mode", "check", "--output", baselinePath]);
    assert.equal(code, 0);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("validate-ingestion CLI check mode fails when baseline drifts", async () => {
  const projectRoot = await mkdtemp(
    resolve(tmpdir(), "validate-ingestion-drift-")
  );
  const baselinePath = resolve(projectRoot, "baseline.json");

  try {
    await writeFile(
      baselinePath,
      JSON.stringify(
        {
          schemaVersion: "ingestion_validation_summary.v2",
          generatedAt: "2026-01-01T00:00:00.000Z",
          sources: { mode: "deterministic" },
        },
        null,
        2
      ),
      "utf8"
    );

    const code = await main(["--mode", "check", "--output", baselinePath]);
    assert.equal(code, 1);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("validate-ingestion CLI refresh mode rewrites baseline report path", async () => {
  const projectRoot = await mkdtemp(
    resolve(tmpdir(), "validate-ingestion-refresh-")
  );
  const outputPath = resolve(projectRoot, "refreshed-report.json");

  try {
    const code = await main(["--mode", "refresh", "--output", outputPath]);
    assert.equal(code, 0);

    const refreshed = await readFile(outputPath, "utf8");
    const parsed = JSON.parse(refreshed) as {
      readonly schemaVersion?: string;
      readonly sources?: { readonly mode?: string };
    };
    assert.equal(parsed.schemaVersion, "ingestion_validation_summary.v2");
    assert.equal(parsed.sources?.mode, "deterministic");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("validate-ingestion local mode blocks tracked baseline overwrite without force", async () => {
  const code = await main([
    "--mode",
    "local",
    "--write-report",
    "--output",
    "docs/reports/multi-store-ingestion-validation-summary.json",
  ]);
  assert.equal(code, 1);
});

test("validate-ingestion CLI main returns failure on unknown arguments", async () => {
  const code = await main(["--does-not-exist"]);
  assert.equal(code, 1);
});
