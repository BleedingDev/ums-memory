import type { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";

import type {
  DomainRecord,
  DomainValue,
  StorageDeleteRequest,
  StorageDeleteResponse,
  StorageUpsertRequest,
  StorageUpsertResponse,
} from "../../contracts/index.js";
import {
  ContractValidationError,
  StorageConflictError,
  StorageNotFoundError,
  type StorageServiceError,
} from "../../errors.js";
import {
  type EnterpriseMemoryKind,
  type EnterpriseMemoryStatus,
  enterpriseMemoryKinds,
  enterpriseMemoryStatuses,
} from "./enterprise-schema.js";
import { applyEnterpriseSqliteMigrations } from "./migrations.js";

const tenantCreatedAtMillis = 0;
const tenantUpdatedAtMillis = 0;

const memoryKindSet: ReadonlySet<string> = new Set(enterpriseMemoryKinds);
const memoryStatusSet: ReadonlySet<string> = new Set(enterpriseMemoryStatuses);
const sqliteForeignKeysModeByConnection = new WeakMap<DatabaseSync, boolean>();

type CanonicalJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

class StoragePayloadValidationFailure extends Error {}
class MissingStorageDeleteFailure extends Error {}
const storageRuntimeFailureContract = "StorageRuntimeFailure";

interface StoragePayloadProjection {
  readonly scopeId: string | null;
  readonly memoryKind: EnterpriseMemoryKind;
  readonly status: EnterpriseMemoryStatus;
  readonly title: string;
  readonly payloadJson: string;
  readonly createdByUserId: string | null;
  readonly supersedesMemoryId: string | null;
  readonly createdAtMillis: number;
  readonly updatedAtMillis: number;
  readonly expiresAtMillis: number | null;
  readonly tombstonedAtMillis: number | null;
}

export interface SqliteStorageRepositoryOptions {
  readonly applyMigrations?: boolean;
  readonly enforceForeignKeys?: boolean;
}

export interface SqliteStorageRepository {
  readonly upsertMemory: (
    request: StorageUpsertRequest,
  ) => Effect.Effect<StorageUpsertResponse, StorageServiceError>;
  readonly deleteMemory: (
    request: StorageDeleteRequest,
  ) => Effect.Effect<StorageDeleteResponse, StorageServiceError>;
}

const withImmediateTransaction = <Value>(database: DatabaseSync, execute: () => Value): Value => {
  let committed = false;
  database.exec("BEGIN IMMEDIATE;");

  try {
    const value = execute();
    database.exec("COMMIT;");
    committed = true;
    return value;
  } finally {
    if (!committed) {
      try {
        database.exec("ROLLBACK;");
      } catch {
        // Ignore rollback failures so the original error is preserved.
      }
    }
  }
};

const toNonNegativeSafeInteger = (value: unknown, label: string): number => {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`${label} must be a non-negative safe integer. Received: ${value}.`);
    }
    return value;
  }

  if (typeof value === "bigint") {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new RangeError(`${label} must be a non-negative safe integer. Received: ${value}.`);
    }
    return Number(value);
  }

  throw new TypeError(`${label} must be a numeric SQLite integer value.`);
};

const readRecordValue = (
  payload: DomainRecord,
  keys: readonly string[],
): DomainValue | undefined => {
  for (const key of keys) {
    if (Object.hasOwn(payload, key)) {
      return payload[key];
    }
  }

  return undefined;
};

const expectTrimmedString = (value: DomainValue, label: string): string => {
  if (typeof value !== "string") {
    throw new StoragePayloadValidationFailure(`${label} must be a non-empty string.`);
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new StoragePayloadValidationFailure(`${label} must be a non-empty string.`);
  }

  return trimmed;
};

const expectNonNegativeSafeInteger = (value: DomainValue, label: string): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new StoragePayloadValidationFailure(
      `${label} must be a non-negative safe integer number.`,
    );
  }

  return value;
};

const parseOptionalTrimmedString = (
  payload: DomainRecord,
  keys: readonly string[],
  label: string,
): string | undefined => {
  const value = readRecordValue(payload, keys);
  if (value === undefined) {
    return undefined;
  }

  return expectTrimmedString(value, label);
};

