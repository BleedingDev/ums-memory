import {
  enterprisePostgresIndexes,
  enterprisePostgresSchemaStatements,
  enterprisePostgresTables,
  enterprisePostgresTriggers,
} from "./schema.js";

export interface PostgresMigrationDefinition<Version extends number = number> {
  readonly version: Version;
  readonly name: string;
  readonly description: string;
  readonly statements: readonly string[];
  readonly sql: string;
}

export interface PostgresMigrationPlan<
  Migration extends PostgresMigrationDefinition = PostgresMigrationDefinition,
> {
  readonly currentVersion: number;
  readonly targetVersion: number;
  readonly latestVersion: number;
  readonly pendingMigrations: readonly Migration[];
  readonly isUpToDate: boolean;
}

const POSTGRES_SCHEMA_VERSION_MAX = 2_147_483_647;

const assertNonNegativeSafeInteger = (value: number, label: string): number => {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > POSTGRES_SCHEMA_VERSION_MAX
  ) {
    throw new RangeError(
      `${label} must be a non-negative safe integer. Received: ${value}.`
    );
  }
  return value;
};

const assertDeterministicMigrations = <
  Migration extends PostgresMigrationDefinition,
>(
  migrations: readonly Migration[]
): readonly Migration[] => {
  let previousVersion = -1;

  for (const migration of migrations) {
    const migrationVersion = assertNonNegativeSafeInteger(
      migration.version,
      `migration version for ${migration.name}`
    );
    if (migrationVersion < 1) {
      throw new RangeError(
        `Migration ${migration.name} must use a version >= 1. Received: ${migrationVersion}.`
      );
    }
    if (migrationVersion <= previousVersion) {
      throw new RangeError(
        `Migrations must be strictly ordered by ascending version. Found ${migrationVersion} after ${previousVersion}.`
      );
    }
    if (migration.statements.length === 0) {
      throw new TypeError(
        `Migration ${migration.name} must define at least one SQL statement.`
      );
    }
    const expectedSql = `${migration.statements.join("\n\n")}\n`;
    if (migration.sql !== expectedSql) {
      throw new TypeError(
        `Migration ${migration.name} sql must equal statements joined with deterministic separators.`
      );
    }
    previousVersion = migrationVersion;
  }

  return migrations;
};

const getLatestMigrationVersion = <
  Migration extends PostgresMigrationDefinition,
>(
  migrations: readonly Migration[]
): number => {
  const orderedMigrations = assertDeterministicMigrations(migrations);
  const latestMigration = orderedMigrations.at(-1);
  return latestMigration === undefined ? 0 : latestMigration.version;
};

const hasVersion = <Migration extends PostgresMigrationDefinition>(
  migrations: readonly Migration[],
  version: number
): boolean => migrations.some((migration) => migration.version === version);

const resolveMigrationBounds = <Migration extends PostgresMigrationDefinition>(
  migrations: readonly Migration[],
  currentVersion: number,
  targetVersion?: number
): {
  readonly orderedMigrations: readonly Migration[];
  readonly normalizedCurrentVersion: number;
  readonly normalizedTargetVersion: number;
  readonly latestVersion: number;
} => {
  const orderedMigrations = assertDeterministicMigrations(migrations);
  const latestVersion = getLatestMigrationVersion(orderedMigrations);
  const normalizedCurrentVersion = assertNonNegativeSafeInteger(
    currentVersion,
    "currentVersion"
  );
  const normalizedTargetVersion =
    targetVersion === undefined
      ? latestVersion
      : assertNonNegativeSafeInteger(targetVersion, "targetVersion");

  if (normalizedTargetVersion > latestVersion) {
    throw new RangeError(
      `targetVersion ${normalizedTargetVersion} is greater than latest migration version ${latestVersion}.`
    );
  }
  if (normalizedCurrentVersion > latestVersion) {
    throw new RangeError(
      `currentVersion ${normalizedCurrentVersion} is ahead of latest migration version ${latestVersion}.`
    );
  }
  if (
    normalizedCurrentVersion !== 0 &&
    !hasVersion(orderedMigrations, normalizedCurrentVersion)
  ) {
    throw new RangeError(
      `currentVersion ${normalizedCurrentVersion} must match an existing migration version.`
    );
  }
  if (
    normalizedTargetVersion !== 0 &&
    !hasVersion(orderedMigrations, normalizedTargetVersion)
  ) {
    throw new RangeError(
      `targetVersion ${normalizedTargetVersion} must match an existing migration version.`
    );
  }
  if (normalizedCurrentVersion > normalizedTargetVersion) {
    throw new RangeError(
      `targetVersion ${normalizedTargetVersion} is behind currentVersion ${normalizedCurrentVersion}.`
    );
  }

  return Object.freeze({
    orderedMigrations,
    normalizedCurrentVersion,
    normalizedTargetVersion,
    latestVersion,
  });
};

const statementsForMigrationVersion = (version: number): readonly string[] =>
  Object.freeze([
    ...enterprisePostgresTables
      .filter((table) => table.migrationVersion === version)
      .map((table) => table.ddl),
    ...enterprisePostgresTriggers
      .filter((trigger) => trigger.migrationVersion === version)
      .map((trigger) => trigger.ddl),
    ...enterprisePostgresIndexes
      .filter((index) => index.migrationVersion === version)
      .map((index) => index.ddl),
  ]);

