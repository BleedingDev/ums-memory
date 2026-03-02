import { createHash } from "node:crypto";
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
  type EnterpriseAuditEventOperation,
  type EnterpriseAuditEventOutcome,
  type EnterpriseAuditEventReason,
  type EnterpriseAuditEventReferenceKind,
  type EnterpriseEvidenceRelationKind,
  type EnterpriseEvidenceSourceKind,
  type EnterpriseMemoryKind,
  type EnterpriseMemoryStatus,
  enterpriseEvidenceRelationKinds,
  enterpriseEvidenceSourceKinds,
  enterpriseMemoryKinds,
  enterpriseMemoryStatuses,
} from "./enterprise-schema.js";
import { applyEnterpriseSqliteMigrations } from "./migrations.js";

const tenantCreatedAtMillis = 0;
const tenantUpdatedAtMillis = 0;

const memoryKindSet: ReadonlySet<string> = new Set(enterpriseMemoryKinds);
const memoryStatusSet: ReadonlySet<string> = new Set(enterpriseMemoryStatuses);
const evidenceSourceKindSet: ReadonlySet<string> = new Set(enterpriseEvidenceSourceKinds);
const evidenceRelationKindSet: ReadonlySet<string> = new Set(enterpriseEvidenceRelationKinds);
const sqliteForeignKeysModeByConnection = new WeakMap<DatabaseSync, boolean>();

type CanonicalJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

class StoragePayloadValidationFailure extends Error {}
class MissingStorageDeleteFailure extends Error {
  readonly ownerTenantId: string | null;
  readonly reason: Extract<
    EnterpriseAuditEventReason,
    "memory_not_found" | "cross_tenant_delete_probe"
  >;

  constructor(ownerTenantId: string | null) {
    const reason: Extract<
      EnterpriseAuditEventReason,
      "memory_not_found" | "cross_tenant_delete_probe"
    > = ownerTenantId === null ? "memory_not_found" : "cross_tenant_delete_probe";
    const details =
      ownerTenantId === null
        ? "Delete request targeted memory missing for tenant."
        : "Delete request targeted memory owned by another tenant.";
    super(details);
    this.ownerTenantId = ownerTenantId;
    this.reason = reason;
  }
}
class TenantIsolationViolationFailure extends Error {
  readonly event: TenantIsolationViolationAuditEvent;

  constructor(event: TenantIsolationViolationAuditEvent) {
    super(event.details);
    this.event = event;
  }
}
const storageRuntimeFailureContract = "StorageRuntimeFailure";

export interface TenantIsolationViolationAuditEvent {
  readonly operation: "upsert" | "delete";
  readonly spaceId: string;
  readonly memoryId: string;
  readonly referenceKind: "scope" | "project" | "role" | "user" | "supersedes_memory" | "memory";
  readonly referenceId: string;
  readonly ownerTenantId: string;
  readonly reason: "cross_tenant_reference" | "cross_tenant_delete_probe";
  readonly details: string;
}

interface StorageAuditLedgerEntry {
  readonly eventId: string;
  readonly tenantId: string;
  readonly memoryId: string;
  readonly operation: EnterpriseAuditEventOperation;
  readonly outcome: EnterpriseAuditEventOutcome;
  readonly reason: EnterpriseAuditEventReason;
  readonly details: string;
  readonly referenceKind: EnterpriseAuditEventReferenceKind | null;
  readonly referenceId: string | null;
  readonly ownerTenantId: string | null;
  readonly recordedAtMillis: number;
}

interface StoragePayloadProjection {
  readonly scopeId: string | null;
  readonly scopeProjectId: string | null;
  readonly scopeRoleId: string | null;
  readonly scopeUserId: string | null;
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
  readonly provenanceJson: string | null;
  readonly evidencePointers: readonly EvidencePointerProjection[];
}

interface EvidencePointerProjection {
  readonly proposedEvidenceId: string;
  readonly sourceKind: EnterpriseEvidenceSourceKind;
  readonly sourceRef: string;
  readonly digestSha256: string;
  readonly payloadJson: string;
  readonly observedAtMillis: number;
  readonly createdAtMillis: number;
  readonly relationKind: EnterpriseEvidenceRelationKind;
}

export interface SqliteStorageRepositoryOptions {
  readonly applyMigrations?: boolean;
  readonly enforceForeignKeys?: boolean;
  readonly onTenantIsolationViolation?: (event: TenantIsolationViolationAuditEvent) => void;
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

const compareStringsAscending = (left: string, right: string): number => {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
};

const parseOptionalTrimmedStringArray = (
  payload: DomainRecord,
  keys: readonly string[],
  label: string,
): readonly string[] | undefined => {
  const value = readRecordValue(payload, keys);
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new StoragePayloadValidationFailure(`${label} must be an array of non-empty strings.`);
  }

  const normalized = value.map((entry, index) => {
    if (typeof entry !== "string") {
      throw new StoragePayloadValidationFailure(
        `${label}[${index}] must be a non-empty string value.`,
      );
    }
    const trimmed = entry.trim();
    if (trimmed.length === 0) {
      throw new StoragePayloadValidationFailure(
        `${label}[${index}] must be a non-empty string value.`,
      );
    }
    return trimmed;
  });

  return Object.freeze(
    [...new Set(normalized)].sort((left, right) => compareStringsAscending(left, right)),
  );
};

const toSha256Hex = (value: string): string => createHash("sha256").update(value).digest("hex");

const toDeterministicAuditEventId = (event: Omit<StorageAuditLedgerEntry, "eventId">): string => {
  const nullable = (value: string | null): string => value ?? "";
  return `audit:${toSha256Hex(
    [
      event.tenantId,
      event.memoryId,
      event.operation,
      event.outcome,
      event.reason,
      event.details,
      nullable(event.referenceKind),
      nullable(event.referenceId),
      nullable(event.ownerTenantId),
      String(event.recordedAtMillis),
    ].join("\n"),
  )}`;
};

const createStorageAuditLedgerEntry = (
  event: Omit<StorageAuditLedgerEntry, "eventId">,
): StorageAuditLedgerEntry =>
  Object.freeze({
    eventId: toDeterministicAuditEventId(event),
    ...event,
  });

