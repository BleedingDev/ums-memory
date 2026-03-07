import assert from "node:assert/strict";

import { test } from "@effect-native/bun-test";

import {
  enterprisePostgresIndexNames,
  enterprisePostgresIndexes,
  enterprisePostgresSchema,
  enterprisePostgresSchemaSql,
  enterprisePostgresSchemaStatements,
  enterprisePostgresSchemaVersion,
  enterprisePostgresTableNames,
  enterprisePostgresTables,
  enterprisePostgresTriggerNames,
  enterprisePostgresTriggers,
} from "../../libs/shared/src/effect/storage/postgres/schema.ts";
import {
  enterpriseSqliteIndexNames,
  enterpriseSqliteSchemaVersion,
  enterpriseSqliteTableNames,
  enterpriseSqliteTriggerNames,
} from "../../libs/shared/src/effect/storage/sqlite/enterprise-schema.ts";

test("ums-memory-onf.1: enterprise postgres schema ordering stays deterministic and parity-aligned", () => {
  assert.equal(enterprisePostgresSchemaVersion, enterpriseSqliteSchemaVersion);
  assert.deepEqual(
    [...enterprisePostgresTableNames],
    [...enterpriseSqliteTableNames]
  );
  assert.deepEqual(
    [...enterprisePostgresIndexNames],
    [...enterpriseSqliteIndexNames]
  );
  assert.deepEqual(
    [...enterprisePostgresTriggerNames],
    [...enterpriseSqliteTriggerNames]
  );
  assert.deepEqual(
    enterprisePostgresTables.map((table) => table.name),
    [...enterprisePostgresTableNames]
  );
  assert.deepEqual(
    enterprisePostgresIndexes.map((index) => index.name),
    [...enterprisePostgresIndexNames]
  );
  assert.deepEqual(
    enterprisePostgresTriggers.map((trigger) => trigger.name),
    [...enterprisePostgresTriggerNames]
  );
  assert.deepEqual(enterprisePostgresSchemaStatements, [
    ...enterprisePostgresTables.map((table) => table.ddl),
    ...enterprisePostgresTriggers.map((trigger) => trigger.ddl),
    ...enterprisePostgresIndexes.map((index) => index.ddl),
  ]);
  assert.equal(
    enterprisePostgresSchemaSql,
    `${enterprisePostgresSchemaStatements.join("\n\n")}\n`
  );
  assert.equal(
    enterprisePostgresSchema.version,
    enterprisePostgresSchemaVersion
  );
});

test("ums-memory-onf.1: enterprise postgres schema encodes required postgres semantics", () => {
  const memoryItemsTable = enterprisePostgresTables.find(
    (table) => table.name === "memory_items"
  );
  const memorySearchTable = enterprisePostgresTables.find(
    (table) => table.name === "memory_items_fts"
  );
  const identityBindingIndex = enterprisePostgresIndexes.find(
    (index) => index.name === "uq_identity_issuer_bindings_primary"
  );
  const ftsUpdateTrigger = enterprisePostgresTriggers.find(
    (trigger) => trigger.name === "trg_memory_items_fts_update"
  );

  assert.ok(memoryItemsTable);
  assert.match(memoryItemsTable.ddl, /payload_json JSONB NOT NULL/);
  assert.ok(memorySearchTable);
  assert.match(memorySearchTable.ddl, /document TSVECTOR GENERATED ALWAYS AS/);
  assert.ok(identityBindingIndex);
  assert.match(identityBindingIndex.ddl, /WHERE is_primary = TRUE;/);
  assert.ok(ftsUpdateTrigger);
  assert.match(ftsUpdateTrigger.ddl, /payload_json::text/);
  assert.match(
    enterprisePostgresSchemaSql,
    /CREATE TABLE IF NOT EXISTS audit_event_provenance_links/
  );
});
