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

async function writeProjectFile(projectRoot, relativePath, content = "") {
  const targetPath = resolve(projectRoot, relativePath);
  await mkdir(resolve(targetPath, ".."), { recursive: true });
  await writeFile(targetPath, content, "utf8");
}

async function writeInventory(projectRoot, entries) {
  const inventoryPath = resolve(
    projectRoot,
    "docs/migration/legacy-runtime-shim-inventory.v1.json"
  );
  await mkdir(resolve(inventoryPath, ".."), { recursive: true });
  await writeFile(
    inventoryPath,
    `${JSON.stringify({ schemaVersion: INVENTORY_SCHEMA_VERSION, entries }, null, 2)}\n`,
    "utf8"
  );
  return inventoryPath;
}

function makeInventoryEntry(path) {
  return {
    path,
    kind: "runtime_entrypoint",
    followUpBeadId: "ums-memory-n4m.6",
    notes: "legacy shim",
  };
}

test("legacy runtime cutover validation passes for allowed mjs importer patterns", async () => {
  const projectRoot = await mkdtemp(resolve(tmpdir(), "legacy-cutover-pass-"));

  try {
    await writeProjectFile(
      projectRoot,
      SHIM_PATH,
      "export function run() { return true; }\n"
    );
    await writeProjectFile(
      projectRoot,
      "scripts/tool.mjs",
      'import { run } from "../apps/api/src/core.mjs";\nvoid run;\n'
    );
    const inventoryPath = await writeInventory(projectRoot, [
      makeInventoryEntry(SHIM_PATH),
    ]);
    const result = await validateLegacyRuntimeCutover({
      projectRoot,
      inventoryPath,
    });

    assert.equal(result.ok, true);
    assert.equal(result.strictTypeScriptViolations.length, 0);
    assert.equal(result.unexpectedLegacyImporters.length, 0);
    assert.equal(result.legacyImportEdgeCount, 1);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("legacy runtime cutover validation rejects strict TypeScript imports of legacy shims", async () => {
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

test("legacy runtime cutover validation rejects .tsx strict TypeScript imports of legacy shims", async () => {
  const projectRoot = await mkdtemp(
    resolve(tmpdir(), "legacy-cutover-tsx-violation-")
  );

  try {
    await writeProjectFile(
      projectRoot,
      SHIM_PATH,
      "export function run() { return true; }\n"
    );
    await writeProjectFile(
      projectRoot,
      "apps/web/src/widget.tsx",
      'import { run } from "../../api/src/core.mjs";\nvoid run;\n'
    );
    const inventoryPath = await writeInventory(projectRoot, [
      makeInventoryEntry(SHIM_PATH),
    ]);
    const result = await validateLegacyRuntimeCutover({
      projectRoot,
      inventoryPath,
    });

    assert.equal(result.ok, false);
    assert.deepEqual(result.strictTypeScriptViolations, [
      {
        importer: "apps/web/src/widget.tsx",
        target: SHIM_PATH,
      },
    ]);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("legacy runtime cutover validation rejects unexpected importer locations", async () => {
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
      "libs/shared/src/consumer.mjs",
      'import { run } from "../../../apps/api/src/core.mjs";\nvoid run;\n'
    );
    const inventoryPath = await writeInventory(projectRoot, [
      makeInventoryEntry(SHIM_PATH),
    ]);
    const result = await validateLegacyRuntimeCutover({
      projectRoot,
      inventoryPath,
    });

    assert.equal(result.ok, false);
    assert.deepEqual(result.unexpectedLegacyImporters, [
      {
        importer: "libs/shared/src/consumer.mjs",
        target: SHIM_PATH,
      },
    ]);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("legacy runtime cutover validation ignores commented import references", async () => {
  const projectRoot = await mkdtemp(
    resolve(tmpdir(), "legacy-cutover-comments-")
  );

  try {
    await writeProjectFile(
      projectRoot,
      SHIM_PATH,
      "export function run() { return true; }\n"
    );
    await writeProjectFile(
      projectRoot,
      "scripts/commented.mjs",
      [
        '// import { run } from "../apps/api/src/core.mjs";',
        "/*",
        'import { run } from "../apps/api/src/core.mjs";',
        "*/",
        "export const value = 1;",
      ].join("\n")
    );
    const inventoryPath = await writeInventory(projectRoot, [
      makeInventoryEntry(SHIM_PATH),
    ]);
    const result = await validateLegacyRuntimeCutover({
      projectRoot,
      inventoryPath,
    });

    assert.equal(result.ok, true);
    assert.equal(result.legacyImportEdgeCount, 0);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("legacy runtime cutover validation captures multiple real imports in one file while ignoring comments", async () => {
  const projectRoot = await mkdtemp(
    resolve(tmpdir(), "legacy-cutover-multi-import-")
  );

  try {
    const secondShimPath = "apps/cli/src/index.mjs";
    await writeProjectFile(
      projectRoot,
      SHIM_PATH,
      "export function run() { return true; }\n"
    );
    await writeProjectFile(
      projectRoot,
      secondShimPath,
      "export function runCli() { return true; }\n"
    );
    await writeProjectFile(
      projectRoot,
      "scripts/multi.mjs",
      [
        'import { run } from "../apps/api/src/core.mjs";',
        '// import { ignored } from "../apps/api/src/core.mjs";',
        'import { runCli } from "../apps/cli/src/index.mjs";',
        "void run;",
        "void runCli;",
      ].join("\n")
    );
    const inventoryPath = await writeInventory(projectRoot, [
      makeInventoryEntry(SHIM_PATH),
      makeInventoryEntry(secondShimPath),
    ]);
    const result = await validateLegacyRuntimeCutover({
      projectRoot,
      inventoryPath,
    });

    assert.equal(result.ok, true);
    assert.equal(result.legacyImportEdgeCount, 2);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("legacy runtime cutover CLI main returns failure on unknown args", async () => {
  const code = await main(["--does-not-exist"]);
  assert.equal(code, 1);
});
