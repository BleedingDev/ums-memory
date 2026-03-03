import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";

type JsonRecord = Record<string, unknown>;

const ALLOWLIST_SCHEMA_VERSION = "runtime_ts_suppression_allowlist.v1";
const FOLLOW_UP_BEAD_PATTERN = /^ums-memory-[a-z0-9]+(?:[.-][a-z0-9]+)*$/i;
const TARGET_ROOTS = ["apps", "libs"] as const;
const RUNTIME_SOURCE_PATH_PATTERN =
  /^(?:apps|libs)\/[^/]+\/src\/.+\.(?:ts|mts|cts|tsx)$/u;
const SUPPRESSION_PATTERNS = [
  "@ts-nocheck",
  "@ts-ignore",
  "@ts-expect-error",
] as const;

interface AllowlistEntry {
  path: string;
  followUpBeadId: string;
  notes: string;
}

interface SuppressionFinding {
  path: string;
  matchedPatterns: string[];
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizePath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

function toRelativePath(root: string, absolutePath: string): string {
  return normalizePath(path.relative(root, absolutePath));
}

async function walkDirectory(
  directory: string,
  callback: (filePath: string) => Promise<void> | void
): Promise<void> {
  const queue = [directory];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }

    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(entryPath);
        continue;
      }
      if (entry.isFile()) {
        await callback(entryPath);
      }
    }
  }
}

function readAllowlist(projectRoot: string): AllowlistEntry[] {
  const allowlistPath = path.resolve(
    projectRoot,
    "docs/migration/runtime-ts-suppression-allowlist.v1.json"
  );
  const source = readFileSync(allowlistPath, "utf8");
  const parsed = JSON.parse(source) as unknown;

  if (!isRecord(parsed)) {
    throw new Error("Allowlist root must be an object.");
  }
  if (parsed.schemaVersion !== ALLOWLIST_SCHEMA_VERSION) {
    throw new Error(
      `Allowlist schemaVersion must be "${ALLOWLIST_SCHEMA_VERSION}".`
    );
  }
  if (!Array.isArray(parsed.entries)) {
    throw new Error("Allowlist entries must be an array.");
  }

  const entries: AllowlistEntry[] = [];
  for (let index = 0; index < parsed.entries.length; index += 1) {
    const value = parsed.entries[index];
    if (!isRecord(value)) {
      throw new Error(`entries[${index}] must be an object.`);
    }

    const entryPath = typeof value.path === "string" ? value.path.trim() : "";
    const followUpBeadId =
      typeof value.followUpBeadId === "string"
        ? value.followUpBeadId.trim()
        : "";
    const notes = typeof value.notes === "string" ? value.notes.trim() : "";

    if (!entryPath) {
      throw new Error(`entries[${index}].path must be a non-empty string.`);
    }
    if (!RUNTIME_SOURCE_PATH_PATTERN.test(normalizePath(entryPath))) {
      throw new Error(
        `entries[${index}].path must target runtime source under apps/**/src or libs/**/src.`
      );
    }
    if (!FOLLOW_UP_BEAD_PATTERN.test(followUpBeadId)) {
      throw new Error(
        `entries[${index}].followUpBeadId must match ${FOLLOW_UP_BEAD_PATTERN.source}.`
      );
    }
    if (!notes) {
      throw new Error(`entries[${index}].notes must be a non-empty string.`);
    }

    entries.push({
      path: normalizePath(entryPath),
      followUpBeadId,
      notes,
    });
  }

  return entries;
}

function compareStrings(left: string, right: string): number {
  return left.localeCompare(right);
}

function findDuplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
      continue;
    }
    seen.add(value);
  }
  return [...duplicates].sort(compareStrings);
}

function isSorted(values: readonly string[]): boolean {
  for (let index = 1; index < values.length; index += 1) {
    if (compareStrings(values[index - 1]!, values[index]!) > 0) {
      return false;
    }
  }
  return true;
}

function findSuppressions(source: string): string[] {
  const matches = SUPPRESSION_PATTERNS.filter((pattern) =>
    source.includes(pattern)
  );
  return [...matches];
}

async function collectRuntimeSuppressions(
  projectRoot: string
): Promise<SuppressionFinding[]> {
  const findings: SuppressionFinding[] = [];
  for (const root of TARGET_ROOTS) {
    const absoluteRoot = path.resolve(projectRoot, root);
    await walkDirectory(absoluteRoot, (filePath) => {
      const relativePath = toRelativePath(projectRoot, filePath);
      const isRuntimeSource = RUNTIME_SOURCE_PATH_PATTERN.test(relativePath);
      if (!isRuntimeSource) {
        return;
      }

      const source = readFileSync(filePath, "utf8");
      const matchedPatterns = findSuppressions(source);
      if (matchedPatterns.length > 0) {
        findings.push({
          path: relativePath,
          matchedPatterns,
        });
      }
    });
  }

  findings.sort((left, right) => left.path.localeCompare(right.path));
  return findings;
}

async function main(): Promise<void> {
  const projectRoot = process.cwd();
  const allowlist = readAllowlist(projectRoot);
  const allowlistPaths = allowlist.map((entry) => entry.path);
  const allowlistSet = new Set(allowlist.map((entry) => entry.path));
  const findings = await collectRuntimeSuppressions(projectRoot);
  const findingSet = new Set(findings.map((entry) => entry.path));

  const failures: string[] = [];
  const duplicateAllowlistPaths = findDuplicates(allowlistPaths);
  if (duplicateAllowlistPaths.length > 0) {
    failures.push(
      `suppression allowlist contains duplicate paths: ${duplicateAllowlistPaths.join(", ")}.`
    );
  }
  if (!isSorted(allowlistPaths)) {
    failures.push("suppression allowlist entries must be sorted by path.");
  }
  for (const finding of findings) {
    if (!allowlistSet.has(finding.path)) {
      failures.push(
        `${finding.path} contains ${finding.matchedPatterns.join(", ")} but is not in suppression allowlist.`
      );
    }
  }

  for (const entry of allowlist) {
    if (!findingSet.has(entry.path)) {
      failures.push(
        `${entry.path} is allowlisted for ts-suppressions but no suppression was found (stale allowlist entry).`
      );
    }
  }

  if (failures.length > 0) {
    process.stderr.write("runtime ts-suppression validation failed:\n");
    for (const failure of failures) {
      process.stderr.write(`- ${failure}\n`);
    }
    process.exit(1);
  }

  process.stdout.write(
    `runtime ts-suppression validation passed (${findings.length} allowlisted suppression file(s)).\n`
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(
    `runtime ts-suppression validation failed: ${message}\n`
  );
  process.exit(1);
});
