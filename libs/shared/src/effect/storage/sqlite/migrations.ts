import type { DatabaseSync } from "./database.ts";
import { enterpriseSqliteSchemaStatements } from "./enterprise-schema.js";

export interface SqliteMigrationDefinition<Version extends number = number> {
  readonly version: Version;
  readonly name: string;
  readonly description: string;
  readonly statements: readonly string[];
  readonly sql: string;
}

export interface SqliteMigrationPlan<
  Migration extends SqliteMigrationDefinition = SqliteMigrationDefinition,
> {
  readonly currentVersion: number;
  readonly targetVersion: number;
  readonly latestVersion: number;
  readonly pendingMigrations: readonly Migration[];
  readonly isUpToDate: boolean;
}

export interface SqliteMigrationApplyResult<
  Migration extends SqliteMigrationDefinition = SqliteMigrationDefinition,
> extends SqliteMigrationPlan<Migration> {
  readonly appliedMigrations: readonly Migration[];
}

const SQLITE_USER_VERSION_MAX = 2_147_483_647;
const SQLITE_CREATE_IF_NOT_EXISTS_PATTERN = /\bIF NOT EXISTS\b\s+/g;
const SQLITE_SCHEMA_OBJECT_PATTERN =
  /^CREATE\s+(?:UNIQUE\s+)?(?:VIRTUAL\s+)?(TABLE|INDEX|TRIGGER|VIEW)\s+([A-Za-z_][A-Za-z0-9_]*)/i;

type SqliteSchemaObjectType = "table" | "index" | "trigger" | "view";

interface SqliteSchemaDefinition {
  readonly type: SqliteSchemaObjectType;
  readonly name: string;
  readonly normalizedSql: string;
}

export interface SqliteMigrationValidationOptions {
  readonly validateBeforeCommit?: (
    database: DatabaseSync,
    targetVersion: number
  ) => void;
}

const toNonNegativeSafeInteger = (value: unknown, label: string): number => {
  if (typeof value === "number") {
    if (
      !Number.isSafeInteger(value) ||
      value < 0 ||
      value > SQLITE_USER_VERSION_MAX
    ) {
      throw new RangeError(
        `${label} must be a non-negative safe integer. Received: ${value}.`
      );
    }

    return value;
  }

  if (typeof value === "bigint") {
    if (value < 0n || value > BigInt(SQLITE_USER_VERSION_MAX)) {
      throw new RangeError(
        `${label} must be a non-negative safe integer. Received: ${value.toString()}.`
      );
    }

    return Number(value);
  }

  throw new TypeError(`${label} must be a numeric SQLite integer value.`);
};

const normalizeSqlDefinition = (sql: string): string =>
  sql.replace(/\s+/g, " ").replace(/;+$/g, "").trim();

const parseSqliteSchemaDefinition = (
  statement: string
): SqliteSchemaDefinition | null => {
  const match = SQLITE_SCHEMA_OBJECT_PATTERN.exec(statement.trim());
  if (!match) {
    return null;
  }

  const rawType = match[1];
  const objectName = match[2];
  if (typeof rawType !== "string" || typeof objectName !== "string") {
    return null;
  }
  const normalizedType = rawType.toLowerCase() as SqliteSchemaObjectType;
  return Object.freeze({
    type: normalizedType,
    name: objectName,
    normalizedSql: normalizeSqlDefinition(statement),
  });
};

const assertDeterministicMigrations = <
  Migration extends SqliteMigrationDefinition,
