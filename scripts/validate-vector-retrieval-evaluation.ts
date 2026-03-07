import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const RESULT_SCHEMA_VERSION = "vector_retrieval_evaluation_validation.v1";
const DEFAULT_RUNBOOK_PATH = path.resolve(
  process.cwd(),
  "docs/runbooks/vector-retrieval-extension-evaluation.md"
);

const REQUIRED_HEADINGS = Object.freeze([
  "## Purpose",
  "## Scope",
  "## Current Baseline (Must Remain Stable)",
  "## Deterministic Fallback Contract",
  "## Proposed Effect Service Contracts",
  "## Replay and Evaluation Gates",
  "## Rollout Plan",
  "## Explicit Non-Goals",
]);

const REQUIRED_PHRASES = Object.freeze([
  "ums-memory-dd2.3",
  "vector retrieval is optional",
  "deterministic fallback",
  "strict TypeScript + Effect",
  "SQLite remains the source of truth",
  "replay evaluation",
]);

const REQUIRED_CONTENT_RULES = Object.freeze([
  Object.freeze({
    id: "fallback-timeout-event",
    pattern: /retrieval\.vector\.fallback\.timeout/iu,
  }),
  Object.freeze({
    id: "go-metric-semantic-recall",
    pattern: /semantic recall improvement >= 8%/iu,
  }),
  Object.freeze({
    id: "go-metric-deterministic-mismatch",
    pattern: /deterministic mismatch rate == 0/iu,
  }),
  Object.freeze({
    id: "go-metric-fallback-success",
    pattern: /fallback success rate >= 99\.9%/iu,
  }),
]);

interface ValidateOptions {
  readonly runbookPath?: string;
}

interface ValidationResult {
  readonly schemaVersion: string;
  readonly runbookPath: string;
  readonly missingHeadings: readonly string[];
  readonly missingPhrases: readonly string[];
  readonly missingContentRules: readonly string[];
  readonly ok: boolean;
}

interface ParsedArgs {
  runbookPath: string;
  json: boolean;
  help: boolean;
}

function normalizePath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export async function validateVectorRetrievalEvaluation({
  runbookPath = DEFAULT_RUNBOOK_PATH,
}: ValidateOptions = {}): Promise<ValidationResult> {
  const absoluteRunbookPath = path.resolve(runbookPath);
  const markdown = await readFile(absoluteRunbookPath, "utf8");

  const missingHeadings = REQUIRED_HEADINGS.filter(
    (heading) => !markdown.includes(heading)
  );
  const missingPhrases = REQUIRED_PHRASES.filter(
    (phrase) => !new RegExp(escapeRegExp(phrase), "iu").test(markdown)
  );
  const missingContentRules = REQUIRED_CONTENT_RULES.filter(
    (rule) => !rule.pattern.test(markdown)
  ).map((rule) => rule.id);

  return {
    schemaVersion: RESULT_SCHEMA_VERSION,
    runbookPath: normalizePath(absoluteRunbookPath),
    missingHeadings,
    missingPhrases,
    missingContentRules,
    ok:
      missingHeadings.length === 0 &&
      missingPhrases.length === 0 &&
      missingContentRules.length === 0,
  };
}

function printUsage() {
  process.stdout.write(
    [
      "Usage:",
      "  bun scripts/validate-vector-retrieval-evaluation.ts [--file <path>] [--json]",
      "",
      "Options:",
      "  --file         Path to vector retrieval runbook markdown.",
      "  --json         Emit structured JSON output.",
      "  --help, -h     Show this help text.",
    ].join("\n") + "\n"
  );
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    runbookPath: DEFAULT_RUNBOOK_PATH,
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
    if (token === "--file") {
      const value = args.shift();
      if (!value) {
        throw new Error("--file requires a value.");
      }
      parsed.runbookPath = path.resolve(value);
      continue;
    }

    throw new Error(`Unknown argument: ${token}`);
  }

  return parsed;
}

function printResult(result: ValidationResult, asJson: boolean): void {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  process.stdout.write(
    [
      `Schema version: ${result.schemaVersion}`,
      `Runbook path: ${result.runbookPath}`,
      `Missing headings: ${result.missingHeadings.length}`,
      ...result.missingHeadings.map((heading) => `  - ${heading}`),
      `Missing phrases: ${result.missingPhrases.length}`,
      ...result.missingPhrases.map((phrase) => `  - ${phrase}`),
      `Missing content rules: ${result.missingContentRules.length}`,
      ...result.missingContentRules.map((rule) => `  - ${rule}`),
      `Result: ${result.ok ? "ok" : "failed"}`,
    ].join("\n") + "\n"
  );
}

export async function main(argv = process.argv.slice(2)) {
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
    const result = await validateVectorRetrievalEvaluation({
      runbookPath: parsed.runbookPath,
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
