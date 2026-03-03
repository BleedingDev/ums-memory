import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { pathToFileURL } from "node:url";

import ts from "typescript";

const sqliteModuleDirectory = new URL(
  "../../libs/shared/src/effect/storage/sqlite/",
  import.meta.url
);

const transpileToTempModule = (sourceFilename, tempDirectory) => {
  const sourceFileUrl = new URL(sourceFilename, sqliteModuleDirectory);
  const source = readFileSync(sourceFileUrl, "utf8");
  const transpiled = ts.transpileModule(source, {
    fileName: sourceFileUrl.pathname,
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  });
  writeFileSync(
    join(tempDirectory, sourceFilename.replace(/\.ts$/, ".js")),
    transpiled.outputText,
    "utf8"
  );
};

let sqliteMigrationModulePromise;
let transpiledDirectoryPath;

const loadSqliteMigrationModule = async () => {
  if (!sqliteMigrationModulePromise) {
    transpiledDirectoryPath = mkdtempSync(
      join(tmpdir(), "ums-memory-sqlite-migrations-")
    );
    transpileToTempModule("schema-metadata.ts", transpiledDirectoryPath);
    transpileToTempModule("enterprise-schema.ts", transpiledDirectoryPath);
    transpileToTempModule("migrations.ts", transpiledDirectoryPath);
    const migrationsModuleUrl = pathToFileURL(
      join(transpiledDirectoryPath, "migrations.js")
    ).href;
    sqliteMigrationModulePromise = import(migrationsModuleUrl);
  }

  return sqliteMigrationModulePromise;
};

process.on("exit", () => {
  if (transpiledDirectoryPath) {
    rmSync(transpiledDirectoryPath, { recursive: true, force: true });
  }
});

const toMigrationVersions = (migrations) =>
  migrations.map((migration) => migration.version);

const readSchemaSignature = (database) =>
  database
    .prepare(
      [
        "SELECT type, name, tbl_name AS table_name, sql",
        "FROM sqlite_schema",
        "WHERE type IN ('table', 'index', 'trigger', 'view')",
        "  AND name NOT LIKE 'sqlite_%'",
        "ORDER BY type, name;",
      ].join("\n")
    )
    .all();

test("ums-memory-5cb.2: enterprise sqlite migration definitions and planning are deterministic", async () => {
  const migrationsModule = await loadSqliteMigrationModule();

  assert.equal(migrationsModule.enterpriseSqliteMigrations.length, 4);
  assert.equal(migrationsModule.enterpriseSqliteLatestMigrationVersion, 4);

  const migrationV1 = migrationsModule.enterpriseSqliteMigrations[0];
  assert.equal(migrationV1.version, 1);
  assert.equal(migrationV1.name, "enterprise_sqlite_v1");
  assert.equal(migrationV1.sql, `${migrationV1.statements.join("\n\n")}\n`);
  const migrationV2 = migrationsModule.enterpriseSqliteMigrations[1];
  assert.equal(migrationV2.version, 2);
  assert.equal(migrationV2.name, "enterprise_sqlite_v2_fts5_memory_search");
  assert.equal(migrationV2.sql, `${migrationV2.statements.join("\n\n")}\n`);
  const migrationV3 = migrationsModule.enterpriseSqliteMigrations[2];
  assert.equal(migrationV3.version, 3);
  assert.equal(migrationV3.name, "enterprise_sqlite_v3_audit_event_ledger");
  assert.equal(migrationV3.sql, `${migrationV3.statements.join("\n\n")}\n`);
  const migrationV4 = migrationsModule.enterpriseSqliteMigrations[3];
  assert.equal(migrationV4.version, 4);
  assert.equal(
    migrationV4.name,
    "enterprise_sqlite_v4_storage_idempotency_ledger"
  );
  assert.equal(migrationV4.sql, `${migrationV4.statements.join("\n\n")}\n`);

  const planFromVersionZero = migrationsModule.planSqliteMigrations(
    migrationsModule.enterpriseSqliteMigrations,
    0
  );
  assert.equal(planFromVersionZero.currentVersion, 0);
  assert.equal(planFromVersionZero.targetVersion, 4);
  assert.equal(planFromVersionZero.latestVersion, 4);
  assert.equal(planFromVersionZero.isUpToDate, false);
  assert.deepEqual(
    toMigrationVersions(planFromVersionZero.pendingMigrations),
    [1, 2, 3, 4]
  );

  const planFromLatest = migrationsModule.planSqliteMigrations(
    migrationsModule.enterpriseSqliteMigrations,
    4
  );
  assert.equal(planFromLatest.currentVersion, 4);
  assert.equal(planFromLatest.isUpToDate, true);
  assert.deepEqual(toMigrationVersions(planFromLatest.pendingMigrations), []);

  const planFromVersionOne = migrationsModule.planSqliteMigrations(
    migrationsModule.enterpriseSqliteMigrations,
    1
  );
  assert.equal(planFromVersionOne.currentVersion, 1);
  assert.deepEqual(
    toMigrationVersions(planFromVersionOne.pendingMigrations),
    [2, 3, 4]
  );
});