>(
  migrations: readonly Migration[]
): readonly Migration[] => {
  let previousVersion = -1;

  for (const migration of migrations) {
    const migrationVersion = toNonNegativeSafeInteger(
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

const resolveMigrationBounds = <Migration extends SqliteMigrationDefinition>(
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
  const latestMigration = orderedMigrations.at(-1);
  const latestVersion =
    latestMigration === undefined ? 0 : latestMigration.version;
  const normalizedCurrentVersion = toNonNegativeSafeInteger(
    currentVersion,
    "currentVersion"
  );
  const normalizedTargetVersion =
    targetVersion === undefined
      ? latestVersion
      : toNonNegativeSafeInteger(targetVersion, "targetVersion");

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
    !boundsHasVersion(orderedMigrations, normalizedCurrentVersion)
  ) {
    throw new RangeError(
      `currentVersion ${normalizedCurrentVersion} must match an existing migration version.`
    );
  }

  if (
    normalizedTargetVersion !== 0 &&
    !boundsHasVersion(orderedMigrations, normalizedTargetVersion)
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

const boundsHasVersion = <Migration extends SqliteMigrationDefinition>(
  migrations: readonly Migration[],
  version: number
): boolean => migrations.some((migration) => migration.version === version);

const readPragmaUserVersionRow = (
  database: DatabaseSync
): Record<string, unknown> => {
  const row = database.prepare("PRAGMA user_version;").get();
  if (typeof row !== "object" || row === null) {
    throw new TypeError("PRAGMA user_version did not return an object row.");
  }

  return row as Record<string, unknown>;
};

export const readSqliteUserVersion = (database: DatabaseSync): number => {
  const pragmaRow = readPragmaUserVersionRow(database);
  if (!Object.hasOwn(pragmaRow, "user_version")) {
    throw new TypeError(
      "PRAGMA user_version row did not contain user_version."
    );
  }

  return toNonNegativeSafeInteger(
    pragmaRow["user_version"],
    "PRAGMA user_version"
  );
};

export const writeSqliteUserVersion = (
  database: DatabaseSync,
  version: number
): number => {
  const normalizedVersion = toNonNegativeSafeInteger(version, "user_version");
  database.exec(`PRAGMA user_version = ${normalizedVersion};`);
  return normalizedVersion;
};

export const getLatestSqliteMigrationVersion = <
  Migration extends SqliteMigrationDefinition,
>(
  migrations: readonly Migration[]
): number => {
  const orderedMigrations = assertDeterministicMigrations(migrations);
  const latestMigration = orderedMigrations.at(-1);
  return latestMigration === undefined ? 0 : latestMigration.version;
};

export const listPendingSqliteMigrations = <
  Migration extends SqliteMigrationDefinition,
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

export const planSqliteMigrations = <
  Migration extends SqliteMigrationDefinition,
>(
  migrations: readonly Migration[],
  currentVersion: number,
  targetVersion?: number
): SqliteMigrationPlan<Migration> => {
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

export const applySqliteMigrations = <
  Migration extends SqliteMigrationDefinition,
>(
  database: DatabaseSync,
  migrations: readonly Migration[],
  targetVersion?: number,
  options?: SqliteMigrationValidationOptions
): SqliteMigrationApplyResult<Migration> => {
  let didCommit = false;
  database.exec("BEGIN IMMEDIATE;");
  try {
    const currentVersion = readSqliteUserVersion(database);
    const plan = planSqliteMigrations(
      migrations,
      currentVersion,
      targetVersion
    );
    const validateBeforeCommit = options?.validateBeforeCommit;

    if (plan.pendingMigrations.length === 0) {
      validateBeforeCommit?.(database, plan.targetVersion);
      database.exec("COMMIT;");
      didCommit = true;
      return Object.freeze({
        ...plan,
        appliedMigrations: Object.freeze([] as Migration[]),
      });
    }

    for (const migration of plan.pendingMigrations) {
      for (const statement of migration.statements) {
        database.exec(statement);
      }
      writeSqliteUserVersion(database, migration.version);
    }

    const appliedVersion = readSqliteUserVersion(database);
    if (appliedVersion !== plan.targetVersion) {
      throw new RangeError(
        `Applied user_version ${appliedVersion} does not match targetVersion ${plan.targetVersion}.`
      );
    }

    validateBeforeCommit?.(database, plan.targetVersion);
    database.exec("COMMIT;");
    didCommit = true;
    return Object.freeze({
      ...plan,
      appliedMigrations: Object.freeze([...plan.pendingMigrations]),
    });
  } finally {
    if (!didCommit) {
      try {
        database.exec("ROLLBACK;");
      } catch {
        // Ignore rollback failures so original migration failure surfaces.
      }
    }
  }
};

const toDeterministicMigrationStatements = (
  statements: readonly string[]
): readonly string[] =>
  Object.freeze(
    statements.map((statement) =>
      statement.replace(SQLITE_CREATE_IF_NOT_EXISTS_PATTERN, "")
    )
  );

const statementDefinesAnySchemaObject = (
  statement: string,
  objectNames: readonly string[]
): boolean => {
  const definition = parseSqliteSchemaDefinition(statement);
  return (
    definition !== null &&
    objectNames.some((objectName) => definition.name.includes(objectName))
  );
};

const hasMemoryItemsFtsSchemaObject = (statement: string): boolean =>
  statementDefinesAnySchemaObject(statement, ["memory_items_fts"]);
const hasAuditEventsSchemaObject = (statement: string): boolean =>
  statementDefinesAnySchemaObject(statement, ["audit_events"]);
const hasStorageIdempotencyLedgerSchemaObject = (statement: string): boolean =>
  statementDefinesAnySchemaObject(statement, ["storage_idempotency_ledger"]);
const hasIdentityRuntimeSchemaObject = (statement: string): boolean =>
  statementDefinesAnySchemaObject(statement, [
    "identity_issuer_bindings",
    "user_external_subjects",
    "identity_sync_checkpoints",
  ]);
const hasProvenanceSchemaObject = (statement: string): boolean =>
  statementDefinesAnySchemaObject(statement, [
    "provenance_envelopes",
    "memory_provenance_links",
    "evidence_provenance_links",
    "audit_event_provenance_links",
  ]);

const enterpriseSqliteSchemaObjectStatements =
  toDeterministicMigrationStatements(enterpriseSqliteSchemaStatements);

const enterpriseSqliteV1Statements = Object.freeze(
  enterpriseSqliteSchemaObjectStatements.filter(
    (statement) =>
      !hasMemoryItemsFtsSchemaObject(statement) &&
      !hasAuditEventsSchemaObject(statement) &&
      !hasStorageIdempotencyLedgerSchemaObject(statement) &&
      !hasIdentityRuntimeSchemaObject(statement) &&
      !hasProvenanceSchemaObject(statement)
  )
);

const enterpriseSqliteV2Statements = Object.freeze([
  ...enterpriseSqliteSchemaObjectStatements.filter((statement) =>
    hasMemoryItemsFtsSchemaObject(statement)
  ),
  [
    "INSERT INTO memory_items_fts (rowid, tenant_id, memory_id, title, payload_text)",
    "SELECT rowid, tenant_id, memory_id, title, payload_json",
    "FROM memory_items",
    "WHERE rowid NOT IN (SELECT rowid FROM memory_items_fts);",
  ].join("\n"),
]);

const enterpriseSqliteV3Statements = Object.freeze(
  enterpriseSqliteSchemaObjectStatements.filter((statement) =>
    hasAuditEventsSchemaObject(statement)
  )
);

const enterpriseSqliteV4Statements = Object.freeze(
  enterpriseSqliteSchemaObjectStatements.filter((statement) =>
    hasStorageIdempotencyLedgerSchemaObject(statement)
  )
);

const enterpriseSqliteV5Statements = Object.freeze(
  enterpriseSqliteSchemaObjectStatements.filter((statement) =>
    hasIdentityRuntimeSchemaObject(statement)
  )
);

const enterpriseSqliteV6Statements = Object.freeze(
  enterpriseSqliteSchemaObjectStatements.filter((statement) =>
    hasProvenanceSchemaObject(statement)
  )
);

const enterpriseInitialMigration = Object.freeze({
  version: 1,
  name: "enterprise_sqlite_v1",
  description:
    "Initial enterprise SQLite schema for tenant isolation, scope lattice constraints, memory lineage, evidence, and feedback.",
  statements: enterpriseSqliteV1Statements,
  sql: "",
} as const satisfies SqliteMigrationDefinition<1>);

const enterpriseInitialMigrationWithSql = Object.freeze({
  ...enterpriseInitialMigration,
  sql: `${enterpriseInitialMigration.statements.join("\n\n")}\n`,
} as const satisfies SqliteMigrationDefinition<1>);

const enterpriseFtsMigration = Object.freeze({
  version: 2,
  name: "enterprise_sqlite_v2_fts5_memory_search",
  description:
    "Adds FTS5 virtual-table indexing and synchronization triggers for scalable tenant-scoped memory retrieval.",
  statements: enterpriseSqliteV2Statements,
  sql: "",
} as const satisfies SqliteMigrationDefinition<2>);

const enterpriseFtsMigrationWithSql = Object.freeze({
  ...enterpriseFtsMigration,
  sql: `${enterpriseFtsMigration.statements.join("\n\n")}\n`,
} as const satisfies SqliteMigrationDefinition<2>);

const enterpriseAuditEventLedgerMigration = Object.freeze({
  version: 3,
  name: "enterprise_sqlite_v3_audit_event_ledger",
  description:
    "Adds append-only deterministic audit ledger tables, indexes, and triggers for storage operation forensics.",
  statements: enterpriseSqliteV3Statements,
  sql: "",
} as const satisfies SqliteMigrationDefinition<3>);

const enterpriseAuditEventLedgerMigrationWithSql = Object.freeze({
  ...enterpriseAuditEventLedgerMigration,
  sql: `${enterpriseAuditEventLedgerMigration.statements.join("\n\n")}\n`,
} as const satisfies SqliteMigrationDefinition<3>);

const enterpriseStorageIdempotencyLedgerMigration = Object.freeze({
  version: 4,
  name: "enterprise_sqlite_v4_storage_idempotency_ledger",
  description:
    "Adds tenant-scoped write-path idempotency key ledger objects for deterministic upsert/delete deduplication.",
  statements: enterpriseSqliteV4Statements,
  sql: "",
} as const satisfies SqliteMigrationDefinition<4>);

const enterpriseStorageIdempotencyLedgerMigrationWithSql = Object.freeze({
  ...enterpriseStorageIdempotencyLedgerMigration,
  sql: `${enterpriseStorageIdempotencyLedgerMigration.statements.join("\n\n")}\n`,
} as const satisfies SqliteMigrationDefinition<4>);

const enterpriseIdentityRuntimeMigration = Object.freeze({
  version: 5,
  name: "enterprise_sqlite_v5_identity_runtime_bindings",
  description:
    "Adds deterministic enterprise identity runtime tables and indexes for issuer bindings, external subject mappings, and sync checkpoints.",
  statements: enterpriseSqliteV5Statements,
  sql: "",
} as const satisfies SqliteMigrationDefinition<5>);

const enterpriseIdentityRuntimeMigrationWithSql = Object.freeze({
  ...enterpriseIdentityRuntimeMigration,
  sql: `${enterpriseIdentityRuntimeMigration.statements.join("\n\n")}\n`,
} as const satisfies SqliteMigrationDefinition<5>);

const enterpriseProvenanceSchemaMigration = Object.freeze({
  version: 6,
  name: "enterprise_sqlite_v6_provenance_lineage_dimensions",
  description:
    "Adds provenance envelope and linkage tables/indexes for deterministic memory, evidence, and audit lineage joins.",
  statements: enterpriseSqliteV6Statements,
  sql: "",
} as const satisfies SqliteMigrationDefinition<6>);

const enterpriseProvenanceSchemaMigrationWithSql = Object.freeze({
  ...enterpriseProvenanceSchemaMigration,
  sql: `${enterpriseProvenanceSchemaMigration.statements.join("\n\n")}\n`,
} as const satisfies SqliteMigrationDefinition<6>);

export const enterpriseSqliteMigrations = Object.freeze([
  enterpriseInitialMigrationWithSql,
  enterpriseFtsMigrationWithSql,
  enterpriseAuditEventLedgerMigrationWithSql,
  enterpriseStorageIdempotencyLedgerMigrationWithSql,
  enterpriseIdentityRuntimeMigrationWithSql,
  enterpriseProvenanceSchemaMigrationWithSql,
] as const satisfies readonly SqliteMigrationDefinition[]);

export type EnterpriseSqliteMigration =
  (typeof enterpriseSqliteMigrations)[number];

export const enterpriseSqliteLatestMigrationVersion =
  getLatestSqliteMigrationVersion(enterpriseSqliteMigrations);

export const planEnterpriseSqliteMigrations = (
  database: DatabaseSync,
  targetVersion?: number
): SqliteMigrationPlan<EnterpriseSqliteMigration> =>
  planSqliteMigrations(
    enterpriseSqliteMigrations,
    readSqliteUserVersion(database),
    targetVersion
  );

export const listPendingEnterpriseSqliteMigrations = (
  database: DatabaseSync,
  targetVersion?: number
): readonly EnterpriseSqliteMigration[] =>
  listPendingSqliteMigrations(
    enterpriseSqliteMigrations,
    readSqliteUserVersion(database),
    targetVersion
  );

export const applyEnterpriseSqliteMigrations = (
  database: DatabaseSync,
  targetVersion?: number
): SqliteMigrationApplyResult<EnterpriseSqliteMigration> => {
  return applySqliteMigrations(
    database,
    enterpriseSqliteMigrations,
    targetVersion,
    {
      validateBeforeCommit: (candidateDatabase, candidateTargetVersion) => {
        if (candidateTargetVersion === enterpriseSqliteLatestMigrationVersion) {
          assertEnterpriseSqliteSchemaIntegrity(candidateDatabase);
        }
      },
    }
  );
};

const listSqliteSchemaDefinitions = (
  database: DatabaseSync
): readonly SqliteSchemaDefinition[] => {
  const rows = database
    .prepare(
      "SELECT type, name, sql FROM sqlite_schema WHERE type IN ('table', 'index', 'trigger', 'view') AND name NOT LIKE 'sqlite_%';"
    )
    .all() as ReadonlyArray<{
    readonly type?: unknown;
    readonly name?: unknown;
    readonly sql?: unknown;
  }>;

  return Object.freeze(
    rows
      .map((row) => {
        if (
          (row.type === "table" ||
            row.type === "index" ||
            row.type === "trigger" ||
            row.type === "view") &&
          typeof row.name === "string" &&
          typeof row.sql === "string"
        ) {
          return Object.freeze({
            type: row.type,
            name: row.name,
            normalizedSql: normalizeSqlDefinition(row.sql),
          } satisfies SqliteSchemaDefinition);
        }
        return null;
      })
      .filter(
        (definition): definition is SqliteSchemaDefinition =>
          definition !== null
      )
  );
};

const enterpriseExpectedSchemaDefinitions = Object.freeze(
  enterpriseSqliteSchemaObjectStatements
    .map((statement) => parseSqliteSchemaDefinition(statement))
    .filter(
      (definition): definition is SqliteSchemaDefinition => definition !== null
    )
);

const SQLITE_ALLOWED_IMPLICIT_SCHEMA_OBJECT_PATTERNS = Object.freeze([
  /^table:memory_items_fts_(?:content|data|idx|docsize|config|segments|segdir|stat)$/,
]);

const isAllowedImplicitSchemaObject = (key: string): boolean =>
  SQLITE_ALLOWED_IMPLICIT_SCHEMA_OBJECT_PATTERNS.some((pattern) =>
    pattern.test(key)
  );

export const assertEnterpriseSqliteSchemaIntegrity = (
  database: DatabaseSync
): void => {
  const definitions = listSqliteSchemaDefinitions(database);
  const definitionsByKey = new Map<string, string>(
    definitions.map(
      (definition) =>
        [
          `${definition.type}:${definition.name}`,
          definition.normalizedSql,
        ] as const
    )
  );
  const expectedKeys = new Set(
    enterpriseExpectedSchemaDefinitions.map(
      (definition) => `${definition.type}:${definition.name}`
    )
  );

  const missingObjects: string[] = [];
  const mismatchedObjects: string[] = [];

  for (const expectedDefinition of enterpriseExpectedSchemaDefinitions) {
    const key = `${expectedDefinition.type}:${expectedDefinition.name}`;
    const actualDefinition = definitionsByKey.get(key);
    if (actualDefinition === undefined) {
      missingObjects.push(key);
      continue;
    }
    if (actualDefinition !== expectedDefinition.normalizedSql) {
      mismatchedObjects.push(key);
    }
  }

  const unexpectedObjects = definitions
    .map((definition) => `${definition.type}:${definition.name}`)
    .filter(
      (key) => !expectedKeys.has(key) && !isAllowedImplicitSchemaObject(key)
    );

  if (
    missingObjects.length === 0 &&
    mismatchedObjects.length === 0 &&
    unexpectedObjects.length === 0
  ) {
    return;
  }

  const segments = [
    missingObjects.length > 0 ? `missing=[${missingObjects.join(",")}]` : null,
    mismatchedObjects.length > 0
      ? `mismatched=[${mismatchedObjects.join(",")}]`
      : null,
    unexpectedObjects.length > 0
      ? `unexpected=[${unexpectedObjects.join(",")}]`
      : null,
  ].filter((segment): segment is string => segment !== null);

  throw new Error(
    `Enterprise SQLite schema drift detected for version ${enterpriseSqliteLatestMigrationVersion}: ${segments.join("; ")}`
  );
};
