import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

type JsonRecord = Record<string, unknown>;

const EFFECT_VERSION_PATTERN = /^4\.0\.0-beta\.\d+$/u;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readJsonFile(filePath: string): unknown {
  const absolutePath = resolve(process.cwd(), filePath);
  const source = readFileSync(absolutePath, "utf8");
  return JSON.parse(source) as unknown;
}

function readTextFile(filePath: string): string {
  const absolutePath = resolve(process.cwd(), filePath);
  return readFileSync(absolutePath, "utf8");
}

function readPinnedDependency(): string {
  const packageJson = readJsonFile("package.json");
  if (!isRecord(packageJson) || !isRecord(packageJson["dependencies"])) {
    throw new Error("package.json must define dependencies.");
  }

  const dependencyValue = packageJson["dependencies"]["effect"];
  if (typeof dependencyValue !== "string") {
    throw new Error("dependencies.effect must be a string in package.json.");
  }
  if (!EFFECT_VERSION_PATTERN.test(dependencyValue)) {
    throw new Error(
      `dependencies.effect must match ${EFFECT_VERSION_PATTERN.source}; received "${dependencyValue}".`
    );
  }
  return dependencyValue;
}

function validateLockfile(pinnedVersion: string): void {
  const lockfilePath = resolve(process.cwd(), "bun.lock");
  if (!existsSync(lockfilePath)) {
    throw new Error("bun.lock must exist.");
  }

  const match = readTextFile("bun.lock").match(
    /"effect"\s*:\s*\[\s*"effect@([^"]+)"/u
  );
  if (!match?.[1]) {
    throw new Error('bun.lock must contain an "effect" package entry.');
  }

  const lockedVersion = match[1];
  if (lockedVersion !== pinnedVersion) {
    throw new Error(
      `bun.lock effect version (${lockedVersion}) does not match package.json (${pinnedVersion}).`
    );
  }
}

try {
  const pinnedVersion = readPinnedDependency();
  validateLockfile(pinnedVersion);
  process.stdout.write(
    `effect beta pin validation passed (dependencies.effect=${pinnedVersion}).\n`
  );
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`effect beta pin validation failed: ${message}\n`);
  process.exit(1);
}
