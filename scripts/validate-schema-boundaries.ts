import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const RESULT_SCHEMA_VERSION = "schema_boundaries_validation.v1";
const DEFAULT_PROJECT_ROOT = process.cwd();
const DEFAULT_BOUNDARY_DIRECTORIES = Object.freeze([
  "apps/api/src",
  "apps/cli/src",
  "apps/ums/src",
]);
const SUPPORTED_TS_EXTENSIONS = Object.freeze([".ts", ".tsx", ".mts", ".cts"]);

const BOUNDARY_RULES = Object.freeze([
  Object.freeze({
    id: "no-zod-imports",
    description: "Boundary modules must not import zod.",
    pattern: /\bfrom\s+["']zod["']/u,
  }),
  Object.freeze({
    id: "no-direct-schema-decoding",
    description:
      "Boundary modules must decode unknown payloads via contract validators, not direct Schema.decodeUnknown* calls.",
    pattern: /\bSchema\.decodeUnknown(?:Sync|Effect)?\s*\(/u,
  }),
]);

interface ValidationViolation {
  readonly file: string;
  readonly ruleId: string;
  readonly description: string;
}

interface ValidateOptions {
  readonly projectRoot?: string;
}

interface ValidationResult {
  readonly schemaVersion: string;
  readonly projectRoot: string;
  readonly checkedFiles: number;
  readonly violations: readonly ValidationViolation[];
  readonly ok: boolean;
}

interface ParsedArgs {
  readonly projectRoot: string;
  readonly json: boolean;
  readonly help: boolean;
}

function normalizePath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

function listTypeScriptFiles(directoryPath: string): string[] {
  if (!existsSync(directoryPath)) {
    return [];
  }

  const files: string[] = [];
  const stack = [directoryPath];

  while (stack.length > 0) {
    const currentDirectoryPath = stack.pop();
    if (!currentDirectoryPath) {
      continue;
    }

    for (const entry of readdirSync(currentDirectoryPath, {
      withFileTypes: true,
    })) {
      const nextPath = path.join(currentDirectoryPath, entry.name);
      if (entry.isDirectory()) {
        stack.push(nextPath);
        continue;
      }
      if (
        !entry.isFile() ||
        !SUPPORTED_TS_EXTENSIONS.some((extension) =>
          entry.name.endsWith(extension)
        )
      ) {
        continue;
      }
      files.push(nextPath);
    }
  }

  files.sort((leftPath, rightPath) => leftPath.localeCompare(rightPath));
  return files;
}

export async function validateSchemaBoundaries({
  projectRoot = DEFAULT_PROJECT_ROOT,
}: ValidateOptions = {}): Promise<ValidationResult> {
  const absoluteProjectRoot = path.resolve(projectRoot);
  const boundaryFiles = DEFAULT_BOUNDARY_DIRECTORIES.flatMap(
    (relativeDirectory) =>
      listTypeScriptFiles(path.join(absoluteProjectRoot, relativeDirectory))
  );

  const violations: ValidationViolation[] = [];
  for (const boundaryFile of boundaryFiles) {
    const source = readFileSync(boundaryFile, "utf8");
    for (const rule of BOUNDARY_RULES) {
      if (!rule.pattern.test(source)) {
        continue;
      }
      violations.push({
        file: normalizePath(path.relative(absoluteProjectRoot, boundaryFile)),
        ruleId: rule.id,
        description: rule.description,
      });
    }
  }

  return {
    schemaVersion: RESULT_SCHEMA_VERSION,
    projectRoot: normalizePath(absoluteProjectRoot),
    checkedFiles: boundaryFiles.length,
    violations,
    ok: violations.length === 0,
  };
}

function printUsage() {
  process.stdout.write(
    [
      "Usage:",
      "  bun scripts/validate-schema-boundaries.ts [--root <path>] [--json]",
      "",
      "Options:",
      "  --root         Project root to validate (defaults to current working directory).",
      "  --json         Emit structured JSON output.",
      "  --help, -h     Show this help text.",
    ].join("\n") + "\n"
  );
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  let projectRoot = DEFAULT_PROJECT_ROOT;
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
    if (token === "--root") {
      const value = args.shift();
      if (!value) {
        throw new Error("--root requires a value.");
      }
      projectRoot = path.resolve(value);
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  return {
    projectRoot,
    json,
    help,
  };
}

function printResult(result: ValidationResult, asJson: boolean): void {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  process.stdout.write(
    [
      `Schema version: ${result.schemaVersion}`,
      `Project root: ${result.projectRoot}`,
      `Checked files: ${result.checkedFiles}`,
      `Violations: ${result.violations.length}`,
      ...result.violations.map(
        (violation) =>
          `  - ${violation.file}: [${violation.ruleId}] ${violation.description}`
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
    const result = await validateSchemaBoundaries({
      projectRoot: parsed.projectRoot,
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
