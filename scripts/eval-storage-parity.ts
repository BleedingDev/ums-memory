import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { Effect, Inspectable, Predicate, Schema, SchemaIssue } from "effect";

import {
  createStorageParityFixtureDigest,
  decodeStorageParityFixture,
  evaluateStorageDualRun,
  type StorageDualRunMismatchReasonCode,
  type StorageDualRunReport,
  type StorageParityFixture,
} from "../apps/api/src/storage-dualrun.ts";

const RESULT_SCHEMA_VERSION = "storage_parity_evaluation.v1";
const DEFAULT_FIXTURE_DIR = path.resolve(
  process.cwd(),
  "tests/fixtures/storage-parity"
);

interface ParsedArgs {
  fixtureDir: string;
  json: boolean;
  help: boolean;
}

interface FixtureFailure {
  readonly code: string;
  readonly message: string;
}

interface FixtureEvaluationResult {
  readonly file: string;
  readonly fixtureId: string;
  readonly fixtureDigest: string;
  readonly actualDigest: string;
  readonly ok: boolean;
  readonly mismatchCount: number;
  readonly waivedMismatchCount: number;
  readonly mismatchReasonCodes: readonly StorageDualRunMismatchReasonCode[];
  readonly failures: readonly FixtureFailure[];
}

export interface StorageParityCorpusResult {
  readonly schemaVersion: string;
  readonly fixtureDir: string;
  readonly fixtureCount: number;
  readonly ok: boolean;
  readonly failures: readonly string[];
  readonly results: readonly FixtureEvaluationResult[];
}

const isMainModule = import.meta.main;

