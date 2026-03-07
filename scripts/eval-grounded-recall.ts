import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { Effect, Schema } from "effect";

import { createUmsEngine } from "../apps/api/src/ums/engine.ts";
import { GroundedAnswerCitationSchema } from "../libs/shared/src/effect/contracts/services.js";

const RESULT_SCHEMA_VERSION = "grounded_recall_holdout_evaluation.v1";
const HOLDOUT_SCHEMA_VERSION = "grounded_holdout_case.v1";
const SUPPORTED_OBJECTIVE = "grounded_recall_citation_integrity";

const NonEmptyTrimmedStringSchema = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty()
);
const PositiveIntSchema = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThan(0)
);
const NonNegativeIntSchema = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0)
);
const RateSchema = Schema.Number.check(
  Schema.isBetween({ minimum: 0, maximum: 1 })
);

const HoldoutEventSchema = Schema.Struct({
  id: NonEmptyTrimmedStringSchema,
  storeId: NonEmptyTrimmedStringSchema,
  space: NonEmptyTrimmedStringSchema,
  source: NonEmptyTrimmedStringSchema,
  timestamp: NonEmptyTrimmedStringSchema,
  content: NonEmptyTrimmedStringSchema,
  tags: Schema.optional(Schema.Array(NonEmptyTrimmedStringSchema)),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});

const ExpectedCitationSchema = Schema.Struct({
  memoryId: NonEmptyTrimmedStringSchema,
  source: NonEmptyTrimmedStringSchema,
  quote: NonEmptyTrimmedStringSchema,
});

const HoldoutCaseSchema = Schema.Struct({
  schemaVersion: NonEmptyTrimmedStringSchema,
  caseId: NonEmptyTrimmedStringSchema,
  usage: Schema.Struct({
    split: NonEmptyTrimmedStringSchema,
    tuningAllowed: Schema.Boolean,
    ownerBeadId: NonEmptyTrimmedStringSchema,
  }),
  objective: NonEmptyTrimmedStringSchema,
  description: NonEmptyTrimmedStringSchema,
  seed: NonEmptyTrimmedStringSchema,
  request: Schema.Struct({
    storeId: NonEmptyTrimmedStringSchema,
    space: NonEmptyTrimmedStringSchema,
    query: NonEmptyTrimmedStringSchema,
    maxItems: PositiveIntSchema,
    tokenBudget: PositiveIntSchema,
  }),
  dataset: Schema.Struct({
    events: Schema.Array(HoldoutEventSchema),
  }),
  expect: Schema.Struct({
    citations: Schema.Array(ExpectedCitationSchema),
    minRecallRate: RateSchema,
    minCitationIntegrityRate: RateSchema,
  }),
});

const RecallHitSchema = Schema.Struct({
  id: NonEmptyTrimmedStringSchema,
  storeId: NonEmptyTrimmedStringSchema,
  space: NonEmptyTrimmedStringSchema,
  source: NonEmptyTrimmedStringSchema,
  timestamp: NonEmptyTrimmedStringSchema,
  content: NonEmptyTrimmedStringSchema,
  score: Schema.Number,
  flags: Schema.Struct({
    hasSecret: Schema.Boolean,
    unsafeInstruction: Schema.Boolean,
  }),
  evidence: Schema.Struct({
    episodeId: NonEmptyTrimmedStringSchema,
    source: NonEmptyTrimmedStringSchema,
  }),
});

const RecallResponseSchema = Schema.Struct({
  query: NonEmptyTrimmedStringSchema,
  storeId: NonEmptyTrimmedStringSchema,
  space: NonEmptyTrimmedStringSchema,
  maxItems: PositiveIntSchema,
  tokenBudget: PositiveIntSchema,
  estimatedTokens: NonNegativeIntSchema,
  payloadBytes: NonNegativeIntSchema,
  truncated: Schema.Boolean,
  items: Schema.Array(RecallHitSchema),
  guardrails: Schema.Struct({
    filteredUnsafe: NonNegativeIntSchema,
    redactedSecrets: NonNegativeIntSchema,
    storeIsolationEnforced: Schema.Boolean,
    spaceIsolationEnforced: Schema.Boolean,
  }),
});

