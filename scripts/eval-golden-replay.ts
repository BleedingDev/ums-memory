import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { Schema, SchemaIssue } from "effect";

import { createUmsEngine } from "../apps/api/src/ums/engine.ts";

const RESULT_SCHEMA_VERSION = "golden_replay_evaluation.v1";
const FIXTURE_SCHEMA_VERSION = "golden_replay_fixture.v1";
const DEFAULT_FIXTURE_DIR = path.resolve(
  process.cwd(),
  "tests/fixtures/eval/golden-replay"
);

const GoldenReplayOperationKindSchema = Schema.Literals(["ingest", "recall"]);

const EngineOptionsSchema = Schema.Struct({
  seed: Schema.optional(Schema.String),
  defaultStore: Schema.optional(Schema.String),
  defaultSpace: Schema.optional(Schema.String),
  defaultMaxItems: Schema.optional(Schema.Number),
  defaultTokenBudget: Schema.optional(Schema.Number),
  maxMaxItems: Schema.optional(Schema.Number),
  maxTokenBudget: Schema.optional(Schema.Number),
});

const GoldenReplayOperationSchema = Schema.Struct({
  kind: GoldenReplayOperationKindSchema,
  label: Schema.String,
  input: Schema.Unknown,
  expect: Schema.Unknown,
});

const GoldenReplayFixtureSchema = Schema.Struct({
  schemaVersion: Schema.Literal(FIXTURE_SCHEMA_VERSION),
  fixtureId: Schema.String,
  fixtureVersion: Schema.Number,
  fixtureDigest: Schema.String,
  description: Schema.String,
  engineOptions: Schema.optional(EngineOptionsSchema),
  operations: Schema.Array(GoldenReplayOperationSchema),
  expectedStateDigest: Schema.String,
});

type GoldenReplayOperation = Schema.Schema.Type<
  typeof GoldenReplayOperationSchema
>;
type GoldenReplayEngineOptions = Parameters<typeof createUmsEngine>[0];

interface EvaluateGoldenReplayCorpusOptions {
  readonly fixtureDir?: string;
}

interface ParsedArgs {
  fixtureDir: string;
  json: boolean;
  help: boolean;
}

interface OperationEvaluationResult {
  readonly kind: GoldenReplayOperation["kind"];
  readonly label: string;
  readonly ok: boolean;
  readonly expectedDigest: string;
  readonly actualDigest: string;
}

interface FixtureFailure {
  readonly code: string;
  readonly message: string;
}

interface FixtureEvaluationResult {
  readonly file: string;
  readonly fixtureId: string;
  readonly fixtureVersion: number | null;
  readonly fixtureDigest: string | null;
  readonly actualFixtureDigest: string | null;
  readonly expectedStateDigest: string | null;
  readonly actualStateDigest: string | null;
  readonly ok: boolean;
  readonly failures: readonly FixtureFailure[];
  readonly operationResults: readonly OperationEvaluationResult[];
}

interface CorpusEvaluationResult {
  readonly schemaVersion: string;
  readonly fixtureDir: string;
  readonly fixtureCount: number;
  readonly ok: boolean;
  readonly failures: readonly string[];
  readonly results: readonly FixtureEvaluationResult[];
}

const decodeGoldenReplayFixture = Schema.decodeUnknownSync(
  GoldenReplayFixtureSchema
);

