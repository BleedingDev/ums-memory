import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { Schema, SchemaIssue } from "effect";

import {
  type AdapterSource,
  AdapterSessionMessageRoleSchema,
  AdapterSourceSchema,
} from "../libs/shared/src/effect/contracts/services.ts";
import { decodeAdapterSessionEnvelope } from "../libs/shared/src/effect/contracts/validators.ts";
import { deepClone, stableStringify } from "../libs/shared/src/utils.ts";

const RESULT_SCHEMA_VERSION = "adapter_conformance_summary.v1";
const FIXTURE_SCHEMA_VERSION = "adapter_conformance_fixture.v1";

export const DEFAULT_FIXTURE_DIRECTORY = path.resolve(
  process.cwd(),
  "tests/fixtures/eval/adapter-conformance"
);

export const SUPPORTED_ADAPTERS = Object.freeze([
  "claude-code",
  "codex-cli",
  "codex-native",
  "cursor",
  "opencode",
  "plan",
  "vscode",
] satisfies readonly AdapterSource[]);

const NonEmptyTrimmedStringSchema = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty()
);
const NonNegativeIntSchema = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0)
);
const PositiveIntSchema = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThan(0)
);

const ReplayExpectationSchema = Schema.Struct({
  tenantId: NonEmptyTrimmedStringSchema,
  spaceId: NonEmptyTrimmedStringSchema,
  source: AdapterSourceSchema,
  sessionId: NonEmptyTrimmedStringSchema,
  messageCount: PositiveIntSchema,
  roles: Schema.Array(AdapterSessionMessageRoleSchema),
  citationCounts: Schema.Array(NonNegativeIntSchema),
});

const ReplayFixtureSchema = Schema.Struct({
  schemaVersion: Schema.Literal(FIXTURE_SCHEMA_VERSION),
  id: NonEmptyTrimmedStringSchema,
  description: NonEmptyTrimmedStringSchema,
  kind: Schema.Literal("replay"),
  adapter: AdapterSourceSchema,
  replayCount: PositiveIntSchema,
  input: Schema.Unknown,
  expected: ReplayExpectationSchema,
});

const MalformedFixtureSchema = Schema.Struct({
  schemaVersion: Schema.Literal(FIXTURE_SCHEMA_VERSION),
  id: NonEmptyTrimmedStringSchema,
  description: NonEmptyTrimmedStringSchema,
  kind: Schema.Literal("malformed"),
  input: Schema.Unknown,
  expectedErrorPattern: NonEmptyTrimmedStringSchema,
});

const AdapterConformanceFixtureSchema = Schema.Union([
  ReplayFixtureSchema,
  MalformedFixtureSchema,
]);

type ReplayExpectation = Schema.Schema.Type<typeof ReplayExpectationSchema>;
type ReplayFixture = Schema.Schema.Type<typeof ReplayFixtureSchema>;
type MalformedFixture = Schema.Schema.Type<typeof MalformedFixtureSchema>;
type AdapterConformanceFixture = Schema.Schema.Type<
  typeof AdapterConformanceFixtureSchema
>;

interface EvaluateOptions {
  readonly fixtureDirectory?: string;
}

interface ParsedArgs {
  readonly fixtureDirectory: string;
  readonly json: boolean;
  readonly help: boolean;
}

interface BaseCaseResult {
  readonly fixtureId: string;
  readonly fixturePath: string;
  readonly ok: boolean;
}

interface ReplayCaseResult extends BaseCaseResult {
  readonly kind: "replay";
  readonly adapter: AdapterSource;
  readonly digest: string | null;
  readonly messageCount: number;
  readonly error: string | null;
}

interface MalformedCaseResult extends BaseCaseResult {
  readonly kind: "malformed";
  readonly error: string | null;
}

export type AdapterConformanceCaseResult =
  | ReplayCaseResult
  | MalformedCaseResult;

export interface AdapterConformanceSummary {
  readonly schemaVersion: string;
  readonly fixtureDirectory: string;
  readonly fixtureCount: number;
  readonly replayCaseCount: number;
  readonly malformedCaseCount: number;
  readonly adaptersCovered: readonly AdapterSource[];
  readonly passingAdapters: readonly AdapterSource[];
  readonly missingAdapters: readonly AdapterSource[];
  readonly failedCaseIds: readonly string[];
  readonly caseResults: readonly AdapterConformanceCaseResult[];
  readonly ok: boolean;
}