const parseOptionalNullableTrimmedString = (
  payload: DomainRecord,
  keys: readonly string[],
  label: string,
): string | null | undefined => {
  const value = readRecordValue(payload, keys);
  if (value === undefined || value === null) {
    return value;
  }

  return expectTrimmedString(value, label);
};

const parseOptionalNonNegativeSafeInteger = (
  payload: DomainRecord,
  keys: readonly string[],
  label: string,
): number | undefined => {
  const value = readRecordValue(payload, keys);
  if (value === undefined) {
    return undefined;
  }

  return expectNonNegativeSafeInteger(value, label);
};

const parseOptionalNullableNonNegativeSafeInteger = (
  payload: DomainRecord,
  keys: readonly string[],
  label: string,
): number | null | undefined => {
  const value = readRecordValue(payload, keys);
  if (value === undefined || value === null) {
    return value;
  }

  return expectNonNegativeSafeInteger(value, label);
};

const parseOptionalEnum = <Value extends string>(
  payload: DomainRecord,
  keys: readonly string[],
  allowedValues: ReadonlySet<string>,
  label: string,
): Value | undefined => {
  const value = readRecordValue(payload, keys);
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string" || !allowedValues.has(value)) {
    throw new StoragePayloadValidationFailure(
      `${label} must be one of: ${[...allowedValues].join(", ")}.`,
    );
  }

  return value as Value;
};

const isDomainRecord = (value: unknown): value is DomainRecord => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  return isPlainRecordObject(value);
};

const readSqliteForeignKeysMode = (database: DatabaseSync): boolean => {
  const foreignKeysRow = database.prepare("PRAGMA foreign_keys;").get();
  if (typeof foreignKeysRow !== "object" || foreignKeysRow === null) {
    throw new ContractValidationError({
      contract: "SqliteStorageRepositoryOptions.enforceForeignKeys",
      message: "SQLite did not return PRAGMA foreign_keys state.",
      details: "PRAGMA foreign_keys query returned a non-object row.",
    });
  }

  const foreignKeysValue = (foreignKeysRow as Record<string, unknown>)["foreign_keys"];
  const normalizedForeignKeysValue = toNonNegativeSafeInteger(
    foreignKeysValue,
    "PRAGMA foreign_keys",
  );
  if (normalizedForeignKeysValue !== 0 && normalizedForeignKeysValue !== 1) {
    throw new ContractValidationError({
      contract: "SqliteStorageRepositoryOptions.enforceForeignKeys",
      message: "SQLite returned an invalid PRAGMA foreign_keys value.",
      details: `Expected 0 or 1 but received: ${String(foreignKeysValue)}.`,
    });
  }

  return normalizedForeignKeysValue === 1;
};

const configureSqliteForeignKeys = (database: DatabaseSync, enforceForeignKeys: boolean): void => {
  const existingMode = sqliteForeignKeysModeByConnection.get(database);
  if (existingMode !== undefined) {
    if (existingMode !== enforceForeignKeys) {
      throw new ContractValidationError({
        contract: "SqliteStorageRepositoryOptions.enforceForeignKeys",
        message: "SQLite foreign_keys mode is immutable per DatabaseSync connection.",
        details: `Connection already bootstrapped with foreign_keys=${
          existingMode ? "ON" : "OFF"
        }; requested ${enforceForeignKeys ? "ON" : "OFF"}. Use a separate DatabaseSync instance.`,
      });
    }
  }

  let effectiveForeignKeysMode = readSqliteForeignKeysMode(database);
  if (effectiveForeignKeysMode !== enforceForeignKeys) {
    database.exec(`PRAGMA foreign_keys = ${enforceForeignKeys ? "ON" : "OFF"};`);
    effectiveForeignKeysMode = readSqliteForeignKeysMode(database);
  }

  if (effectiveForeignKeysMode !== enforceForeignKeys) {
    throw new ContractValidationError({
      contract: "SqliteStorageRepositoryOptions.enforceForeignKeys",
      message: "SQLite foreign_keys mode could not be applied.",
      details: `Requested foreign_keys=${enforceForeignKeys ? "ON" : "OFF"} but SQLite reports ${
        effectiveForeignKeysMode ? "ON" : "OFF"
      }. Ensure initialization runs outside active transactions.`,
    });
  }

  if (existingMode === undefined) {
    sqliteForeignKeysModeByConnection.set(database, effectiveForeignKeysMode);
  }
};

