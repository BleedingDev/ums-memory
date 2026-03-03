import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import {
  main,
  validateLegacyRuntimeShims,
} from "../../scripts/validate-legacy-runtime-shims.ts";

const INVENTORY_SCHEMA_VERSION = "legacy_runtime_shim_inventory.v1";
const FOLLOW_UP = "ums-memory-n4m.6";

type InventoryEntry = {
  path: string;
  kind: "runtime_entrypoint" | "legacy_shared_contract";
  followUpBeadId: string;
  notes: string;
};

const BASE_ENTRIES: readonly InventoryEntry[] = Object.freeze([
  Object.freeze({
    path: "apps/api/src/core.mjs",
    kind: "runtime_entrypoint",
    followUpBeadId: FOLLOW_UP,
    notes: "shim",
  }),
  Object.freeze({
    path: "apps/api/src/server.mjs",
    kind: "runtime_entrypoint",
    followUpBeadId: FOLLOW_UP,
    notes: "shim",
  }),
]);

async function writeShimFile(
  projectRoot: string,
  relativePath: string
): Promise<void> {
  const targetPath = resolve(projectRoot, relativePath);
  await mkdir(resolve(targetPath, ".."), { recursive: true });
  await writeFile(targetPath, "export const shim = true;\n", "utf8");
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

test("legacy runtime shim validation passes when inventory is empty and no shim files exist", async () => {
  const projectRoot = await mkdtemp(
    resolve(tmpdir(), "legacy-shim-validation-pass-")
  );

  try {
    const inventoryPath = await writeInventory(projectRoot, []);
    const result = await validateLegacyRuntimeShims({
      projectRoot,
      inventoryPath,
    });

    assert.equal(result.ok, true);
    assert.equal(result.expectedCount, 0);
    assert.equal(result.actualCount, 0);
    assert.equal(result.inventoryMustBeEmpty, true);
    assert.deepEqual(result.missingFromInventory, []);
    assert.deepEqual(result.missingOnDisk, []);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("legacy runtime shim validation detects runtime shims missing from inventory", async () => {
  const projectRoot = await mkdtemp(
    resolve(tmpdir(), "legacy-shim-validation-missing-inventory-")
  );

  try {
    await writeShimFile(projectRoot, BASE_ENTRIES[0]!.path);
    const inventoryPath = await writeInventory(projectRoot, []);
    const result = await validateLegacyRuntimeShims({
      projectRoot,
      inventoryPath,
    });

    assert.equal(result.ok, false);
    assert.equal(result.inventoryMustBeEmpty, true);
    assert.deepEqual(result.missingFromInventory, [BASE_ENTRIES[0]!.path]);
    assert.deepEqual(result.missingOnDisk, []);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("legacy runtime shim validation fails when inventory contains legacy shim entries", async () => {
  const projectRoot = await mkdtemp(
    resolve(tmpdir(), "legacy-shim-validation-non-empty-inventory-")
  );

  try {
    const inventoryPath = await writeInventory(projectRoot, BASE_ENTRIES);
    const result = await validateLegacyRuntimeShims({
      projectRoot,
      inventoryPath,
    });

    assert.equal(result.ok, false);
    assert.equal(result.inventoryMustBeEmpty, false);
    assert.deepEqual(result.missingFromInventory, []);
    assert.deepEqual(
      result.missingOnDisk,
      BASE_ENTRIES.map((entry) => entry.path)
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("legacy runtime shim validation enforces follow-up bead IDs when inventory drift appears", async () => {
  const projectRoot = await mkdtemp(
    resolve(tmpdir(), "legacy-shim-validation-follow-up-")
  );

  try {
    const inventoryPath = await writeInventory(projectRoot, [
      {
        ...BASE_ENTRIES[0]!,
        followUpBeadId: "",
      },
    ]);
    const result = await validateLegacyRuntimeShims({
      projectRoot,
      inventoryPath,
    });

    assert.equal(result.ok, false);
    assert.equal(result.inventoryMustBeEmpty, false);
    assert.deepEqual(result.invalidFollowUpBeadIds, [BASE_ENTRIES[0]!.path]);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("legacy runtime shim validation requires non-empty inventory notes", async () => {
  const projectRoot = await mkdtemp(
    resolve(tmpdir(), "legacy-shim-validation-notes-")
  );

  try {
    const inventoryPath = await writeInventory(projectRoot, [
      {
        ...BASE_ENTRIES[0]!,
        notes: "",
      },
    ]);

    await assert.rejects(
      () => validateLegacyRuntimeShims({ projectRoot, inventoryPath }),
      /entries\[0\]\.notes must be a non-empty string/i
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("legacy runtime shim validation detects duplicate inventory paths", async () => {
  const projectRoot = await mkdtemp(
    resolve(tmpdir(), "legacy-shim-validation-duplicates-")
  );

  try {
    const inventoryPath = await writeInventory(projectRoot, [
      BASE_ENTRIES[0]!,
      BASE_ENTRIES[0]!,
    ]);
    const result = await validateLegacyRuntimeShims({
      projectRoot,
      inventoryPath,
    });

    assert.equal(result.ok, false);
    assert.deepEqual(result.duplicateInventoryEntries, [BASE_ENTRIES[0]!.path]);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("legacy runtime shim validation requires sorted inventory order", async () => {
  const projectRoot = await mkdtemp(
    resolve(tmpdir(), "legacy-shim-validation-order-")
  );

  try {
    const inventoryPath = await writeInventory(projectRoot, [
      BASE_ENTRIES[1]!,
      BASE_ENTRIES[0]!,
    ]);
    const result = await validateLegacyRuntimeShims({
      projectRoot,
      inventoryPath,
    });

    assert.equal(result.ok, false);
    assert.equal(result.inventoryOrderStable, false);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("legacy runtime shim validation CLI main supports json output for explicit project and inventory paths", async () => {
  const projectRoot = await mkdtemp(
    resolve(tmpdir(), "legacy-shim-validation-main-json-")
  );

  try {
    const inventoryPath = await writeInventory(projectRoot, []);
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