function normalizePath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort((left, right) => left.localeCompare(right));
  const serializedPairs = keys.map(
    (key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`
  );
  return `{${serializedPairs.join(",")}}`;
}

function digestValue(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

function formatSchemaError(error: unknown): string {
  const formatter = SchemaIssue.makeFormatterDefault();
  if (SchemaIssue.isIssue(error)) {
    return formatter(error);
  }
  if (Schema.isSchemaError(error)) {
    return formatter(error.issue);
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function stripFixtureDigest(
  fixture: Record<string, unknown>
): Record<string, unknown> {
  const strippedFixture = { ...fixture };
  delete strippedFixture["fixtureDigest"];
  return strippedFixture;
}

function evaluateOperation(
  engine: ReturnType<typeof createUmsEngine>,
  operation: GoldenReplayOperation
): unknown {
  const clonedInput = structuredClone(operation.input);
  return operation.kind === "ingest"
    ? engine.ingest(clonedInput)
    : engine.recall(clonedInput);
}

function makeFailure(code: string, message: string): FixtureFailure {
  return { code, message };
}

function parseArgs(argv: readonly string[]): ParsedArgs {
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

    if (token === "--help" || token === "-h") {
      parsed.help = true;
      continue;
    }
    if (token === "--json") {
      parsed.json = true;
      continue;
    }
    if (token === "--fixture-dir") {
      const value = args.shift();
      if (!value) {
        throw new Error("--fixture-dir requires a value.");
      }
      parsed.fixtureDir = path.resolve(value);
      continue;
    }

    throw new Error(`Unknown argument: ${token}`);
  }

  return parsed;
}

function printUsage(): void {
  process.stdout.write(
    [
      "Usage:",
      "  bun scripts/eval-golden-replay.ts [--fixture-dir <path>] [--json]",
      "",
      "Options:",
      "  --fixture-dir  Path to the golden replay fixture directory.",
      "  --json         Emit structured JSON output.",
      "  --help, -h     Show this help text.",
    ].join("\n") + "\n"
  );
}

function printResult(result: CorpusEvaluationResult, asJson: boolean): void {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  const lines = [
    `Schema version: ${result.schemaVersion}`,
    `Fixture dir: ${result.fixtureDir}`,
    `Fixture count: ${result.fixtureCount}`,
    `Corpus failures: ${result.failures.length}`,
    ...result.failures.map((failure) => `  - ${failure}`),
  ];

  for (const fixtureResult of result.results) {
    lines.push(
      `Fixture ${fixtureResult.fixtureId}: ${fixtureResult.ok ? "ok" : "failed"}`
    );
    lines.push(`  File: ${fixtureResult.file}`);
    lines.push(`  Fixture version: ${fixtureResult.fixtureVersion ?? "n/a"}`);
    lines.push(`  Expected digest: ${fixtureResult.fixtureDigest ?? "n/a"}`);
    lines.push(
      `  Actual digest: ${fixtureResult.actualFixtureDigest ?? "n/a"}`
    );
    lines.push(
      `  Expected state digest: ${fixtureResult.expectedStateDigest ?? "n/a"}`
    );
    lines.push(
      `  Actual state digest: ${fixtureResult.actualStateDigest ?? "n/a"}`
    );
    lines.push(`  Failures: ${fixtureResult.failures.length}`);
    for (const failure of fixtureResult.failures) {
      lines.push(`    - ${failure.code}: ${failure.message}`);
    }
  }

  lines.push(`Result: ${result.ok ? "ok" : "failed"}`);
  process.stdout.write(`${lines.join("\n")}\n`);
}

export async function evaluateGoldenReplayCorpus({
  fixtureDir = DEFAULT_FIXTURE_DIR,
}: EvaluateGoldenReplayCorpusOptions = {}): Promise<CorpusEvaluationResult> {
  const absoluteFixtureDir = path.resolve(fixtureDir);
  const fixtureFiles = (await readdir(absoluteFixtureDir))
    .filter((entry) => entry.endsWith(".json"))
    .sort((left, right) => left.localeCompare(right));
  const seenFixtureIds = new Set<string>();
  const results: FixtureEvaluationResult[] = [];

  for (const fixtureFile of fixtureFiles) {
    const absoluteFixturePath = path.resolve(absoluteFixtureDir, fixtureFile);

    try {
      const rawText = await readFile(absoluteFixturePath, "utf8");
      const parsed = JSON.parse(rawText) as unknown;
      if (!isRecord(parsed)) {
        throw new Error("Fixture root must be a JSON object.");
      }

      const fixture = decodeGoldenReplayFixture(parsed);
      const failures: FixtureFailure[] = [];
      const expectedFixtureDigest = fixture.fixtureDigest;
      const actualFixtureDigest = digestValue(stripFixtureDigest(parsed));

      if (
        !Number.isInteger(fixture.fixtureVersion) ||
        fixture.fixtureVersion < 1
      ) {
        failures.push(
          makeFailure(
            "FIXTURE_VERSION_INVALID",
            "fixtureVersion must be a positive integer."
          )
        );
      }
      if (!/^sha256:[0-9a-f]{64}$/u.test(expectedFixtureDigest)) {
        failures.push(
          makeFailure(
            "FIXTURE_DIGEST_FORMAT_INVALID",
            "fixtureDigest must use sha256:<64 hex chars> format."
          )
        );
      }
      if (expectedFixtureDigest !== actualFixtureDigest) {
        failures.push(
          makeFailure(
            "FIXTURE_DIGEST_MISMATCH",
            "Fixture content changed without updating fixtureDigest."
          )
        );
      }
      if (path.basename(fixtureFile, ".json") !== fixture.fixtureId) {
        failures.push(
          makeFailure(
            "FIXTURE_ID_FILENAME_MISMATCH",
            "fixtureId must match the fixture filename."
          )
        );
      }
      if (fixture.operations.length === 0) {
        failures.push(
          makeFailure(
            "FIXTURE_OPERATIONS_EMPTY",
            "Fixture must include at least one operation."
          )
        );
      }
      if (seenFixtureIds.has(fixture.fixtureId)) {
        failures.push(
          makeFailure(
            "FIXTURE_ID_DUPLICATE",
            "fixtureId must be unique within the corpus."
          )
        );
      } else {
        seenFixtureIds.add(fixture.fixtureId);
      }

      const engine = createUmsEngine(
        fixture.engineOptions as GoldenReplayEngineOptions
      );
      const operationResults: OperationEvaluationResult[] = [];

      for (const operation of fixture.operations) {
        const actual = evaluateOperation(engine, operation);
        const expectedDigest = digestValue(operation.expect);
        const actualDigest = digestValue(actual);
        const operationOk = expectedDigest === actualDigest;

        if (!operationOk) {
          failures.push(
            makeFailure(
              "OPERATION_MISMATCH",
              `${operation.kind} '${operation.label}' diverged from the golden expectation.`
            )
          );
        }

        operationResults.push({
          kind: operation.kind,
          label: operation.label,
          ok: operationOk,
          expectedDigest,
          actualDigest,
        });
      }

      const actualStateDigest = engine.stateDigest();
      if (actualStateDigest !== fixture.expectedStateDigest) {
        failures.push(
          makeFailure(
            "STATE_DIGEST_MISMATCH",
            "Final engine state digest diverged from the golden expectation."
          )
        );
      }

      results.push({
        file: normalizePath(absoluteFixturePath),
        fixtureId: fixture.fixtureId,
        fixtureVersion: fixture.fixtureVersion,
        fixtureDigest: expectedFixtureDigest,
        actualFixtureDigest,
        expectedStateDigest: fixture.expectedStateDigest,
        actualStateDigest,
        ok: failures.length === 0,
        failures,
        operationResults,
      });
    } catch (error) {
      results.push({
        file: normalizePath(absoluteFixturePath),
        fixtureId: path.basename(fixtureFile, ".json"),
        fixtureVersion: null,
        fixtureDigest: null,
        actualFixtureDigest: null,
        expectedStateDigest: null,
        actualStateDigest: null,
        ok: false,
        failures: [
          makeFailure("FIXTURE_PARSE_ERROR", formatSchemaError(error)),
        ],
        operationResults: [],
      });
    }
  }

  const failures =
    results.length === 0
      ? (["EMPTY_CORPUS: no golden replay fixtures were found."] as const)
      : [];

  return {
    schemaVersion: RESULT_SCHEMA_VERSION,
    fixtureDir: normalizePath(absoluteFixtureDir),
    fixtureCount: results.length,
    ok: failures.length === 0 && results.every((result) => result.ok),
    failures,
    results,
  };
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    printUsage();
    return 1;
  }

  if (parsed.help) {
    printUsage();
    return 0;
  }

  try {
    const result = await evaluateGoldenReplayCorpus({
      fixtureDir: parsed.fixtureDir,
    });
    printResult(result, parsed.json);
    return result.ok ? 0 : 1;
  } catch (error) {
    const message =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${message}\n`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const code = await main();
  process.exit(code);
}