const isPlainRecordObject = (value: object): boolean => {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const normalizeDomainValue = (value: DomainValue, path: string): CanonicalJsonValue => {
  if (value === null) {
    return null;
  }

  if (typeof value === "string" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new StoragePayloadValidationFailure(`${path} must not contain non-finite numbers.`);
    }
    return value;
  }

  if (Array.isArray(value)) {
    const sequence = value as readonly DomainValue[];
    return sequence.map((item, index) => normalizeDomainValue(item, `${path}[${index}]`));
  }

  if (!isPlainRecordObject(value)) {
    throw new StoragePayloadValidationFailure(
      `${path} must contain only plain JSON-compatible objects.`,
    );
  }

  const record = value as DomainRecord;
  const sortedKeys = Object.keys(record).sort((left, right) => {
    if (left < right) {
      return -1;
    }
    if (left > right) {
      return 1;
    }
    return 0;
  });
  const normalizedEntries = sortedKeys.map((key) => {
    const childValue = record[key];
    if (childValue === undefined) {
      throw new StoragePayloadValidationFailure(`${path}.${key} must be defined.`);
    }
    return [key, normalizeDomainValue(childValue, `${path}.${key}`)] as const;
  });

  return Object.fromEntries(normalizedEntries);
};

const toCanonicalPayloadJson = (payload: DomainRecord): string =>
  JSON.stringify(normalizeDomainValue(payload, "payload"));

