import assert from "node:assert/strict";

import { test } from "@effect-native/bun-test";

import {
  enterprisePostgresLatestMigrationVersion,
  enterprisePostgresMigrations,
  enterprisePostgresSchemaCoverageStatements,
  listPendingEnterprisePostgresMigrations,
  planEnterprisePostgresMigrations,
} from "../../libs/shared/src/effect/storage/postgres/migrations.ts";

const toMigrationVersions = (
  migrations: readonly (typeof enterprisePostgresMigrations)[number][]
): readonly number[] => migrations.map((migration) => migration.version);

test("ums-memory-onf.1: enterprise postgres migration definitions and planning are deterministic", () => {
  assert.equal(enterprisePostgresMigrations.length, 6);
  assert.equal(enterprisePostgresLatestMigrationVersion, 6);

  const firstMigration = enterprisePostgresMigrations.at(0);
  const secondMigration = enterprisePostgresMigrations.at(1);
  const thirdMigration = enterprisePostgresMigrations.at(2);
  const fourthMigration = enterprisePostgresMigrations.at(3);
  const fifthMigration = enterprisePostgresMigrations.at(4);
  const sixthMigration = enterprisePostgresMigrations.at(5);

  assert.ok(firstMigration);
  assert.equal(firstMigration.version, 1);
  assert.equal(firstMigration.name, "enterprise_postgres_v1");
  assert.equal(
    firstMigration.sql,
    `${firstMigration.statements.join("\n\n")}\n`
  );
  assert.ok(secondMigration);
  assert.equal(secondMigration.version, 2);
  assert.equal(
    secondMigration.name,
    "enterprise_postgres_v2_tsvector_memory_search"
  );
  assert.ok(thirdMigration);
  assert.equal(thirdMigration.version, 3);
  assert.equal(
    thirdMigration.name,
    "enterprise_postgres_v3_audit_event_ledger"
  );
  assert.ok(fourthMigration);
  assert.equal(fourthMigration.version, 4);
  assert.equal(
    fourthMigration.name,
    "enterprise_postgres_v4_storage_idempotency_ledger"
  );
  assert.ok(fifthMigration);
  assert.equal(fifthMigration.version, 5);
  assert.equal(
    fifthMigration.name,
    "enterprise_postgres_v5_identity_runtime_bindings"
  );
  assert.ok(sixthMigration);
  assert.equal(sixthMigration.version, 6);
  assert.equal(
    sixthMigration.name,
    "enterprise_postgres_v6_provenance_lineage_dimensions"
  );

  const planFromZero = planEnterprisePostgresMigrations(0);
  assert.equal(planFromZero.currentVersion, 0);
  assert.equal(planFromZero.targetVersion, 6);
  assert.equal(planFromZero.latestVersion, 6);
  assert.equal(planFromZero.isUpToDate, false);
  assert.deepEqual(
    toMigrationVersions(planFromZero.pendingMigrations),
    [1, 2, 3, 4, 5, 6]
  );

  const planFromLatest = planEnterprisePostgresMigrations(6);
  assert.equal(planFromLatest.currentVersion, 6);
  assert.equal(planFromLatest.isUpToDate, true);
  assert.deepEqual(toMigrationVersions(planFromLatest.pendingMigrations), []);

  const planFromOne = planEnterprisePostgresMigrations(1);
  assert.equal(planFromOne.currentVersion, 1);
  assert.deepEqual(
    toMigrationVersions(planFromOne.pendingMigrations),
    [2, 3, 4, 5, 6]
  );

  assert.deepEqual(
    toMigrationVersions(listPendingEnterprisePostgresMigrations(0)),
    [1, 2, 3, 4, 5, 6]
  );
});

test("ums-memory-onf.1: enterprise postgres migrations cover the full schema exactly once plus the v2 backfill", () => {
  const schemaStatements = new Set(enterprisePostgresSchemaCoverageStatements);
  const migrationStatements = enterprisePostgresMigrations.flatMap(
    (migration) => migration.statements
  );
  const uniqueMigrationStatements = new Set(migrationStatements);

  assert.equal(uniqueMigrationStatements.size, migrationStatements.length);
  for (const statement of enterprisePostgresSchemaCoverageStatements) {
    assert.ok(
      uniqueMigrationStatements.has(statement),
      `Missing schema coverage statement: ${statement.slice(0, 80)}`
    );
  }
  assert.ok(
    migrationStatements.some((statement) =>
      statement.includes("INSERT INTO memory_items_fts")
    )
  );
  assert.equal(uniqueMigrationStatements.size, schemaStatements.size);
});