test("ums-memory-5cb.2: enterprise sqlite migration apply is replay-safe deterministic and no-op when up to date", async () => {
  const migrationsModule = await loadSqliteMigrationModule();

  const migrateAndSnapshotSchema = () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec("PRAGMA foreign_keys = ON;");
      assert.equal(migrationsModule.readSqliteUserVersion(database), 0);

      const initialPending =
        migrationsModule.listPendingEnterpriseSqliteMigrations(database);
      assert.deepEqual(toMigrationVersions(initialPending), [1, 2, 3, 4]);

      const firstApplyResult =
        migrationsModule.applyEnterpriseSqliteMigrations(database);
      assert.equal(firstApplyResult.isUpToDate, false);
      assert.deepEqual(
        toMigrationVersions(firstApplyResult.appliedMigrations),
        [1, 2, 3, 4]
      );
      assert.equal(migrationsModule.readSqliteUserVersion(database), 4);

      const replayApplyResult =
        migrationsModule.applyEnterpriseSqliteMigrations(database);
      assert.equal(replayApplyResult.isUpToDate, true);
      assert.deepEqual(
        toMigrationVersions(replayApplyResult.appliedMigrations),
        []
      );
      assert.equal(migrationsModule.readSqliteUserVersion(database), 4);

      return readSchemaSignature(database);
    } finally {
      database.close();
    }
  };

  const firstSchemaSnapshot = migrateAndSnapshotSchema();
  const secondSchemaSnapshot = migrateAndSnapshotSchema();
  assert.deepEqual(firstSchemaSnapshot, secondSchemaSnapshot);
});

test("ums-memory-5cb.6: migrating from v1 to v2 backfills FTS rows and uses virtual table query plans", async () => {
  const migrationsModule = await loadSqliteMigrationModule();
  const database = new DatabaseSync(":memory:");

  try {
    database.exec("PRAGMA foreign_keys = ON;");
    const v1ApplyResult = migrationsModule.applyEnterpriseSqliteMigrations(
      database,
      1
    );
    assert.deepEqual(toMigrationVersions(v1ApplyResult.appliedMigrations), [1]);
    assert.equal(migrationsModule.readSqliteUserVersion(database), 1);

    const now = 1_700_000_000_010;
    database
      .prepare(
        "INSERT INTO tenants (tenant_id, tenant_slug, display_name, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?)"
      )
      .run("tenant_v1", "tenant-v1", "Tenant V1", now, now);
    database
      .prepare(
        "INSERT INTO scopes (tenant_id, scope_id, scope_level, project_id, role_id, user_id, parent_scope_id, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        "tenant_v1",
        "scope_common_v1",
        "common",
        null,
        null,
        null,
        null,
        now
      );
    database
      .prepare(
        "INSERT INTO memory_items (tenant_id, memory_id, scope_id, memory_layer, memory_kind, status, title, payload_json, created_by_user_id, supersedes_memory_id, created_at_ms, updated_at_ms, expires_at_ms, tombstoned_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        "tenant_v1",
        "memory_backfill",
        "scope_common_v1",
        "working",
        "note",
        "active",
        "Backfill Search Seed",
        '{"body":"delta keyword"}',
        null,
        null,
        now,
        now,
        null,
        null
      );

    const v2ApplyResult = migrationsModule.applyEnterpriseSqliteMigrations(
      database,
      2
    );
    assert.deepEqual(toMigrationVersions(v2ApplyResult.appliedMigrations), [2]);
    assert.equal(migrationsModule.readSqliteUserVersion(database), 2);

    const searchRows = database
      .prepare(
        "SELECT memory_id FROM memory_items_fts WHERE memory_items_fts MATCH ? AND tenant_id = ?;"
      )
      .all("delta", "tenant_v1");
    assert.equal(searchRows.length, 1);
    assert.equal(searchRows[0].memory_id, "memory_backfill");

    const planRows = database
      .prepare(
        "EXPLAIN QUERY PLAN SELECT memory_id FROM memory_items_fts WHERE memory_items_fts MATCH ? AND tenant_id = ? LIMIT 5;"
      )
      .all("delta", "tenant_v1");
    const planDetails = planRows.map((row) => String(row.detail ?? ""));
    assert.ok(
      planDetails.some(
        (detail) =>
          /virtual table/i.test(detail) && /memory_items_fts/i.test(detail)
      )
    );

    const v3AndV4ApplyResult =
      migrationsModule.applyEnterpriseSqliteMigrations(database);
    assert.deepEqual(
      toMigrationVersions(v3AndV4ApplyResult.appliedMigrations),
      [3, 4]
    );
    assert.equal(migrationsModule.readSqliteUserVersion(database), 4);
  } finally {
    database.close();
  }
});

