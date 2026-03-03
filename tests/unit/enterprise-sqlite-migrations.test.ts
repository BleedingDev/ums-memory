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

const transpileToTempModule = (sourceFilename: any, tempDirectory: any) => {
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

let sqliteMigrationModulePromise: any;
let transpiledDirectoryPath: any;

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

const toMigrationVersions = (migrations: any) =>
  migrations.map((migration: any) => migration.version);

const readSchemaSignature = (database: any) =>
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

  assert.equal(migrationsModule.enterpriseSqliteMigrations.length, 6);
  assert.equal(migrationsModule.enterpriseSqliteLatestMigrationVersion, 6);

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
  const migrationV5 = migrationsModule.enterpriseSqliteMigrations[4];
  assert.equal(migrationV5.version, 5);
  assert.equal(
    migrationV5.name,
    "enterprise_sqlite_v5_identity_runtime_bindings"
  );
  assert.equal(migrationV5.sql, `${migrationV5.statements.join("\n\n")}\n`);
  const migrationV6 = migrationsModule.enterpriseSqliteMigrations[5];
  assert.equal(migrationV6.version, 6);
  assert.equal(
    migrationV6.name,
    "enterprise_sqlite_v6_provenance_lineage_dimensions"
  );
  assert.equal(migrationV6.sql, `${migrationV6.statements.join("\n\n")}\n`);

  const planFromVersionZero = migrationsModule.planSqliteMigrations(
    migrationsModule.enterpriseSqliteMigrations,
    0
  );
  assert.equal(planFromVersionZero.currentVersion, 0);
  assert.equal(planFromVersionZero.targetVersion, 6);
  assert.equal(planFromVersionZero.latestVersion, 6);
  assert.equal(planFromVersionZero.isUpToDate, false);
  assert.deepEqual(
    toMigrationVersions(planFromVersionZero.pendingMigrations),
    [1, 2, 3, 4, 5, 6]
  );

  const planFromLatest = migrationsModule.planSqliteMigrations(
    migrationsModule.enterpriseSqliteMigrations,
    6
  );
  assert.equal(planFromLatest.currentVersion, 6);
  assert.equal(planFromLatest.isUpToDate, true);
  assert.deepEqual(toMigrationVersions(planFromLatest.pendingMigrations), []);

  const planFromVersionOne = migrationsModule.planSqliteMigrations(
    migrationsModule.enterpriseSqliteMigrations,
    1
  );
  assert.equal(planFromVersionOne.currentVersion, 1);
  assert.deepEqual(
    toMigrationVersions(planFromVersionOne.pendingMigrations),
    [2, 3, 4, 5, 6]
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
      assert.deepEqual(toMigrationVersions(initialPending), [1, 2, 3, 4, 5, 6]);

      const firstApplyResult =
        migrationsModule.applyEnterpriseSqliteMigrations(database);
      assert.equal(firstApplyResult.isUpToDate, false);
      assert.deepEqual(
        toMigrationVersions(firstApplyResult.appliedMigrations),
        [1, 2, 3, 4, 5, 6]
      );
      assert.equal(migrationsModule.readSqliteUserVersion(database), 6);

      const replayApplyResult =
        migrationsModule.applyEnterpriseSqliteMigrations(database);
      assert.equal(replayApplyResult.isUpToDate, true);
      assert.deepEqual(
        toMigrationVersions(replayApplyResult.appliedMigrations),
        []
      );
      assert.equal(migrationsModule.readSqliteUserVersion(database), 6);

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

    const v3ToV6ApplyResult =
      migrationsModule.applyEnterpriseSqliteMigrations(database);
    assert.deepEqual(
      toMigrationVersions(v3ToV6ApplyResult.appliedMigrations),
      [3, 4, 5, 6]
    );
    assert.equal(migrationsModule.readSqliteUserVersion(database), 6);
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

    const v4ApplyResult = migrationsModule.applyEnterpriseSqliteMigrations(
      database,
      4
    );
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

test("ums-memory-wt0.1: migrating from v4 to v5 adds deterministic identity runtime objects", async () => {
  const migrationsModule = await loadSqliteMigrationModule();
  const database = new DatabaseSync(":memory:");

  try {
    database.exec("PRAGMA foreign_keys = ON;");
    const v4ApplyResult = migrationsModule.applyEnterpriseSqliteMigrations(
      database,
      4
    );
    assert.deepEqual(
      toMigrationVersions(v4ApplyResult.appliedMigrations),
      [1, 2, 3, 4]
    );
    assert.equal(migrationsModule.readSqliteUserVersion(database), 4);

    const v5ApplyResult = migrationsModule.applyEnterpriseSqliteMigrations(
      database,
      5
    );
    assert.deepEqual(toMigrationVersions(v5ApplyResult.appliedMigrations), [5]);
    assert.equal(migrationsModule.readSqliteUserVersion(database), 5);

    const identityTableNames = database
      .prepare(
        [
          "SELECT name FROM sqlite_schema",
          "WHERE type = 'table'",
          "  AND name IN ('identity_issuer_bindings', 'user_external_subjects', 'identity_sync_checkpoints')",
          "ORDER BY name ASC;",
        ].join("\n")
      )
      .all()
      .map((row) => row.name);
    assert.deepEqual(identityTableNames, [
      "identity_issuer_bindings",
      "identity_sync_checkpoints",
      "user_external_subjects",
    ]);

    const now = 1_700_000_000_020;
    database
      .prepare(
        "INSERT INTO tenants (tenant_id, tenant_slug, display_name, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?);"
      )
      .run("tenant-id-v5", "tenant-id-v5", "Tenant Id V5", now, now);
    database
      .prepare(
        "INSERT INTO users (tenant_id, user_id, email, display_name, status, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?);"
      )
      .run(
        "tenant-id-v5",
        "user-id-v5",
        "user-id-v5@example.com",
        "User Id V5",
        "active",
        now,
        now
      );

    database
      .prepare(
        "INSERT INTO identity_issuer_bindings (tenant_id, issuer_binding_id, issuer, issuer_kind, is_primary, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?);"
      )
      .run(
        "tenant-id-v5",
        "issuer-v5-primary",
        "https://idp.v5.example.com",
        "oidc",
        1,
        now,
        now
      );
    database
      .prepare(
        "INSERT INTO user_external_subjects (tenant_id, issuer_binding_id, external_subject_id, user_id, subject_hash_sha256, subject_source, first_seen_at_ms, last_seen_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?);"
      )
      .run(
        "tenant-id-v5",
        "issuer-v5-primary",
        "subject-v5-001",
        "user-id-v5",
        "f".repeat(64),
        "scim",
        now,
        now
      );
    database
      .prepare(
        "INSERT INTO identity_sync_checkpoints (tenant_id, issuer_binding_id, sync_channel, checkpoint_cursor, cursor_hash_sha256, cursor_sequence, checkpointed_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?);"
      )
      .run(
        "tenant-id-v5",
        "issuer-v5-primary",
        "scim_users",
        "cursor-v5-001",
        "e".repeat(64),
        1,
        now,
        now
      );

    assert.throws(
      () =>
        database
          .prepare(
            "INSERT INTO identity_issuer_bindings (tenant_id, issuer_binding_id, issuer, issuer_kind, is_primary, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?);"
          )
          .run(
            "tenant-id-v5",
            "issuer-v5-secondary",
            "https://idp.v5-secondary.example.com",
            "oidc",
            1,
            now,
            now
          ),
      /constraint|unique/i
    );
  } finally {
    database.close();
  }
});

test("ums-memory-i6m.2: migrating from v5 to v6 adds provenance lineage linkage objects", async () => {
  const migrationsModule = await loadSqliteMigrationModule();
  const database = new DatabaseSync(":memory:");

  try {
    database.exec("PRAGMA foreign_keys = ON;");
    const v5ApplyResult = migrationsModule.applyEnterpriseSqliteMigrations(
      database,
      5
    );
    assert.deepEqual(
      toMigrationVersions(v5ApplyResult.appliedMigrations),
      [1, 2, 3, 4, 5]
    );
    assert.equal(migrationsModule.readSqliteUserVersion(database), 5);

    const v6ApplyResult = migrationsModule.applyEnterpriseSqliteMigrations(
      database,
      6
    );
    assert.deepEqual(toMigrationVersions(v6ApplyResult.appliedMigrations), [6]);
    assert.equal(migrationsModule.readSqliteUserVersion(database), 6);

    const now = 1_700_000_000_030;
    database
      .prepare(
        "INSERT INTO tenants (tenant_id, tenant_slug, display_name, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?);"
      )
      .run("tenant-prov-v6", "tenant-prov-v6", "Tenant Prov V6", now, now);
    database
      .prepare(
        "INSERT INTO projects (tenant_id, project_id, project_key, display_name, status, created_at_ms, archived_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?);"
      )
      .run(
        "tenant-prov-v6",
        "project-prov-v6",
        "PROV-V6",
        "Project Prov V6",
        "active",
        now,
        null
      );
    database
      .prepare(
        "INSERT INTO roles (tenant_id, role_id, role_code, display_name, role_type, created_at_ms) VALUES (?, ?, ?, ?, ?, ?);"
      )
      .run(
        "tenant-prov-v6",
        "role-prov-v6",
        "ROLE_PROV_V6",
        "Role Prov V6",
        "project",
        now
      );
    database
      .prepare(
        "INSERT INTO users (tenant_id, user_id, email, display_name, status, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?);"
      )
      .run(
        "tenant-prov-v6",
        "user-prov-v6",
        "user-prov-v6@example.com",
        "User Prov V6",
        "active",
        now,
        now
      );
    database
      .prepare(
        "INSERT INTO scopes (tenant_id, scope_id, scope_level, project_id, role_id, user_id, parent_scope_id, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?);"
      )
      .run(
        "tenant-prov-v6",
        "scope-common-prov-v6",
        "common",
        null,
        null,
        null,
        null,
        now
      );
    database
      .prepare(
        "INSERT INTO scopes (tenant_id, scope_id, scope_level, project_id, role_id, user_id, parent_scope_id, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?);"
      )
      .run(
        "tenant-prov-v6",
        "scope-project-prov-v6",
        "project",
        "project-prov-v6",
        null,
        null,
        "scope-common-prov-v6",
        now
      );
    database
      .prepare(
        "INSERT INTO memory_items (tenant_id, memory_id, scope_id, memory_layer, memory_kind, status, title, payload_json, created_by_user_id, supersedes_memory_id, created_at_ms, updated_at_ms, expires_at_ms, tombstoned_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);"
      )
      .run(
        "tenant-prov-v6",
        "memory-prov-v6",
        "scope-project-prov-v6",
        "working",
        "note",
        "active",
        "Memory Prov V6",
        "{}",
        "user-prov-v6",
        null,
        now,
        now,
        null,
        null
      );
    database
      .prepare(
        "INSERT INTO evidence (tenant_id, evidence_id, source_kind, source_ref, digest_sha256, payload_json, observed_at_ms, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?);"
      )
      .run(
        "tenant-prov-v6",
        "evidence-prov-v6",
        "event",
        "event://prov-v6-1",
        "1".repeat(64),
        "{}",
        now,
        now
      );
    database
      .prepare(
        "INSERT INTO audit_events (event_id, tenant_id, memory_id, operation, outcome, reason, details, reference_kind, reference_id, owner_tenant_id, recorded_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);"
      )
      .run(
        "audit:prov-v6:event-1",
        "tenant-prov-v6",
        "memory-prov-v6",
        "upsert",
        "accepted",
        "inserted",
        "migration provenance test",
        null,
        null,
        null,
        now
      );

    database
      .prepare(
        "INSERT INTO provenance_envelopes (tenant_id, provenance_id, project_id, role_id, user_id, agent_id, conversation_id, message_id, source_id, batch_id, observed_at_ms, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);"
      )
      .run(
        "tenant-prov-v6",
        "prov-v6-1",
        "project-prov-v6",
        "role-prov-v6",
        "user-prov-v6",
        "agent-prov-v6",
        "conversation-prov-v6",
        "message-prov-v6",
        "source-prov-v6",
        "batch-prov-v6",
        now,
        now
      );
    database
      .prepare(
        "INSERT INTO memory_provenance_links (tenant_id, memory_id, provenance_id, linked_at_ms) VALUES (?, ?, ?, ?);"
      )
      .run("tenant-prov-v6", "memory-prov-v6", "prov-v6-1", now);
    database
      .prepare(
        "INSERT INTO evidence_provenance_links (tenant_id, evidence_id, provenance_id, linked_at_ms) VALUES (?, ?, ?, ?);"
      )
      .run("tenant-prov-v6", "evidence-prov-v6", "prov-v6-1", now);
    database
      .prepare(
        "INSERT INTO audit_event_provenance_links (event_id, tenant_id, provenance_id, linked_at_ms) VALUES (?, ?, ?, ?);"
      )
      .run("audit:prov-v6:event-1", "tenant-prov-v6", "prov-v6-1", now);

    assert.throws(
      () =>
        database
          .prepare(
            "INSERT INTO provenance_envelopes (tenant_id, provenance_id, project_id, role_id, user_id, agent_id, conversation_id, message_id, source_id, batch_id, observed_at_ms, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);"
          )
          .run(
            "tenant-prov-v6",
            "prov-v6-empty",
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            now,
            now
          ),
      /constraint|check/i
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

test("ums-memory-5cb.2: enterprise sqlite migration planning rejects any future versions", async () => {
  const migrationsModule = await loadSqliteMigrationModule();
  const database = new DatabaseSync(":memory:");

  try {
    migrationsModule.writeSqliteUserVersion(database, 7);
    assert.equal(migrationsModule.readSqliteUserVersion(database), 7);

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