const enterprisePostgresV1Statements = statementsForMigrationVersion(1);
const enterprisePostgresV2Statements = Object.freeze([
  ...statementsForMigrationVersion(2),
  [
    "INSERT INTO memory_items_fts (tenant_id, memory_id, title, payload_text)",
    "SELECT tenant_id, memory_id, title, payload_json::text",
    "FROM memory_items",
    "ON CONFLICT (tenant_id, memory_id) DO NOTHING;",
  ].join("\n"),
]);
const enterprisePostgresV3Statements = statementsForMigrationVersion(3);
const enterprisePostgresV4Statements = statementsForMigrationVersion(4);
const enterprisePostgresV5Statements = statementsForMigrationVersion(5);
const enterprisePostgresV6Statements = statementsForMigrationVersion(6);

const buildMigration = <const Version extends number>(
  version: Version,
  name: string,
  description: string,
  statements: readonly string[]
): PostgresMigrationDefinition<Version> =>
  Object.freeze({
    version,
    name,
    description,
    statements,
    sql: `${statements.join("\n\n")}\n`,
  });

export const enterprisePostgresMigrations = Object.freeze([
  buildMigration(
    1,
    "enterprise_postgres_v1",
    "Initial enterprise Postgres schema for tenant isolation, scope lattice constraints, memory lineage, evidence, and feedback.",
    enterprisePostgresV1Statements
  ),
  buildMigration(
    2,
    "enterprise_postgres_v2_tsvector_memory_search",
    "Adds Postgres-backed memory search table and synchronization triggers for tenant-scoped retrieval.",
    enterprisePostgresV2Statements
  ),
  buildMigration(
    3,
    "enterprise_postgres_v3_audit_event_ledger",
    "Adds append-only deterministic audit ledger tables, indexes, and triggers for storage operation forensics.",
    enterprisePostgresV3Statements
  ),
  buildMigration(
    4,
    "enterprise_postgres_v4_storage_idempotency_ledger",
    "Adds tenant-scoped write-path idempotency key ledger objects for deterministic upsert/delete deduplication.",
    enterprisePostgresV4Statements
  ),
  buildMigration(
    5,
    "enterprise_postgres_v5_identity_runtime_bindings",
    "Adds deterministic enterprise identity runtime tables and indexes for issuer bindings, external subject mappings, and sync checkpoints.",
    enterprisePostgresV5Statements
  ),
  buildMigration(
    6,
    "enterprise_postgres_v6_provenance_lineage_dimensions",
    "Adds provenance lineage tables and indexes for memory, evidence, and audit event traceability.",
    enterprisePostgresV6Statements
  ),
]);

export type EnterprisePostgresMigration =
  (typeof enterprisePostgresMigrations)[number];

export const enterprisePostgresLatestMigrationVersion =
  getLatestMigrationVersion(enterprisePostgresMigrations);

export const listPendingPostgresMigrations = <
  Migration extends PostgresMigrationDefinition,
>(
  migrations: readonly Migration[],
  currentVersion: number,
  targetVersion?: number
): readonly Migration[] => {
  const bounds = resolveMigrationBounds(
    migrations,
    currentVersion,
    targetVersion
  );
  return Object.freeze(
    bounds.orderedMigrations.filter(
      (migration) =>
        migration.version > bounds.normalizedCurrentVersion &&
        migration.version <= bounds.normalizedTargetVersion
    )
  );
};

export const planPostgresMigrations = <
  Migration extends PostgresMigrationDefinition,
>(
  migrations: readonly Migration[],
  currentVersion: number,
  targetVersion?: number
): PostgresMigrationPlan<Migration> => {
  const bounds = resolveMigrationBounds(
    migrations,
    currentVersion,
    targetVersion
  );
  const pendingMigrations = Object.freeze(
    bounds.orderedMigrations.filter(
      (migration) =>
        migration.version > bounds.normalizedCurrentVersion &&
        migration.version <= bounds.normalizedTargetVersion
    )
  );

  return Object.freeze({
    currentVersion: bounds.normalizedCurrentVersion,
    targetVersion: bounds.normalizedTargetVersion,
    latestVersion: bounds.latestVersion,
    pendingMigrations,
    isUpToDate: pendingMigrations.length === 0,
  });
};

export const listPendingEnterprisePostgresMigrations = (
  currentVersion: number,
  targetVersion?: number
): readonly EnterprisePostgresMigration[] =>
  listPendingPostgresMigrations(
    enterprisePostgresMigrations,
    currentVersion,
    targetVersion
  );

export const planEnterprisePostgresMigrations = (
  currentVersion: number,
  targetVersion?: number
): PostgresMigrationPlan<EnterprisePostgresMigration> =>
  planPostgresMigrations(
    enterprisePostgresMigrations,
    currentVersion,
    targetVersion
  );

export const enterprisePostgresSchemaCoverageStatements = Object.freeze([
  ...enterprisePostgresSchemaStatements,
  enterprisePostgresV2Statements.at(-1) ?? "",
]);