test("ums-memory-5cb.8: migrating from v2 to v3 adds append-only audit ledger objects", async () => {
  const migrationsModule = await loadSqliteMigrationModule();
  const database = new DatabaseSync(":memory:");

  try {
    database.exec("PRAGMA foreign_keys = ON;");
    const v2ApplyResult = migrationsModule.applyEnterpriseSqliteMigrations(
      database,
      2
    );
    assert.deepEqual(
      toMigrationVersions(v2ApplyResult.appliedMigrations),
      [1, 2]
    );
    assert.equal(migrationsModule.readSqliteUserVersion(database), 2);

    const v3ApplyResult = migrationsModule.applyEnterpriseSqliteMigrations(
      database,
      3
    );
    assert.deepEqual(toMigrationVersions(v3ApplyResult.appliedMigrations), [3]);
    assert.equal(migrationsModule.readSqliteUserVersion(database), 3);

    const tableRow = database
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'audit_events';"
      )
      .get();
    assert.equal(tableRow?.name, "audit_events");

    database
      .prepare(
        "INSERT INTO audit_events (event_id, tenant_id, memory_id, operation, outcome, reason, details, reference_kind, reference_id, owner_tenant_id, recorded_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        "audit:migration-v3",
        "tenant-migration-v3",
        "memory-migration-v3",
        "delete",
        "not_found",
        "memory_not_found",
        "migration test",
        null,
        null,
        null,
        0
      );
    assert.throws(
      () =>
        database
          .prepare("UPDATE audit_events SET details = ? WHERE event_id = ?")
          .run("mutated", "audit:migration-v3"),
      /audit_events_append_only/i
    );
  } finally {
    database.close();
  }
});

test("ums-memory-5cb.10: migrating from v3 to v4 adds storage idempotency ledger objects", async () => {
  const migrationsModule = await loadSqliteMigrationModule();
  const database = new DatabaseSync(":memory:");

  try {
    database.exec("PRAGMA foreign_keys = ON;");
    const v3ApplyResult = migrationsModule.applyEnterpriseSqliteMigrations(
      database,
      3
    );
    assert.deepEqual(
      toMigrationVersions(v3ApplyResult.appliedMigrations),
      [1, 2, 3]
    );
    assert.equal(migrationsModule.readSqliteUserVersion(database), 3);

    const v4ApplyResult =
      migrationsModule.applyEnterpriseSqliteMigrations(database);
    assert.deepEqual(toMigrationVersions(v4ApplyResult.appliedMigrations), [4]);
    assert.equal(migrationsModule.readSqliteUserVersion(database), 4);

    const tableRow = database
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'storage_idempotency_ledger';"
      )
      .get();
    assert.equal(tableRow?.name, "storage_idempotency_ledger");

    database
      .prepare(
        "INSERT INTO storage_idempotency_ledger (tenant_id, operation, idempotency_key, request_hash_sha256, response_json, created_at_ms) VALUES (?, ?, ?, ?, ?, ?);"
      )
      .run(
        "tenant-migration-v4",
        "upsert",
        "migration-v4-key",
        "a".repeat(64),
        '{"spaceId":"tenant-migration-v4","memoryId":"memory-migration-v4","accepted":true,"persistedAtMillis":0,"version":1}',
        0
      );

    const indexRows = database
      .prepare(
        [
          "SELECT name FROM sqlite_schema",
          "WHERE type = 'index'",
          "  AND name IN ('idx_storage_idempotency_ledger_created', 'idx_storage_idempotency_ledger_request_hash')",
          "ORDER BY name ASC;",
        ].join("\n")
      )
      .all();
    assert.deepEqual(
      indexRows.map((row) => row.name),
      [
        "idx_storage_idempotency_ledger_created",
        "idx_storage_idempotency_ledger_request_hash",
      ]
    );
  } finally {
    database.close();
  }
});