const stableStringify = (value: unknown): string => {
  if (Predicate.isNullish(value)) {
    return "null";
  }
  if (
    Predicate.isString(value) ||
    Predicate.isNumber(value) ||
    Predicate.isBoolean(value)
  ) {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort((left, right) => left.localeCompare(right));
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
};

const formatSchemaError = (error: unknown): string => {
  const formatter = SchemaIssue.makeFormatterDefault();
  if (SchemaIssue.isIssue(error)) {
    return formatter(error);
  }
  if (Schema.isSchemaError(error)) {
    return formatter(error.issue);
  }
  if (Predicate.isError(error)) {
    return error.message;
  }
  return Inspectable.toStringUnknown(error);
};

const normalizePath = (filePath: string): string =>
  filePath.split(path.sep).join("/");

const parseArgs = (argv: readonly string[]): ParsedArgs => {
  const parsed: ParsedArgs = {
    fixtureDir: DEFAULT_FIXTURE_DIR,
    json: false,
    help: false,
  };
  const args = [...argv];
  while (args.length > 0) {
    const token = args.shift();
    if (!token) {
      continue;
    }
    if (token === "--json") {
      parsed.json = true;
      continue;
    }
    if (token === "--help" || token === "-h") {
      parsed.help = true;
      continue;
    }
    if (token === "--fixture-dir") {
      const next = args.shift();
      if (!next) {
        throw new Error("--fixture-dir requires a value.");
      }
      parsed.fixtureDir = path.resolve(next);
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }
  return parsed;
};

const printUsage = (): void => {
  process.stdout.write(
    [
      "Usage:",
      "  bun scripts/eval-storage-parity.ts [--fixture-dir <path>] [--json]",
      "",
      "Options:",
      "  --fixture-dir  Path to the storage parity fixture directory.",
      "  --json         Emit structured JSON output.",
      "  --help, -h     Show this help text.",
    ].join("\n") + "\n"
  );
};

const makeFailure = (code: string, message: string): FixtureFailure => ({
  code,
  message,
});

const digestValue = (value: unknown): string =>
  createHash("sha256").update(stableStringify(value)).digest("hex");

const summarizeFixture = async (
  file: string,
  fixture: StorageParityFixture
): Promise<FixtureEvaluationResult> => {
  const report: StorageDualRunReport = await Effect.runPromise(
    evaluateStorageDualRun(fixture.request)
  );
  const actualDigest = digestValue({
    ok: report.ok,
    mismatchCount: report.mismatchCount,
    waivedMismatchCount: report.waivedMismatchCount,
    mismatchReasonCodes: report.mismatchReasonCodes,
  });
  const failures: FixtureFailure[] = [];

  if (report.ok !== fixture.expect.ok) {
    failures.push(
      makeFailure(
        "EXPECT_OK_MISMATCH",
        `Expected ok=${fixture.expect.ok}, received ok=${report.ok}.`
      )
    );
  }
  if (report.mismatchCount !== fixture.expect.mismatchCount) {
    failures.push(
      makeFailure(
        "MISMATCH_COUNT_MISMATCH",
        `Expected mismatchCount=${fixture.expect.mismatchCount}, received ${report.mismatchCount}.`
      )
    );
  }
  if (report.waivedMismatchCount !== fixture.expect.waivedMismatchCount) {
    failures.push(
      makeFailure(
        "WAIVED_MISMATCH_COUNT_MISMATCH",
        `Expected waivedMismatchCount=${fixture.expect.waivedMismatchCount}, received ${report.waivedMismatchCount}.`
      )
    );
  }
  if (
    stableStringify(report.mismatchReasonCodes) !==
    stableStringify(fixture.expect.mismatchReasonCodes)
  ) {
    failures.push(
      makeFailure(
        "MISMATCH_REASON_CODES_MISMATCH",
        `Expected mismatchReasonCodes=${stableStringify(
          fixture.expect.mismatchReasonCodes
        )}, received ${stableStringify(report.mismatchReasonCodes)}.`
      )
    );
  }

  return {
    file: normalizePath(file),
    fixtureId: fixture.fixtureId,
    fixtureDigest: createStorageParityFixtureDigest(fixture),
    actualDigest,
    ok: failures.length === 0,
    mismatchCount: report.mismatchCount,
    waivedMismatchCount: report.waivedMismatchCount,
    mismatchReasonCodes: report.mismatchReasonCodes,
    failures: Object.freeze(failures),
  };
};

export const evaluateStorageParityCorpus = async ({
  fixtureDir = DEFAULT_FIXTURE_DIR,
}: {
  readonly fixtureDir?: string;
} = {}): Promise<StorageParityCorpusResult> => {
  const files = (await readdir(fixtureDir))
    .filter((entry) => entry.endsWith(".json"))
    .sort((left, right) => left.localeCompare(right));

  const failures: string[] = [];
  const results: FixtureEvaluationResult[] = [];

  for (const file of files) {
    const fullPath = path.join(fixtureDir, file);
    try {
      const raw = await readFile(fullPath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      const fixture = decodeStorageParityFixture(parsed);
      results.push(await summarizeFixture(fullPath, fixture));
    } catch (error) {
      failures.push(`${normalizePath(fullPath)}: ${formatSchemaError(error)}`);
    }
  }

  const hasFixtureFailures = results.some((result) => !result.ok);
  return {
    schemaVersion: RESULT_SCHEMA_VERSION,
    fixtureDir: normalizePath(fixtureDir),
    fixtureCount: files.length,
    ok: failures.length === 0 && !hasFixtureFailures,
    failures: Object.freeze(failures),
    results: Object.freeze(results),
  };
};

const printResult = (
  result: StorageParityCorpusResult,
  asJson: boolean
): void => {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  const lines = [
    `Schema version: ${result.schemaVersion}`,
    `Fixture dir: ${result.fixtureDir}`,
    `Fixture count: ${result.fixtureCount}`,
    `Failures: ${result.failures.length}`,
    ...result.failures.map((failure) => `  - ${failure}`),
  ];
  for (const fixtureResult of result.results) {
    lines.push(
      `Fixture ${fixtureResult.fixtureId}: ${fixtureResult.ok ? "ok" : "failed"}`
    );
    lines.push(`  File: ${fixtureResult.file}`);
    lines.push(`  Digest: ${fixtureResult.fixtureDigest}`);
    lines.push(`  Actual digest: ${fixtureResult.actualDigest}`);
    lines.push(`  Mismatch count: ${fixtureResult.mismatchCount}`);
    lines.push(`  Waived mismatch count: ${fixtureResult.waivedMismatchCount}`);
    if (fixtureResult.mismatchReasonCodes.length > 0) {
      lines.push(
        `  Mismatch reason codes: ${fixtureResult.mismatchReasonCodes.join(", ")}`
      );
    }
    for (const failure of fixtureResult.failures) {
      lines.push(`  - ${failure.code}: ${failure.message}`);
    }
  }
  process.stdout.write(`${lines.join("\n")}\n`);
};

const main = async (): Promise<void> => {
  const parsedArgs = parseArgs(process.argv.slice(2));
  if (parsedArgs.help) {
    printUsage();
    return;
  }
  const result = await evaluateStorageParityCorpus({
    fixtureDir: parsedArgs.fixtureDir,
  });
  printResult(result, parsedArgs.json);
  if (!result.ok) {
    process.exitCode = 1;
  }
};

if (isMainModule) {
  await main();
}
