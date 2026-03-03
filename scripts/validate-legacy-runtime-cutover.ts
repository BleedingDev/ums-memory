import { constants as fsConstants } from "node:fs";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const INVENTORY_SCHEMA_VERSION = "legacy_runtime_shim_inventory.v1";
const RESULT_SCHEMA_VERSION = "legacy_runtime_cutover_validation.v1";
const SOURCE_DIRECTORIES = ["apps", "libs", "scripts", "tests", "benchmarks"];
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizePath(filePath) {
  return filePath.split(path.sep).join("/");
}

function toProjectRelativePath(projectRoot, filePath) {
  return normalizePath(path.relative(projectRoot, filePath));
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function pathExists(targetPath) {
  try {
    await access(targetPath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readInventoryPaths(inventoryPath) {
  const raw = await readFile(inventoryPath, "utf8");

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to parse inventory JSON at ${inventoryPath}: ${message}`
    );
  }

  if (!isRecord(parsed)) {
    throw new Error("Inventory root must be an object.");
  }
  if (parsed.schemaVersion !== INVENTORY_SCHEMA_VERSION) {
    throw new Error(
      `Inventory schemaVersion must be "${INVENTORY_SCHEMA_VERSION}", received "${String(parsed.schemaVersion)}".`
    );
  }
  if (!Array.isArray(parsed.entries)) {
    throw new Error("Inventory entries must be an array.");
  }

  const paths = [];
  for (let index = 0; index < parsed.entries.length; index += 1) {
    const entry = parsed.entries[index];
    if (!isRecord(entry)) {
      throw new Error(`entries[${index}] must be a JSON object.`);
    }
    const entryPath = typeof entry.path === "string" ? entry.path.trim() : "";
    if (!entryPath) {
      throw new Error(`entries[${index}].path must be a non-empty string.`);
    }
    paths.push(normalizePath(entryPath));
  }

  return [...new Set(paths)].sort(compareStrings);
}

async function walkDirectory(rootDirectory, fileVisitor) {
  const exists = await pathExists(rootDirectory);
  if (!exists) {
    return;
  }

  const queue = [rootDirectory];
  while (queue.length > 0) {
    const currentDirectory = queue.shift();
    if (!currentDirectory) {
      continue;
    }

    const entries = await readdir(currentDirectory, { withFileTypes: true });
    entries.sort((left, right) => compareStrings(left.name, right.name));

    for (const entry of entries) {
      const entryPath = path.join(currentDirectory, entry.name);
      if (entry.isDirectory()) {
        queue.push(entryPath);
        continue;
      }
      if (entry.isFile()) {
        fileVisitor(entryPath);
      }
    }
  }
}

async function collectSourceFiles(projectRoot) {
  const files = [];

  for (const directory of SOURCE_DIRECTORIES) {
    await walkDirectory(path.resolve(projectRoot, directory), (entryPath) => {
      const extension = path.extname(entryPath);
      if (SOURCE_EXTENSIONS.has(extension)) {
        files.push(entryPath);
      }
    });
  }

  return files.sort((left, right) =>
    compareStrings(normalizePath(left), normalizePath(right))
  );
}

function extractImportSpecifiers(sourceText) {
  const normalizedSource = stripJavaScriptComments(sourceText);
  const specifiers = [];
  const patterns = [
    /\bimport\s+(?:[^"'()]*?\s+from\s+)?["']([^"']+)["']/gu,
    /\bexport\s+[^"'()]*?\s+from\s+["']([^"']+)["']/gu,
    /\bimport\(\s*["']([^"']+)["']\s*\)/gu,
  ];

  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match = pattern.exec(normalizedSource);
    while (match) {
      if (match[1]) {
        specifiers.push(match[1]);
      }
      match = pattern.exec(normalizedSource);
    }
  }

  return specifiers;
}

function stripJavaScriptComments(sourceText) {
  let index = 0;
  let state = "code";
  let output = "";

  while (index < sourceText.length) {
    const char = sourceText[index];
    const next = sourceText[index + 1] ?? "";

    if (state === "code") {
      if (char === "'" || char === '"' || char === "`") {
        state = char;
        output += char;
        index += 1;
        continue;
      }
      if (char === "/" && next === "/") {
        state = "line_comment";
        index += 2;
        continue;
      }
      if (char === "/" && next === "*") {
        state = "block_comment";
        index += 2;
        continue;
      }
      output += char;
      index += 1;
      continue;
    }

    if (state === "line_comment") {
      if (char === "\n") {
        output += "\n";
        state = "code";
      }
      index += 1;
      continue;
    }

    if (state === "block_comment") {
      if (char === "*" && next === "/") {
        index += 2;
        state = "code";
        continue;
      }
      if (char === "\n") {
        output += "\n";
      }
      index += 1;
      continue;
    }

    output += char;
    if (char === "\\") {
      const escaped = sourceText[index + 1] ?? "";
      output += escaped;
      index += 2;
      continue;
    }
    if (char === state) {
      state = "code";
    }
    index += 1;
  }

  return output;
}

async function resolveImportTarget(projectRoot, importerPath, specifier) {
  if (!specifier.startsWith(".") && !specifier.startsWith("/")) {
    return null;
  }

  const importerDirectory = path.dirname(importerPath);
  const rawResolved = specifier.startsWith("/")
    ? path.resolve(projectRoot, `.${specifier}`)
    : path.resolve(importerDirectory, specifier);
  const extension = path.extname(rawResolved);

  const candidates = extension
    ? [rawResolved]
    : [
        `${rawResolved}.ts`,
        `${rawResolved}.tsx`,
        `${rawResolved}.mts`,
        `${rawResolved}.cts`,
        path.join(rawResolved, "index.ts"),
        path.join(rawResolved, "index.tsx"),
        path.join(rawResolved, "index.mts"),
        path.join(rawResolved, "index.cts"),
      ];

  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return toProjectRelativePath(projectRoot, candidate);
    }
  }

  return null;
}