test("ums-memory-5cb.2: migration fails fast on incompatible pre-existing schema", async () => {
  const migrationsModule = await loadSqliteMigrationModule();
  const database = new DatabaseSync(":memory:");

  try {
    database.exec("CREATE TABLE tenants (tenant_id TEXT PRIMARY KEY) STRICT;");
    assert.equal(migrationsModule.readSqliteUserVersion(database), 0);

    assert.throws(
      () => migrationsModule.applyEnterpriseSqliteMigrations(database),
      /already exists/i
    );
    assert.equal(migrationsModule.readSqliteUserVersion(database), 0);
  } finally {
    database.close();
  }
});

test("ums-memory-5cb.2: no-op apply rejects user_version/schema drift", async () => {
  const migrationsModule = await loadSqliteMigrationModule();
  const database = new DatabaseSync(":memory:");

  try {
    migrationsModule.writeSqliteUserVersion(
      database,
      migrationsModule.enterpriseSqliteLatestMigrationVersion
    );
    assert.throws(
      () => migrationsModule.applyEnterpriseSqliteMigrations(database),
      /schema drift detected/i
    );
  } finally {
    database.close();
  }
});

test("ums-memory-5cb.2: integrity check rejects mismatched object definitions", async () => {
  const migrationsModule = await loadSqliteMigrationModule();
  const database = new DatabaseSync(":memory:");

  try {
    migrationsModule.applyEnterpriseSqliteMigrations(database);
    assert.equal(
      migrationsModule.readSqliteUserVersion(database),
      migrationsModule.enterpriseSqliteLatestMigrationVersion
    );

    database.exec("DROP TRIGGER trg_scopes_scope_level_immutable;");
    database.exec(
      [
        "CREATE TRIGGER trg_scopes_scope_level_immutable",
        "BEFORE UPDATE OF scope_level ON scopes",
        "FOR EACH ROW",
        "BEGIN",
        "  SELECT 1;",
        "END;",
      ].join("\n")
    );

    assert.throws(
      () => migrationsModule.applyEnterpriseSqliteMigrations(database),
      /schema drift detected/i
    );
  } finally {
    database.close();
  }
});

test("ums-memory-5cb.2: integrity check rejects unexpected schema objects", async () => {
  const migrationsModule = await loadSqliteMigrationModule();
  const database = new DatabaseSync(":memory:");

  try {
    migrationsModule.applyEnterpriseSqliteMigrations(database);
    database.exec(
      "CREATE TABLE rogue_schema_object (id INTEGER PRIMARY KEY) STRICT;"
    );

    assert.throws(
      () => migrationsModule.applyEnterpriseSqliteMigrations(database),
      /schema drift detected/i
    );
  } finally {
    database.close();
  }
});

test("ums-memory-5cb.2: integrity check rejects unexpected views", async () => {
  const migrationsModule = await loadSqliteMigrationModule();
  const database = new DatabaseSync(":memory:");

  try {
    migrationsModule.applyEnterpriseSqliteMigrations(database);
    database.exec("CREATE VIEW rogue_schema_view AS SELECT 1 AS one;");

    assert.throws(
      () => migrationsModule.applyEnterpriseSqliteMigrations(database),
      /schema drift detected/i
    );
  } finally {
    database.close();
  }
});

test("ums-memory-5cb.2: integrity check preserves case-sensitive SQL drift detection", async () => {
  const migrationsModule = await loadSqliteMigrationModule();
  const database = new DatabaseSync(":memory:");

  try {
    migrationsModule.applyEnterpriseSqliteMigrations(database);
    database.exec("DROP TRIGGER trg_scopes_scope_level_immutable;");
    database.exec(
      [
        "CREATE TRIGGER trg_scopes_scope_level_immutable",
        "BEFORE UPDATE OF scope_level ON scopes",
        "FOR EACH ROW",
        "WHEN NEW.scope_level <> OLD.scope_level",
        "BEGIN",
        "  SELECT RAISE(ABORT, 'scope_level_immutable');",
        "END;",
      ].join("\n")
    );

    assert.throws(
      () => migrationsModule.applyEnterpriseSqliteMigrations(database),
      /schema drift detected/i
    );
  } finally {
    database.close();
  }
});

