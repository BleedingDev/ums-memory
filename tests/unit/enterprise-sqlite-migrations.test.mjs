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
  import.meta.url,
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
    "utf8",
  );
};

let sqliteMigrationModulePromise;
let transpiledDirectoryPath;

const loadSqliteMigrationModule = async () => {
  if (!sqliteMigrationModulePromise) {
    transpiledDirectoryPath = mkdtempSync(join(tmpdir(), "ums-memory-sqlite-migrations-"));
    transpileToTempModule("schema-metadata.ts", transpiledDirectoryPath);
    transpileToTempModule("enterprise-schema.ts", transpiledDirectoryPath);
    transpileToTempModule("migrations.ts", transpiledDirectoryPath);
    const migrationsModuleUrl = pathToFileURL(
      join(transpiledDirectoryPath, "migrations.js"),
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
      ].join("\n"),
    )
    .all();

test("ums-memory-5cb.2: enterprise sqlite migration definitions and planning are deterministic", async () => {
  const migrationsModule = await loadSqliteMigrationModule();

  assert.equal(migrationsModule.enterpriseSqliteMigrations.length, 1);
  assert.equal(migrationsModule.enterpriseSqliteLatestMigrationVersion, 1);

  const migrationV1 = migrationsModule.enterpriseSqliteMigrations[0];
  assert.equal(migrationV1.version, 1);
  assert.equal(migrationV1.name, "enterprise_sqlite_v1");
  assert.equal(migrationV1.sql, `${migrationV1.statements.join("\n\n")}\n`);

  const planFromVersionZero = migrationsModule.planSqliteMigrations(
    migrationsModule.enterpriseSqliteMigrations,
    0,
  );
  assert.equal(planFromVersionZero.currentVersion, 0);
  assert.equal(planFromVersionZero.targetVersion, 1);
  assert.equal(planFromVersionZero.latestVersion, 1);
  assert.equal(planFromVersionZero.isUpToDate, false);
  assert.deepEqual(toMigrationVersions(planFromVersionZero.pendingMigrations), [1]);

  const planFromLatest = migrationsModule.planSqliteMigrations(
    migrationsModule.enterpriseSqliteMigrations,
    1,
  );
  assert.equal(planFromLatest.currentVersion, 1);
  assert.equal(planFromLatest.isUpToDate, true);
  assert.deepEqual(toMigrationVersions(planFromLatest.pendingMigrations), []);
});

test("ums-memory-5cb.2: enterprise sqlite migration apply is replay-safe deterministic and no-op when up to date", async () => {
  const migrationsModule = await loadSqliteMigrationModule();

  const migrateAndSnapshotSchema = () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec("PRAGMA foreign_keys = ON;");
      assert.equal(migrationsModule.readSqliteUserVersion(database), 0);

      const initialPending = migrationsModule.listPendingEnterpriseSqliteMigrations(database);
      assert.deepEqual(toMigrationVersions(initialPending), [1]);

      const firstApplyResult = migrationsModule.applyEnterpriseSqliteMigrations(database);
      assert.equal(firstApplyResult.isUpToDate, false);
      assert.deepEqual(toMigrationVersions(firstApplyResult.appliedMigrations), [1]);
      assert.equal(migrationsModule.readSqliteUserVersion(database), 1);

      const replayApplyResult = migrationsModule.applyEnterpriseSqliteMigrations(database);
      assert.equal(replayApplyResult.isUpToDate, true);
      assert.deepEqual(toMigrationVersions(replayApplyResult.appliedMigrations), []);
      assert.equal(migrationsModule.readSqliteUserVersion(database), 1);

      return readSchemaSignature(database);
    } finally {
      database.close();
    }
  };

  const firstSchemaSnapshot = migrateAndSnapshotSchema();
  const secondSchemaSnapshot = migrateAndSnapshotSchema();
  assert.deepEqual(firstSchemaSnapshot, secondSchemaSnapshot);
});

