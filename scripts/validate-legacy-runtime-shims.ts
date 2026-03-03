import { constants as fsConstants } from "node:fs";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const INVENTORY_SCHEMA_VERSION = "legacy_runtime_shim_inventory.v1";
const VALIDATION_SCHEMA_VERSION = "legacy_runtime_shim_validation_result.v1";
const VALID_ENTRY_KINDS = new Set([
  "runtime_entrypoint",
  "legacy_shared_contract",
]);
const FOLLOW_UP_BEAD_PATTERN = /^ums-memory-[a-z0-9]+(?:[.-][a-z0-9]+)*$/i;

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

    const directoryEntries = await readdir(currentDirectory, {
      withFileTypes: true,
    });
    directoryEntries.sort((left, right) =>
      compareStrings(left.name, right.name)
    );

    for (const entry of directoryEntries) {
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

async function collectLegacyShimPaths(projectRoot) {
  const collected = [];
  const appsRoot = path.resolve(projectRoot, "apps");
  const appsRootExists = await pathExists(appsRoot);

  if (appsRootExists) {
    const appEntries = await readdir(appsRoot, { withFileTypes: true });
    appEntries.sort((left, right) => compareStrings(left.name, right.name));

    for (const appEntry of appEntries) {
      if (!appEntry.isDirectory()) {
        continue;
      }
      const srcRoot = path.join(appsRoot, appEntry.name, "src");
      await walkDirectory(srcRoot, (entryPath) => {
        if (entryPath.endsWith(".mjs")) {
          collected.push(toProjectRelativePath(projectRoot, entryPath));
        }
      });
    }
  }

  const sharedSourceRoot = path.resolve(projectRoot, "libs/shared/src");
  await walkDirectory(sharedSourceRoot, (entryPath) => {
    if (entryPath.endsWith(".js")) {
      collected.push(toProjectRelativePath(projectRoot, entryPath));
    }
  });

  return [...new Set(collected)].sort(compareStrings);
}

function parseInventoryEntry(entry, index) {
  if (!isRecord(entry)) {
    throw new Error(`entries[${index}] must be a JSON object.`);
  }

  const pathValue = typeof entry.path === "string" ? entry.path.trim() : "";
  if (!pathValue) {
    throw new Error(`entries[${index}].path must be a non-empty string.`);
  }

  const kindValue = typeof entry.kind === "string" ? entry.kind.trim() : "";
  if (!VALID_ENTRY_KINDS.has(kindValue)) {
    throw new Error(
      `entries[${index}].kind must be one of: ${[...VALID_ENTRY_KINDS].sort(compareStrings).join(", ")}.`
    );
  }

  const followUpBeadId =
    typeof entry.followUpBeadId === "string" ? entry.followUpBeadId.trim() : "";
  const notes = typeof entry.notes === "string" ? entry.notes.trim() : "";
  if (!notes) {
    throw new Error(`entries[${index}].notes must be a non-empty string.`);
  }

  return {
    path: normalizePath(pathValue),
    kind: kindValue,
    followUpBeadId,
    notes,
  };
}

async function loadInventory(inventoryPath) {
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

  const rawEntries = parsed.entries;
  if (!Array.isArray(rawEntries)) {
    throw new Error("Inventory entries must be an array.");
  }

  const entries = rawEntries.map((entry, index) =>
    parseInventoryEntry(entry, index)
  );
  return {
    schemaVersion: INVENTORY_SCHEMA_VERSION,
    entries,
  };
}

function compareExpectedAndActual(expectedPaths, actualPaths) {
  const expected = new Set(expectedPaths);
  const actual = new Set(actualPaths);

  return {
    missingFromInventory: actualPaths.filter(
      (entryPath) => !expected.has(entryPath)
    ),
    missingOnDisk: expectedPaths.filter((entryPath) => !actual.has(entryPath)),
  };
}

function findDuplicates(values) {
  const duplicates = new Set();
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
    } else {
      seen.add(value);
    }
  }
  return [...duplicates].sort(compareStrings);
}

function findInvalidFollowUpBeadIds(entries) {
  return entries
    .filter((entry) => !FOLLOW_UP_BEAD_PATTERN.test(entry.followUpBeadId))
    .map((entry) => entry.path)
    .sort(compareStrings);
}