const toCanonicalJsonString = (value: DomainValue, path: string): string =>
  JSON.stringify(normalizeDomainValue(value, path));

const readPayloadMetadataRecord = (payload: DomainRecord): DomainRecord | undefined => {
  const metadataValue = readRecordValue(payload, ["metadata"]);
  if (metadataValue === undefined) {
    return undefined;
  }

  return isDomainRecord(metadataValue) ? metadataValue : undefined;
};

const readPayloadProvenanceValue = (payload: DomainRecord): DomainValue | undefined => {
  const rootValue = readRecordValue(payload, [
    "provenance",
    "provenanceMetadata",
    "provenance_metadata",
  ]);
  if (rootValue !== undefined) {
    return rootValue;
  }

  const metadataRecord = readPayloadMetadataRecord(payload);
  if (metadataRecord === undefined) {
    return undefined;
  }

  return readRecordValue(metadataRecord, [
    "provenance",
    "provenanceMetadata",
    "provenance_metadata",
  ]);
};

const parseIncomingProvenanceJson = (payload: DomainRecord): string | null => {
  const provenanceValue = readPayloadProvenanceValue(payload);
  if (provenanceValue === undefined || provenanceValue === null) {
    return null;
  }
  if (!isDomainRecord(provenanceValue)) {
    throw new StoragePayloadValidationFailure(
      "payload.provenance must be a plain object record when provided.",
    );
  }

  return toCanonicalJsonString(provenanceValue, "payload.provenance");
};

const readPayloadEvidencePointersValue = (payload: DomainRecord): DomainValue | undefined => {
  const rootValue = readRecordValue(payload, ["evidencePointers", "evidence_pointers"]);
  if (rootValue !== undefined) {
    return rootValue;
  }

  const metadataRecord = readPayloadMetadataRecord(payload);
  if (metadataRecord === undefined) {
    return undefined;
  }

  return readRecordValue(metadataRecord, ["evidencePointers", "evidence_pointers"]);
};

const createEvidencePointerFromReferenceId = (
  sourceId: string,
  relationKind: EnterpriseEvidenceRelationKind,
  observedAtMillis: number,
  createdAtMillis: number,
): EvidencePointerProjection => {
  const sourceKind: EnterpriseEvidenceSourceKind = "event";
  const sourceRef = `event://${sourceId}`;
  const payloadJson = "{}";
  const digestSha256 = toSha256Hex(`${sourceKind}\n${sourceRef}\n${payloadJson}`);
  const proposedEvidenceId = `evidence:${toSha256Hex(`${sourceKind}\n${sourceRef}\n${digestSha256}`)}`;

  return Object.freeze({
    proposedEvidenceId,
    sourceKind,
    sourceRef,
    digestSha256,
    payloadJson,
    observedAtMillis,
    createdAtMillis,
    relationKind,
  });
};

const parseEvidencePointerRecord = (
  pointerRecord: DomainRecord,
  label: string,
  fallbackObservedAtMillis: number,
  fallbackCreatedAtMillis: number,
): EvidencePointerProjection => {
  const eventOrEpisodeId =
    parseOptionalTrimmedString(
      pointerRecord,
      ["eventId", "event_id", "episodeId", "episode_id"],
      `${label}.eventId`,
    ) ?? null;
  const sourceRefCandidate =
    parseOptionalTrimmedString(
      pointerRecord,
      ["sourceRef", "source_ref", "reference", "ref"],
      `${label}.sourceRef`,
    ) ?? null;
  const sourceRef =
    sourceRefCandidate ?? (eventOrEpisodeId === null ? null : `event://${eventOrEpisodeId}`);
  if (sourceRef === null) {
    throw new StoragePayloadValidationFailure(
      `${label} must define sourceRef or eventId/episodeId.`,
    );
  }

  const sourceKind =
    parseOptionalEnum<EnterpriseEvidenceSourceKind>(
      pointerRecord,
      ["sourceKind", "source_kind"],
      evidenceSourceKindSet,
      `${label}.sourceKind`,
    ) ?? "event";
  const relationKind =
    parseOptionalEnum<EnterpriseEvidenceRelationKind>(
      pointerRecord,
      ["relationKind", "relation_kind"],
      evidenceRelationKindSet,
      `${label}.relationKind`,
    ) ?? "supports";

  const evidencePayloadValue = readRecordValue(pointerRecord, [
    "payload",
    "payload_json",
    "metadata",
  ]);
  const payloadJson =
    evidencePayloadValue === undefined
      ? "{}"
      : toCanonicalJsonString(evidencePayloadValue, `${label}.payload`);

  const rawDigest =
    parseOptionalTrimmedString(
      pointerRecord,
      ["digestSha256", "digest_sha256", "digest", "sha256"],
      `${label}.digestSha256`,
    ) ?? null;
  const digestSha256 =
    rawDigest === null
      ? toSha256Hex(`${sourceKind}\n${sourceRef}\n${payloadJson}`)
      : rawDigest.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(digestSha256)) {
    throw new StoragePayloadValidationFailure(
      `${label}.digestSha256 must be a 64-character hexadecimal sha256 digest.`,
    );
  }

  const observedAtMillis =
    parseOptionalNonNegativeSafeInteger(
      pointerRecord,
      ["observedAtMillis", "observed_at_ms", "occurredAtMillis", "occurred_at_ms"],
      `${label}.observedAtMillis`,
    ) ?? fallbackObservedAtMillis;
  const createdAtMillisInput = parseOptionalNonNegativeSafeInteger(
    pointerRecord,
    ["createdAtMillis", "created_at_ms"],
    `${label}.createdAtMillis`,
  );
  const createdAtMillis = Math.max(
    createdAtMillisInput ?? fallbackCreatedAtMillis,
    observedAtMillis,
  );

  const proposedEvidenceId =
    parseOptionalTrimmedString(
      pointerRecord,
      ["evidenceId", "evidence_id"],
      `${label}.evidenceId`,
    ) ?? `evidence:${toSha256Hex(`${sourceKind}\n${sourceRef}\n${digestSha256}`)}`;

  return Object.freeze({
    proposedEvidenceId,
    sourceKind,
    sourceRef,
    digestSha256,
    payloadJson,
    observedAtMillis,
    createdAtMillis,
    relationKind,
  });
};