function normalizePath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function formatError(error: unknown): string {
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

function decodeFixture(input: unknown): AdapterConformanceFixture {
  return Schema.decodeUnknownSync(AdapterConformanceFixtureSchema)(input);
}

function toReplayExpectation(fixture: ReplayFixture): ReplayExpectation {
  const decoded = decodeAdapterSessionEnvelope(fixture.input);
  return {
    tenantId: decoded.tenantId,
    spaceId: decoded.spaceId,
    source: decoded.source,
    sessionId: decoded.sessionId,
    messageCount: decoded.messages.length,
    roles: decoded.messages.map((message) => message.role),
    citationCounts: decoded.messages.map((message) => message.citations.length),
  };
}

function evaluateReplayFixture(
  fixture: ReplayFixture,
  fixturePath: string
): ReplayCaseResult {
  let digest: string | null = null;

  try {
    const expectedProjection = stableStringify(fixture.expected);

    for (let index = 0; index < fixture.replayCount; index += 1) {
      const replayInput = deepClone(fixture.input);
      const inputBefore = stableStringify(replayInput);
      const projection = toReplayExpectation({
        ...fixture,
        input: replayInput,
      });
      const inputAfter = stableStringify(replayInput);
      if (inputAfter !== inputBefore) {
        throw new Error("Decoder mutated replay input.");
      }
      const nextDigest = sha256(stableStringify(projection));
      if (stableStringify(projection) !== expectedProjection) {
        throw new Error(
          `Decoded projection did not match fixture expectation for ${fixture.adapter}.`
        );
      }
      if (projection.source !== fixture.adapter) {
        throw new Error(
          `Fixture adapter ${fixture.adapter} did not decode to source ${projection.source}.`
        );
      }
      if (digest === null) {
        digest = nextDigest;
        continue;
      }
      if (digest !== nextDigest) {
        throw new Error("Replay digest changed across decode passes.");
      }
    }

    return {
      fixtureId: fixture.id,
      fixturePath,
      kind: "replay",
      ok: true,
      adapter: fixture.adapter,
      digest,
      messageCount: fixture.expected.messageCount,
      error: null,
    };
  } catch (error) {
    return {
      fixtureId: fixture.id,
      fixturePath,
      kind: "replay",
      ok: false,
      adapter: fixture.adapter,
      digest,
      messageCount: 0,
      error: formatError(error),
    };
  }
}

function evaluateMalformedFixture(
  fixture: MalformedFixture,
  fixturePath: string
): MalformedCaseResult {
  try {
    decodeAdapterSessionEnvelope(fixture.input);
    return {
      fixtureId: fixture.id,
      fixturePath,
      kind: "malformed",
      ok: false,
      error: "Malformed fixture decoded successfully.",
    };
  } catch (error) {
    const message = formatError(error);
    const pattern = new RegExp(fixture.expectedErrorPattern, "iu");
    return {
      fixtureId: fixture.id,
      fixturePath,
      kind: "malformed",
      ok: pattern.test(message),
      error: pattern.test(message)
        ? null
        : `Expected /${fixture.expectedErrorPattern}/ to match "${message}".`,
    };
  }
}

async function loadFixtures(
  fixtureDirectory: string
): Promise<readonly [string, AdapterConformanceFixture][]> {
  const absoluteDirectory = path.resolve(fixtureDirectory);
  const entries = (await readdir(absoluteDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  const fixtures: [string, AdapterConformanceFixture][] = [];
  for (const fileName of entries) {
    const absolutePath = path.join(absoluteDirectory, fileName);
    const rawFixture = await readFile(absolutePath, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawFixture);
    } catch (error) {
      throw new Error(
        `Failed to parse fixture ${normalizePath(absolutePath)}: ${formatError(error)}`
      );
    }
    try {
      fixtures.push([normalizePath(absolutePath), decodeFixture(parsed)]);
    } catch (error) {
      throw new Error(
        `Invalid fixture ${normalizePath(absolutePath)}: ${formatError(error)}`
      );
    }
  }
  return fixtures;
}

export async function evaluateAdapterConformance({
  fixtureDirectory = DEFAULT_FIXTURE_DIRECTORY,
}: EvaluateOptions = {}): Promise<AdapterConformanceSummary> {
  const absoluteFixtureDirectory = path.resolve(fixtureDirectory);
  const fixtures = await loadFixtures(absoluteFixtureDirectory);
  const caseResults = fixtures.map(([fixturePath, fixture]) =>
    fixture.kind === "replay"
      ? evaluateReplayFixture(fixture, fixturePath)
      : evaluateMalformedFixture(fixture, fixturePath)
  );

  const replayResults = caseResults.filter(
    (entry): entry is ReplayCaseResult => entry.kind === "replay"
  );
  const malformedResults = caseResults.filter(
    (entry): entry is MalformedCaseResult => entry.kind === "malformed"
  );

  const adaptersCovered = [
    ...new Set(replayResults.map((entry) => entry.adapter)),
  ].sort() as AdapterSource[];
  const passingAdapters = [
    ...new Set(
      replayResults.filter((entry) => entry.ok).map((entry) => entry.adapter)
    ),
  ].sort() as AdapterSource[];
  const missingAdapters = SUPPORTED_ADAPTERS.filter(
    (adapter) => !adaptersCovered.includes(adapter)
  );
  const failedCaseIds = caseResults
    .filter((entry) => !entry.ok)
    .map((entry) => entry.fixtureId);

  const ok =
    fixtures.length > 0 &&
    replayResults.length > 0 &&
    malformedResults.length > 0 &&
    missingAdapters.length === 0 &&
    failedCaseIds.length === 0;

  return {
    schemaVersion: RESULT_SCHEMA_VERSION,
    fixtureDirectory: normalizePath(absoluteFixtureDirectory),
    fixtureCount: fixtures.length,
    replayCaseCount: replayResults.length,
    malformedCaseCount: malformedResults.length,
    adaptersCovered,
    passingAdapters,
    missingAdapters,
    failedCaseIds,
    caseResults,
    ok,
  };
}

function printUsage() {
  process.stdout.write(
    [
      "Usage:",
      "  bun scripts/eval-adapter-conformance.ts [--dir <path>] [--json]",
      "",
      "Options:",
      "  --dir          Fixture directory to evaluate.",
      "  --json         Emit structured JSON output.",
      "  --help, -h     Show this help text.",
    ].join("\n") + "\n"
  );
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  let fixtureDirectory = DEFAULT_FIXTURE_DIRECTORY;
  let json = false;
  let help = false;

  const args = [...argv];
  while (args.length > 0) {
    const token = args.shift();
    if (!token) {
      continue;
    }
    if (token === "--help" || token === "-h") {
      help = true;
      continue;
    }
    if (token === "--json") {
      json = true;
      continue;
    }
    if (token === "--dir") {
      const value = args.shift();
      if (!value) {
        throw new Error("--dir requires a value.");
      }
      fixtureDirectory = path.resolve(value);
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  return {
    fixtureDirectory,
    json,
    help,
  };
}

function printResult(result: AdapterConformanceSummary, asJson: boolean): void {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  process.stdout.write(
    [
      `Schema version: ${result.schemaVersion}`,
      `Fixture directory: ${result.fixtureDirectory}`,
      `Fixtures: ${result.fixtureCount}`,
      `Replay cases: ${result.replayCaseCount}`,
      `Malformed cases: ${result.malformedCaseCount}`,
      `Adapters covered: ${result.adaptersCovered.join(", ") || "(none)"}`,
      `Missing adapters: ${result.missingAdapters.join(", ") || "(none)"}`,
      `Failed cases: ${result.failedCaseIds.length}`,
      ...result.caseResults
        .filter((entry) => !entry.ok)
        .map(
          (entry) =>
            `  - ${entry.fixtureId}: ${entry.error ?? "unknown failure"}`
        ),
      `Result: ${result.ok ? "ok" : "failed"}`,
    ].join("\n") + "\n"
  );
}

export async function main(argv = process.argv.slice(2)) {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${formatError(error)}\n`);
    printUsage();
    return 1;
  }

  if (parsed.help) {
    printUsage();
    return 0;
  }

  try {
    const result = await evaluateAdapterConformance({
      fixtureDirectory: parsed.fixtureDirectory,
    });
    printResult(result, parsed.json);
    return result.ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${formatError(error)}\n`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const code = await main();
  process.exit(code);
}