const parsePayloadProjection = (request: StorageUpsertRequest): StoragePayloadProjection => {
  if (!isDomainRecord(request.payload)) {
    throw new StoragePayloadValidationFailure(
      "StorageUpsertRequest.payload must be a plain object record.",
    );
  }

  const payload = request.payload;
  const memoryKind =
    parseOptionalEnum<EnterpriseMemoryKind>(
      payload,
      ["memoryKind", "memory_kind"],
      memoryKindSet,
      "payload.memoryKind",
    ) ?? "note";
  const title = parseOptionalTrimmedString(payload, ["title"], "payload.title") ?? request.memoryId;

  const createdAtMillis = parseOptionalNonNegativeSafeInteger(
    payload,
    ["createdAtMillis", "created_at_ms"],
    "payload.createdAtMillis",
  );
  const updatedAtMillis = parseOptionalNonNegativeSafeInteger(
    payload,
    ["updatedAtMillis", "updated_at_ms"],
    "payload.updatedAtMillis",
  );

  const normalizedCreatedAtMillis = createdAtMillis ?? updatedAtMillis ?? 0;
  const normalizedUpdatedAtMillis = updatedAtMillis ?? normalizedCreatedAtMillis;
  if (normalizedUpdatedAtMillis < normalizedCreatedAtMillis) {
    throw new StoragePayloadValidationFailure(
      "payload.updatedAtMillis must be greater than or equal to payload.createdAtMillis.",
    );
  }

  const expiresAtMillisInput = parseOptionalNullableNonNegativeSafeInteger(
    payload,
    ["expiresAtMillis", "expires_at_ms"],
    "payload.expiresAtMillis",
  );
  const normalizedExpiresAtMillis = expiresAtMillisInput ?? null;
  if (normalizedExpiresAtMillis !== null && normalizedExpiresAtMillis < normalizedCreatedAtMillis) {
    throw new StoragePayloadValidationFailure(
      "payload.expiresAtMillis must be greater than or equal to payload.createdAtMillis.",
    );
  }

  const tombstonedAtMillisInput = parseOptionalNullableNonNegativeSafeInteger(
    payload,
    ["tombstonedAtMillis", "tombstoned_at_ms"],
    "payload.tombstonedAtMillis",
  );
  const statusInput = parseOptionalEnum<EnterpriseMemoryStatus>(
    payload,
    ["status"],
    memoryStatusSet,
    "payload.status",
  );
  const normalizedStatus: EnterpriseMemoryStatus =
    statusInput ?? (typeof tombstonedAtMillisInput === "number" ? "tombstoned" : "active");

  let normalizedTombstonedAtMillis: number | null = tombstonedAtMillisInput ?? null;
  if (normalizedStatus === "tombstoned" && normalizedTombstonedAtMillis === null) {
    normalizedTombstonedAtMillis = normalizedUpdatedAtMillis;
  }
  if (normalizedStatus !== "tombstoned" && normalizedTombstonedAtMillis !== null) {
    throw new StoragePayloadValidationFailure(
      'payload.tombstonedAtMillis can only be set when payload.status is "tombstoned".',
    );
  }
  if (
    normalizedTombstonedAtMillis !== null &&
    normalizedTombstonedAtMillis < normalizedCreatedAtMillis
  ) {
    throw new StoragePayloadValidationFailure(
      "payload.tombstonedAtMillis must be greater than or equal to payload.createdAtMillis.",
    );
  }
  if (
    normalizedTombstonedAtMillis !== null &&
    normalizedUpdatedAtMillis < normalizedTombstonedAtMillis
  ) {
    throw new StoragePayloadValidationFailure(
      "payload.updatedAtMillis must be greater than or equal to payload.tombstonedAtMillis.",
    );
  }

  const scopeId = parseOptionalTrimmedString(payload, ["scopeId", "scope_id"], "payload.scopeId");
  const createdByUserId =
    parseOptionalNullableTrimmedString(
      payload,
      ["createdByUserId", "created_by_user_id"],
      "payload.createdByUserId",
    ) ?? null;
  const supersedesMemoryId =
    parseOptionalNullableTrimmedString(
      payload,
      ["supersedesMemoryId", "supersedes_memory_id"],
      "payload.supersedesMemoryId",
    ) ?? null;

  return Object.freeze({
    scopeId: scopeId ?? null,
    memoryKind,
    status: normalizedStatus,
    title,
    payloadJson: toCanonicalPayloadJson(payload),
    createdByUserId,
    supersedesMemoryId,
    createdAtMillis: normalizedCreatedAtMillis,
    updatedAtMillis: normalizedUpdatedAtMillis,
    expiresAtMillis: normalizedExpiresAtMillis,
    tombstonedAtMillis: normalizedTombstonedAtMillis,
  });
};

const toContractValidationError = (details: string): ContractValidationError =>
  new ContractValidationError({
    contract: "StorageUpsertRequest.payload",
    message: "Contract validation failed for StorageUpsertRequest payload mapping",
    details,
  });

const readRowColumn = (row: unknown, columnName: string): unknown => {
  if (typeof row !== "object" || row === null || !Object.hasOwn(row, columnName)) {
    throw new Error(`SQLite row does not include column: ${columnName}.`);
  }

  return (row as Record<string, unknown>)[columnName];
};

const isSqliteConstraintFailure = (cause: unknown): boolean => {
  if (!(cause instanceof Error)) {
    return false;
  }

  const code = (cause as { readonly code?: unknown }).code;
  if (typeof code === "string" && code.startsWith("ERR_SQLITE")) {
    const normalizedMessage = cause.message.toLowerCase();
    const trimmedMessage = cause.message.trim();
    return (
      normalizedMessage.includes("constraint") ||
      normalizedMessage.includes("foreign key") ||
      normalizedMessage.includes("check") ||
      normalizedMessage.includes("abort") ||
      /^[A-Z0-9_]+$/.test(trimmedMessage)
    );
  }

  return /constraint|foreign key|check|abort/i.test(cause.message);
};

const toErrorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : `Unknown SQLite failure: ${String(cause)}`;