const compareEvidencePointers = (
  left: EvidencePointerProjection,
  right: EvidencePointerProjection,
): number => {
  const bySourceKind = compareStringsAscending(left.sourceKind, right.sourceKind);
  if (bySourceKind !== 0) {
    return bySourceKind;
  }
  const bySourceRef = compareStringsAscending(left.sourceRef, right.sourceRef);
  if (bySourceRef !== 0) {
    return bySourceRef;
  }
  const byDigest = compareStringsAscending(left.digestSha256, right.digestSha256);
  if (byDigest !== 0) {
    return byDigest;
  }
  const byRelation = compareStringsAscending(left.relationKind, right.relationKind);
  if (byRelation !== 0) {
    return byRelation;
  }
  const byEvidenceId = compareStringsAscending(left.proposedEvidenceId, right.proposedEvidenceId);
  if (byEvidenceId !== 0) {
    return byEvidenceId;
  }
  if (left.observedAtMillis !== right.observedAtMillis) {
    return left.observedAtMillis - right.observedAtMillis;
  }
  if (left.createdAtMillis !== right.createdAtMillis) {
    return left.createdAtMillis - right.createdAtMillis;
  }
  return compareStringsAscending(left.payloadJson, right.payloadJson);
};

const parseEvidencePointerProjections = (
  payload: DomainRecord,
  fallbackObservedAtMillis: number,
  fallbackCreatedAtMillis: number,
): readonly EvidencePointerProjection[] => {
  const explicitPointersValue = readPayloadEvidencePointersValue(payload);
  const pointers: EvidencePointerProjection[] = [];

  if (explicitPointersValue !== undefined) {
    if (!Array.isArray(explicitPointersValue)) {
      throw new StoragePayloadValidationFailure(
        "payload.evidencePointers must be an array of evidence pointer objects.",
      );
    }
    for (const [index, pointerValue] of explicitPointersValue.entries()) {
      if (!isDomainRecord(pointerValue)) {
        throw new StoragePayloadValidationFailure(
          `payload.evidencePointers[${index}] must be a plain object record.`,
        );
      }
      pointers.push(
        parseEvidencePointerRecord(
          pointerValue,
          `payload.evidencePointers[${index}]`,
          fallbackObservedAtMillis,
          fallbackCreatedAtMillis,
        ),
      );
    }
  }

  const evidenceEventIds =
    parseOptionalTrimmedStringArray(
      payload,
      ["evidenceEventIds", "evidence_event_ids"],
      "payload.evidenceEventIds",
    ) ?? [];
  const evidenceEpisodeIds =
    parseOptionalTrimmedStringArray(
      payload,
      ["evidenceEpisodeIds", "evidence_episode_ids"],
      "payload.evidenceEpisodeIds",
    ) ?? [];
  const allSourceIds = [...new Set([...evidenceEventIds, ...evidenceEpisodeIds])].sort(
    (left, right) => compareStringsAscending(left, right),
  );
  for (const sourceId of allSourceIds) {
    pointers.push(
      createEvidencePointerFromReferenceId(
        sourceId,
        "supports",
        fallbackObservedAtMillis,
        fallbackCreatedAtMillis,
      ),
    );
  }

  const sortedPointers = [...pointers].sort((left, right) => compareEvidencePointers(left, right));
  const deduplicatedPointers: EvidencePointerProjection[] = [];
  const relationKindByNaturalKey = new Map<string, EnterpriseEvidenceRelationKind>();
  for (const pointer of sortedPointers) {
    const naturalKey = `${pointer.sourceKind}\u0000${pointer.sourceRef}\u0000${pointer.digestSha256}`;
    const existingRelationKind = relationKindByNaturalKey.get(naturalKey);
    if (existingRelationKind !== undefined) {
      if (existingRelationKind !== pointer.relationKind) {
        throw new StoragePayloadValidationFailure(
          "Each evidence pointer must use a single relationKind per deterministic evidence key.",
        );
      }
      continue;
    }
    relationKindByNaturalKey.set(naturalKey, pointer.relationKind);
    deduplicatedPointers.push(pointer);
  }

  return Object.freeze(deduplicatedPointers);
};

const readPersistedProvenanceJsonFromPayloadJson = (payloadJson: string): string | null => {
  let parsedPayload: unknown;
  try {
    parsedPayload = JSON.parse(payloadJson);
  } catch (cause) {
    const details = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`Persisted memory payload_json is not valid JSON: ${details}`);
  }
  if (!isDomainRecord(parsedPayload)) {
    return null;
  }

  const provenanceValue = readPayloadProvenanceValue(parsedPayload);
  if (provenanceValue === undefined || provenanceValue === null) {
    return null;
  }

  return toCanonicalJsonString(provenanceValue, "persistedPayload.provenance");
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

interface ScopeControlProjection {
  readonly scopeId: string | null;
  readonly scopeProjectId: string | null;
  readonly scopeRoleId: string | null;
  readonly scopeUserId: string | null;
}