function isStrictTypeScriptPath(importerPath) {
  const typeScriptExtension =
    importerPath.endsWith(".ts") ||
    importerPath.endsWith(".tsx") ||
    importerPath.endsWith(".mts") ||
    importerPath.endsWith(".cts");
  return (
    typeScriptExtension &&
    (importerPath.startsWith("apps/") || importerPath.startsWith("libs/"))
  );
}

function compareEdges(left, right) {
  const importerDiff = compareStrings(left.importer, right.importer);
  if (importerDiff !== 0) {
    return importerDiff;
  }
  return compareStrings(left.target, right.target);
}

export async function validateLegacyRuntimeCutover({
  projectRoot = process.cwd(),
  inventoryPath = path.resolve(
    process.cwd(),
    "docs/migration/legacy-runtime-shim-inventory.v1.json"
  ),
} = {}) {
  const absoluteProjectRoot = path.resolve(projectRoot);
  const absoluteInventoryPath = path.resolve(inventoryPath);
  const inventoryPaths = await readInventoryPaths(absoluteInventoryPath);
  const inventoryMustBeEmpty = inventoryPaths.length === 0;
  const legacyPathSet = new Set(inventoryPaths);
  const sourceFiles = await collectSourceFiles(absoluteProjectRoot);

  const legacyImportEdges = [];
  for (const sourceFile of sourceFiles) {
    const sourceText = await readFile(sourceFile, "utf8");
    const specifiers = extractImportSpecifiers(sourceText);
    const importerPath = toProjectRelativePath(absoluteProjectRoot, sourceFile);

    for (const specifier of specifiers) {
      const resolvedTarget = await resolveImportTarget(
        absoluteProjectRoot,
        sourceFile,
        specifier
      );
      if (!resolvedTarget || !legacyPathSet.has(resolvedTarget)) {
        continue;
      }
      legacyImportEdges.push({
        importer: importerPath,
        target: resolvedTarget,
      });
    }
  }

  legacyImportEdges.sort(compareEdges);

  const strictTypeScriptViolations = legacyImportEdges.filter((edge) =>
    isStrictTypeScriptPath(edge.importer)
  );
  const unexpectedLegacyImporters = legacyImportEdges.filter(
    (edge) => !isStrictTypeScriptPath(edge.importer)
  );

  const result = {
    schemaVersion: RESULT_SCHEMA_VERSION,
    projectRoot: normalizePath(absoluteProjectRoot),
    inventoryPath: normalizePath(absoluteInventoryPath),
    legacyShimCount: inventoryPaths.length,
    inventoryMustBeEmpty,
    legacyImportEdgeCount: legacyImportEdges.length,
    strictTypeScriptViolations,
    unexpectedLegacyImporters,
  };

  return {
    ...result,
    ok:
      inventoryMustBeEmpty &&
      strictTypeScriptViolations.length === 0 &&
      unexpectedLegacyImporters.length === 0,
  };
}

function renderFailureSummary(result) {
  const lines = ["Legacy runtime cutover validation failed."];
  if (!result.inventoryMustBeEmpty) {
    lines.push(
      "- Legacy runtime shim inventory must remain empty after TS runtime cutover."
    );
  }
  if (result.strictTypeScriptViolations.length > 0) {
    lines.push("- Strict TypeScript files importing legacy shims:");
    for (const edge of result.strictTypeScriptViolations) {
      lines.push(`  - ${edge.importer} -> ${edge.target}`);
    }
  }
  if (result.unexpectedLegacyImporters.length > 0) {
    lines.push("- Unexpected importers of legacy shims:");
    for (const edge of result.unexpectedLegacyImporters) {
      lines.push(`  - ${edge.importer} -> ${edge.target}`);
    }
  }
  return lines.join("\n");
}

function printUsage() {
  process.stdout.write(
    [
      "Usage:",
      "  node --import tsx scripts/validate-legacy-runtime-cutover.ts [--project-root <path>] [--inventory <path>] [--json]",
      "",
      "Options:",
      "  --project-root   Repository root to scan (default: current working directory).",
      "  --inventory      Legacy shim inventory path.",
      "  --json           Emit structured JSON output.",
      "  --help, -h       Show this help text.",
    ].join("\n") + "\n"
  );
}

function parseArgs(argv) {
  const parsed = {
    projectRoot: process.cwd(),
    inventoryPath: path.resolve(
      process.cwd(),
      "docs/migration/legacy-runtime-shim-inventory.v1.json"
    ),
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
    if (token === "--project-root") {
      const value = (args.shift() ?? "").trim();
      if (!value) {
        throw new Error("Missing value for --project-root.");
      }
      parsed.projectRoot = value;
      continue;
    }
    if (token === "--inventory") {
      const value = (args.shift() ?? "").trim();
      if (!value) {
        throw new Error("Missing value for --inventory.");
      }
      parsed.inventoryPath = value;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  return parsed;
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    if (args.help) {
      printUsage();
      return 0;
    }

    const result = await validateLegacyRuntimeCutover({
      projectRoot: args.projectRoot,
      inventoryPath: args.inventoryPath,
    });

    if (args.json) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } else if (result.ok) {
      process.stdout.write(
        `Legacy runtime cutover validation passed (${result.legacyImportEdgeCount} legacy import edges).\n`
      );
    } else {
      process.stderr.write(`${renderFailureSummary(result)}\n`);
    }

    return result.ok ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `Legacy runtime cutover validation failed: ${message}\n`
    );
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const exitCode = await main();
  if (exitCode !== 0) {
    process.exitCode = exitCode;
  }
}