const decodeHoldoutCase = Schema.decodeUnknownSync(HoldoutCaseSchema);
const decodeRecallResponse = Schema.decodeUnknownSync(RecallResponseSchema);
const decodeGroundedAnswerCitation = Schema.decodeUnknownSync(
  GroundedAnswerCitationSchema
);

type HoldoutCase = Schema.Schema.Type<typeof HoldoutCaseSchema>;
type ExpectedCitation = Schema.Schema.Type<typeof ExpectedCitationSchema>;
type GroundedAnswerCitation = Schema.Schema.Type<
  typeof GroundedAnswerCitationSchema
>;
type RecallResponse = Schema.Schema.Type<typeof RecallResponseSchema>;

interface EvaluateGroundedRecallOptions {
  readonly fixtureDir?: string;
}

interface ParsedArgs {
  fixtureDir: string;
  json: boolean;
  help: boolean;
}

export interface GroundedRecallCaseEvaluation {
  readonly caseId: string;
  readonly filePath: string;
  readonly description: string;
  readonly query: string;
  readonly storeId: string;
  readonly space: string;
  readonly retrievedMemoryIds: readonly string[];
  readonly expectedMemoryIds: readonly string[];
  readonly matchedMemoryIds: readonly string[];
  readonly missingMemoryIds: readonly string[];
  readonly actualCitations: readonly GroundedAnswerCitation[];
  readonly missingCitations: readonly string[];
  readonly recallRate: number;
  readonly citationIntegrityRate: number;
  readonly hitCount: number;
  readonly ingestAccepted: number;
  readonly reasonCodes: readonly string[];
  readonly errorMessage?: string;
  readonly ok: boolean;
}

export interface GroundedRecallEvaluationResult {
  readonly schemaVersion: string;
  readonly fixtureDirectory: string;
  readonly fixtureFiles: readonly string[];
  readonly summary: {
    readonly totalCases: number;
    readonly passedCases: number;
    readonly failedCases: number;
    readonly expectedMemoryIds: number;
    readonly matchedMemoryIds: number;
    readonly expectedCitations: number;
    readonly matchedCitations: number;
    readonly recallRate: number;
    readonly citationIntegrityRate: number;
  };
  readonly cases: readonly GroundedRecallCaseEvaluation[];
  readonly reasonCodes: readonly string[];
  readonly ok: boolean;
}

export const DEFAULT_HOLDOUT_FIXTURE_DIR = path.resolve(
  process.cwd(),
  "tests/fixtures/eval/grounded-holdout"
);

function round(value: number, digits = 6): number {
  return Number(value.toFixed(digits));
}

function normalizePath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}