const parseScopeControlProjection = (payload: DomainRecord): ScopeControlProjection => {
  const legacyRootScopeId =
    parseOptionalTrimmedString(payload, ["scopeId", "scope_id"], "payload.scopeId") ?? null;

  const scopeControlValue = readRecordValue(payload, ["scope"]);
  if (scopeControlValue === undefined) {
    return Object.freeze({
      scopeId: legacyRootScopeId,
      scopeProjectId: null,
      scopeRoleId: null,
      scopeUserId: null,
    });
  }

  if (!isDomainRecord(scopeControlValue)) {
    throw new StoragePayloadValidationFailure(
      "StorageUpsertRequest.payload.scope must be a plain object record.",
    );
  }

  const scopeRecord = scopeControlValue;
  const scopeId =
    parseOptionalTrimmedString(scopeRecord, ["scopeId", "scope_id"], "payload.scope.scopeId") ??
    null;
  const scopeProjectId =
    parseOptionalTrimmedString(
      scopeRecord,
      ["projectId", "project_id"],
      "payload.scope.projectId",
    ) ?? null;
  const scopeRoleId =
    parseOptionalTrimmedString(
      scopeRecord,
      ["roleId", "role_id", "jobRoleId", "job_role_id"],
      "payload.scope.roleId",
    ) ?? null;
  const scopeUserId =
    parseOptionalTrimmedString(scopeRecord, ["userId", "user_id"], "payload.scope.userId") ?? null;
  if (
    legacyRootScopeId !== null &&
    (scopeId !== null || scopeProjectId !== null || scopeRoleId !== null || scopeUserId !== null)
  ) {
    throw new StoragePayloadValidationFailure(
      "payload.scopeId cannot be combined with payload.scope controls.",
    );
  }
  const resolvedScopeId = scopeId ?? legacyRootScopeId;
  if (
    resolvedScopeId !== null &&
    (scopeProjectId !== null || scopeRoleId !== null || scopeUserId !== null)
  ) {
    throw new StoragePayloadValidationFailure(
      "Explicit scopeId cannot be combined with project/role/user scope anchors.",
    );
  }

  return Object.freeze({
    scopeId: resolvedScopeId,
    scopeProjectId,
    scopeRoleId,
    scopeUserId,
  });
};

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

  const scopeControl = parseScopeControlProjection(payload);
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
  const provenanceJson = parseIncomingProvenanceJson(payload);
  const evidencePointers = parseEvidencePointerProjections(
    payload,
    normalizedUpdatedAtMillis,
    normalizedCreatedAtMillis,
  );
  if (request.layer === "procedural" && evidencePointers.length === 0) {
    throw new StoragePayloadValidationFailure(
      "Promoted procedural memory requires at least one evidence pointer.",
    );
  }

  return Object.freeze({
    scopeId: scopeControl.scopeId,
    scopeProjectId: scopeControl.scopeProjectId,
    scopeRoleId: scopeControl.scopeRoleId,
    scopeUserId: scopeControl.scopeUserId,
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
    provenanceJson,
    evidencePointers,
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
  if (cause instanceof TenantIsolationViolationFailure) {
    return new ContractValidationError({
      contract: "StorageTenantIsolationGuardrail",
      message: "Tenant isolation guardrail denied a cross-tenant storage reference.",
      details: cause.message,
    });
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
  if (cause instanceof TenantIsolationViolationFailure) {
    return new ContractValidationError({
      contract: "StorageTenantIsolationGuardrail",
      message: "Tenant isolation guardrail denied a cross-tenant storage delete probe.",
      details: cause.message,
    });
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
  const selectProjectScopeIdStatement = database.prepare(
    "SELECT scope_id FROM scopes WHERE tenant_id = ? AND scope_level = 'project' AND project_id = ? ORDER BY scope_id LIMIT 1;",
  );
  const insertProjectScopeStatement = database.prepare(
    "INSERT OR IGNORE INTO scopes (tenant_id, scope_id, scope_level, project_id, role_id, user_id, parent_scope_id, created_at_ms) VALUES (?, ?, 'project', ?, NULL, NULL, ?, ?);",
  );
  const selectProjectAnchorStatement = database.prepare(
    "SELECT project_id FROM projects WHERE tenant_id = ? AND project_id = ? LIMIT 1;",
  );
  const selectForeignProjectAnchorOwnerStatement = database.prepare(
    "SELECT tenant_id FROM projects WHERE project_id = ? AND tenant_id <> ? ORDER BY tenant_id ASC LIMIT 1;",
  );
  const selectJobRoleScopeIdStatement = database.prepare(
    "SELECT scope_id FROM scopes WHERE tenant_id = ? AND scope_level = 'job_role' AND role_id = ? ORDER BY scope_id LIMIT 1;",
  );
  const insertJobRoleScopeStatement = database.prepare(
    "INSERT OR IGNORE INTO scopes (tenant_id, scope_id, scope_level, project_id, role_id, user_id, parent_scope_id, created_at_ms) VALUES (?, ?, 'job_role', NULL, ?, NULL, ?, ?);",
  );
  const selectRoleAnchorStatement = database.prepare(
    "SELECT role_id FROM roles WHERE tenant_id = ? AND role_id = ? LIMIT 1;",
  );
  const selectForeignRoleAnchorOwnerStatement = database.prepare(
    "SELECT tenant_id FROM roles WHERE role_id = ? AND tenant_id <> ? ORDER BY tenant_id ASC LIMIT 1;",
  );
  const selectUserScopeIdStatement = database.prepare(
    "SELECT scope_id, parent_scope_id FROM scopes WHERE tenant_id = ? AND scope_level = 'user' AND user_id = ? ORDER BY scope_id LIMIT 1;",
  );
  const insertUserScopeStatement = database.prepare(
    "INSERT OR IGNORE INTO scopes (tenant_id, scope_id, scope_level, project_id, role_id, user_id, parent_scope_id, created_at_ms) VALUES (?, ?, 'user', NULL, NULL, ?, ?, ?);",
  );
  const selectUserAnchorStatement = database.prepare(
    "SELECT user_id FROM users WHERE tenant_id = ? AND user_id = ? LIMIT 1;",
  );
  const selectForeignUserAnchorOwnerStatement = database.prepare(
    "SELECT tenant_id FROM users WHERE user_id = ? AND tenant_id <> ? ORDER BY tenant_id ASC LIMIT 1;",
  );
  const selectTenantScopedScopeStatement = database.prepare(
    "SELECT scope_id FROM scopes WHERE tenant_id = ? AND scope_id = ? LIMIT 1;",
  );
  const selectForeignScopeOwnerStatement = database.prepare(
    "SELECT tenant_id FROM scopes WHERE scope_id = ? AND tenant_id <> ? ORDER BY tenant_id ASC LIMIT 1;",
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
  const selectExistingMemoryLayerAndPayloadStatement = database.prepare(
    "SELECT memory_layer, payload_json FROM memory_items WHERE tenant_id = ? AND memory_id = ? LIMIT 1;",
  );
  const selectTenantMemoryStatement = database.prepare(
    "SELECT memory_id FROM memory_items WHERE tenant_id = ? AND memory_id = ? LIMIT 1;",
  );
  const selectTenantMemoryUpdatedAtStatement = database.prepare(
    "SELECT updated_at_ms FROM memory_items WHERE tenant_id = ? AND memory_id = ? LIMIT 1;",
  );
  const selectForeignMemoryOwnerStatement = database.prepare(
    "SELECT tenant_id FROM memory_items WHERE memory_id = ? AND tenant_id <> ? ORDER BY tenant_id ASC LIMIT 1;",
  );
  const insertEvidenceStatement = database.prepare(
    "INSERT OR IGNORE INTO evidence (tenant_id, evidence_id, source_kind, source_ref, digest_sha256, payload_json, observed_at_ms, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?);",
  );
  const selectEvidenceIdByNaturalKeyStatement = database.prepare(
    "SELECT evidence_id FROM evidence WHERE tenant_id = ? AND source_kind = ? AND source_ref = ? AND digest_sha256 = ? LIMIT 1;",
  );
  const insertMemoryEvidenceLinkStatement = database.prepare(
    "INSERT OR IGNORE INTO memory_evidence_links (tenant_id, memory_id, evidence_id, relation_kind, created_at_ms) VALUES (?, ?, ?, ?, ?);",
  );
  const deleteMemoryEvidenceLinksStatement = database.prepare(
    "DELETE FROM memory_evidence_links WHERE tenant_id = ? AND memory_id = ?;",
  );
  const deleteMemoryStatement = database.prepare(
    "DELETE FROM memory_items WHERE tenant_id = ? AND memory_id = ?;",
  );
  const insertAuditEventStatement = database.prepare(
    [
      "INSERT OR IGNORE INTO audit_events (",
      "  event_id,",
      "  tenant_id,",
      "  memory_id,",
      "  operation,",
      "  outcome,",
      "  reason,",
      "  details,",
      "  reference_kind,",
      "  reference_id,",
      "  owner_tenant_id,",
      "  recorded_at_ms",
      ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);",
    ].join("\n"),
  );
  const selectMaxAuditFailureRecordedAtStatement = database.prepare(
    [
      "SELECT MAX(recorded_at_ms) AS max_recorded_at_ms",
      "FROM audit_events",
      "WHERE tenant_id = ?",
      "  AND memory_id = ?",
      "  AND operation = ?",
      "  AND outcome = ?",
      "  AND reason = ?",
      "  AND details = ?",
      "  AND COALESCE(reference_kind, '') = ?",
      "  AND COALESCE(reference_id, '') = ?",
      "  AND COALESCE(owner_tenant_id, '') = ?;",
    ].join("\n"),
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
  const readResolvedScopeId = (scopeRow: unknown, errorPrefix: string): string => {
    const scopeId = readRowColumn(scopeRow, "scope_id");
    if (typeof scopeId !== "string" || scopeId.trim().length === 0) {
      throw new Error(`${errorPrefix} scope_id is not a valid string.`);
    }

    return scopeId;
  };
  const readResolvedMemoryLayer = (memoryRow: unknown, errorPrefix: string): string => {
    const memoryLayer = readRowColumn(memoryRow, "memory_layer");
    if (typeof memoryLayer !== "string" || memoryLayer.trim().length === 0) {
      throw new Error(`${errorPrefix} memory_layer is not a valid string.`);
    }

    return memoryLayer;
  };
  const readResolvedEvidenceId = (evidenceRow: unknown, errorPrefix: string): string => {
    const evidenceId = readRowColumn(evidenceRow, "evidence_id");
    if (typeof evidenceId !== "string" || evidenceId.trim().length === 0) {
      throw new Error(`${errorPrefix} evidence_id is not a valid string.`);
    }

    return evidenceId;
  };
  const emitTenantIsolationViolation = options.onTenantIsolationViolation;
  const readOwnerTenantId = (foreignOwnerRow: unknown): string => {
    const ownerTenantId = readRowColumn(foreignOwnerRow, "tenant_id");
    if (typeof ownerTenantId !== "string" || ownerTenantId.trim().length === 0) {
      throw new Error("Resolved tenant_id owner column is not a valid string.");
    }

    return ownerTenantId;
  };
  const auditTenantIsolationViolation = (event: TenantIsolationViolationAuditEvent): void => {
    if (emitTenantIsolationViolation === undefined) {
      return;
    }

    try {
      emitTenantIsolationViolation(event);
    } catch {
      // Guardrail audit hooks must never change repository behavior.
    }
  };
  const persistAuditLedgerEntry = (event: StorageAuditLedgerEntry): void => {
    insertAuditEventStatement.run(
      event.eventId,
      event.tenantId,
      event.memoryId,
      event.operation,
      event.outcome,
      event.reason,
      event.details,
      event.referenceKind,
      event.referenceId,
      event.ownerTenantId,
      event.recordedAtMillis,
    );
  };
  const persistAuditLedgerEntryBestEffort = (event: StorageAuditLedgerEntry): void => {
    try {
      persistAuditLedgerEntry(event);
    } catch {
      // Audit persistence must not mask the original storage failure mapping.
    }
  };
  const toNullableAuditLookupKey = (value: string | null): string => value ?? "";
  const allocateFailureAuditRecordedAtMillis = (
    event: Omit<StorageAuditLedgerEntry, "eventId" | "recordedAtMillis">,
  ): number => {
    const existingFailureRow = selectMaxAuditFailureRecordedAtStatement.get(
      event.tenantId,
      event.memoryId,
      event.operation,
      event.outcome,
      event.reason,
      event.details,
      toNullableAuditLookupKey(event.referenceKind),
      toNullableAuditLookupKey(event.referenceId),
      toNullableAuditLookupKey(event.ownerTenantId),
    );
    const maxRecordedAtValue = readRowColumn(existingFailureRow, "max_recorded_at_ms");
    const maxRecordedAtMillis =
      maxRecordedAtValue === null
        ? -1
        : toNonNegativeSafeInteger(maxRecordedAtValue, "audit_events.max_recorded_at_ms");
    return maxRecordedAtMillis + 1;
  };
  const denyTenantIsolationViolation = (
    operation: "upsert" | "delete",
    spaceId: string,
    memoryId: string,
    referenceKind: TenantIsolationViolationAuditEvent["referenceKind"],
    referenceId: string,
    ownerTenantId: string,
    reason: TenantIsolationViolationAuditEvent["reason"],
    details: string,
  ): never => {
    const event: TenantIsolationViolationAuditEvent = Object.freeze({
      operation,
      spaceId,
      memoryId,
      referenceKind,
      referenceId,
      ownerTenantId,
      reason,
      details,
    });
    auditTenantIsolationViolation(event);
    throw new TenantIsolationViolationFailure(event);
  };
  const persistUpsertFailureAuditEntry = (cause: unknown, request: StorageUpsertRequest): void => {
    if (!(cause instanceof TenantIsolationViolationFailure)) {
      return;
    }

    persistAuditLedgerEntryBestEffort(
      createStorageAuditLedgerEntry({
        tenantId: request.spaceId,
        memoryId: request.memoryId,
        operation: "upsert",
        outcome: "denied",
        reason: cause.event.reason,
        details: cause.event.details,
        referenceKind: cause.event.referenceKind,
        referenceId: cause.event.referenceId,
        ownerTenantId: cause.event.ownerTenantId,
        recordedAtMillis: allocateFailureAuditRecordedAtMillis({
          tenantId: request.spaceId,
          memoryId: request.memoryId,
          operation: "upsert",
          outcome: "denied",
          reason: cause.event.reason,
          details: cause.event.details,
          referenceKind: cause.event.referenceKind,
          referenceId: cause.event.referenceId,
          ownerTenantId: cause.event.ownerTenantId,
        }),
      }),
    );
  };
  const persistDeleteFailureAuditEntry = (cause: unknown, request: StorageDeleteRequest): void => {
    if (!(cause instanceof MissingStorageDeleteFailure)) {
      return;
    }

    const referenceKind: EnterpriseAuditEventReferenceKind | null =
      cause.ownerTenantId === null ? null : "memory";
    const referenceId = cause.ownerTenantId === null ? null : request.memoryId;
    persistAuditLedgerEntryBestEffort(
      createStorageAuditLedgerEntry({
        tenantId: request.spaceId,
        memoryId: request.memoryId,
        operation: "delete",
        outcome: "not_found",
        reason: cause.reason,
        details: cause.message,
        referenceKind,
        referenceId,
        ownerTenantId: cause.ownerTenantId,
        recordedAtMillis: allocateFailureAuditRecordedAtMillis({
          tenantId: request.spaceId,
          memoryId: request.memoryId,
          operation: "delete",
          outcome: "not_found",
          reason: cause.reason,
          details: cause.message,
          referenceKind,
          referenceId,
          ownerTenantId: cause.ownerTenantId,
        }),
      }),
    );
  };
  const assertScopeAnchorExists = (
    scopeAnchorRow: unknown,
    foreignOwnerRow: unknown,
    spaceId: string,
    memoryId: string,
    anchorPath: string,
    anchorKind: "project" | "role" | "user",
    anchorId: string,
  ): void => {
    if (scopeAnchorRow !== undefined) {
      return;
    }
    if (foreignOwnerRow !== undefined) {
      const ownerTenantId = readOwnerTenantId(foreignOwnerRow);
      denyTenantIsolationViolation(
        "upsert",
        spaceId,
        memoryId,
        anchorKind,
        anchorId,
        ownerTenantId,
        "cross_tenant_reference",
        `${anchorPath} references an anchor owned by another tenant.`,
      );
    }

    throw new StoragePayloadValidationFailure(
      `${anchorPath} references unknown tenant ${anchorKind} anchor "${anchorId}".`,
    );
  };
  const resolveCommonScopeId = (tenantId: string): string => {
    const existingScopeRow = selectCommonScopeIdStatement.get(tenantId);
    if (existingScopeRow !== undefined) {
      return readResolvedScopeId(existingScopeRow, "Resolved common");
    }

    insertCommonScopeStatement.run(tenantId, `common:${tenantId}`, tenantCreatedAtMillis);
    const insertedScopeRow = selectCommonScopeIdStatement.get(tenantId);
    if (insertedScopeRow === undefined) {
      throw new Error("Unable to resolve tenant common scope after deterministic bootstrap.");
    }

    return readResolvedScopeId(insertedScopeRow, "Bootstrapped common");
  };
  const resolveProjectScopeId = (
    tenantId: string,
    projectId: string,
    commonScopeId: string,
    memoryId: string,
  ): string => {
    const existingScopeRow = selectProjectScopeIdStatement.get(tenantId, projectId);
    if (existingScopeRow !== undefined) {
      return readResolvedScopeId(existingScopeRow, "Resolved project");
    }
    assertScopeAnchorExists(
      selectProjectAnchorStatement.get(tenantId, projectId),
      selectForeignProjectAnchorOwnerStatement.get(projectId, tenantId),
      tenantId,
      memoryId,
      "payload.scope.projectId",
      "project",
      projectId,
    );

    insertProjectScopeStatement.run(
      tenantId,
      `project:${tenantId}:${projectId}`,
      projectId,
      commonScopeId,
      tenantCreatedAtMillis,
    );
    const insertedScopeRow = selectProjectScopeIdStatement.get(tenantId, projectId);
    if (insertedScopeRow === undefined) {
      throw new Error("Unable to resolve tenant project scope after deterministic bootstrap.");
    }

    return readResolvedScopeId(insertedScopeRow, "Bootstrapped project");
  };
  const resolveJobRoleScopeId = (
    tenantId: string,
    roleId: string,
    commonScopeId: string,
    memoryId: string,
  ): string => {
    const existingScopeRow = selectJobRoleScopeIdStatement.get(tenantId, roleId);
    if (existingScopeRow !== undefined) {
      return readResolvedScopeId(existingScopeRow, "Resolved job_role");
    }
    assertScopeAnchorExists(
      selectRoleAnchorStatement.get(tenantId, roleId),
      selectForeignRoleAnchorOwnerStatement.get(roleId, tenantId),
      tenantId,
      memoryId,
      "payload.scope.roleId",
      "role",
      roleId,
    );

    insertJobRoleScopeStatement.run(
      tenantId,
      `job_role:${tenantId}:${roleId}`,
      roleId,
      commonScopeId,
      tenantCreatedAtMillis,
    );
    const insertedScopeRow = selectJobRoleScopeIdStatement.get(tenantId, roleId);
    if (insertedScopeRow === undefined) {
      throw new Error("Unable to resolve tenant job_role scope after deterministic bootstrap.");
    }

    return readResolvedScopeId(insertedScopeRow, "Bootstrapped job_role");
  };
  const resolveUserScopeId = (
    tenantId: string,
    userId: string,
    requestedParentScopeId: string | null,
    defaultParentScopeId: string,
    memoryId: string,
  ): string => {
    const existingScopeRow = selectUserScopeIdStatement.get(tenantId, userId);
    if (existingScopeRow !== undefined) {
      const existingScopeId = readResolvedScopeId(existingScopeRow, "Resolved user");
      const existingParentScopeId = readRowColumn(existingScopeRow, "parent_scope_id");
      if (typeof existingParentScopeId !== "string" || existingParentScopeId.trim().length === 0) {
        throw new Error("Resolved user parent_scope_id is not a valid string.");
      }
      if (requestedParentScopeId !== null && existingParentScopeId !== requestedParentScopeId) {
        throw new StoragePayloadValidationFailure(
          `payload.scope anchors conflict with existing user scope parent. Existing parent=${existingParentScopeId}, requested parent=${requestedParentScopeId}.`,
        );
      }

      return existingScopeId;
    }

    assertScopeAnchorExists(
      selectUserAnchorStatement.get(tenantId, userId),
      selectForeignUserAnchorOwnerStatement.get(userId, tenantId),
      tenantId,
      memoryId,
      "payload.scope.userId",
      "user",
      userId,
    );
    const parentScopeId = requestedParentScopeId ?? defaultParentScopeId;
    insertUserScopeStatement.run(
      tenantId,
      `user:${tenantId}:${userId}`,
      userId,
      parentScopeId,
      tenantCreatedAtMillis,
    );
    const insertedScopeRow = selectUserScopeIdStatement.get(tenantId, userId);
    if (insertedScopeRow === undefined) {
      throw new Error("Unable to resolve tenant user scope after deterministic bootstrap.");
    }

    return readResolvedScopeId(insertedScopeRow, "Bootstrapped user");
  };

  return {
    upsertMemory: (request) =>
      Effect.try({
        try: () =>
          withImmediateTransaction(database, () => {
            assertExpectedForeignKeysMode();
            const payloadProjection = parsePayloadProjection(request);
            const existingMemoryRow = selectExistingMemoryLayerAndPayloadStatement.get(
              request.spaceId,
              request.memoryId,
            );
            if (existingMemoryRow !== undefined) {
              const existingMemoryLayer = readResolvedMemoryLayer(
                existingMemoryRow,
                "Existing memory",
              );
              if (existingMemoryLayer === "procedural") {
                const existingPayloadJson = readRowColumn(existingMemoryRow, "payload_json");
                if (typeof existingPayloadJson !== "string") {
                  throw new Error("Existing memory payload_json is not a valid string.");
                }
                const existingProvenanceJson =
                  readPersistedProvenanceJsonFromPayloadJson(existingPayloadJson);
                if (
                  existingProvenanceJson !== null &&
                  existingProvenanceJson !== payloadProjection.provenanceJson
                ) {
                  throw new StoragePayloadValidationFailure(
                    "Promoted memory provenance metadata is immutable once memory is procedural.",
                  );
                }
              }
            }

            ensureTenantStatement.run(
              request.spaceId,
              request.spaceId,
              request.spaceId,
              tenantCreatedAtMillis,
              tenantUpdatedAtMillis,
            );

            let resolvedScopeId = payloadProjection.scopeId;
            if (resolvedScopeId === null) {
              const commonScopeId = resolveCommonScopeId(request.spaceId);
              const scopeUserId = payloadProjection.scopeUserId;

              if (scopeUserId !== null) {
                const requestedUserParentScopeId =
                  payloadProjection.scopeRoleId !== null
                    ? resolveJobRoleScopeId(
                        request.spaceId,
                        payloadProjection.scopeRoleId,
                        commonScopeId,
                        request.memoryId,
                      )
                    : payloadProjection.scopeProjectId !== null
                      ? resolveProjectScopeId(
                          request.spaceId,
                          payloadProjection.scopeProjectId,
                          commonScopeId,
                          request.memoryId,
                        )
                      : null;
                resolvedScopeId = resolveUserScopeId(
                  request.spaceId,
                  scopeUserId,
                  requestedUserParentScopeId,
                  commonScopeId,
                  request.memoryId,
                );
              } else if (payloadProjection.scopeRoleId !== null) {
                resolvedScopeId = resolveJobRoleScopeId(
                  request.spaceId,
                  payloadProjection.scopeRoleId,
                  commonScopeId,
                  request.memoryId,
                );
              } else if (payloadProjection.scopeProjectId !== null) {
                resolvedScopeId = resolveProjectScopeId(
                  request.spaceId,
                  payloadProjection.scopeProjectId,
                  commonScopeId,
                  request.memoryId,
                );
              } else {
                resolvedScopeId = commonScopeId;
              }
            }
            if (payloadProjection.scopeId !== null) {
              const tenantScopedRow = selectTenantScopedScopeStatement.get(
                request.spaceId,
                resolvedScopeId,
              );
              if (tenantScopedRow === undefined) {
                const foreignScopeOwnerRow = selectForeignScopeOwnerStatement.get(
                  resolvedScopeId,
                  request.spaceId,
                );
                if (foreignScopeOwnerRow !== undefined) {
                  const ownerTenantId = readOwnerTenantId(foreignScopeOwnerRow);
                  denyTenantIsolationViolation(
                    "upsert",
                    request.spaceId,
                    request.memoryId,
                    "scope",
                    resolvedScopeId,
                    ownerTenantId,
                    "cross_tenant_reference",
                    "Explicit scopeId reference is owned by another tenant.",
                  );
                }
              }
            }
            if (payloadProjection.supersedesMemoryId !== null) {
              const tenantScopedSupersedesRow = selectTenantMemoryStatement.get(
                request.spaceId,
                payloadProjection.supersedesMemoryId,
              );
              if (tenantScopedSupersedesRow === undefined) {
                const foreignSupersedesOwnerRow = selectForeignMemoryOwnerStatement.get(
                  payloadProjection.supersedesMemoryId,
                  request.spaceId,
                );
                if (foreignSupersedesOwnerRow !== undefined) {
                  const ownerTenantId = readOwnerTenantId(foreignSupersedesOwnerRow);
                  denyTenantIsolationViolation(
                    "upsert",
                    request.spaceId,
                    request.memoryId,
                    "supersedes_memory",
                    payloadProjection.supersedesMemoryId,
                    ownerTenantId,
                    "cross_tenant_reference",
                    "supersedesMemoryId references memory owned by another tenant.",
                  );
                }
              }
            }

            const upsertMemoryResult = upsertMemoryStatement.run(
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
            const upsertChanges = toNonNegativeSafeInteger(
              readRowColumn(upsertMemoryResult, "changes"),
              "memory_items.upsert.changes",
            );
            if (upsertChanges > 0) {
              deleteMemoryEvidenceLinksStatement.run(request.spaceId, request.memoryId);
              if (request.layer === "procedural") {
                for (const evidencePointer of payloadProjection.evidencePointers) {
                  insertEvidenceStatement.run(
                    request.spaceId,
                    evidencePointer.proposedEvidenceId,
                    evidencePointer.sourceKind,
                    evidencePointer.sourceRef,
                    evidencePointer.digestSha256,
                    evidencePointer.payloadJson,
                    evidencePointer.observedAtMillis,
                    evidencePointer.createdAtMillis,
                  );
                  const persistedEvidenceRow = selectEvidenceIdByNaturalKeyStatement.get(
                    request.spaceId,
                    evidencePointer.sourceKind,
                    evidencePointer.sourceRef,
                    evidencePointer.digestSha256,
                  );
                  if (persistedEvidenceRow === undefined) {
                    throw new Error(
                      "Unable to resolve evidence_id after deterministic evidence upsert.",
                    );
                  }
                  const persistedEvidenceId = readResolvedEvidenceId(
                    persistedEvidenceRow,
                    "Persisted evidence",
                  );
                  insertMemoryEvidenceLinkStatement.run(
                    request.spaceId,
                    request.memoryId,
                    persistedEvidenceId,
                    evidencePointer.relationKind,
                    payloadProjection.updatedAtMillis,
                  );
                }
              }
            }

            const persistedRow = selectPersistedMemoryStatement.get(
              request.spaceId,
              request.memoryId,
            );
            const persistedAtMillis = toNonNegativeSafeInteger(
              readRowColumn(persistedRow, "updated_at_ms"),
              "memory_items.updated_at_ms",
            );
            const upsertReason: EnterpriseAuditEventReason =
              upsertChanges > 0
                ? existingMemoryRow === undefined
                  ? "inserted"
                  : "updated"
                : payloadProjection.updatedAtMillis < persistedAtMillis
                  ? "stale_replay"
                  : "equal_replay";
            const upsertAuditDetails = [
              `layer=${request.layer}`,
              `scope_id=${resolvedScopeId}`,
              `requested_updated_at_ms=${payloadProjection.updatedAtMillis}`,
              `persisted_updated_at_ms=${persistedAtMillis}`,
              `payload_sha256=${toSha256Hex(payloadProjection.payloadJson)}`,
            ].join(";");
            persistAuditLedgerEntry(
              createStorageAuditLedgerEntry({
                tenantId: request.spaceId,
                memoryId: request.memoryId,
                operation: "upsert",
                outcome: "accepted",
                reason: upsertReason,
                details: upsertAuditDetails,
                referenceKind: null,
                referenceId: null,
                ownerTenantId: null,
                recordedAtMillis: persistedAtMillis,
              }),
            );

            return {
              spaceId: request.spaceId,
              memoryId: request.memoryId,
              accepted: true,
              persistedAtMillis,
              version: 1,
            } satisfies StorageUpsertResponse;
          }),
        catch: (cause) => {
          persistUpsertFailureAuditEntry(cause, request);
          return mapUpsertFailure(cause, request);
        },
      }),
    deleteMemory: (request) =>
      Effect.try({
        try: () =>
          withImmediateTransaction(database, () => {
            assertExpectedForeignKeysMode();
            const existingMemoryRow = selectTenantMemoryUpdatedAtStatement.get(
              request.spaceId,
              request.memoryId,
            );
            const deleteResult = deleteMemoryStatement.run(request.spaceId, request.memoryId);
            const deletedCount = toNonNegativeSafeInteger(
              readRowColumn(deleteResult, "changes"),
              "sqlite delete changes",
            );
            if (deletedCount === 0) {
              let ownerTenantId: string | null = null;
              const foreignMemoryOwnerRow = selectForeignMemoryOwnerStatement.get(
                request.memoryId,
                request.spaceId,
              );
              if (foreignMemoryOwnerRow !== undefined) {
                ownerTenantId = readOwnerTenantId(foreignMemoryOwnerRow);
                auditTenantIsolationViolation(
                  Object.freeze({
                    operation: "delete",
                    spaceId: request.spaceId,
                    memoryId: request.memoryId,
                    referenceKind: "memory",
                    referenceId: request.memoryId,
                    ownerTenantId,
                    reason: "cross_tenant_delete_probe",
                    details: "Delete request targeted memory owned by another tenant.",
                  }),
                );
              }
              throw new MissingStorageDeleteFailure(ownerTenantId);
            }
            const deletedUpdatedAtMillis =
              existingMemoryRow === undefined
                ? 0
                : toNonNegativeSafeInteger(
                    readRowColumn(existingMemoryRow, "updated_at_ms"),
                    "memory_items.updated_at_ms",
                  );
            persistAuditLedgerEntry(
              createStorageAuditLedgerEntry({
                tenantId: request.spaceId,
                memoryId: request.memoryId,
                operation: "delete",
                outcome: "accepted",
                reason: "deleted",
                details: `deleted_updated_at_ms=${deletedUpdatedAtMillis}`,
                referenceKind: null,
                referenceId: null,
                ownerTenantId: null,
                recordedAtMillis: deletedUpdatedAtMillis,
              }),
            );

            return {
              spaceId: request.spaceId,
              memoryId: request.memoryId,
              deleted: true,
            } satisfies StorageDeleteResponse;
          }),
        catch: (cause) => {
          persistDeleteFailureAuditEntry(cause, request);
          return mapDeleteFailure(cause, request);
        },
      }),
  };
};