const mapUpsertFailure = (cause: unknown, request: StorageUpsertRequest): StorageServiceError => {
  if (cause instanceof ContractValidationError) {
    return cause;
  }
  if (cause instanceof StoragePayloadValidationFailure) {
    return toContractValidationError(cause.message);
  }
  if (isSqliteConstraintFailure(cause)) {
    return new StorageConflictError({
      spaceId: request.spaceId,
      memoryId: request.memoryId,
      message: `SQLite constraint prevented memory upsert: ${toErrorMessage(cause)}`,
    });
  }

  return new ContractValidationError({
    contract: storageRuntimeFailureContract,
    message: "Unexpected SQLite storage upsert failure",
    details: toErrorMessage(cause),
  });
};

const mapDeleteFailure = (cause: unknown, request: StorageDeleteRequest): StorageServiceError => {
  if (cause instanceof ContractValidationError) {
    return cause;
  }
  if (cause instanceof MissingStorageDeleteFailure) {
    return new StorageNotFoundError({
      spaceId: request.spaceId,
      memoryId: request.memoryId,
      message: "Memory row does not exist for delete request.",
    });
  }
  if (isSqliteConstraintFailure(cause)) {
    return new StorageConflictError({
      spaceId: request.spaceId,
      memoryId: request.memoryId,
      message: `SQLite constraint prevented memory delete: ${toErrorMessage(cause)}`,
    });
  }

  return new ContractValidationError({
    contract: storageRuntimeFailureContract,
    message: "Unexpected SQLite storage delete failure",
    details: toErrorMessage(cause),
  });
};

