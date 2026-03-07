import { existsSync, readdirSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

const DEFAULT_DIRECTORIES = ["apps", "libs", "scripts", "tests", "benchmarks"];
const BLOCKED_EXTENSIONS = new Set([".js", ".mjs", ".cjs"]);
const SKIP_DIRECTORY_NAMES = new Set([
  ".git",
  ".beads",
  "node_modules",
  "dist",
  "coverage",
]);

interface ParsedArgs {
  readonly directories: readonly string[];
  readonly help: boolean;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const directories: string[] = [];
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token) {
      continue;
    }
    if (token === "--help" || token === "-h") {
      help = true;
      continue;
    }
    if (token === "--dir") {
      const directory = (argv[index + 1] ?? "").trim();
      if (!directory) {
        throw new Error("Missing value for --dir.");
      }
      directories.push(directory);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  return {
    directories: directories.length > 0 ? directories : DEFAULT_DIRECTORIES,
    help,
  };
}

function printUsage() {
  process.stdout.write(
    [
      "Usage:",
      "  bun scripts/validate-no-legacy-js-sources.ts [--dir <path>]...",
      "",
      "Defaults:",
      `  ${DEFAULT_DIRECTORIES.join(", ")}`,
      "",
      "Rule:",
      "  Reject tracked source files ending with .js/.mjs/.cjs in guarded directories.",
    ].join("\n") + "\n"
  );
}

function collectBlockedFiles(rootDirectory: string): string[] {
  if (!existsSync(rootDirectory)) {
    return [];
  }

  const blocked: string[] = [];
  const queue = [rootDirectory];
  while (queue.length > 0) {
    const current = queue.pop();
    if (!current) {
      continue;
    }
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const entryPath = join(current, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORY_NAMES.has(entry.name)) {
          continue;
        }
        queue.push(entryPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const extension = extname(entry.name).toLowerCase();
      if (BLOCKED_EXTENSIONS.has(extension)) {
        blocked.push(entryPath);
      }
    }
  }

  return blocked.sort((left, right) => left.localeCompare(right));
}

export async function main(argv: readonly string[] = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  if (parsed.help) {
    printUsage();
    return 0;
  }

  const projectRoot = process.cwd();
  const blockedFiles = parsed.directories.flatMap((directory) =>
    collectBlockedFiles(resolve(projectRoot, directory))
  );

  if (blockedFiles.length > 0) {
    process.stderr.write(
      [
        "Legacy JS/MJS source guard failed. Remove or migrate the following files:",
        ...blockedFiles.map((path) => `  - ${relative(projectRoot, path)}`),
      ].join("\n") + "\n"
    );
    return 1;
  }

  process.stdout.write(
    `Legacy JS/MJS source guard passed (${parsed.directories.length} directory scope(s)).\n`
  );
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(
      `validate-no-legacy-js-sources failed: ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exitCode = 1;
  }
);
