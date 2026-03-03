import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import {
  main,
  validateLegacyRuntimeCutover,
} from "../../scripts/validate-legacy-runtime-cutover.ts";

const INVENTORY_SCHEMA_VERSION = "legacy_runtime_shim_inventory.v1";
const SHIM_PATH = "apps/api/src/core.mjs";

type InventoryEntry = {
  path: string;
  kind: "runtime_entrypoint" | "legacy_shared_contract";
  followUpBeadId: string;
  notes: string;
};

async function writeProjectFile(
  projectRoot: string,
  relativePath: string,
  content = ""
): Promise<void> {
  const targetPath = resolve(projectRoot, relativePath);
  await mkdir(resolve(targetPath, ".."), { recursive: true });
  await writeFile(targetPath, content, "utf8");
}

async function writeInventory(
  projectRoot: string,
  entries: readonly InventoryEntry[]
): Promise<string> {
  const inventoryPath = resolve(
    projectRoot,
    "docs/migration/legacy-runtime-shim-inventory.v1.json"
  );
  await mkdir(resolve(inventoryPath, ".."), { recursive: true });
  await writeFile(
    inventoryPath,
    `${JSON.stringify(
      { schemaVersion: INVENTORY_SCHEMA_VERSION, entries },
      null,
      2
    )}\n`,
    "utf8"
  );
  return inventoryPath;
}

function makeInventoryEntry(entryPath: string): InventoryEntry {
  return {
    path: entryPath,
    kind: "runtime_entrypoint",
    followUpBeadId: "ums-memory-n4m.6",
    notes: "legacy shim",
  };
}

test("legacy runtime cutover validation passes with empty inventory and no import edges", async () => {
  const projectRoot = await mkdtemp(
    resolve(tmpdir(), "legacy-cutover-empty-inventory-pass-")
  );

  try {
    await writeProjectFile(
      projectRoot,
      "apps/api/src/server.ts",
      "export const server = true;\n"
    );
    const inventoryPath = await writeInventory(projectRoot, []);
    const result = await validateLegacyRuntimeCutover({
      projectRoot,
      inventoryPath,
    });

    assert.equal(result.ok, true);
    assert.equal(result.inventoryMustBeEmpty, true);
    assert.equal(result.legacyImportEdgeCount, 0);
    assert.deepEqual(result.strictTypeScriptViolations, []);
    assert.deepEqual(result.unexpectedLegacyImporters, []);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("legacy runtime cutover validation fails when inventory is non-empty", async () => {
  const projectRoot = await mkdtemp(
    resolve(tmpdir(), "legacy-cutover-non-empty-inventory-")
  );

  try {
    await writeProjectFile(
      projectRoot,
      SHIM_PATH,
      "export function run() { return true; }\n"
    );
    const inventoryPath = await writeInventory(projectRoot, [
      makeInventoryEntry(SHIM_PATH),
    ]);
    const result = await validateLegacyRuntimeCutover({
      projectRoot,
      inventoryPath,
    });

    assert.equal(result.ok, false);
    assert.equal(result.inventoryMustBeEmpty, false);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("legacy runtime cutover validation detects strict TypeScript imports of legacy shim paths", async () => {
  const projectRoot = await mkdtemp(
    resolve(tmpdir(), "legacy-cutover-ts-violation-")
  );

  try {
    await writeProjectFile(
      projectRoot,
      SHIM_PATH,
      "export function run() { return true; }\n"
    );
    await writeProjectFile(
      projectRoot,
      "libs/shared/src/effect/service.ts",
      'import { run } from "../../../../apps/api/src/core.mjs";\nvoid run;\n'
    );
    const inventoryPath = await writeInventory(projectRoot, [
      makeInventoryEntry(SHIM_PATH),
    ]);
    const result = await validateLegacyRuntimeCutover({
      projectRoot,
      inventoryPath,
    });

    assert.equal(result.ok, false);
    assert.equal(result.inventoryMustBeEmpty, false);
    assert.deepEqual(result.strictTypeScriptViolations, [
      {
        importer: "libs/shared/src/effect/service.ts",
        target: SHIM_PATH,
      },
    ]);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("legacy runtime cutover validation reports non-runtime TS importers as unexpected", async () => {
  const projectRoot = await mkdtemp(
    resolve(tmpdir(), "legacy-cutover-unexpected-importer-")
  );

  try {
    await writeProjectFile(
      projectRoot,
      SHIM_PATH,
      "export function run() { return true; }\n"
    );
    await writeProjectFile(
      projectRoot,
      "scripts/tool.ts",
      'import { run } from "../apps/api/src/core.mjs";\nvoid run;\n'
    );
    const inventoryPath = await writeInventory(projectRoot, [
      makeInventoryEntry(SHIM_PATH),
    ]);
    const result = await validateLegacyRuntimeCutover({
      projectRoot,
      inventoryPath,
    });

    assert.equal(result.ok, false);
    assert.equal(result.inventoryMustBeEmpty, false);
    assert.deepEqual(result.unexpectedLegacyImporters, [
      {
        importer: "scripts/tool.ts",
        target: SHIM_PATH,
      },
    ]);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("legacy runtime cutover validation ignores commented import references when inventory is empty", async () => {
  const projectRoot = await mkdtemp(
    resolve(tmpdir(), "legacy-cutover-comments-")
  );

  try {
    await writeProjectFile(
      projectRoot,
      "scripts/commented.ts",
      [
        '// import { run } from "../apps/api/src/core.mjs";',
        "/*",
        'import { run } from "../apps/api/src/core.mjs";',
        "*/",
        "export const value = 1;",
      ].join("\n")
    );
    const inventoryPath = await writeInventory(projectRoot, []);
    const result = await validateLegacyRuntimeCutover({
      projectRoot,
      inventoryPath,
    });

    assert.equal(result.ok, true);
    assert.equal(result.inventoryMustBeEmpty, true);
    assert.equal(result.legacyImportEdgeCount, 0);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("legacy runtime cutover CLI main returns failure on any args", async () => {
  const code = await main(["--does-not-exist"]);
  assert.equal(code, 1);
});