export const makeSqliteStorageRepository = (
  database: DatabaseSync,
  options: SqliteStorageRepositoryOptions = {},
): SqliteStorageRepository => {
  const enforceForeignKeys = options.enforceForeignKeys ?? true;
  const runMigrations = options.applyMigrations ?? true;

  configureSqliteForeignKeys(database, enforceForeignKeys);
  if (runMigrations) {
    applyEnterpriseSqliteMigrations(database);
  }

  const ensureTenantStatement = database.prepare(
    "INSERT OR IGNORE INTO tenants (tenant_id, tenant_slug, display_name, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?);",
  );
  const selectCommonScopeIdStatement = database.prepare(
    "SELECT scope_id FROM scopes WHERE tenant_id = ? AND scope_level = 'common' ORDER BY scope_id LIMIT 1;",
  );
  const insertCommonScopeStatement = database.prepare(
    "INSERT OR IGNORE INTO scopes (tenant_id, scope_id, scope_level, project_id, role_id, user_id, parent_scope_id, created_at_ms) VALUES (?, ?, 'common', NULL, NULL, NULL, NULL, ?);",
  );
  const upsertMemoryStatement = database.prepare(
    [
      "INSERT INTO memory_items (",
      "  tenant_id,",
      "  memory_id,",
      "  scope_id,",
      "  memory_layer,",
      "  memory_kind,",
      "  status,",
      "  title,",
      "  payload_json,",
      "  created_by_user_id,",
      "  supersedes_memory_id,",
      "  created_at_ms,",
      "  updated_at_ms,",
      "  expires_at_ms,",
      "  tombstoned_at_ms",
      ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      "ON CONFLICT (tenant_id, memory_id) DO UPDATE SET",
      "  scope_id = excluded.scope_id,",
      "  memory_layer = excluded.memory_layer,",
      "  memory_kind = excluded.memory_kind,",
      "  status = excluded.status,",
      "  title = excluded.title,",
      "  payload_json = excluded.payload_json,",
      "  created_by_user_id = excluded.created_by_user_id,",
      "  supersedes_memory_id = excluded.supersedes_memory_id,",
      "  updated_at_ms = excluded.updated_at_ms,",
      "  expires_at_ms = excluded.expires_at_ms,",
      "  tombstoned_at_ms = excluded.tombstoned_at_ms",
      "WHERE excluded.updated_at_ms > memory_items.updated_at_ms;",
    ].join("\n"),
  );
  const selectPersistedMemoryStatement = database.prepare(
    "SELECT updated_at_ms FROM memory_items WHERE tenant_id = ? AND memory_id = ?;",
  );
  const deleteMemoryStatement = database.prepare(
    "DELETE FROM memory_items WHERE tenant_id = ? AND memory_id = ?;",
  );
  const assertExpectedForeignKeysMode = () => {
    const effectiveForeignKeysMode = readSqliteForeignKeysMode(database);
    if (effectiveForeignKeysMode !== enforceForeignKeys) {
      throw new ContractValidationError({
        contract: "SqliteStorageRepositoryOptions.enforceForeignKeys",
        message: "SQLite foreign_keys mode drift detected for active storage repository.",
        details: `Repository expects foreign_keys=${enforceForeignKeys ? "ON" : "OFF"} but SQLite reports ${
          effectiveForeignKeysMode ? "ON" : "OFF"
        }.`,
      });
    }
  };

  return {
    upsertMemory: (request) =>
      Effect.try({
        try: () =>
          withImmediateTransaction(database, () => {
            assertExpectedForeignKeysMode();
            const payloadProjection = parsePayloadProjection(request);

            ensureTenantStatement.run(
              request.spaceId,
              request.spaceId,
              request.spaceId,
              tenantCreatedAtMillis,
              tenantUpdatedAtMillis,
            );

            let resolvedScopeId = payloadProjection.scopeId;
            if (resolvedScopeId === null) {
              const defaultCommonScopeId = `common:${request.spaceId}`;
              const existingScopeRow = selectCommonScopeIdStatement.get(request.spaceId);
              if (existingScopeRow !== undefined) {
                const existingScopeId = readRowColumn(existingScopeRow, "scope_id");
                if (typeof existingScopeId !== "string" || existingScopeId.trim().length === 0) {
                  throw new Error("Resolved common scope_id is not a valid string.");
                }
                resolvedScopeId = existingScopeId;
              } else {
                insertCommonScopeStatement.run(
                  request.spaceId,
                  defaultCommonScopeId,
                  tenantCreatedAtMillis,
                );
                const commonScopeRow = selectCommonScopeIdStatement.get(request.spaceId);
                if (commonScopeRow === undefined) {
                  throw new Error(
                    "Unable to resolve tenant common scope after deterministic bootstrap.",
                  );
                }
                const bootstrappedScopeId = readRowColumn(commonScopeRow, "scope_id");
                if (
                  typeof bootstrappedScopeId !== "string" ||
                  bootstrappedScopeId.trim().length === 0
                ) {
                  throw new Error("Bootstrapped common scope_id is not a valid string.");
                }
                resolvedScopeId = bootstrappedScopeId;
              }
            }

            upsertMemoryStatement.run(
              request.spaceId,
              request.memoryId,
              resolvedScopeId,
              request.layer,
              payloadProjection.memoryKind,
              payloadProjection.status,
              payloadProjection.title,
              payloadProjection.payloadJson,
              payloadProjection.createdByUserId,
              payloadProjection.supersedesMemoryId,
              payloadProjection.createdAtMillis,
              payloadProjection.updatedAtMillis,
              payloadProjection.expiresAtMillis,
              payloadProjection.tombstonedAtMillis,
            );

            const persistedRow = selectPersistedMemoryStatement.get(
              request.spaceId,
              request.memoryId,
            );
            const persistedAtMillis = toNonNegativeSafeInteger(
              readRowColumn(persistedRow, "updated_at_ms"),
              "memory_items.updated_at_ms",
            );

            return {
              spaceId: request.spaceId,
              memoryId: request.memoryId,
              accepted: true,
              persistedAtMillis,
              version: 1,
            } satisfies StorageUpsertResponse;
          }),
        catch: (cause) => mapUpsertFailure(cause, request),
      }),
    deleteMemory: (request) =>
      Effect.try({
        try: () =>
          withImmediateTransaction(database, () => {
            assertExpectedForeignKeysMode();
            const deleteResult = deleteMemoryStatement.run(request.spaceId, request.memoryId);
            const deletedCount = toNonNegativeSafeInteger(
              readRowColumn(deleteResult, "changes"),
              "sqlite delete changes",
            );
            if (deletedCount === 0) {
              throw new MissingStorageDeleteFailure();
            }

            return {
              spaceId: request.spaceId,
              memoryId: request.memoryId,
              deleted: true,
            } satisfies StorageDeleteResponse;
          }),
        catch: (cause) => mapDeleteFailure(cause, request),
      }),
  };
};
