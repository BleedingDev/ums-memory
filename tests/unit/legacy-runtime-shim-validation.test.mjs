import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { main, validateLegacyRuntimeShims } from "../../scripts/validate-legacy-runtime-shims.mjs";

const INVENTORY_SCHEMA_VERSION = "legacy_runtime_shim_inventory.v1";
const FOLLOW_UP = "ums-memory-n4m.6";

const BASE_ENTRIES = Object.freeze([
  Object.freeze({
    path: "apps/api/src/server.mjs",
    kind: "runtime_entrypoint",
    followUpBeadId: FOLLOW_UP,
    notes: "shim",
  }),
  Object.freeze({
    path: "libs/shared/src/errors.js",
    kind: "legacy_shared_contract",
    followUpBeadId: FOLLOW_UP,
    notes: "shim",
  }),
]);

async function writeShimFile(projectRoot, relativePath) {
  const targetPath = resolve(projectRoot, relativePath);
  await mkdir(resolve(targetPath, ".."), { recursive: true });
  await writeFile(targetPath, "export const shim = true;\n", "utf8");
}

async function writeInventory(projectRoot, entries) {
  const inventoryPath = resolve(projectRoot, "docs/migration/legacy-runtime-shim-inventory.v1.json");
  await mkdir(resolve(inventoryPath, ".."), { recursive: true });
  await writeFile(
    inventoryPath,
    `${JSON.stringify({ schemaVersion: INVENTORY_SCHEMA_VERSION, entries }, null, 2)}\n`,
    "utf8",
  );
  return inventoryPath;
}

test("legacy runtime shim validation passes when inventory and filesystem match", async () => {
  const projectRoot = await mkdtemp(resolve(tmpdir(), "legacy-shim-validation-pass-"));

  try {
    for (const entry of BASE_ENTRIES) {
      await writeShimFile(projectRoot, entry.path);
    }
    const inventoryPath = await writeInventory(projectRoot, BASE_ENTRIES);
    const result = await validateLegacyRuntimeShims({ projectRoot, inventoryPath });

    assert.equal(result.ok, true);
    assert.equal(result.expectedCount, 2);
    assert.equal(result.actualCount, 2);
    assert.deepEqual(result.missingFromInventory, []);
    assert.deepEqual(result.missingOnDisk, []);
    assert.deepEqual(result.invalidFollowUpBeadIds, []);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("legacy runtime shim validation detects runtime shims missing from inventory", async () => {
  const projectRoot = await mkdtemp(resolve(tmpdir(), "legacy-shim-validation-missing-inventory-"));

  try {
    for (const entry of BASE_ENTRIES) {
      await writeShimFile(projectRoot, entry.path);
    }
    await writeShimFile(projectRoot, "apps/cli/src/index.mjs");
    const inventoryPath = await writeInventory(projectRoot, BASE_ENTRIES);
    const result = await validateLegacyRuntimeShims({ projectRoot, inventoryPath });

    assert.equal(result.ok, false);
    assert.deepEqual(result.missingFromInventory, ["apps/cli/src/index.mjs"]);
    assert.deepEqual(result.missingOnDisk, []);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("legacy runtime shim validation detects inventory entries missing on disk", async () => {
  const projectRoot = await mkdtemp(resolve(tmpdir(), "legacy-shim-validation-missing-disk-"));

  try {
    await writeShimFile(projectRoot, BASE_ENTRIES[0].path);
    const inventoryPath = await writeInventory(projectRoot, BASE_ENTRIES);
    const result = await validateLegacyRuntimeShims({ projectRoot, inventoryPath });

    assert.equal(result.ok, false);
    assert.deepEqual(result.missingFromInventory, []);
    assert.deepEqual(result.missingOnDisk, ["libs/shared/src/errors.js"]);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("legacy runtime shim validation enforces follow-up bead IDs", async () => {
  const projectRoot = await mkdtemp(resolve(tmpdir(), "legacy-shim-validation-follow-up-"));

  try {
    for (const entry of BASE_ENTRIES) {
      await writeShimFile(projectRoot, entry.path);
    }
    const inventoryPath = await writeInventory(projectRoot, [
      {
        ...BASE_ENTRIES[0],
        followUpBeadId: "",
      },
      BASE_ENTRIES[1],
    ]);
    const result = await validateLegacyRuntimeShims({ projectRoot, inventoryPath });

    assert.equal(result.ok, false);
    assert.deepEqual(result.invalidFollowUpBeadIds, ["apps/api/src/server.mjs"]);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("legacy runtime shim validation requires non-empty inventory notes", async () => {
  const projectRoot = await mkdtemp(resolve(tmpdir(), "legacy-shim-validation-notes-"));

  try {
    for (const entry of BASE_ENTRIES) {
      await writeShimFile(projectRoot, entry.path);
    }
    const inventoryPath = await writeInventory(projectRoot, [
      {
        ...BASE_ENTRIES[0],
        notes: "",
      },
      BASE_ENTRIES[1],
    ]);

    await assert.rejects(
      () => validateLegacyRuntimeShims({ projectRoot, inventoryPath }),
      /entries\[0\]\.notes must be a non-empty string/i,
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("legacy runtime shim validation detects duplicate inventory paths", async () => {
  const projectRoot = await mkdtemp(resolve(tmpdir(), "legacy-shim-validation-duplicates-"));

  try {
    for (const entry of BASE_ENTRIES) {
      await writeShimFile(projectRoot, entry.path);
    }
    const inventoryPath = await writeInventory(projectRoot, [
      BASE_ENTRIES[0],
      BASE_ENTRIES[0],
      BASE_ENTRIES[1],
    ]);
    const result = await validateLegacyRuntimeShims({ projectRoot, inventoryPath });

    assert.equal(result.ok, false);
    assert.deepEqual(result.duplicateInventoryEntries, ["apps/api/src/server.mjs"]);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("legacy runtime shim validation requires sorted inventory order", async () => {
  const projectRoot = await mkdtemp(resolve(tmpdir(), "legacy-shim-validation-order-"));

  try {
    for (const entry of BASE_ENTRIES) {
      await writeShimFile(projectRoot, entry.path);
    }
    const inventoryPath = await writeInventory(projectRoot, [BASE_ENTRIES[1], BASE_ENTRIES[0]]);
    const result = await validateLegacyRuntimeShims({ projectRoot, inventoryPath });

    assert.equal(result.ok, false);
    assert.equal(result.inventoryOrderStable, false);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("legacy runtime shim validation CLI main supports json output for explicit project and inventory paths", async () => {
  const projectRoot = await mkdtemp(resolve(tmpdir(), "legacy-shim-validation-main-json-"));

  try {
    for (const entry of BASE_ENTRIES) {
      await writeShimFile(projectRoot, entry.path);
    }
    const inventoryPath = await writeInventory(projectRoot, BASE_ENTRIES);
    const code = await main([
      "--project-root",
      projectRoot,
      "--inventory",
      inventoryPath,
      "--json",
    ]);

    assert.equal(code, 0);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("legacy runtime shim validation CLI main returns failure on unknown arguments", async () => {
  const code = await main(["--does-not-exist"]);
  assert.equal(code, 1);
});