test("ums-memory-5cb.2: migration fails fast on incompatible pre-existing schema", async () => {
  const migrationsModule = await loadSqliteMigrationModule();
  const database = new DatabaseSync(":memory:");

  try {
    database.exec("CREATE TABLE tenants (tenant_id TEXT PRIMARY KEY) STRICT;");
    assert.equal(migrationsModule.readSqliteUserVersion(database), 0);

    assert.throws(
      () => migrationsModule.applyEnterpriseSqliteMigrations(database),
      /already exists/i,
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
      migrationsModule.enterpriseSqliteLatestMigrationVersion,
    );
    assert.throws(
      () => migrationsModule.applyEnterpriseSqliteMigrations(database),
      /schema drift detected/i,
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
      migrationsModule.enterpriseSqliteLatestMigrationVersion,
    );

    database.exec("DROP TRIGGER trg_scopes_scope_level_immutable;");
    database.exec([
      "CREATE TRIGGER trg_scopes_scope_level_immutable",
      "BEFORE UPDATE OF scope_level ON scopes",
      "FOR EACH ROW",
      "BEGIN",
      "  SELECT 1;",
      "END;",
    ].join("\n"));

    assert.throws(
      () => migrationsModule.applyEnterpriseSqliteMigrations(database),
      /schema drift detected/i,
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
    database.exec("CREATE TABLE rogue_schema_object (id INTEGER PRIMARY KEY) STRICT;");

    assert.throws(
      () => migrationsModule.applyEnterpriseSqliteMigrations(database),
      /schema drift detected/i,
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
      /schema drift detected/i,
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
    database.exec([
      "CREATE TRIGGER trg_scopes_scope_level_immutable",
      "BEFORE UPDATE OF scope_level ON scopes",
      "FOR EACH ROW",
      "WHEN NEW.scope_level <> OLD.scope_level",
      "BEGIN",
      "  SELECT RAISE(ABORT, 'scope_level_immutable');",
      "END;",
    ].join("\n"));

    assert.throws(
      () => migrationsModule.applyEnterpriseSqliteMigrations(database),
      /schema drift detected/i,
    );
  } finally {
    database.close();
  }
});

test("ums-memory-5cb.2: enterprise sqlite migration planning rejects unknown future versions", async () => {
  const migrationsModule = await loadSqliteMigrationModule();
  const database = new DatabaseSync(":memory:");

  try {
    migrationsModule.writeSqliteUserVersion(database, 2);
    assert.equal(migrationsModule.readSqliteUserVersion(database), 2);

    assert.throws(
      () => migrationsModule.planEnterpriseSqliteMigrations(database),
      /ahead of latest migration version/i,
    );
    assert.throws(
      () => migrationsModule.applyEnterpriseSqliteMigrations(database),
      /ahead of latest migration version/i,
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
      statements: Object.freeze(["CREATE TABLE IF NOT EXISTS t1 (id INTEGER PRIMARY KEY) STRICT;"]),
      sql: "CREATE TABLE IF NOT EXISTS t1 (id INTEGER PRIMARY KEY) STRICT;\n",
    }),
    Object.freeze({
      version: 3,
      name: "v3",
      description: "v3",
      statements: Object.freeze(["CREATE TABLE IF NOT EXISTS t3 (id INTEGER PRIMARY KEY) STRICT;"]),
      sql: "CREATE TABLE IF NOT EXISTS t3 (id INTEGER PRIMARY KEY) STRICT;\n",
    }),
  ]);

  assert.throws(
    () => migrationsModule.planSqliteMigrations(sparseMigrations, 0, 2),
    /must match an existing migration version/i,
  );
  assert.throws(
    () => migrationsModule.listPendingSqliteMigrations(sparseMigrations, 0, 2),
    /must match an existing migration version/i,
  );

  assert.throws(
    () => migrationsModule.planSqliteMigrations(sparseMigrations, 2, 3),
    /currentVersion 2 must match an existing migration version/i,
  );
  assert.throws(
    () => migrationsModule.listPendingSqliteMigrations(sparseMigrations, 2, 3),
    /currentVersion 2 must match an existing migration version/i,
  );

  const database = new DatabaseSync(":memory:");
  try {
    migrationsModule.writeSqliteUserVersion(database, 2);
    assert.throws(
      () => migrationsModule.applySqliteMigrations(database, sparseMigrations, 3),
      /currentVersion 2 must match an existing migration version/i,
    );
  } finally {
    database.close();
  }

  const zeroVersionMigration = Object.freeze([
    Object.freeze({
      version: 0,
      name: "v0_invalid",
      description: "invalid",
      statements: Object.freeze(["CREATE TABLE IF NOT EXISTS t0 (id INTEGER PRIMARY KEY) STRICT;"]),
      sql: "CREATE TABLE IF NOT EXISTS t0 (id INTEGER PRIMARY KEY) STRICT;\n",
    }),
  ]);
  assert.throws(
    () => migrationsModule.planSqliteMigrations(zeroVersionMigration, 0),
    /must use a version >= 1/i,
  );
});

test("ums-memory-5cb.2: user_version writes enforce SQLite integer bounds", async () => {
  const migrationsModule = await loadSqliteMigrationModule();
  const database = new DatabaseSync(":memory:");

  try {
    assert.throws(
      () => migrationsModule.writeSqliteUserVersion(database, 2_147_483_648),
      /non-negative safe integer/i,
    );
    assert.throws(
      () => migrationsModule.writeSqliteUserVersion(database, Number.MAX_SAFE_INTEGER),
      /non-negative safe integer/i,
    );

    migrationsModule.writeSqliteUserVersion(database, 2_147_483_647);
    assert.equal(migrationsModule.readSqliteUserVersion(database), 2_147_483_647);
  } finally {
    database.close();
  }
});