function citationKey(citation: ExpectedCitation): string {
  return `${citation.memoryId}:${citation.quote}`;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function buildFailureResult(
  filePath: string,
  reasonCode: string,
  errorMessage: string
): GroundedRecallCaseEvaluation {
  return {
    caseId: path.basename(filePath, path.extname(filePath)),
    filePath: normalizePath(filePath),
    description: "",
    query: "",
    storeId: "",
    space: "",
    retrievedMemoryIds: [],
    expectedMemoryIds: [],
    matchedMemoryIds: [],
    missingMemoryIds: [],
    actualCitations: [],
    missingCitations: [],
    recallRate: 0,
    citationIntegrityRate: 0,
    hitCount: 0,
    ingestAccepted: 0,
    reasonCodes: [reasonCode],
    errorMessage,
    ok: false,
  };
}

function buildCitation(
  recall: RecallResponse,
  expectedCitation: ExpectedCitation
): GroundedAnswerCitation | null {
  const hit = recall.items.find(
    (item) => item.id === expectedCitation.memoryId
  );
  if (!hit) {
    return null;
  }
  if (hit.evidence.episodeId !== expectedCitation.memoryId) {
    return null;
  }
  if (hit.source !== expectedCitation.source) {
    return null;
  }
  if (hit.evidence.source !== expectedCitation.source) {
    return null;
  }

  const startOffset = hit.content.indexOf(expectedCitation.quote);
  if (startOffset < 0) {
    return null;
  }

  return decodeGroundedAnswerCitation({
    citationId: hit.evidence.episodeId,
    memoryId: hit.id,
    sourceId: hit.source,
    startOffset,
    endOffset: startOffset + expectedCitation.quote.length,
    quote: expectedCitation.quote,
  });
}

function evaluateDecodedCase(
  filePath: string,
  holdoutCase: HoldoutCase
): GroundedRecallCaseEvaluation {
  const reasonCodes = new Set<string>();

  if (holdoutCase.schemaVersion !== HOLDOUT_SCHEMA_VERSION) {
    reasonCodes.add("UNSUPPORTED_FIXTURE_SCHEMA");
  }
  if (holdoutCase.usage.split !== "holdout") {
    reasonCodes.add("INVALID_HOLDOUT_SPLIT");
  }
  if (holdoutCase.usage.tuningAllowed) {
    reasonCodes.add("HOLDOUT_TUNING_REUSE");
  }
  if (holdoutCase.objective !== SUPPORTED_OBJECTIVE) {
    reasonCodes.add("UNSUPPORTED_OBJECTIVE");
  }
  if (holdoutCase.expect.citations.length === 0) {
    reasonCodes.add("EMPTY_EXPECTED_CITATIONS");
  }

  const engine = createUmsEngine({ seed: holdoutCase.seed });
  const ingestResult = engine.ingest(holdoutCase.dataset.events);
  if (
    ingestResult.accepted !== holdoutCase.dataset.events.length ||
    ingestResult.duplicates !== 0 ||
    ingestResult.rejected !== 0
  ) {
    reasonCodes.add("INGEST_REJECTED_EVENTS");
  }

  const recall = decodeRecallResponse(engine.recall(holdoutCase.request));
  if (recall.storeId !== holdoutCase.request.storeId) {
    reasonCodes.add("STORE_ISOLATION_FAILURE");
  }
  if (recall.space !== holdoutCase.request.space) {
    reasonCodes.add("SPACE_ISOLATION_FAILURE");
  }
  if (!recall.guardrails.storeIsolationEnforced) {
    reasonCodes.add("STORE_ISOLATION_FAILURE");
  }
  if (!recall.guardrails.spaceIsolationEnforced) {
    reasonCodes.add("SPACE_ISOLATION_FAILURE");
  }
  if (
    recall.items.some((item) => item.storeId !== holdoutCase.request.storeId)
  ) {
    reasonCodes.add("STORE_ISOLATION_FAILURE");
  }
  if (recall.items.some((item) => item.space !== holdoutCase.request.space)) {
    reasonCodes.add("SPACE_ISOLATION_FAILURE");
  }

  const retrievedMemoryIds = recall.items.map((item) => item.id);
  const expectedMemoryIds = unique(
    holdoutCase.expect.citations.map((citation) => citation.memoryId)
  );
  const matchedMemoryIds = expectedMemoryIds.filter((memoryId) =>
    retrievedMemoryIds.includes(memoryId)
  );
  const missingMemoryIds = expectedMemoryIds.filter(
    (memoryId) => !retrievedMemoryIds.includes(memoryId)
  );
  if (missingMemoryIds.length > 0) {
    reasonCodes.add("MISSING_EXPECTED_HIT");
  }

  const actualCitations: GroundedAnswerCitation[] = [];
  const missingCitations: string[] = [];
  for (const expectedCitation of holdoutCase.expect.citations) {
    const citation = buildCitation(recall, expectedCitation);
    if (citation) {
      actualCitations.push(citation);
      continue;
    }
    missingCitations.push(citationKey(expectedCitation));
  }
  if (missingCitations.length > 0) {
    reasonCodes.add("INVALID_CITATION");
  }

  const recallRate =
    expectedMemoryIds.length === 0
      ? 0
      : round(matchedMemoryIds.length / expectedMemoryIds.length);
  const citationIntegrityRate =
    holdoutCase.expect.citations.length === 0
      ? 0
      : round(actualCitations.length / holdoutCase.expect.citations.length);

  if (recallRate < holdoutCase.expect.minRecallRate) {
    reasonCodes.add("RECALL_BELOW_THRESHOLD");
  }
  if (citationIntegrityRate < holdoutCase.expect.minCitationIntegrityRate) {
    reasonCodes.add("CITATION_INTEGRITY_BELOW_THRESHOLD");
  }

  return {
    caseId: holdoutCase.caseId,
    filePath: normalizePath(filePath),
    description: holdoutCase.description,
    query: holdoutCase.request.query,
    storeId: holdoutCase.request.storeId,
    space: holdoutCase.request.space,
    retrievedMemoryIds,
    expectedMemoryIds,
    matchedMemoryIds,
    missingMemoryIds,
    actualCitations,
    missingCitations,
    recallRate,
    citationIntegrityRate,
    hitCount: recall.items.length,
    ingestAccepted: ingestResult.accepted,
    reasonCodes: [...reasonCodes].sort(),
    ok: reasonCodes.size === 0,
  };
}

async function evaluateFixtureFile(
  filePath: string
): Promise<GroundedRecallCaseEvaluation> {
  try {
    const rawText = await readFile(filePath, "utf8");
    const parsed = JSON.parse(rawText) as unknown;
    const holdoutCase = decodeHoldoutCase(parsed);
    return evaluateDecodedCase(filePath, holdoutCase);
  } catch (error) {
    return buildFailureResult(
      filePath,
      "FIXTURE_PARSE_ERROR",
      toErrorMessage(error)
    );
  }
}

export async function evaluateGroundedRecall({
  fixtureDir = DEFAULT_HOLDOUT_FIXTURE_DIR,
}: EvaluateGroundedRecallOptions = {}): Promise<GroundedRecallEvaluationResult> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const absoluteFixtureDir = path.resolve(fixtureDir);
      const fixtureDirectory = normalizePath(absoluteFixtureDir);
      const entries = yield* Effect.tryPromise({
        try: () => readdir(absoluteFixtureDir, { withFileTypes: true }),
        catch: (error) =>
          new Error(
            `Failed to enumerate fixtures under ${fixtureDirectory}: ${toErrorMessage(error)}`
          ),
      });

      const fixtureFiles = entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) =>
          normalizePath(path.join(absoluteFixtureDir, entry.name))
        )
        .sort();

      if (fixtureFiles.length === 0) {
        return {
          schemaVersion: RESULT_SCHEMA_VERSION,
          fixtureDirectory,
          fixtureFiles: [],
          summary: {
            totalCases: 0,
            passedCases: 0,
            failedCases: 0,
            expectedMemoryIds: 0,
            matchedMemoryIds: 0,
            expectedCitations: 0,
            matchedCitations: 0,
            recallRate: 0,
            citationIntegrityRate: 0,
          },
          cases: [],
          reasonCodes: ["NO_FIXTURES_FOUND"],
          ok: false,
        } satisfies GroundedRecallEvaluationResult;
      }

      const cases = yield* Effect.promise(() =>
        Promise.all(
          fixtureFiles.map((filePath) => evaluateFixtureFile(filePath))
        )
      );

      const summary = cases.reduce(
        (accumulator, evaluation) => {
          accumulator.totalCases += 1;
          if (evaluation.ok) {
            accumulator.passedCases += 1;
          } else {
            accumulator.failedCases += 1;
          }
          accumulator.expectedMemoryIds += evaluation.expectedMemoryIds.length;
          accumulator.matchedMemoryIds += evaluation.matchedMemoryIds.length;
          accumulator.expectedCitations +=
            evaluation.actualCitations.length +
            evaluation.missingCitations.length;
          accumulator.matchedCitations += evaluation.actualCitations.length;
          return accumulator;
        },
        {
          totalCases: 0,
          passedCases: 0,
          failedCases: 0,
          expectedMemoryIds: 0,
          matchedMemoryIds: 0,
          expectedCitations: 0,
          matchedCitations: 0,
          recallRate: 0,
          citationIntegrityRate: 0,
        }
      );

      summary.recallRate =
        summary.expectedMemoryIds === 0
          ? 0
          : round(summary.matchedMemoryIds / summary.expectedMemoryIds);
      summary.citationIntegrityRate =
        summary.expectedCitations === 0
          ? 0
          : round(summary.matchedCitations / summary.expectedCitations);

      const reasonCodes = unique(
        cases.flatMap((evaluation) => evaluation.reasonCodes)
      ).sort();

      return {
        schemaVersion: RESULT_SCHEMA_VERSION,
        fixtureDirectory,
        fixtureFiles,
        summary,
        cases,
        reasonCodes,
        ok: summary.failedCases === 0,
      } satisfies GroundedRecallEvaluationResult;
    })
  );
}