test("ums-memory-5cb.2: enterprise sqlite migration planning rejects unknown future versions", async () => {
  const migrationsModule = await loadSqliteMigrationModule();
  const database = new DatabaseSync(":memory:");

  try {
    migrationsModule.writeSqliteUserVersion(database, 5);
    assert.equal(migrationsModule.readSqliteUserVersion(database), 5);

    assert.throws(
      () => migrationsModule.planEnterpriseSqliteMigrations(database),
      /ahead of latest migration version/i
    );
    assert.throws(
      () => migrationsModule.applyEnterpriseSqliteMigrations(database),
      /ahead of latest migration version/i
    );
  } finally {
    database.close();
  }
});

test("ums-memory-5cb.2: targetVersion must match a declared migration version", async () => {
  const migrationsModule = await loadSqliteMigrationModule();
  const sparseMigrations = Object.freeze([
    Object.freeze({
      version: 1,
      name: "v1",
      description: "v1",
      statements: Object.freeze([
        "CREATE TABLE IF NOT EXISTS t1 (id INTEGER PRIMARY KEY) STRICT;",
      ]),
      sql: "CREATE TABLE IF NOT EXISTS t1 (id INTEGER PRIMARY KEY) STRICT;\n",
    }),
    Object.freeze({
      version: 3,
      name: "v3",
      description: "v3",
      statements: Object.freeze([
        "CREATE TABLE IF NOT EXISTS t3 (id INTEGER PRIMARY KEY) STRICT;",
      ]),
      sql: "CREATE TABLE IF NOT EXISTS t3 (id INTEGER PRIMARY KEY) STRICT;\n",
    }),
  ]);

  assert.throws(
    () => migrationsModule.planSqliteMigrations(sparseMigrations, 0, 2),
    /must match an existing migration version/i
  );
  assert.throws(
    () => migrationsModule.listPendingSqliteMigrations(sparseMigrations, 0, 2),
    /must match an existing migration version/i
  );

  assert.throws(
    () => migrationsModule.planSqliteMigrations(sparseMigrations, 2, 3),
    /currentVersion 2 must match an existing migration version/i
  );
  assert.throws(
    () => migrationsModule.listPendingSqliteMigrations(sparseMigrations, 2, 3),
    /currentVersion 2 must match an existing migration version/i
  );

  const database = new DatabaseSync(":memory:");
  try {
    migrationsModule.writeSqliteUserVersion(database, 2);
    assert.throws(
      () =>
        migrationsModule.applySqliteMigrations(database, sparseMigrations, 3),
      /currentVersion 2 must match an existing migration version/i
    );
  } finally {
    database.close();
  }

  const zeroVersionMigration = Object.freeze([
    Object.freeze({
      version: 0,
      name: "v0_invalid",
      description: "invalid",
      statements: Object.freeze([
        "CREATE TABLE IF NOT EXISTS t0 (id INTEGER PRIMARY KEY) STRICT;",
      ]),
      sql: "CREATE TABLE IF NOT EXISTS t0 (id INTEGER PRIMARY KEY) STRICT;\n",
    }),
  ]);
  assert.throws(
    () => migrationsModule.planSqliteMigrations(zeroVersionMigration, 0),
    /must use a version >= 1/i
  );
});

test("ums-memory-5cb.2: user_version writes enforce SQLite integer bounds", async () => {
  const migrationsModule = await loadSqliteMigrationModule();
  const database = new DatabaseSync(":memory:");

  try {
    assert.throws(
      () => migrationsModule.writeSqliteUserVersion(database, 2_147_483_648),
      /non-negative safe integer/i
    );
    assert.throws(
      () =>
        migrationsModule.writeSqliteUserVersion(
          database,
          Number.MAX_SAFE_INTEGER
        ),
      /non-negative safe integer/i
    );

    migrationsModule.writeSqliteUserVersion(database, 2_147_483_647);
    assert.equal(
      migrationsModule.readSqliteUserVersion(database),
      2_147_483_647
    );
  } finally {
    database.close();
  }
});
