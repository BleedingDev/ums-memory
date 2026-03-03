import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type JsonRecord = Record<string, unknown>;

const RUNTIME_TSCONFIG_PATHS = [
  "apps/api/tsconfig.json",
  "apps/cli/tsconfig.json",
  "apps/ums/tsconfig.json",
  "libs/shared/tsconfig.json",
  "apps/api/test/tsconfig.json",
  "apps/api/bench/tsconfig.json",
  "apps/cli/test/tsconfig.json",
  "scripts/tsconfig.json",
  "tests/tsconfig.json",
  "benchmarks/tsconfig.json",
] as const;

const TYPESCRIPT_INCLUDE_PATTERN = /\.(?:d\.ts|ts|tsx|cts|mts)$/u;
const DISALLOWED_INCLUDE_PATTERN = /\.(?:js|mjs|cjs)$/u;

const failures: string[] = [];

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readJsonFile(filePath: string): unknown {
  const absolutePath = resolve(process.cwd(), filePath);
  const source = readFileSync(absolutePath, "utf8");
  return JSON.parse(source) as unknown;
}

function validateAllowJsPolicy(): void {
  const parsed = readJsonFile("tsconfig.base.json");
  if (!isRecord(parsed)) {
    failures.push("tsconfig.base.json must contain a JSON object root.");
    return;
  }
  const compilerOptions = parsed["compilerOptions"];
  if (!isRecord(compilerOptions)) {
    failures.push(
      "tsconfig.base.json must define compilerOptions for strict policy validation."
    );
    return;
  }
  if (compilerOptions["allowJs"] !== false) {
    failures.push(
      "tsconfig.base.json compilerOptions.allowJs must be false for TS-only runtime policy."
    );
  }
}

function validateRuntimeProjectTsconfig(path: string): void {
  const parsed = readJsonFile(path);
  if (!isRecord(parsed)) {
    failures.push(`${path} must contain a JSON object root.`);
    return;
  }

  const compilerOptions = parsed["compilerOptions"];
  if (isRecord(compilerOptions) && compilerOptions["allowJs"] === true) {
    failures.push(`${path} must not override compilerOptions.allowJs=true.`);
  }

  const include = parsed["include"];
  if (!Array.isArray(include) || include.length === 0) {
    failures.push(`${path} must define a non-empty include array.`);
    return;
  }

  for (const entry of include) {
    if (typeof entry !== "string") {
      failures.push(`${path} include entries must be strings.`);
      continue;
    }
    if (DISALLOWED_INCLUDE_PATTERN.test(entry)) {
      failures.push(
        `${path} include pattern "${entry}" must not target js/mjs/cjs files.`
      );
      continue;
    }
    if (!TYPESCRIPT_INCLUDE_PATTERN.test(entry)) {
      failures.push(
        `${path} include pattern "${entry}" is not TS-only (expected .ts/.tsx/.cts/.mts/.d.ts).`
      );
    }
  }
}

try {
  validateAllowJsPolicy();
  for (const tsconfigPath of RUNTIME_TSCONFIG_PATHS) {
    validateRuntimeProjectTsconfig(tsconfigPath);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  failures.push(`Validation execution failed: ${message}`);
}

if (failures.length > 0) {
  process.stderr.write("tsconfig policy lock validation failed:\n");
  for (const failure of failures) {
    process.stderr.write(`- ${failure}\n`);
  }
  process.exit(1);
}

process.stdout.write(
  `tsconfig policy lock validation passed for ${RUNTIME_TSCONFIG_PATHS.length} runtime project tsconfig files.\n`
);