function printUsage() {
  process.stdout.write(
    [
      "Usage:",
      "  bun scripts/eval-grounded-recall.ts [--fixture-dir <path>] [--json]",
      "",
      "Options:",
      "  --fixture-dir  Directory containing grounded holdout fixture JSON files.",
      "  --json         Emit structured JSON output.",
      "  --help, -h     Show this help text.",
    ].join("\n") + "\n"
  );
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    fixtureDir: DEFAULT_HOLDOUT_FIXTURE_DIR,
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

function printResult(
  result: GroundedRecallEvaluationResult,
  asJson: boolean
): void {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  process.stdout.write(
    [
      `Schema version: ${result.schemaVersion}`,
      `Fixture directory: ${result.fixtureDirectory}`,
      `Fixture files: ${result.fixtureFiles.length}`,
      `Cases: ${result.summary.totalCases}`,
      `Passed: ${result.summary.passedCases}`,
      `Failed: ${result.summary.failedCases}`,
      `Expected memory ids: ${result.summary.expectedMemoryIds}`,
      `Matched memory ids: ${result.summary.matchedMemoryIds}`,
      `Expected citations: ${result.summary.expectedCitations}`,
      `Matched citations: ${result.summary.matchedCitations}`,
      `Recall rate: ${result.summary.recallRate}`,
      `Citation integrity rate: ${result.summary.citationIntegrityRate}`,
      `Reason codes: ${result.reasonCodes.length === 0 ? "none" : result.reasonCodes.join(", ")}`,
      `Result: ${result.ok ? "ok" : "failed"}`,
      ...result.cases
        .filter((evaluation) => !evaluation.ok)
        .map(
          (evaluation) =>
            `  - ${evaluation.caseId}: ${evaluation.reasonCodes.join(", ")}`
        ),
    ].join("\n") + "\n"
  );
}

export async function main(argv = process.argv.slice(2)) {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${toErrorMessage(error)}\n`);
    printUsage();
    return 1;
  }

  if (parsed.help) {
    printUsage();
    return 0;
  }

  try {
    const result = await evaluateGroundedRecall({
      fixtureDir: parsed.fixtureDir,
    });
    printResult(result, parsed.json);
    return result.ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${toErrorMessage(error)}\n`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const code = await main();
  process.exit(code);
}