function validateInventoryOrder(entries) {
  const inventoryOrder = entries.map((entry) => entry.path);
  const sortedOrder = [...inventoryOrder].sort(compareStrings);
  if (inventoryOrder.length !== sortedOrder.length) {
    return false;
  }
  for (let index = 0; index < inventoryOrder.length; index += 1) {
    if (inventoryOrder[index] !== sortedOrder[index]) {
      return false;
    }
  }
  return true;
}

export async function validateLegacyRuntimeShims({
  projectRoot = process.cwd(),
  inventoryPath = path.resolve(
    process.cwd(),
    "docs/migration/legacy-runtime-shim-inventory.v1.json"
  ),
} = {}) {
  const absoluteProjectRoot = path.resolve(projectRoot);
  const absoluteInventoryPath = path.resolve(inventoryPath);
  const inventory = await loadInventory(absoluteInventoryPath);
  const actualPaths = await collectLegacyShimPaths(absoluteProjectRoot);
  const expectedPaths = inventory.entries
    .map((entry) => entry.path)
    .sort(compareStrings);
  const duplicateInventoryEntries = findDuplicates(expectedPaths);
  const invalidFollowUpBeadIds = findInvalidFollowUpBeadIds(inventory.entries);
  const inventoryOrderStable = validateInventoryOrder(inventory.entries);

  const diff = compareExpectedAndActual(expectedPaths, actualPaths);
  const result = {
    schemaVersion: VALIDATION_SCHEMA_VERSION,
    projectRoot: normalizePath(absoluteProjectRoot),
    inventoryPath: normalizePath(absoluteInventoryPath),
    expectedCount: expectedPaths.length,
    actualCount: actualPaths.length,
    missingFromInventory: diff.missingFromInventory,
    missingOnDisk: diff.missingOnDisk,
    duplicateInventoryEntries,
    invalidFollowUpBeadIds,
    inventoryOrderStable,
  };

  const hasIssues =
    result.missingFromInventory.length > 0 ||
    result.missingOnDisk.length > 0 ||
    result.duplicateInventoryEntries.length > 0 ||
    result.invalidFollowUpBeadIds.length > 0 ||
    !result.inventoryOrderStable;

  return {
    ...result,
    ok: !hasIssues,
  };
}

function printUsage() {
  process.stdout.write(
    [
      "Usage:",
      "  node --import tsx scripts/validate-legacy-runtime-shims.ts [--project-root <path>] [--inventory <path>] [--json]",
      "",
      "Options:",
      "  --project-root   Repository root to scan (default: current working directory).",
      "  --inventory      Inventory JSON file path.",
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

function renderFailureSummary(result) {
  const lines = ["Legacy runtime shim validation failed."];
  if (!result.inventoryOrderStable) {
    lines.push("- Inventory entries are not sorted by path.");
  }
  if (result.duplicateInventoryEntries.length > 0) {
    lines.push(
      `- Duplicate inventory entries: ${result.duplicateInventoryEntries.join(", ")}`
    );
  }
  if (result.invalidFollowUpBeadIds.length > 0) {
    lines.push(
      `- Missing or invalid followUpBeadId: ${result.invalidFollowUpBeadIds.join(", ")}`
    );
  }
  if (result.missingFromInventory.length > 0) {
    lines.push(
      `- Missing from inventory: ${result.missingFromInventory.join(", ")}`
    );
  }
  if (result.missingOnDisk.length > 0) {
    lines.push(`- Missing on disk: ${result.missingOnDisk.join(", ")}`);
  }
  return lines.join("\n");
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    if (args.help) {
      printUsage();
      return 0;
    }

    const result = await validateLegacyRuntimeShims({
      projectRoot: args.projectRoot,
      inventoryPath: args.inventoryPath,
    });

    if (args.json) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } else if (result.ok) {
      process.stdout.write(
        `Legacy runtime shim validation passed (${result.actualCount} shims, inventory ${result.expectedCount}).\n`
      );
    } else {
      process.stderr.write(`${renderFailureSummary(result)}\n`);
    }

    return result.ok ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Legacy runtime shim validation failed: ${message}\n`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const exitCode = await main();
  if (exitCode !== 0) {
    process.exitCode = exitCode;
  }
}
