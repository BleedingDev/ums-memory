import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { Effect } from "effect";

import type {
  DomainRecord,
  DomainValue,
  ScopeAuthorizationInput,
  StorageDeleteRequest,
  StorageDeleteResponse,
  StorageSnapshotExportRequest,
  StorageSnapshotExportResponse,
  StorageSnapshotImportRequest,
  StorageSnapshotImportResponse,
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
  createSqliteBackupReplicator,
  type SqliteBackupReplicationOptions,
} from "./backup-replication.js";
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
import {
  applySqliteStorageSnapshotData,
  assertSqliteStorageSnapshotSchemaCompatibility,
  countSqliteStorageSnapshotRows,
  createSqliteStorageSnapshotSignature,
  exportSqliteStorageSnapshotData,
  parseSqliteStorageSnapshotPayload,
  serializeSqliteStorageSnapshotData,
  sqliteStorageSnapshotSignatureAlgorithm,
  verifySqliteStorageSnapshotSignature,
} from "./snapshot-codec.js";

const tenantCreatedAtMillis = 0;
const tenantUpdatedAtMillis = 0;

const memoryKindSet: ReadonlySet<string> = new Set(enterpriseMemoryKinds);
const memoryStatusSet: ReadonlySet<string> = new Set(enterpriseMemoryStatuses);
const evidenceSourceKindSet: ReadonlySet<string> = new Set(
  enterpriseEvidenceSourceKinds
);
const evidenceRelationKindSet: ReadonlySet<string> = new Set(
  enterpriseEvidenceRelationKinds
);
const sqliteForeignKeysModeByConnection = new WeakMap<DatabaseSync, boolean>();
const storageScopeAuthorizationGuardrailContract =
  "StorageScopeAuthorizationGuardrail";
const redactedSecretTokenCategory = "SECRET";
const redactedEmailTokenCategory = "EMAIL";
const redactedPhoneTokenCategory = "PHONE";
const redactedTokenDigestHexLength = 32;
const secretAssignmentPattern =
  /(\b(?<!REDACTED_)(?:api[_-]?key|token|password|passphrase|secret|client[_-]?secret|access[_-]?token|refresh[_-]?token|id[_-]?token|bearer)\b\s*[:=]\s*)(?:"([^"]*)"|'([^']*)'|([^\s,;'"`]+))/gi;
const normalizedSecretFieldNameSet: ReadonlySet<string> = new Set([
  "apikey",
  "token",
  "password",
  "passphrase",
  "secret",
  "clientsecret",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "bearer",
]);
const openAiApiKeyPattern = /\bsk-[A-Za-z0-9-]{8,}\b/g;
const jwtPattern =
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;
const longHexTokenPattern = /\b[A-Fa-f0-9]{32,}\b/g;
const emailAddressPattern = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const phoneLikePattern = /\+?\d[\d().\-\s]{8,}\d/g;
const alreadyRedactedTokenPattern =
  /^\[REDACTED_(?:SECRET|EMAIL|PHONE)(?::[0-9a-f]{12,64})?\]$/;
const rootPreservedPayloadFieldSet: ReadonlySet<string> = new Set([
  "scopeId",
  "scope_id",
  "evidenceEventIds",
  "evidence_event_ids",
  "evidenceEpisodeIds",
  "evidence_episode_ids",
  "createdByUserId",
  "created_by_user_id",
  "supersedesMemoryId",
  "supersedes_memory_id",
]);
const scopeControlFieldSet: ReadonlySet<string> = new Set([
  "level",
  "scopeId",
  "scope_id",
  "projectId",
  "project_id",
  "roleId",
  "role_id",
  "jobRoleId",
  "job_role_id",
  "userId",
  "user_id",
]);
const evidencePointerTraceabilityFieldSet: ReadonlySet<string> = new Set([
  "sourceKind",
  "source_kind",
  "sourceRef",
  "source_ref",
  "reference",
  "ref",
  "eventId",
  "event_id",
  "episodeId",
  "episode_id",
  "digestSha256",
  "digest_sha256",
  "digest",
  "sha256",
  "evidenceId",
  "evidence_id",
  "relationKind",
  "relation_kind",
  "observedAtMillis",
  "observed_at_ms",
  "createdAtMillis",
  "created_at_ms",
]);

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
    > =
      ownerTenantId === null ? "memory_not_found" : "cross_tenant_delete_probe";
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

class ScopeAuthorizationViolationFailure extends Error {
  readonly operation: "upsert" | "delete";

  constructor(operation: "upsert" | "delete", details: string) {
    super(details);
    this.operation = operation;
  }
}
const storageRuntimeFailureContract = "StorageRuntimeFailure";
const sqlitePayloadEncryptionContract =
  "SqliteStorageRepositoryOptions.encryptionAtRest";
const sqlitePayloadEncryptionEnvelopeFormat =
  "ums-memory/sqlite-memory-payload-encrypted/v1";
const sqlitePayloadEncryptionEnvelopeVersion = 1;
const sqlitePayloadEncryptionEnvelopeAlgorithm = "aes-256-gcm";
const sqlitePayloadEncryptionKeyLengthBytes = 32;
const sqlitePayloadEncryptionIvLengthBytes = 12;
const sqlitePayloadEncryptionAuthTagLengthBytes = 16;
const sqlitePayloadEncryptionBase64Pattern = /^[A-Za-z0-9+/]+={0,2}$/;

export interface TenantIsolationViolationAuditEvent {
  readonly operation: "upsert" | "delete";
  readonly spaceId: string;
  readonly memoryId: string;
  readonly referenceKind:
    | "scope"
    | "project"
    | "role"
    | "user"
    | "supersedes_memory"
    | "memory";
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
  readonly rawPayloadSha256: string;
  readonly legacyUnsanitizedRequestHashSha256: string;
  readonly evidencePointers: readonly EvidencePointerProjection[];
}

interface EvidencePointerProjection {
  readonly proposedEvidenceId: string;
  readonly sourceKind: EnterpriseEvidenceSourceKind;
  readonly sourceRef: string;
  readonly digestSha256: string;
  readonly payloadJson: string;
  readonly rawPayloadJson: string;
  readonly observedAtMillis: number;
  readonly createdAtMillis: number;
  readonly relationKind: EnterpriseEvidenceRelationKind;
}

type StorageIdempotencyOperation = "upsert" | "delete";

interface StorageIdempotencyLedgerProjection {
  readonly requestHashSha256: string;
  readonly responseJson: string;
}

export interface SqliteStorageRepositoryOptions {
  readonly applyMigrations?: boolean;
  readonly enforceForeignKeys?: boolean;
  readonly wal?: SqliteStorageRepositoryWalOptions;
  readonly encryptionAtRest?: SqliteStorageRepositoryEncryptionAtRestOptions;
  readonly backupReplication?: SqliteBackupReplicationOptions;
  readonly onTenantIsolationViolation?: (
    event: TenantIsolationViolationAuditEvent
  ) => void;
}

export interface SqliteStorageRepositoryWalOptions {
  readonly enabled?: boolean;
}

export interface SqliteStorageRepositoryEncryptionAtRestOptions {
  readonly enabled?: boolean;
  readonly activeKeyId?: string;
  readonly keyRing?: Readonly<Record<string, string>>;
}

export interface SqliteStorageRepository {
  readonly upsertMemory: (
    request: StorageUpsertRequest
  ) => Effect.Effect<StorageUpsertResponse, StorageServiceError>;
  readonly deleteMemory: (
    request: StorageDeleteRequest
  ) => Effect.Effect<StorageDeleteResponse, StorageServiceError>;
  readonly exportSnapshot: (
    request: StorageSnapshotExportRequest
  ) => Effect.Effect<StorageSnapshotExportResponse, StorageServiceError>;
  readonly importSnapshot: (
    request: StorageSnapshotImportRequest
  ) => Effect.Effect<StorageSnapshotImportResponse, StorageServiceError>;
}

interface SqlitePayloadEncryptionConfig {
  readonly enabled: boolean;
  readonly activeKeyId: string | null;
  readonly activeKey: Buffer | null;
  readonly keyRing: ReadonlyMap<string, Buffer>;
}

interface SqlitePayloadEncryptionEnvelope {
  readonly format: string;
  readonly version: number;
  readonly algorithm: string;
  readonly keyId: string;
  readonly ivBase64: string;
  readonly authTagBase64: string;
  readonly ciphertextBase64: string;
}

const withImmediateTransaction = <Value>(
  database: DatabaseSync,
  execute: () => Value
): Value => {
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
      throw new RangeError(
        `${label} must be a non-negative safe integer. Received: ${value}.`
      );
    }
    return value;
  }

  if (typeof value === "bigint") {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new RangeError(
        `${label} must be a non-negative safe integer. Received: ${value}.`
      );
    }
    return Number(value);
  }

  throw new TypeError(`${label} must be a numeric SQLite integer value.`);
};

const readRecordValue = (
  payload: DomainRecord,
  keys: readonly string[]
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
    throw new StoragePayloadValidationFailure(
      `${label} must be a non-empty string.`
    );
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new StoragePayloadValidationFailure(
      `${label} must be a non-empty string.`
    );
  }

  return trimmed;
};

const expectNonNegativeSafeInteger = (
  value: DomainValue,
  label: string
): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new StoragePayloadValidationFailure(
      `${label} must be a non-negative safe integer number.`
    );
  }

  return value;
};

const parseOptionalTrimmedString = (
  payload: DomainRecord,
  keys: readonly string[],
  label: string
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
  label: string
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
  label: string
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
  label: string
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
  label: string
): Value | undefined => {
  const value = readRecordValue(payload, keys);
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string" || !allowedValues.has(value)) {
    throw new StoragePayloadValidationFailure(
      `${label} must be one of: ${[...allowedValues].join(", ")}.`
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
  label: string
): readonly string[] | undefined => {
  const value = readRecordValue(payload, keys);
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new StoragePayloadValidationFailure(
      `${label} must be an array of non-empty strings.`
    );
  }

  const normalized = value.map((entry, index) => {
    if (typeof entry !== "string") {
      throw new StoragePayloadValidationFailure(
        `${label}[${index}] must be a non-empty string value.`
      );
    }
    const trimmed = entry.trim();
    if (trimmed.length === 0) {
      throw new StoragePayloadValidationFailure(
        `${label}[${index}] must be a non-empty string value.`
      );
    }
    return trimmed;
  });

  return Object.freeze(
    [...new Set(normalized)].sort((left, right) =>
      compareStringsAscending(left, right)
    )
  );
};

const toSha256Hex = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const toDeterministicAuditEventId = (
  event: Omit<StorageAuditLedgerEntry, "eventId">
): string => {
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
    ].join("\n")
  )}`;
};

const createStorageAuditLedgerEntry = (
  event: Omit<StorageAuditLedgerEntry, "eventId">
): StorageAuditLedgerEntry =>
  Object.freeze({
    eventId: toDeterministicAuditEventId(event),
    ...event,
  });

const toCanonicalJsonString = (value: DomainValue, path: string): string =>
  JSON.stringify(normalizeDomainValue(value, path));

const readPayloadMetadataRecord = (
  payload: DomainRecord
): DomainRecord | undefined => {
  const metadataValue = readRecordValue(payload, ["metadata"]);
  if (metadataValue === undefined) {
    return undefined;
  }

  return isDomainRecord(metadataValue) ? metadataValue : undefined;
};

const readPayloadProvenanceValue = (
  payload: DomainRecord
): DomainValue | undefined => {
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
      "payload.provenance must be a plain object record when provided."
    );
  }

  return toCanonicalJsonString(provenanceValue, "payload.provenance");
};

const readPayloadEvidencePointersValue = (
  payload: DomainRecord
): DomainValue | undefined => {
  const rootValue = readRecordValue(payload, [
    "evidencePointers",
    "evidence_pointers",
  ]);
  if (rootValue !== undefined) {
    return rootValue;
  }

  const metadataRecord = readPayloadMetadataRecord(payload);
  if (metadataRecord === undefined) {
    return undefined;
  }

  return readRecordValue(metadataRecord, [
    "evidencePointers",
    "evidence_pointers",
  ]);
};

const createEvidencePointerFromReferenceId = (
  sourceId: string,
  relationKind: EnterpriseEvidenceRelationKind,
  observedAtMillis: number,
  createdAtMillis: number
): EvidencePointerProjection => {
  const sourceKind: EnterpriseEvidenceSourceKind = "event";
  const sourceRef = `event://${sourceId}`;
  const payloadJson = "{}";
  const rawPayloadJson = payloadJson;
  const digestSha256 = toSha256Hex(
    `${sourceKind}\n${sourceRef}\n${payloadJson}`
  );
  const proposedEvidenceId = `evidence:${toSha256Hex(`${sourceKind}\n${sourceRef}\n${digestSha256}`)}`;

  return Object.freeze({
    proposedEvidenceId,
    sourceKind,
    sourceRef,
    digestSha256,
    payloadJson,
    rawPayloadJson,
    observedAtMillis,
    createdAtMillis,
    relationKind,
  });
};

const parseEvidencePointerRecord = (
  rawPointerRecord: DomainRecord,
  sanitizedPointerRecord: DomainRecord,
  label: string,
  fallbackObservedAtMillis: number,
  fallbackCreatedAtMillis: number
): EvidencePointerProjection => {
  const eventOrEpisodeId =
    parseOptionalTrimmedString(
      rawPointerRecord,
      ["eventId", "event_id", "episodeId", "episode_id"],
      `${label}.eventId`
    ) ?? null;
  const sourceRefCandidate =
    parseOptionalTrimmedString(
      rawPointerRecord,
      ["sourceRef", "source_ref", "reference", "ref"],
      `${label}.sourceRef`
    ) ?? null;
  const sourceRef =
    sourceRefCandidate ??
    (eventOrEpisodeId === null ? null : `event://${eventOrEpisodeId}`);
  if (sourceRef === null) {
    throw new StoragePayloadValidationFailure(
      `${label} must define sourceRef or eventId/episodeId.`
    );
  }

  const sourceKind =
    parseOptionalEnum<EnterpriseEvidenceSourceKind>(
      rawPointerRecord,
      ["sourceKind", "source_kind"],
      evidenceSourceKindSet,
      `${label}.sourceKind`
    ) ?? "event";
  const relationKind =
    parseOptionalEnum<EnterpriseEvidenceRelationKind>(
      rawPointerRecord,
      ["relationKind", "relation_kind"],
      evidenceRelationKindSet,
      `${label}.relationKind`
    ) ?? "supports";

  const rawEvidencePayloadValue = readRecordValue(rawPointerRecord, [
    "payload",
    "payload_json",
    "metadata",
  ]);
  const sanitizedEvidencePayloadValue = readRecordValue(
    sanitizedPointerRecord,
    ["payload", "payload_json", "metadata"]
  );
  const payloadJson =
    sanitizedEvidencePayloadValue === undefined
      ? "{}"
      : toCanonicalJsonString(
          sanitizedEvidencePayloadValue,
          `${label}.payload`
        );
  const rawPayloadJson =
    rawEvidencePayloadValue === undefined
      ? "{}"
      : toCanonicalJsonString(rawEvidencePayloadValue, `${label}.payload`);

  const rawDigest =
    parseOptionalTrimmedString(
      rawPointerRecord,
      ["digestSha256", "digest_sha256", "digest", "sha256"],
      `${label}.digestSha256`
    ) ?? null;
  const digestSha256 =
    rawDigest === null
      ? toSha256Hex(`${sourceKind}\n${sourceRef}\n${rawPayloadJson}`)
      : rawDigest.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(digestSha256)) {
    throw new StoragePayloadValidationFailure(
      `${label}.digestSha256 must be a 64-character hexadecimal sha256 digest.`
    );
  }

  const observedAtMillis =
    parseOptionalNonNegativeSafeInteger(
      rawPointerRecord,
      [
        "observedAtMillis",
        "observed_at_ms",
        "occurredAtMillis",
        "occurred_at_ms",
      ],
      `${label}.observedAtMillis`
    ) ?? fallbackObservedAtMillis;
  const createdAtMillisInput = parseOptionalNonNegativeSafeInteger(
    rawPointerRecord,
    ["createdAtMillis", "created_at_ms"],
    `${label}.createdAtMillis`
  );
  const createdAtMillis = Math.max(
    createdAtMillisInput ?? fallbackCreatedAtMillis,
    observedAtMillis
  );

  const proposedEvidenceId =
    parseOptionalTrimmedString(
      rawPointerRecord,
      ["evidenceId", "evidence_id"],
      `${label}.evidenceId`
    ) ??
    `evidence:${toSha256Hex(`${sourceKind}\n${sourceRef}\n${digestSha256}`)}`;

  return Object.freeze({
    proposedEvidenceId,
    sourceKind,
    sourceRef,
    digestSha256,
    payloadJson,
    rawPayloadJson,
    observedAtMillis,
    createdAtMillis,
    relationKind,
  });
};

const compareEvidencePointers = (
  left: EvidencePointerProjection,
  right: EvidencePointerProjection
): number => {
  const bySourceKind = compareStringsAscending(
    left.sourceKind,
    right.sourceKind
  );
  if (bySourceKind !== 0) {
    return bySourceKind;
  }
  const bySourceRef = compareStringsAscending(left.sourceRef, right.sourceRef);
  if (bySourceRef !== 0) {
    return bySourceRef;
  }
  const byDigest = compareStringsAscending(
    left.digestSha256,
    right.digestSha256
  );
  if (byDigest !== 0) {
    return byDigest;
  }
  const byRelation = compareStringsAscending(
    left.relationKind,
    right.relationKind
  );
  if (byRelation !== 0) {
    return byRelation;
  }
  const byEvidenceId = compareStringsAscending(
    left.proposedEvidenceId,
    right.proposedEvidenceId
  );
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

const withNormalizedEvidenceDigestField = (
  pointerRecord: DomainRecord,
  digestSha256: string
): DomainRecord => {
  const existingDigestValue = readRecordValue(pointerRecord, [
    "digestSha256",
    "digest_sha256",
    "digest",
    "sha256",
  ]);
  if (
    typeof existingDigestValue === "string" &&
    existingDigestValue.length > 0
  ) {
    return pointerRecord;
  }

  return Object.freeze({
    ...pointerRecord,
    digestSha256,
  }) as DomainRecord;
};

const parseEvidencePointerProjections = (
  rawPayload: DomainRecord,
  sanitizedPayload: DomainRecord,
  fallbackObservedAtMillis: number,
  fallbackCreatedAtMillis: number
): readonly EvidencePointerProjection[] => {
  const explicitPointersValue = readPayloadEvidencePointersValue(rawPayload);
  const sanitizedExplicitPointersValue =
    readPayloadEvidencePointersValue(sanitizedPayload);
  const pointers: EvidencePointerProjection[] = [];

  if (explicitPointersValue !== undefined) {
    if (!Array.isArray(explicitPointersValue)) {
      throw new StoragePayloadValidationFailure(
        "payload.evidencePointers must be an array of evidence pointer objects."
      );
    }
    if (!Array.isArray(sanitizedExplicitPointersValue)) {
      throw new StoragePayloadValidationFailure(
        "payload.evidencePointers sanitization must preserve array structure."
      );
    }
    if (
      sanitizedExplicitPointersValue.length !== explicitPointersValue.length
    ) {
      throw new StoragePayloadValidationFailure(
        "payload.evidencePointers sanitization must preserve pointer count."
      );
    }
    for (const [index, pointerValue] of explicitPointersValue.entries()) {
      if (!isDomainRecord(pointerValue)) {
        throw new StoragePayloadValidationFailure(
          `payload.evidencePointers[${index}] must be a plain object record.`
        );
      }
      const sanitizedPointerValue = sanitizedExplicitPointersValue[index];
      if (!isDomainRecord(sanitizedPointerValue)) {
        throw new StoragePayloadValidationFailure(
          `payload.evidencePointers[${index}] sanitization must preserve pointer object shape.`
        );
      }
      const parsedPointer = parseEvidencePointerRecord(
        pointerValue,
        sanitizedPointerValue,
        `payload.evidencePointers[${index}]`,
        fallbackObservedAtMillis,
        fallbackCreatedAtMillis
      );
      sanitizedExplicitPointersValue[index] = withNormalizedEvidenceDigestField(
        sanitizedPointerValue,
        parsedPointer.digestSha256
      );
      pointers.push(parsedPointer);
    }
  }

  const evidenceEventIds =
    parseOptionalTrimmedStringArray(
      rawPayload,
      ["evidenceEventIds", "evidence_event_ids"],
      "payload.evidenceEventIds"
    ) ?? [];
  const evidenceEpisodeIds =
    parseOptionalTrimmedStringArray(
      rawPayload,
      ["evidenceEpisodeIds", "evidence_episode_ids"],
      "payload.evidenceEpisodeIds"
    ) ?? [];
  const allSourceIds = [
    ...new Set([...evidenceEventIds, ...evidenceEpisodeIds]),
  ].sort((left, right) => compareStringsAscending(left, right));
  for (const sourceId of allSourceIds) {
    pointers.push(
      createEvidencePointerFromReferenceId(
        sourceId,
        "supports",
        fallbackObservedAtMillis,
        fallbackCreatedAtMillis
      )
    );
  }

  const sortedPointers = [...pointers].sort((left, right) =>
    compareEvidencePointers(left, right)
  );
  const deduplicatedPointers: EvidencePointerProjection[] = [];
  const relationKindByNaturalKey = new Map<
    string,
    EnterpriseEvidenceRelationKind
  >();
  for (const pointer of sortedPointers) {
    const naturalKey = `${pointer.sourceKind}\u0000${pointer.sourceRef}\u0000${pointer.digestSha256}`;
    const existingRelationKind = relationKindByNaturalKey.get(naturalKey);
    if (existingRelationKind !== undefined) {
      if (existingRelationKind !== pointer.relationKind) {
        throw new StoragePayloadValidationFailure(
          "Each evidence pointer must use a single relationKind per deterministic evidence key."
        );
      }
      continue;
    }
    relationKindByNaturalKey.set(naturalKey, pointer.relationKind);
    deduplicatedPointers.push(pointer);
  }

  return Object.freeze(deduplicatedPointers);
};

const readPersistedProvenanceJsonFromPayloadJson = (
  payloadJson: string,
  payloadEncryptionConfig: SqlitePayloadEncryptionConfig
): string | null => {
  const plaintextPayloadJson = decryptPersistedMemoryPayloadJson(
    payloadJson,
    payloadEncryptionConfig
  );
  let parsedPayload: unknown;
  try {
    parsedPayload = JSON.parse(plaintextPayloadJson);
  } catch (cause) {
    const details = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `Persisted memory payload_json is not valid JSON: ${details}`
    );
  }
  if (!isDomainRecord(parsedPayload)) {
    return null;
  }

  const sanitizedPayload = sanitizePayloadForPersistence(parsedPayload);
  const provenanceValue = readPayloadProvenanceValue(sanitizedPayload);
  if (provenanceValue === undefined || provenanceValue === null) {
    return null;
  }

  return toCanonicalJsonString(provenanceValue, "persistedPayload.provenance");
};

const toSqlitePayloadEncryptionContractError = (
  contractSuffix: string,
  message: string,
  details: string
): ContractValidationError =>
  new ContractValidationError({
    contract: `${sqlitePayloadEncryptionContract}${contractSuffix}`,
    message,
    details,
  });

const toDisabledSqlitePayloadEncryptionConfig =
  (): SqlitePayloadEncryptionConfig =>
    Object.freeze({
      enabled: false,
      activeKeyId: null,
      activeKey: null,
      keyRing: new Map<string, Buffer>(),
    });

const decodeBase64PayloadEncryptionValue = (
  encodedValue: string,
  label: string,
  contractSuffix: string
): Buffer => {
  const trimmedValue = encodedValue.trim();
  if (trimmedValue.length === 0) {
    throw toSqlitePayloadEncryptionContractError(
      contractSuffix,
      "Encryption-at-rest base64 payload segments must be non-empty.",
      `${label} must be a non-empty base64 string.`
    );
  }
  if (
    trimmedValue.length % 4 !== 0 ||
    !sqlitePayloadEncryptionBase64Pattern.test(trimmedValue)
  ) {
    throw toSqlitePayloadEncryptionContractError(
      contractSuffix,
      "Encryption-at-rest base64 payload segments must be canonical.",
      `${label} must contain canonical base64 characters with standard padding.`
    );
  }
  const decoded = Buffer.from(trimmedValue, "base64");
  if (decoded.toString("base64") !== trimmedValue) {
    throw toSqlitePayloadEncryptionContractError(
      contractSuffix,
      "Encryption-at-rest base64 payload segments must be canonical.",
      `${label} must be canonical base64 data.`
    );
  }

  return decoded;
};

const normalizeSqlitePayloadEncryptionKeyId = (
  keyId: unknown,
  contractSuffix: string
): string => {
  if (typeof keyId !== "string") {
    throw toSqlitePayloadEncryptionContractError(
      contractSuffix,
      "Encryption-at-rest key ids must be non-empty strings.",
      "activeKeyId must be provided as a string."
    );
  }
  const normalizedKeyId = keyId.trim();
  if (normalizedKeyId.length === 0) {
    throw toSqlitePayloadEncryptionContractError(
      contractSuffix,
      "Encryption-at-rest key ids must be non-empty strings.",
      "activeKeyId must be a non-empty string."
    );
  }

  return normalizedKeyId;
};

const decodeSqlitePayloadEncryptionKeyMaterial = (
  keyMaterial: unknown,
  keyId: string
): Buffer => {
  if (typeof keyMaterial !== "string") {
    throw toSqlitePayloadEncryptionContractError(
      ".keyRing",
      "Encryption-at-rest key ring entries must be non-empty base64 strings.",
      `keyRing["${keyId}"] must be a string containing base64 key material.`
    );
  }
  const decodedKey = decodeBase64PayloadEncryptionValue(
    keyMaterial,
    `keyRing["${keyId}"]`,
    ".keyRing"
  );
  if (decodedKey.length !== sqlitePayloadEncryptionKeyLengthBytes) {
    throw toSqlitePayloadEncryptionContractError(
      ".keyRing",
      "Encryption-at-rest key ring entries must decode to 256-bit keys.",
      `keyRing["${keyId}"] must decode to exactly ${sqlitePayloadEncryptionKeyLengthBytes} bytes.`
    );
  }

  return decodedKey;
};

const resolveSqlitePayloadEncryptionConfig = (
  options: SqliteStorageRepositoryOptions
): SqlitePayloadEncryptionConfig => {
  const encryptionOptions = options.encryptionAtRest;
  if (encryptionOptions === undefined) {
    return toDisabledSqlitePayloadEncryptionConfig();
  }
  if (
    typeof encryptionOptions !== "object" ||
    encryptionOptions === null ||
    Array.isArray(encryptionOptions) ||
    !isPlainRecordObject(encryptionOptions)
  ) {
    throw toSqlitePayloadEncryptionContractError(
      "",
      "Encryption-at-rest options must be a plain object.",
      "encryptionAtRest must be a plain object when provided."
    );
  }

  const enabled = encryptionOptions.enabled ?? false;
  if (typeof enabled !== "boolean") {
    throw toSqlitePayloadEncryptionContractError(
      ".enabled",
      "Encryption-at-rest enabled flag must be boolean when provided.",
      `Expected boolean enabled value but received ${String(encryptionOptions.enabled)}.`
    );
  }
  if (!enabled) {
    if (
      encryptionOptions.activeKeyId !== undefined ||
      encryptionOptions.keyRing !== undefined
    ) {
      throw toSqlitePayloadEncryptionContractError(
        ".enabled",
        "Encryption-at-rest key material is only valid when encryption is enabled.",
        "Set encryptionAtRest.enabled to true before providing activeKeyId or keyRing."
      );
    }
    return toDisabledSqlitePayloadEncryptionConfig();
  }

  const activeKeyId = normalizeSqlitePayloadEncryptionKeyId(
    encryptionOptions.activeKeyId,
    ".activeKeyId"
  );
  const keyRingRecord = encryptionOptions.keyRing;
  if (
    typeof keyRingRecord !== "object" ||
    keyRingRecord === null ||
    Array.isArray(keyRingRecord) ||
    !isPlainRecordObject(keyRingRecord)
  ) {
    throw toSqlitePayloadEncryptionContractError(
      ".keyRing",
      "Encryption-at-rest keyRing must be a plain object when encryption is enabled.",
      "keyRing must map key ids to base64 encoded 256-bit keys."
    );
  }
  const keyRingEntries = Object.entries(keyRingRecord);
  if (keyRingEntries.length === 0) {
    throw toSqlitePayloadEncryptionContractError(
      ".keyRing",
      "Encryption-at-rest keyRing must include at least one key.",
      "keyRing cannot be empty when encryption is enabled."
    );
  }

  const decodedKeyRing = new Map<string, Buffer>();
  for (const [keyIdCandidate, rawKeyMaterial] of keyRingEntries) {
    const normalizedKeyId = keyIdCandidate.trim();
    if (normalizedKeyId.length === 0) {
      throw toSqlitePayloadEncryptionContractError(
        ".keyRing",
        "Encryption-at-rest key ids must be non-empty strings.",
        "keyRing must not include blank key ids."
      );
    }
    if (decodedKeyRing.has(normalizedKeyId)) {
      throw toSqlitePayloadEncryptionContractError(
        ".keyRing",
        "Encryption-at-rest key ids must be unique after normalization.",
        `keyRing contains duplicate key ids after trimming: "${normalizedKeyId}".`
      );
    }
    decodedKeyRing.set(
      normalizedKeyId,
      decodeSqlitePayloadEncryptionKeyMaterial(rawKeyMaterial, normalizedKeyId)
    );
  }

  const activeKey = decodedKeyRing.get(activeKeyId);
  if (activeKey === undefined) {
    throw toSqlitePayloadEncryptionContractError(
      ".activeKeyId",
      "Encryption-at-rest activeKeyId must reference a keyRing entry.",
      `activeKeyId "${activeKeyId}" was not found in encryptionAtRest.keyRing.`
    );
  }

  return Object.freeze({
    enabled: true,
    activeKeyId,
    activeKey,
    keyRing: decodedKeyRing,
  });
};

const parsePersistedMemoryPayloadEncryptionEnvelope = (
  parsedPayload: unknown
): SqlitePayloadEncryptionEnvelope | null => {
  if (
    typeof parsedPayload !== "object" ||
    parsedPayload === null ||
    Array.isArray(parsedPayload) ||
    !isPlainRecordObject(parsedPayload)
  ) {
    return null;
  }
  const envelope = parsedPayload as Record<string, unknown>;
  if (envelope["format"] !== sqlitePayloadEncryptionEnvelopeFormat) {
    return null;
  }

  const version = envelope["version"];
  const algorithm = envelope["algorithm"];
  const keyId = envelope["keyId"];
  const ivBase64 = envelope["ivBase64"];
  const authTagBase64 = envelope["authTagBase64"];
  const ciphertextBase64 = envelope["ciphertextBase64"];

  if (version !== sqlitePayloadEncryptionEnvelopeVersion) {
    throw new Error(
      `Persisted encrypted memory payload_json version ${String(version)} is unsupported.`
    );
  }
  if (algorithm !== sqlitePayloadEncryptionEnvelopeAlgorithm) {
    throw new Error(
      `Persisted encrypted memory payload_json algorithm ${String(algorithm)} is unsupported.`
    );
  }
  if (typeof keyId !== "string" || keyId.trim().length === 0) {
    throw new Error(
      "Persisted encrypted memory payload_json keyId is invalid."
    );
  }
  if (typeof ivBase64 !== "string" || ivBase64.trim().length === 0) {
    throw new Error(
      "Persisted encrypted memory payload_json ivBase64 is invalid."
    );
  }
  if (typeof authTagBase64 !== "string" || authTagBase64.trim().length === 0) {
    throw new Error(
      "Persisted encrypted memory payload_json authTagBase64 is invalid."
    );
  }
  if (
    typeof ciphertextBase64 !== "string" ||
    ciphertextBase64.trim().length === 0
  ) {
    throw new Error(
      "Persisted encrypted memory payload_json ciphertextBase64 is invalid."
    );
  }

  return Object.freeze({
    format: sqlitePayloadEncryptionEnvelopeFormat,
    version: sqlitePayloadEncryptionEnvelopeVersion,
    algorithm: sqlitePayloadEncryptionEnvelopeAlgorithm,
    keyId: keyId.trim(),
    ivBase64: ivBase64.trim(),
    authTagBase64: authTagBase64.trim(),
    ciphertextBase64: ciphertextBase64.trim(),
  });
};

const toStoredMemoryPayloadJson = (
  payloadJson: string,
  payloadEncryptionConfig: SqlitePayloadEncryptionConfig
): string => {
  if (!payloadEncryptionConfig.enabled) {
    return payloadJson;
  }
  if (
    payloadEncryptionConfig.activeKeyId === null ||
    payloadEncryptionConfig.activeKey === null
  ) {
    throw toSqlitePayloadEncryptionContractError(
      ".activeKeyId",
      "Encryption-at-rest active key is unavailable for payload writes.",
      "activeKeyId and keyRing must resolve to a usable 256-bit key when encryption is enabled."
    );
  }

  const initializationVector = randomBytes(
    sqlitePayloadEncryptionIvLengthBytes
  );
  const cipher = createCipheriv(
    sqlitePayloadEncryptionEnvelopeAlgorithm,
    payloadEncryptionConfig.activeKey,
    initializationVector
  );
  const ciphertext = Buffer.concat([
    cipher.update(payloadJson, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return JSON.stringify({
    format: sqlitePayloadEncryptionEnvelopeFormat,
    version: sqlitePayloadEncryptionEnvelopeVersion,
    algorithm: sqlitePayloadEncryptionEnvelopeAlgorithm,
    keyId: payloadEncryptionConfig.activeKeyId,
    ivBase64: initializationVector.toString("base64"),
    authTagBase64: authTag.toString("base64"),
    ciphertextBase64: ciphertext.toString("base64"),
  } satisfies SqlitePayloadEncryptionEnvelope);
};

const decryptPersistedMemoryPayloadJson = (
  payloadJson: string,
  payloadEncryptionConfig: SqlitePayloadEncryptionConfig
): string => {
  let parsedPayload: unknown;
  try {
    parsedPayload = JSON.parse(payloadJson);
  } catch (cause) {
    const details = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `Persisted memory payload_json is not valid JSON: ${details}`
    );
  }

  const encryptedEnvelope =
    parsePersistedMemoryPayloadEncryptionEnvelope(parsedPayload);
  if (encryptedEnvelope === null) {
    return payloadJson;
  }
  if (!payloadEncryptionConfig.enabled) {
    throw toSqlitePayloadEncryptionContractError(
      ".enabled",
      "Encrypted payload_json encountered while encryption-at-rest is disabled.",
      "Enable encryptionAtRest with the keyRing that can decrypt persisted rows."
    );
  }

  const decryptionKey = payloadEncryptionConfig.keyRing.get(
    encryptedEnvelope.keyId
  );
  if (decryptionKey === undefined) {
    throw toSqlitePayloadEncryptionContractError(
      ".keyRing",
      "Encryption-at-rest keyRing is missing key material for persisted payload_json.",
      `No decryption key was configured for keyId "${encryptedEnvelope.keyId}".`
    );
  }

  const initializationVector = decodeBase64PayloadEncryptionValue(
    encryptedEnvelope.ivBase64,
    "payload_json.ivBase64",
    ".keyRing"
  );
  if (initializationVector.length !== sqlitePayloadEncryptionIvLengthBytes) {
    throw toSqlitePayloadEncryptionContractError(
      ".keyRing",
      "Persisted encrypted payload_json IV length is invalid.",
      `payload_json.ivBase64 must decode to exactly ${sqlitePayloadEncryptionIvLengthBytes} bytes.`
    );
  }
  const authTag = decodeBase64PayloadEncryptionValue(
    encryptedEnvelope.authTagBase64,
    "payload_json.authTagBase64",
    ".keyRing"
  );
  if (authTag.length !== sqlitePayloadEncryptionAuthTagLengthBytes) {
    throw toSqlitePayloadEncryptionContractError(
      ".keyRing",
      "Persisted encrypted payload_json authentication tag length is invalid.",
      `payload_json.authTagBase64 must decode to exactly ${sqlitePayloadEncryptionAuthTagLengthBytes} bytes.`
    );
  }
  const ciphertext = decodeBase64PayloadEncryptionValue(
    encryptedEnvelope.ciphertextBase64,
    "payload_json.ciphertextBase64",
    ".keyRing"
  );

  try {
    const decipher = createDecipheriv(
      sqlitePayloadEncryptionEnvelopeAlgorithm,
      decryptionKey,
      initializationVector
    );
    decipher.setAuthTag(authTag);
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
  } catch (cause) {
    throw toSqlitePayloadEncryptionContractError(
      ".keyRing",
      "Unable to decrypt persisted encrypted payload_json with configured keyRing.",
      `Decrypt failed for keyId "${encryptedEnvelope.keyId}": ${toErrorMessage(cause)}`
    );
  }
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

  const foreignKeysValue = (foreignKeysRow as Record<string, unknown>)[
    "foreign_keys"
  ];
  const normalizedForeignKeysValue = toNonNegativeSafeInteger(
    foreignKeysValue,
    "PRAGMA foreign_keys"
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

const readSqliteJournalMode = (database: DatabaseSync): string => {
  const journalModeRow = database.prepare("PRAGMA journal_mode;").get();
  if (typeof journalModeRow !== "object" || journalModeRow === null) {
    throw new ContractValidationError({
      contract: "SqliteStorageRepositoryOptions.wal.enabled",
      message: "SQLite did not return PRAGMA journal_mode state.",
      details: "PRAGMA journal_mode query returned a non-object row.",
    });
  }

  const journalModeValue = (journalModeRow as Record<string, unknown>)[
    "journal_mode"
  ];
  if (typeof journalModeValue !== "string") {
    throw new ContractValidationError({
      contract: "SqliteStorageRepositoryOptions.wal.enabled",
      message: "SQLite returned an invalid PRAGMA journal_mode value.",
      details: `Expected string journal_mode value but received ${String(journalModeValue)}.`,
    });
  }

  return journalModeValue.trim().toLowerCase();
};

const configureSqliteForeignKeys = (
  database: DatabaseSync,
  enforceForeignKeys: boolean
): void => {
  const existingMode = sqliteForeignKeysModeByConnection.get(database);
  if (existingMode !== undefined) {
    if (existingMode !== enforceForeignKeys) {
      throw new ContractValidationError({
        contract: "SqliteStorageRepositoryOptions.enforceForeignKeys",
        message:
          "SQLite foreign_keys mode is immutable per DatabaseSync connection.",
        details: `Connection already bootstrapped with foreign_keys=${
          existingMode ? "ON" : "OFF"
        }; requested ${enforceForeignKeys ? "ON" : "OFF"}. Use a separate DatabaseSync instance.`,
      });
    }
  }

  let effectiveForeignKeysMode = readSqliteForeignKeysMode(database);
  if (effectiveForeignKeysMode !== enforceForeignKeys) {
    database.exec(
      `PRAGMA foreign_keys = ${enforceForeignKeys ? "ON" : "OFF"};`
    );
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

const configureSqliteWalMode = (
  database: DatabaseSync,
  walEnabled: boolean
): void => {
  if (!walEnabled) {
    return;
  }

  let effectiveJournalMode = readSqliteJournalMode(database);
  if (effectiveJournalMode !== "wal") {
    database.exec("PRAGMA journal_mode = WAL;");
    effectiveJournalMode = readSqliteJournalMode(database);
  }

  if (effectiveJournalMode !== "wal") {
    throw new ContractValidationError({
      contract: "SqliteStorageRepositoryOptions.wal.enabled",
      message: "SQLite WAL mode could not be applied.",
      details: `Requested journal_mode=WAL but SQLite reports journal_mode=${effectiveJournalMode}.`,
    });
  }
};

const isPlainRecordObject = (value: object): boolean => {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const isLikelyPhoneNumber = (candidate: string): boolean => {
  const digitCount = candidate.replace(/\D/g, "").length;
  if (digitCount < 10 || digitCount > 15) {
    return false;
  }

  return /[()\-\s]/.test(candidate) || candidate.trim().startsWith("+");
};

const toRedactedToken = (
  category:
    | typeof redactedSecretTokenCategory
    | typeof redactedEmailTokenCategory
    | typeof redactedPhoneTokenCategory,
  rawValue: string
): string => {
  const tokenDigest = toSha256Hex(rawValue).slice(
    0,
    redactedTokenDigestHexLength
  );
  return `[REDACTED_${category}:${tokenDigest}]`;
};

const isAlreadyRedactedToken = (candidate: string): boolean =>
  alreadyRedactedTokenPattern.test(candidate);

const isInsideRedactedToken = (
  source: string,
  matchOffset: number,
  matchLength: number
): boolean => {
  const redactedTokenStart = source.lastIndexOf("[REDACTED_", matchOffset);
  if (redactedTokenStart === -1) {
    return false;
  }
  const redactedTokenEnd = source.indexOf("]", redactedTokenStart);
  if (redactedTokenEnd === -1) {
    return false;
  }

  return (
    matchOffset >= redactedTokenStart &&
    matchOffset + matchLength <= redactedTokenEnd + 1
  );
};

const redactSensitiveString = (value: string): string => {
  let redacted = value;
  redacted = redacted.replace(
    secretAssignmentPattern,
    (
      _match,
      prefix: string,
      doubleQuotedValue: string | undefined,
      singleQuotedValue: string | undefined,
      unquotedValue: string | undefined
    ) => {
      const secretValue =
        doubleQuotedValue ?? singleQuotedValue ?? unquotedValue ?? "";
      const normalizedSecretValue = isAlreadyRedactedToken(secretValue)
        ? secretValue
        : toRedactedToken(redactedSecretTokenCategory, secretValue);
      if (doubleQuotedValue !== undefined) {
        return `${prefix}"${normalizedSecretValue}"`;
      }
      if (singleQuotedValue !== undefined) {
        return `${prefix}'${normalizedSecretValue}'`;
      }
      return `${prefix}${normalizedSecretValue}`;
    }
  );
  redacted = redacted.replace(
    openAiApiKeyPattern,
    (candidate, offset, source) =>
      isInsideRedactedToken(source, offset, candidate.length)
        ? candidate
        : toRedactedToken(redactedSecretTokenCategory, candidate)
  );
  redacted = redacted.replace(jwtPattern, (candidate, offset, source) =>
    isInsideRedactedToken(source, offset, candidate.length)
      ? candidate
      : toRedactedToken(redactedSecretTokenCategory, candidate)
  );
  redacted = redacted.replace(
    longHexTokenPattern,
    (candidate, offset, source) =>
      isInsideRedactedToken(source, offset, candidate.length)
        ? candidate
        : toRedactedToken(redactedSecretTokenCategory, candidate)
  );
  redacted = redacted.replace(
    emailAddressPattern,
    (candidate, offset, source) =>
      isInsideRedactedToken(source, offset, candidate.length)
        ? candidate
        : toRedactedToken(redactedEmailTokenCategory, candidate)
  );
  redacted = redacted.replace(phoneLikePattern, (candidate, offset, source) =>
    isLikelyPhoneNumber(candidate) &&
    !isInsideRedactedToken(source, offset, candidate.length)
      ? toRedactedToken(redactedPhoneTokenCategory, candidate)
      : candidate
  );

  return redacted;
};

const toFieldNameSegments = (fieldName: string): readonly string[] =>
  fieldName
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.toLowerCase());

const isSecretLikeFieldName = (fieldName: string): boolean => {
  const segments = toFieldNameSegments(fieldName);
  if (segments.length === 0) {
    return false;
  }
  if (segments.length === 1) {
    const [onlySegment] = segments;
    return (
      onlySegment !== undefined && normalizedSecretFieldNameSet.has(onlySegment)
    );
  }

  return normalizedSecretFieldNameSet.has(segments.join(""));
};

const isEvidencePointerCollectionPathSegment = (
  value: string | number | undefined
): boolean => value === "evidencePointers" || value === "evidence_pointers";

const shouldPreserveRootPayloadField = (
  path: readonly (string | number)[],
  key: string
): boolean => path.length === 0 && rootPreservedPayloadFieldSet.has(key);

const shouldPreserveScopeControlField = (
  path: readonly (string | number)[],
  key: string
): boolean =>
  path.length === 1 && path[0] === "scope" && scopeControlFieldSet.has(key);

const shouldPreserveDirectEvidencePointerTraceabilityField = (
  path: readonly (string | number)[],
  key: string
): boolean => {
  if (!evidencePointerTraceabilityFieldSet.has(key)) {
    return false;
  }
  if (path.length === 2) {
    const collectionKey = path[0];
    const index = path[1];
    return (
      isEvidencePointerCollectionPathSegment(collectionKey) &&
      typeof index === "number"
    );
  }
  if (path.length === 3) {
    const rootKey = path[0];
    const collectionKey = path[1];
    const index = path[2];
    return (
      rootKey === "metadata" &&
      isEvidencePointerCollectionPathSegment(collectionKey) &&
      typeof index === "number"
    );
  }

  return false;
};

const shouldPreservePayloadField = (
  path: readonly (string | number)[],
  key: string
): boolean =>
  shouldPreserveRootPayloadField(path, key) ||
  shouldPreserveScopeControlField(path, key) ||
  shouldPreserveDirectEvidencePointerTraceabilityField(path, key);

const sanitizePayloadDomainValue = (
  value: DomainValue,
  path: readonly (string | number)[]
): DomainValue => {
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "string") {
    return redactSensitiveString(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      sanitizePayloadDomainValue(entry, [...path, index])
    );
  }
  if (!isDomainRecord(value)) {
    return value;
  }

  const sanitizedRecord: Record<string, DomainValue> = {};
  for (const [key, childValue] of Object.entries(value)) {
    if (shouldPreservePayloadField(path, key)) {
      sanitizedRecord[key] = childValue;
      continue;
    }
    if (typeof childValue === "string" && isSecretLikeFieldName(key)) {
      sanitizedRecord[key] = isAlreadyRedactedToken(childValue)
        ? childValue
        : toRedactedToken(redactedSecretTokenCategory, childValue);
      continue;
    }
    sanitizedRecord[key] = sanitizePayloadDomainValue(childValue, [
      ...path,
      key,
    ]);
  }

  return sanitizedRecord;
};

const sanitizePayloadForPersistence = (payload: DomainRecord): DomainRecord =>
  sanitizePayloadDomainValue(payload, []) as DomainRecord;

const normalizeDomainValue = (
  value: DomainValue,
  path: string
): CanonicalJsonValue => {
  if (value === null) {
    return null;
  }

  if (typeof value === "string" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new StoragePayloadValidationFailure(
        `${path} must not contain non-finite numbers.`
      );
    }
    return value;
  }

  if (Array.isArray(value)) {
    const sequence = value as readonly DomainValue[];
    return sequence.map((item, index) =>
      normalizeDomainValue(item, `${path}[${index}]`)
    );
  }

  if (!isPlainRecordObject(value)) {
    throw new StoragePayloadValidationFailure(
      `${path} must contain only plain JSON-compatible objects.`
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
      throw new StoragePayloadValidationFailure(
        `${path}.${key} must be defined.`
      );
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

type StorageScopeLevel = "common" | "project" | "job_role" | "user";

interface ScopeAuthorizationScopeAnchor {
  readonly scopeId: string;
  readonly scopeLevel: StorageScopeLevel;
  readonly scopeProjectId: string | null;
  readonly scopeRoleId: string | null;
  readonly scopeUserId: string | null;
}

interface NormalizedScopeAuthorizationContext {
  readonly tenantId: string | null;
  readonly allowedProjectIds: ReadonlySet<string>;
  readonly allowedRoleIds: ReadonlySet<string>;
  readonly allowedUserIds: ReadonlySet<string>;
}

const resolveScopeAuthorizationContext = (
  request: StorageUpsertRequest | StorageDeleteRequest
): NormalizedScopeAuthorizationContext | null => {
  const requestWithAliases = request as (
    | StorageUpsertRequest
    | StorageDeleteRequest
  ) & {
    readonly scopeAuthorization?: ScopeAuthorizationInput;
    readonly scope_authorization?: ScopeAuthorizationInput;
  };
  const scopeAuthorizationInput =
    requestWithAliases.scopeAuthorization ??
    requestWithAliases.scope_authorization;
  if (scopeAuthorizationInput === undefined) {
    return null;
  }

  return Object.freeze({
    tenantId:
      scopeAuthorizationInput.tenantId ??
      scopeAuthorizationInput.tenant_id ??
      null,
    allowedProjectIds: new Set([
      ...(scopeAuthorizationInput.projectIds ?? []),
      ...(scopeAuthorizationInput.project_ids ?? []),
    ]),
    allowedRoleIds: new Set([
      ...(scopeAuthorizationInput.roleIds ?? []),
      ...(scopeAuthorizationInput.role_ids ?? []),
      ...(scopeAuthorizationInput.jobRoleIds ?? []),
      ...(scopeAuthorizationInput.job_role_ids ?? []),
    ]),
    allowedUserIds: new Set([
      ...(scopeAuthorizationInput.userIds ?? []),
      ...(scopeAuthorizationInput.user_ids ?? []),
    ]),
  });
};

const isScopeAuthorizationAllowedForScopeAnchor = (
  scopeAuthorization: NormalizedScopeAuthorizationContext,
  scopeAnchor: ScopeAuthorizationScopeAnchor
): boolean => {
  switch (scopeAnchor.scopeLevel) {
    case "common":
      return true;
    case "project":
      return (
        scopeAnchor.scopeProjectId !== null &&
        scopeAuthorization.allowedProjectIds.has(scopeAnchor.scopeProjectId)
      );
    case "job_role":
      return (
        scopeAnchor.scopeRoleId !== null &&
        scopeAuthorization.allowedRoleIds.has(scopeAnchor.scopeRoleId)
      );
    case "user":
      return (
        scopeAnchor.scopeUserId !== null &&
        scopeAuthorization.allowedUserIds.has(scopeAnchor.scopeUserId)
      );
    default:
      return false;
  }
};

const denyScopeAuthorizationViolation = (
  operation: "upsert" | "delete",
  details: string
): never => {
  throw new ScopeAuthorizationViolationFailure(operation, details);
};

const assertScopeAuthorizationTenantAccess = (
  scopeAuthorization: NormalizedScopeAuthorizationContext | null,
  operation: "upsert" | "delete",
  spaceId: string
): void => {
  if (
    scopeAuthorization !== null &&
    scopeAuthorization.tenantId !== null &&
    scopeAuthorization.tenantId !== spaceId
  ) {
    denyScopeAuthorizationViolation(
      operation,
      `Scope authorization denied ${operation} tenant "${spaceId}".`
    );
  }
};

const assertScopeAuthorizationAnchorAccess = (
  scopeAuthorization: NormalizedScopeAuthorizationContext | null,
  operation: "upsert" | "delete",
  anchorKind: "project" | "role" | "user",
  anchorId: string
): void => {
  if (scopeAuthorization === null) {
    return;
  }

  const allowed =
    anchorKind === "project"
      ? scopeAuthorization.allowedProjectIds.has(anchorId)
      : anchorKind === "role"
        ? scopeAuthorization.allowedRoleIds.has(anchorId)
        : scopeAuthorization.allowedUserIds.has(anchorId);
  if (!allowed) {
    denyScopeAuthorizationViolation(
      operation,
      `Scope authorization denied ${operation} ${anchorKind} anchor "${anchorId}".`
    );
  }
};

const assertScopeAuthorizationScopeAccess = (
  scopeAuthorization: NormalizedScopeAuthorizationContext | null,
  operation: "upsert" | "delete",
  scopeAnchor: ScopeAuthorizationScopeAnchor
): void => {
  if (scopeAuthorization === null) {
    return;
  }
  if (
    isScopeAuthorizationAllowedForScopeAnchor(scopeAuthorization, scopeAnchor)
  ) {
    return;
  }

  denyScopeAuthorizationViolation(
    operation,
    `Scope authorization denied ${operation} scope "${scopeAnchor.scopeId}" at level "${scopeAnchor.scopeLevel}".`
  );
};

const parseScopeControlProjection = (
  payload: DomainRecord
): ScopeControlProjection => {
  const legacyRootScopeId =
    parseOptionalTrimmedString(
      payload,
      ["scopeId", "scope_id"],
      "payload.scopeId"
    ) ?? null;

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
      "StorageUpsertRequest.payload.scope must be a plain object record."
    );
  }

  const scopeRecord = scopeControlValue;
  const scopeId =
    parseOptionalTrimmedString(
      scopeRecord,
      ["scopeId", "scope_id"],
      "payload.scope.scopeId"
    ) ?? null;
  const scopeProjectId =
    parseOptionalTrimmedString(
      scopeRecord,
      ["projectId", "project_id"],
      "payload.scope.projectId"
    ) ?? null;
  const scopeRoleId =
    parseOptionalTrimmedString(
      scopeRecord,
      ["roleId", "role_id", "jobRoleId", "job_role_id"],
      "payload.scope.roleId"
    ) ?? null;
  const scopeUserId =
    parseOptionalTrimmedString(
      scopeRecord,
      ["userId", "user_id"],
      "payload.scope.userId"
    ) ?? null;
  if (
    legacyRootScopeId !== null &&
    (scopeId !== null ||
      scopeProjectId !== null ||
      scopeRoleId !== null ||
      scopeUserId !== null)
  ) {
    throw new StoragePayloadValidationFailure(
      "payload.scopeId cannot be combined with payload.scope controls."
    );
  }
  const resolvedScopeId = scopeId ?? legacyRootScopeId;
  if (
    resolvedScopeId !== null &&
    (scopeProjectId !== null || scopeRoleId !== null || scopeUserId !== null)
  ) {
    throw new StoragePayloadValidationFailure(
      "Explicit scopeId cannot be combined with project/role/user scope anchors."
    );
  }

  return Object.freeze({
    scopeId: resolvedScopeId,
    scopeProjectId,
    scopeRoleId,
    scopeUserId,
  });
};

const parsePayloadProjection = (
  request: StorageUpsertRequest
): StoragePayloadProjection => {
  if (!isDomainRecord(request.payload)) {
    throw new StoragePayloadValidationFailure(
      "StorageUpsertRequest.payload must be a plain object record."
    );
  }

  const payload = request.payload;
  const sanitizedPayload = sanitizePayloadForPersistence(payload);
  const rawPayloadJson = toCanonicalPayloadJson(payload);
  const memoryKind =
    parseOptionalEnum<EnterpriseMemoryKind>(
      payload,
      ["memoryKind", "memory_kind"],
      memoryKindSet,
      "payload.memoryKind"
    ) ?? "note";
  const rawTitle =
    parseOptionalTrimmedString(payload, ["title"], "payload.title") ??
    request.memoryId;
  const title =
    parseOptionalTrimmedString(sanitizedPayload, ["title"], "payload.title") ??
    request.memoryId;

  const createdAtMillis = parseOptionalNonNegativeSafeInteger(
    payload,
    ["createdAtMillis", "created_at_ms"],
    "payload.createdAtMillis"
  );
  const updatedAtMillis = parseOptionalNonNegativeSafeInteger(
    payload,
    ["updatedAtMillis", "updated_at_ms"],
    "payload.updatedAtMillis"
  );

  const normalizedCreatedAtMillis = createdAtMillis ?? updatedAtMillis ?? 0;
  const normalizedUpdatedAtMillis =
    updatedAtMillis ?? normalizedCreatedAtMillis;
  if (normalizedUpdatedAtMillis < normalizedCreatedAtMillis) {
    throw new StoragePayloadValidationFailure(
      "payload.updatedAtMillis must be greater than or equal to payload.createdAtMillis."
    );
  }

  const expiresAtMillisInput = parseOptionalNullableNonNegativeSafeInteger(
    payload,
    ["expiresAtMillis", "expires_at_ms"],
    "payload.expiresAtMillis"
  );
  const normalizedExpiresAtMillis = expiresAtMillisInput ?? null;
  if (
    normalizedExpiresAtMillis !== null &&
    normalizedExpiresAtMillis < normalizedCreatedAtMillis
  ) {
    throw new StoragePayloadValidationFailure(
      "payload.expiresAtMillis must be greater than or equal to payload.createdAtMillis."
    );
  }

  const tombstonedAtMillisInput = parseOptionalNullableNonNegativeSafeInteger(
    payload,
    ["tombstonedAtMillis", "tombstoned_at_ms"],
    "payload.tombstonedAtMillis"
  );
  const statusInput = parseOptionalEnum<EnterpriseMemoryStatus>(
    payload,
    ["status"],
    memoryStatusSet,
    "payload.status"
  );
  const normalizedStatus: EnterpriseMemoryStatus =
    statusInput ??
    (typeof tombstonedAtMillisInput === "number" ? "tombstoned" : "active");

  let normalizedTombstonedAtMillis: number | null =
    tombstonedAtMillisInput ?? null;
  if (
    normalizedStatus === "tombstoned" &&
    normalizedTombstonedAtMillis === null
  ) {
    normalizedTombstonedAtMillis = normalizedUpdatedAtMillis;
  }
  if (
    normalizedStatus !== "tombstoned" &&
    normalizedTombstonedAtMillis !== null
  ) {
    throw new StoragePayloadValidationFailure(
      'payload.tombstonedAtMillis can only be set when payload.status is "tombstoned".'
    );
  }
  if (
    normalizedTombstonedAtMillis !== null &&
    normalizedTombstonedAtMillis < normalizedCreatedAtMillis
  ) {
    throw new StoragePayloadValidationFailure(
      "payload.tombstonedAtMillis must be greater than or equal to payload.createdAtMillis."
    );
  }
  if (
    normalizedTombstonedAtMillis !== null &&
    normalizedUpdatedAtMillis < normalizedTombstonedAtMillis
  ) {
    throw new StoragePayloadValidationFailure(
      "payload.updatedAtMillis must be greater than or equal to payload.tombstonedAtMillis."
    );
  }

  const scopeControl = parseScopeControlProjection(payload);
  const createdByUserId =
    parseOptionalNullableTrimmedString(
      payload,
      ["createdByUserId", "created_by_user_id"],
      "payload.createdByUserId"
    ) ?? null;
  const supersedesMemoryId =
    parseOptionalNullableTrimmedString(
      payload,
      ["supersedesMemoryId", "supersedes_memory_id"],
      "payload.supersedesMemoryId"
    ) ?? null;
  const rawProvenanceJson = parseIncomingProvenanceJson(payload);
  const provenanceJson = parseIncomingProvenanceJson(sanitizedPayload);
  const evidencePointers = parseEvidencePointerProjections(
    payload,
    sanitizedPayload,
    normalizedUpdatedAtMillis,
    normalizedCreatedAtMillis
  );
  if (request.layer === "procedural" && evidencePointers.length === 0) {
    throw new StoragePayloadValidationFailure(
      "Promoted procedural memory requires at least one evidence pointer."
    );
  }
  const legacyUnsanitizedRequestHashSha256 = toSha256Hex(
    JSON.stringify({
      operation: "upsert",
      spaceId: request.spaceId,
      memoryId: request.memoryId,
      layer: request.layer,
      payloadProjection: {
        scopeId: scopeControl.scopeId,
        scopeProjectId: scopeControl.scopeProjectId,
        scopeRoleId: scopeControl.scopeRoleId,
        scopeUserId: scopeControl.scopeUserId,
        memoryKind,
        status: normalizedStatus,
        title: rawTitle,
        payloadJson: rawPayloadJson,
        createdByUserId,
        supersedesMemoryId,
        createdAtMillis: normalizedCreatedAtMillis,
        updatedAtMillis: normalizedUpdatedAtMillis,
        expiresAtMillis: normalizedExpiresAtMillis,
        tombstonedAtMillis: normalizedTombstonedAtMillis,
        provenanceJson: rawProvenanceJson,
        evidencePointers: evidencePointers.map((pointer) => ({
          proposedEvidenceId: pointer.proposedEvidenceId,
          sourceKind: pointer.sourceKind,
          sourceRef: pointer.sourceRef,
          digestSha256: pointer.digestSha256,
          payloadJson: pointer.rawPayloadJson,
          observedAtMillis: pointer.observedAtMillis,
          createdAtMillis: pointer.createdAtMillis,
          relationKind: pointer.relationKind,
        })),
      },
    })
  );

  return Object.freeze({
    scopeId: scopeControl.scopeId,
    scopeProjectId: scopeControl.scopeProjectId,
    scopeRoleId: scopeControl.scopeRoleId,
    scopeUserId: scopeControl.scopeUserId,
    memoryKind,
    status: normalizedStatus,
    title,
    payloadJson: toCanonicalPayloadJson(sanitizedPayload),
    createdByUserId,
    supersedesMemoryId,
    createdAtMillis: normalizedCreatedAtMillis,
    updatedAtMillis: normalizedUpdatedAtMillis,
    expiresAtMillis: normalizedExpiresAtMillis,
    tombstonedAtMillis: normalizedTombstonedAtMillis,
    provenanceJson,
    rawPayloadSha256: toSha256Hex(rawPayloadJson),
    legacyUnsanitizedRequestHashSha256,
    evidencePointers,
  });
};

const parseOptionalIdempotencyKeyValue = (
  value: unknown,
  fieldName: "idempotencyKey" | "idempotency_key",
  contract:
    | "StorageUpsertRequest.idempotencyKey"
    | "StorageDeleteRequest.idempotencyKey"
): string | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new ContractValidationError({
      contract,
      message: "Idempotency key must be a non-empty string when provided.",
      details: `${fieldName} must be a string value.`,
    });
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new ContractValidationError({
      contract,
      message: "Idempotency key must be a non-empty string when provided.",
      details: `${fieldName} must be a non-empty string value.`,
    });
  }

  return trimmed;
};

const resolveOptionalIdempotencyKey = (
  request: StorageUpsertRequest | StorageDeleteRequest,
  operation: StorageIdempotencyOperation
): string | null => {
  const contract:
    | "StorageUpsertRequest.idempotencyKey"
    | "StorageDeleteRequest.idempotencyKey" =
    operation === "upsert"
      ? "StorageUpsertRequest.idempotencyKey"
      : "StorageDeleteRequest.idempotencyKey";
  const requestWithAliases = request as {
    readonly idempotencyKey?: unknown;
    readonly idempotency_key?: unknown;
  };
  const camelCaseIdempotencyKey = parseOptionalIdempotencyKeyValue(
    requestWithAliases.idempotencyKey,
    "idempotencyKey",
    contract
  );
  const snakeCaseIdempotencyKey = parseOptionalIdempotencyKeyValue(
    requestWithAliases.idempotency_key,
    "idempotency_key",
    contract
  );

  if (
    camelCaseIdempotencyKey !== undefined &&
    snakeCaseIdempotencyKey !== undefined &&
    camelCaseIdempotencyKey !== snakeCaseIdempotencyKey
  ) {
    throw new ContractValidationError({
      contract,
      message: "Idempotency key aliases must match when both are provided.",
      details: `idempotencyKey (${camelCaseIdempotencyKey}) does not match idempotency_key (${snakeCaseIdempotencyKey}).`,
    });
  }

  return camelCaseIdempotencyKey ?? snakeCaseIdempotencyKey ?? null;
};

const toDeterministicUpsertRequestHash = (
  request: StorageUpsertRequest,
  payloadProjection: StoragePayloadProjection,
  options?: {
    readonly includeRawPayloadSha256?: boolean;
  }
): string =>
  (() => {
    const includeRawPayloadSha256 = options?.includeRawPayloadSha256 ?? true;
    return toSha256Hex(
      JSON.stringify({
        operation: "upsert",
        spaceId: request.spaceId,
        memoryId: request.memoryId,
        layer: request.layer,
        payloadProjection: {
          scopeId: payloadProjection.scopeId,
          scopeProjectId: payloadProjection.scopeProjectId,
          scopeRoleId: payloadProjection.scopeRoleId,
          scopeUserId: payloadProjection.scopeUserId,
          memoryKind: payloadProjection.memoryKind,
          status: payloadProjection.status,
          title: payloadProjection.title,
          payloadJson: payloadProjection.payloadJson,
          createdByUserId: payloadProjection.createdByUserId,
          supersedesMemoryId: payloadProjection.supersedesMemoryId,
          createdAtMillis: payloadProjection.createdAtMillis,
          updatedAtMillis: payloadProjection.updatedAtMillis,
          expiresAtMillis: payloadProjection.expiresAtMillis,
          tombstonedAtMillis: payloadProjection.tombstonedAtMillis,
          provenanceJson: payloadProjection.provenanceJson,
          ...(includeRawPayloadSha256
            ? { rawPayloadSha256: payloadProjection.rawPayloadSha256 }
            : {}),
          evidencePointers: payloadProjection.evidencePointers.map(
            (pointer) => ({
              proposedEvidenceId: pointer.proposedEvidenceId,
              sourceKind: pointer.sourceKind,
              sourceRef: pointer.sourceRef,
              digestSha256: pointer.digestSha256,
              payloadJson: pointer.payloadJson,
              observedAtMillis: pointer.observedAtMillis,
              createdAtMillis: pointer.createdAtMillis,
              relationKind: pointer.relationKind,
            })
          ),
        },
      })
    );
  })();

const toLegacyDeterministicUpsertRequestHash = (
  request: StorageUpsertRequest,
  payloadProjection: StoragePayloadProjection
): string =>
  toDeterministicUpsertRequestHash(request, payloadProjection, {
    includeRawPayloadSha256: false,
  });

const toDeterministicDeleteRequestHash = (
  request: StorageDeleteRequest
): string =>
  toSha256Hex(
    JSON.stringify({
      operation: "delete",
      spaceId: request.spaceId,
      memoryId: request.memoryId,
    })
  );

const toStoredIdempotencyResponseJson = (
  response: StorageUpsertResponse | StorageDeleteResponse
): string => JSON.stringify(response);

const parseStoredIdempotencyResponseRecord = (
  responseJson: string,
  operation: StorageIdempotencyOperation
): Record<string, unknown> => {
  let parsedResponse: unknown;
  try {
    parsedResponse = JSON.parse(responseJson);
  } catch (cause) {
    const details = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `Stored ${operation} idempotency response_json is not valid JSON: ${details}`
    );
  }

  if (
    typeof parsedResponse !== "object" ||
    parsedResponse === null ||
    Array.isArray(parsedResponse)
  ) {
    throw new Error(
      `Stored ${operation} idempotency response_json must decode to an object.`
    );
  }

  return parsedResponse as Record<string, unknown>;
};

const readStoredIdempotencyResponseString = (
  record: Record<string, unknown>,
  fieldName: string,
  operation: StorageIdempotencyOperation
): string => {
  const value = record[fieldName];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(
      `Stored ${operation} idempotency response_json.${fieldName} must be a non-empty string.`
    );
  }

  return value;
};

const readStoredIdempotencyResponseBoolean = (
  record: Record<string, unknown>,
  fieldName: string,
  operation: StorageIdempotencyOperation
): boolean => {
  const value = record[fieldName];
  if (typeof value !== "boolean") {
    throw new Error(
      `Stored ${operation} idempotency response_json.${fieldName} must be boolean.`
    );
  }

  return value;
};

const readStoredIdempotencyResponseInteger = (
  record: Record<string, unknown>,
  fieldName: string,
  operation: StorageIdempotencyOperation
): number =>
  toNonNegativeSafeInteger(
    record[fieldName],
    `stored ${operation} idempotency response_json.${fieldName}`
  );

const decodeStoredUpsertIdempotencyResponse = (
  responseJson: string,
  request: StorageUpsertRequest
): StorageUpsertResponse => {
  const responseRecord = parseStoredIdempotencyResponseRecord(
    responseJson,
    "upsert"
  );
  const spaceId = readStoredIdempotencyResponseString(
    responseRecord,
    "spaceId",
    "upsert"
  );
  const memoryId = readStoredIdempotencyResponseString(
    responseRecord,
    "memoryId",
    "upsert"
  );
  if (spaceId !== request.spaceId || memoryId !== request.memoryId) {
    throw new Error(
      "Stored upsert idempotency response identity does not match incoming request identity."
    );
  }

  return {
    spaceId: request.spaceId,
    memoryId: request.memoryId,
    accepted: readStoredIdempotencyResponseBoolean(
      responseRecord,
      "accepted",
      "upsert"
    ),
    persistedAtMillis: readStoredIdempotencyResponseInteger(
      responseRecord,
      "persistedAtMillis",
      "upsert"
    ),
    version: readStoredIdempotencyResponseInteger(
      responseRecord,
      "version",
      "upsert"
    ),
  } satisfies StorageUpsertResponse;
};

const decodeStoredDeleteIdempotencyResponse = (
  responseJson: string,
  request: StorageDeleteRequest
): StorageDeleteResponse => {
  const responseRecord = parseStoredIdempotencyResponseRecord(
    responseJson,
    "delete"
  );
  const spaceId = readStoredIdempotencyResponseString(
    responseRecord,
    "spaceId",
    "delete"
  );
  const memoryId = readStoredIdempotencyResponseString(
    responseRecord,
    "memoryId",
    "delete"
  );
  if (spaceId !== request.spaceId || memoryId !== request.memoryId) {
    throw new Error(
      "Stored delete idempotency response identity does not match incoming request identity."
    );
  }

  return {
    spaceId: request.spaceId,
    memoryId: request.memoryId,
    deleted: readStoredIdempotencyResponseBoolean(
      responseRecord,
      "deleted",
      "delete"
    ),
  } satisfies StorageDeleteResponse;
};

const readStorageIdempotencyLedgerProjection = (
  row: unknown,
  operation: StorageIdempotencyOperation
): StorageIdempotencyLedgerProjection => {
  const requestHashSha256 = readRowColumn(row, "request_hash_sha256");
  if (
    typeof requestHashSha256 !== "string" ||
    !/^[0-9a-f]{64}$/i.test(requestHashSha256)
  ) {
    throw new Error(
      `Stored ${operation} idempotency request_hash_sha256 must be a 64-character hex digest.`
    );
  }
  const responseJson = readRowColumn(row, "response_json");
  if (typeof responseJson !== "string" || responseJson.trim().length === 0) {
    throw new Error(
      `Stored ${operation} idempotency response_json must be a non-empty string.`
    );
  }

  return Object.freeze({
    requestHashSha256: requestHashSha256.toLowerCase(),
    responseJson,
  });
};

const toIdempotencyKeyConflictError = (
  operation: StorageIdempotencyOperation,
  idempotencyKey: string,
  storedRequestHashSha256: string,
  incomingRequestHashSha256: string
): ContractValidationError => {
  const contract:
    | "StorageUpsertRequest.idempotencyKey"
    | "StorageDeleteRequest.idempotencyKey" =
    operation === "upsert"
      ? "StorageUpsertRequest.idempotencyKey"
      : "StorageDeleteRequest.idempotencyKey";

  return new ContractValidationError({
    contract,
    message: `Idempotency key reuse conflict for storage ${operation} request.`,
    details: `idempotencyKey "${idempotencyKey}" already maps to request hash ${storedRequestHashSha256} and cannot be reused with hash ${incomingRequestHashSha256}.`,
  });
};

const toContractValidationError = (details: string): ContractValidationError =>
  new ContractValidationError({
    contract: "StorageUpsertRequest.payload",
    message:
      "Contract validation failed for StorageUpsertRequest payload mapping",
    details,
  });

const readRowColumn = (row: unknown, columnName: string): unknown => {
  if (
    typeof row !== "object" ||
    row === null ||
    !Object.hasOwn(row, columnName)
  ) {
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
  cause instanceof Error
    ? cause.message
    : `Unknown SQLite failure: ${String(cause)}`;

const mapUpsertFailure = (
  cause: unknown,
  request: StorageUpsertRequest
): StorageServiceError => {
  if (cause instanceof ContractValidationError) {
    return cause;
  }
  if (cause instanceof ScopeAuthorizationViolationFailure) {
    return new ContractValidationError({
      contract: storageScopeAuthorizationGuardrailContract,
      message: "Scope authorization guardrail denied storage upsert request.",
      details: cause.message,
    });
  }
  if (cause instanceof TenantIsolationViolationFailure) {
    return new ContractValidationError({
      contract: "StorageTenantIsolationGuardrail",
      message:
        "Tenant isolation guardrail denied a cross-tenant storage reference.",
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

const mapDeleteFailure = (
  cause: unknown,
  request: StorageDeleteRequest
): StorageServiceError => {
  if (cause instanceof ContractValidationError) {
    return cause;
  }
  if (cause instanceof ScopeAuthorizationViolationFailure) {
    return new ContractValidationError({
      contract: storageScopeAuthorizationGuardrailContract,
      message: "Scope authorization guardrail denied storage delete request.",
      details: cause.message,
    });
  }
  if (cause instanceof TenantIsolationViolationFailure) {
    return new ContractValidationError({
      contract: "StorageTenantIsolationGuardrail",
      message:
        "Tenant isolation guardrail denied a cross-tenant storage delete probe.",
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

const parseOptionalSnapshotAliasValue = (
  value: unknown,
  fieldName: "signatureSecret" | "signature_secret",
  contract:
    | "StorageSnapshotExportRequest.signatureSecret"
    | "StorageSnapshotImportRequest.signatureSecret"
): string | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new ContractValidationError({
      contract,
      message: "Snapshot signing secret must be a non-empty string.",
      details: `${fieldName} must be a string value.`,
    });
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new ContractValidationError({
      contract,
      message: "Snapshot signing secret must be a non-empty string.",
      details: `${fieldName} must be a non-empty string value.`,
    });
  }

  return trimmed;
};

const resolveSnapshotSigningSecret = (
  request: StorageSnapshotExportRequest | StorageSnapshotImportRequest,
  contract:
    | "StorageSnapshotExportRequest.signatureSecret"
    | "StorageSnapshotImportRequest.signatureSecret"
): string => {
  const requestWithAliases = request as {
    readonly signatureSecret?: unknown;
    readonly signature_secret?: unknown;
  };
  const camelCaseSecret = parseOptionalSnapshotAliasValue(
    requestWithAliases.signatureSecret,
    "signatureSecret",
    contract
  );
  const snakeCaseSecret = parseOptionalSnapshotAliasValue(
    requestWithAliases.signature_secret,
    "signature_secret",
    contract
  );
  if (
    camelCaseSecret !== undefined &&
    snakeCaseSecret !== undefined &&
    camelCaseSecret !== snakeCaseSecret
  ) {
    throw new ContractValidationError({
      contract,
      message:
        "Snapshot signing secret aliases must match when both are provided.",
      details: `signatureSecret (${camelCaseSecret}) does not match signature_secret (${snakeCaseSecret}).`,
    });
  }

  const resolvedSecret = camelCaseSecret ?? snakeCaseSecret;
  if (resolvedSecret === undefined) {
    throw new ContractValidationError({
      contract,
      message: "Snapshot signing secret is required.",
      details: "Provide signatureSecret or signature_secret.",
    });
  }

  return resolvedSecret;
};

const normalizeSnapshotPayload = (payload: unknown): string => {
  if (typeof payload !== "string") {
    throw new ContractValidationError({
      contract: "StorageSnapshotImportRequest.payload",
      message: "Snapshot payload must be a non-empty string.",
      details: "payload must be a string value.",
    });
  }
  if (payload.length === 0) {
    throw new ContractValidationError({
      contract: "StorageSnapshotImportRequest.payload",
      message: "Snapshot payload must be a non-empty string.",
      details: "payload must not be empty.",
    });
  }

  return payload;
};

const normalizeSnapshotSignatureAlgorithm = (value: unknown): string => {
  if (typeof value !== "string") {
    throw new ContractValidationError({
      contract: "StorageSnapshotImportRequest.signatureAlgorithm",
      message: "Snapshot signature algorithm must be hmac-sha256.",
      details: "signatureAlgorithm must be a string value.",
    });
  }
  const trimmed = value.trim().toLowerCase();
  if (trimmed !== sqliteStorageSnapshotSignatureAlgorithm) {
    throw new ContractValidationError({
      contract: "StorageSnapshotImportRequest.signatureAlgorithm",
      message: "Snapshot signature algorithm must be hmac-sha256.",
      details: `Expected ${sqliteStorageSnapshotSignatureAlgorithm} but received ${value}.`,
    });
  }
  return trimmed;
};

const normalizeSnapshotSignatureHex = (value: unknown): string => {
  if (typeof value !== "string") {
    throw new ContractValidationError({
      contract: "StorageSnapshotImportRequest.signature",
      message:
        "Snapshot signature must be a 64-character hexadecimal hmac digest.",
      details: "signature must be a string value.",
    });
  }
  const normalizedSignature = value.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalizedSignature)) {
    throw new ContractValidationError({
      contract: "StorageSnapshotImportRequest.signature",
      message:
        "Snapshot signature must be a 64-character hexadecimal hmac digest.",
      details: "signature must contain exactly 64 hexadecimal characters.",
    });
  }
  return normalizedSignature;
};

const mapSnapshotExportFailure = (cause: unknown): StorageServiceError => {
  if (cause instanceof ContractValidationError) {
    return cause;
  }

  return new ContractValidationError({
    contract: "StorageSnapshotExportRequest",
    message: "Unexpected SQLite storage snapshot export failure",
    details: toErrorMessage(cause),
  });
};

const mapSnapshotImportFailure = (cause: unknown): StorageServiceError => {
  if (cause instanceof ContractValidationError) {
    return cause;
  }

  return new ContractValidationError({
    contract: "StorageSnapshotImportRequest",
    message: "Unexpected SQLite storage snapshot import failure",
    details: toErrorMessage(cause),
  });
};

const hasSqliteTable = (database: DatabaseSync, tableName: string): boolean =>
  database
    .prepare(
      [
        "SELECT 1",
        "FROM sqlite_master",
        "WHERE type = 'table' AND name = ?",
        "LIMIT 1;",
      ].join("\n")
    )
    .get(tableName) !== undefined;

const scrubEncryptedPayloadTextFromFts = (
  database: DatabaseSync,
  payloadEncryptionConfig: SqlitePayloadEncryptionConfig,
  memoryItemsFtsAvailable: boolean
): void => {
  if (!payloadEncryptionConfig.enabled || !memoryItemsFtsAvailable) {
    return;
  }
  try {
    database.exec(
      "UPDATE memory_items_fts SET payload_text = '' WHERE payload_text <> '';"
    );
  } catch (cause) {
    throw toSqlitePayloadEncryptionContractError(
      ".enabled",
      "Encryption-at-rest requires deterministic FTS payload scrubbing.",
      `Failed to scrub encrypted payload text from memory_items_fts: ${toErrorMessage(cause)}`
    );
  }
};

export const makeSqliteStorageRepository = (
  database: DatabaseSync,
  options: SqliteStorageRepositoryOptions = {}
): SqliteStorageRepository => {
  const enforceForeignKeys = options.enforceForeignKeys ?? true;
  const walEnabled = options.wal?.enabled ?? false;
  const runMigrations = options.applyMigrations ?? true;
  const payloadEncryptionConfig = resolveSqlitePayloadEncryptionConfig(options);

  configureSqliteForeignKeys(database, enforceForeignKeys);
  configureSqliteWalMode(database, walEnabled);
  if (runMigrations) {
    applyEnterpriseSqliteMigrations(database);
  }
  const memoryItemsFtsAvailable = hasSqliteTable(database, "memory_items_fts");
  scrubEncryptedPayloadTextFromFts(
    database,
    payloadEncryptionConfig,
    memoryItemsFtsAvailable
  );
  if (options.backupReplication !== undefined) {
    createSqliteBackupReplicator(database, options.backupReplication);
  }

  const ensureTenantStatement = database.prepare(
    "INSERT OR IGNORE INTO tenants (tenant_id, tenant_slug, display_name, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?);"
  );
  const selectCommonScopeIdStatement = database.prepare(
    "SELECT scope_id FROM scopes WHERE tenant_id = ? AND scope_level = 'common' ORDER BY scope_id LIMIT 1;"
  );
  const insertCommonScopeStatement = database.prepare(
    "INSERT OR IGNORE INTO scopes (tenant_id, scope_id, scope_level, project_id, role_id, user_id, parent_scope_id, created_at_ms) VALUES (?, ?, 'common', NULL, NULL, NULL, NULL, ?);"
  );
  const selectProjectScopeIdStatement = database.prepare(
    "SELECT scope_id FROM scopes WHERE tenant_id = ? AND scope_level = 'project' AND project_id = ? ORDER BY scope_id LIMIT 1;"
  );
  const insertProjectScopeStatement = database.prepare(
    "INSERT OR IGNORE INTO scopes (tenant_id, scope_id, scope_level, project_id, role_id, user_id, parent_scope_id, created_at_ms) VALUES (?, ?, 'project', ?, NULL, NULL, ?, ?);"
  );
  const selectProjectAnchorStatement = database.prepare(
    "SELECT project_id FROM projects WHERE tenant_id = ? AND project_id = ? LIMIT 1;"
  );
  const selectForeignProjectAnchorOwnerStatement = database.prepare(
    "SELECT tenant_id FROM projects WHERE project_id = ? AND tenant_id <> ? ORDER BY tenant_id ASC LIMIT 1;"
  );
  const selectJobRoleScopeIdStatement = database.prepare(
    "SELECT scope_id FROM scopes WHERE tenant_id = ? AND scope_level = 'job_role' AND role_id = ? ORDER BY scope_id LIMIT 1;"
  );
  const insertJobRoleScopeStatement = database.prepare(
    "INSERT OR IGNORE INTO scopes (tenant_id, scope_id, scope_level, project_id, role_id, user_id, parent_scope_id, created_at_ms) VALUES (?, ?, 'job_role', NULL, ?, NULL, ?, ?);"
  );
  const selectRoleAnchorStatement = database.prepare(
    "SELECT role_id FROM roles WHERE tenant_id = ? AND role_id = ? LIMIT 1;"
  );
  const selectForeignRoleAnchorOwnerStatement = database.prepare(
    "SELECT tenant_id FROM roles WHERE role_id = ? AND tenant_id <> ? ORDER BY tenant_id ASC LIMIT 1;"
  );
  const selectUserScopeIdStatement = database.prepare(
    "SELECT scope_id, parent_scope_id FROM scopes WHERE tenant_id = ? AND scope_level = 'user' AND user_id = ? ORDER BY scope_id LIMIT 1;"
  );
  const insertUserScopeStatement = database.prepare(
    "INSERT OR IGNORE INTO scopes (tenant_id, scope_id, scope_level, project_id, role_id, user_id, parent_scope_id, created_at_ms) VALUES (?, ?, 'user', NULL, NULL, ?, ?, ?);"
  );
  const selectUserAnchorStatement = database.prepare(
    "SELECT user_id FROM users WHERE tenant_id = ? AND user_id = ? LIMIT 1;"
  );
  const selectForeignUserAnchorOwnerStatement = database.prepare(
    "SELECT tenant_id FROM users WHERE user_id = ? AND tenant_id <> ? ORDER BY tenant_id ASC LIMIT 1;"
  );
  const selectTenantScopedScopeStatement = database.prepare(
    "SELECT scope_id FROM scopes WHERE tenant_id = ? AND scope_id = ? LIMIT 1;"
  );
  const selectTenantScopedScopeAuthorizationStatement = database.prepare(
    [
      "SELECT scope_id, scope_level, project_id, role_id, user_id",
      "FROM scopes",
      "WHERE tenant_id = ? AND scope_id = ?",
      "LIMIT 1;",
    ].join("\n")
  );
  const selectForeignScopeOwnerStatement = database.prepare(
    "SELECT tenant_id FROM scopes WHERE scope_id = ? AND tenant_id <> ? ORDER BY tenant_id ASC LIMIT 1;"
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
    ].join("\n")
  );
  const selectPersistedMemoryStatement = database.prepare(
    "SELECT updated_at_ms FROM memory_items WHERE tenant_id = ? AND memory_id = ?;"
  );
  const scrubEncryptedMemoryFtsPayloadStatement = memoryItemsFtsAvailable
    ? database.prepare(
        [
          "UPDATE memory_items_fts",
          "SET payload_text = ''",
          "WHERE rowid = (",
          "  SELECT rowid FROM memory_items",
          "  WHERE tenant_id = ? AND memory_id = ?",
          "  LIMIT 1",
          ");",
        ].join("\n")
      )
    : null;
  const selectExistingMemoryLayerAndPayloadStatement = database.prepare(
    "SELECT memory_layer, payload_json FROM memory_items WHERE tenant_id = ? AND memory_id = ? LIMIT 1;"
  );
  const selectTenantMemoryStatement = database.prepare(
    "SELECT memory_id FROM memory_items WHERE tenant_id = ? AND memory_id = ? LIMIT 1;"
  );
  const selectTenantMemoryScopeAuthorizationStatement = database.prepare(
    [
      "SELECT m.updated_at_ms, m.scope_id, s.scope_level, s.project_id, s.role_id, s.user_id",
      "FROM memory_items AS m",
      "INNER JOIN scopes AS s",
      "  ON s.tenant_id = m.tenant_id",
      " AND s.scope_id = m.scope_id",
      "WHERE m.tenant_id = ? AND m.memory_id = ?",
      "LIMIT 1;",
    ].join("\n")
  );
  const selectForeignMemoryOwnerStatement = database.prepare(
    "SELECT tenant_id FROM memory_items WHERE memory_id = ? AND tenant_id <> ? ORDER BY tenant_id ASC LIMIT 1;"
  );
  const insertEvidenceStatement = database.prepare(
    "INSERT OR IGNORE INTO evidence (tenant_id, evidence_id, source_kind, source_ref, digest_sha256, payload_json, observed_at_ms, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?);"
  );
  const selectEvidenceIdByNaturalKeyStatement = database.prepare(
    "SELECT evidence_id FROM evidence WHERE tenant_id = ? AND source_kind = ? AND source_ref = ? AND digest_sha256 = ? LIMIT 1;"
  );
  const insertMemoryEvidenceLinkStatement = database.prepare(
    "INSERT OR IGNORE INTO memory_evidence_links (tenant_id, memory_id, evidence_id, relation_kind, created_at_ms) VALUES (?, ?, ?, ?, ?);"
  );
  const deleteMemoryEvidenceLinksStatement = database.prepare(
    "DELETE FROM memory_evidence_links WHERE tenant_id = ? AND memory_id = ?;"
  );
  const deleteMemoryStatement = database.prepare(
    "DELETE FROM memory_items WHERE tenant_id = ? AND memory_id = ?;"
  );
  const selectIdempotencyLedgerStatement = database.prepare(
    [
      "SELECT request_hash_sha256, response_json",
      "FROM storage_idempotency_ledger",
      "WHERE tenant_id = ?",
      "  AND operation = ?",
      "  AND idempotency_key = ?",
      "LIMIT 1;",
    ].join("\n")
  );
  const insertIdempotencyLedgerStatement = database.prepare(
    [
      "INSERT OR IGNORE INTO storage_idempotency_ledger (",
      "  tenant_id,",
      "  operation,",
      "  idempotency_key,",
      "  request_hash_sha256,",
      "  response_json,",
      "  created_at_ms",
      ") VALUES (?, ?, ?, ?, ?, ?);",
    ].join("\n")
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
    ].join("\n")
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
    ].join("\n")
  );
  const assertExpectedForeignKeysMode = () => {
    const effectiveForeignKeysMode = readSqliteForeignKeysMode(database);
    if (effectiveForeignKeysMode !== enforceForeignKeys) {
      throw new ContractValidationError({
        contract: "SqliteStorageRepositoryOptions.enforceForeignKeys",
        message:
          "SQLite foreign_keys mode drift detected for active storage repository.",
        details: `Repository expects foreign_keys=${enforceForeignKeys ? "ON" : "OFF"} but SQLite reports ${
          effectiveForeignKeysMode ? "ON" : "OFF"
        }.`,
      });
    }
  };
  const readResolvedScopeId = (
    scopeRow: unknown,
    errorPrefix: string
  ): string => {
    const scopeId = readRowColumn(scopeRow, "scope_id");
    if (typeof scopeId !== "string" || scopeId.trim().length === 0) {
      throw new Error(`${errorPrefix} scope_id is not a valid string.`);
    }

    return scopeId;
  };
  const readScopeAuthorizationScopeLevel = (
    scopeRow: unknown,
    errorPrefix: string
  ): StorageScopeLevel => {
    const scopeLevel = readRowColumn(scopeRow, "scope_level");
    if (
      scopeLevel === "common" ||
      scopeLevel === "project" ||
      scopeLevel === "job_role" ||
      scopeLevel === "user"
    ) {
      return scopeLevel;
    }
    throw new Error(`${errorPrefix} scope_level is not a valid scope level.`);
  };
  const readNullableScopeAuthorizationAnchorId = (
    scopeRow: unknown,
    columnName: "project_id" | "role_id" | "user_id",
    errorPrefix: string
  ): string | null => {
    const value = readRowColumn(scopeRow, columnName);
    if (value === null) {
      return null;
    }
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(
        `${errorPrefix} ${columnName} is not a valid nullable id.`
      );
    }
    return value;
  };
  const readScopeAuthorizationScopeAnchor = (
    scopeRow: unknown,
    errorPrefix: string
  ): ScopeAuthorizationScopeAnchor => ({
    scopeId: readResolvedScopeId(scopeRow, errorPrefix),
    scopeLevel: readScopeAuthorizationScopeLevel(scopeRow, errorPrefix),
    scopeProjectId: readNullableScopeAuthorizationAnchorId(
      scopeRow,
      "project_id",
      errorPrefix
    ),
    scopeRoleId: readNullableScopeAuthorizationAnchorId(
      scopeRow,
      "role_id",
      errorPrefix
    ),
    scopeUserId: readNullableScopeAuthorizationAnchorId(
      scopeRow,
      "user_id",
      errorPrefix
    ),
  });
  const readResolvedMemoryLayer = (
    memoryRow: unknown,
    errorPrefix: string
  ): string => {
    const memoryLayer = readRowColumn(memoryRow, "memory_layer");
    if (typeof memoryLayer !== "string" || memoryLayer.trim().length === 0) {
      throw new Error(`${errorPrefix} memory_layer is not a valid string.`);
    }

    return memoryLayer;
  };
  const readResolvedEvidenceId = (
    evidenceRow: unknown,
    errorPrefix: string
  ): string => {
    const evidenceId = readRowColumn(evidenceRow, "evidence_id");
    if (typeof evidenceId !== "string" || evidenceId.trim().length === 0) {
      throw new Error(`${errorPrefix} evidence_id is not a valid string.`);
    }

    return evidenceId;
  };
  const emitTenantIsolationViolation = options.onTenantIsolationViolation;
  const readOwnerTenantId = (foreignOwnerRow: unknown): string => {
    const ownerTenantId = readRowColumn(foreignOwnerRow, "tenant_id");
    if (
      typeof ownerTenantId !== "string" ||
      ownerTenantId.trim().length === 0
    ) {
      throw new Error("Resolved tenant_id owner column is not a valid string.");
    }

    return ownerTenantId;
  };
  const auditTenantIsolationViolation = (
    event: TenantIsolationViolationAuditEvent
  ): void => {
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
      event.recordedAtMillis
    );
  };
  const persistAuditLedgerEntryBestEffort = (
    event: StorageAuditLedgerEntry
  ): void => {
    try {
      persistAuditLedgerEntry(event);
    } catch {
      // Audit persistence must not mask the original storage failure mapping.
    }
  };
  const persistIdempotencyLedgerEntry = (
    tenantId: string,
    operation: StorageIdempotencyOperation,
    idempotencyKey: string,
    requestHashSha256: string,
    responseJson: string,
    createdAtMillis: number
  ): StorageIdempotencyLedgerProjection | null => {
    const insertResult = insertIdempotencyLedgerStatement.run(
      tenantId,
      operation,
      idempotencyKey,
      requestHashSha256,
      responseJson,
      createdAtMillis
    );
    const insertedRows = toNonNegativeSafeInteger(
      readRowColumn(insertResult, "changes"),
      "storage_idempotency_ledger.insert.changes"
    );
    if (insertedRows > 0) {
      return null;
    }

    const existingLedgerRow = selectIdempotencyLedgerStatement.get(
      tenantId,
      operation,
      idempotencyKey
    );
    if (existingLedgerRow === undefined) {
      throw new Error(
        "Unable to resolve storage idempotency ledger row after deterministic INSERT OR IGNORE replay."
      );
    }

    const existingLedgerProjection = readStorageIdempotencyLedgerProjection(
      existingLedgerRow,
      operation
    );
    if (existingLedgerProjection.requestHashSha256 !== requestHashSha256) {
      throw toIdempotencyKeyConflictError(
        operation,
        idempotencyKey,
        existingLedgerProjection.requestHashSha256,
        requestHashSha256
      );
    }

    return existingLedgerProjection;
  };
  const toNullableAuditLookupKey = (value: string | null): string =>
    value ?? "";
  const allocateFailureAuditRecordedAtMillis = (
    event: Omit<StorageAuditLedgerEntry, "eventId" | "recordedAtMillis">
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
      toNullableAuditLookupKey(event.ownerTenantId)
    );
    const maxRecordedAtValue = readRowColumn(
      existingFailureRow,
      "max_recorded_at_ms"
    );
    const maxRecordedAtMillis =
      maxRecordedAtValue === null
        ? -1
        : toNonNegativeSafeInteger(
            maxRecordedAtValue,
            "audit_events.max_recorded_at_ms"
          );
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
    details: string
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
  const persistUpsertFailureAuditEntry = (
    cause: unknown,
    request: StorageUpsertRequest
  ): void => {
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
      })
    );
  };
  const persistDeleteFailureAuditEntry = (
    cause: unknown,
    request: StorageDeleteRequest
  ): void => {
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
      })
    );
  };
  const assertScopeAnchorExists = (
    scopeAnchorRow: unknown,
    foreignOwnerRow: unknown,
    spaceId: string,
    memoryId: string,
    anchorPath: string,
    anchorKind: "project" | "role" | "user",
    anchorId: string
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
        `${anchorPath} references an anchor owned by another tenant.`
      );
    }

    throw new StoragePayloadValidationFailure(
      `${anchorPath} references unknown tenant ${anchorKind} anchor "${anchorId}".`
    );
  };
  const resolveCommonScopeId = (tenantId: string): string => {
    const existingScopeRow = selectCommonScopeIdStatement.get(tenantId);
    if (existingScopeRow !== undefined) {
      return readResolvedScopeId(existingScopeRow, "Resolved common");
    }

    insertCommonScopeStatement.run(
      tenantId,
      `common:${tenantId}`,
      tenantCreatedAtMillis
    );
    const insertedScopeRow = selectCommonScopeIdStatement.get(tenantId);
    if (insertedScopeRow === undefined) {
      throw new Error(
        "Unable to resolve tenant common scope after deterministic bootstrap."
      );
    }

    return readResolvedScopeId(insertedScopeRow, "Bootstrapped common");
  };
  const resolveProjectScopeId = (
    tenantId: string,
    projectId: string,
    commonScopeId: string,
    memoryId: string
  ): string => {
    const existingScopeRow = selectProjectScopeIdStatement.get(
      tenantId,
      projectId
    );
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
      projectId
    );

    insertProjectScopeStatement.run(
      tenantId,
      `project:${tenantId}:${projectId}`,
      projectId,
      commonScopeId,
      tenantCreatedAtMillis
    );
    const insertedScopeRow = selectProjectScopeIdStatement.get(
      tenantId,
      projectId
    );
    if (insertedScopeRow === undefined) {
      throw new Error(
        "Unable to resolve tenant project scope after deterministic bootstrap."
      );
    }

    return readResolvedScopeId(insertedScopeRow, "Bootstrapped project");
  };
  const resolveJobRoleScopeId = (
    tenantId: string,
    roleId: string,
    commonScopeId: string,
    memoryId: string
  ): string => {
    const existingScopeRow = selectJobRoleScopeIdStatement.get(
      tenantId,
      roleId
    );
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
      roleId
    );

    insertJobRoleScopeStatement.run(
      tenantId,
      `job_role:${tenantId}:${roleId}`,
      roleId,
      commonScopeId,
      tenantCreatedAtMillis
    );
    const insertedScopeRow = selectJobRoleScopeIdStatement.get(
      tenantId,
      roleId
    );
    if (insertedScopeRow === undefined) {
      throw new Error(
        "Unable to resolve tenant job_role scope after deterministic bootstrap."
      );
    }

    return readResolvedScopeId(insertedScopeRow, "Bootstrapped job_role");
  };
  const resolveUserScopeId = (
    tenantId: string,
    userId: string,
    requestedParentScopeId: string | null,
    defaultParentScopeId: string,
    memoryId: string
  ): string => {
    const existingScopeRow = selectUserScopeIdStatement.get(tenantId, userId);
    if (existingScopeRow !== undefined) {
      const existingScopeId = readResolvedScopeId(
        existingScopeRow,
        "Resolved user"
      );
      const existingParentScopeId = readRowColumn(
        existingScopeRow,
        "parent_scope_id"
      );
      if (
        typeof existingParentScopeId !== "string" ||
        existingParentScopeId.trim().length === 0
      ) {
        throw new Error("Resolved user parent_scope_id is not a valid string.");
      }
      if (
        requestedParentScopeId !== null &&
        existingParentScopeId !== requestedParentScopeId
      ) {
        throw new StoragePayloadValidationFailure(
          `payload.scope anchors conflict with existing user scope parent. Existing parent=${existingParentScopeId}, requested parent=${requestedParentScopeId}.`
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
      userId
    );
    const parentScopeId = requestedParentScopeId ?? defaultParentScopeId;
    insertUserScopeStatement.run(
      tenantId,
      `user:${tenantId}:${userId}`,
      userId,
      parentScopeId,
      tenantCreatedAtMillis
    );
    const insertedScopeRow = selectUserScopeIdStatement.get(tenantId, userId);
    if (insertedScopeRow === undefined) {
      throw new Error(
        "Unable to resolve tenant user scope after deterministic bootstrap."
      );
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
            const scopeAuthorization =
              resolveScopeAuthorizationContext(request);
            assertScopeAuthorizationTenantAccess(
              scopeAuthorization,
              "upsert",
              request.spaceId
            );
            if (payloadProjection.scopeProjectId !== null) {
              assertScopeAuthorizationAnchorAccess(
                scopeAuthorization,
                "upsert",
                "project",
                payloadProjection.scopeProjectId
              );
            }
            if (payloadProjection.scopeRoleId !== null) {
              assertScopeAuthorizationAnchorAccess(
                scopeAuthorization,
                "upsert",
                "role",
                payloadProjection.scopeRoleId
              );
            }
            if (payloadProjection.scopeUserId !== null) {
              assertScopeAuthorizationAnchorAccess(
                scopeAuthorization,
                "upsert",
                "user",
                payloadProjection.scopeUserId
              );
            }
            if (payloadProjection.scopeId !== null) {
              const tenantScopedScopeAuthorizationRow =
                selectTenantScopedScopeAuthorizationStatement.get(
                  request.spaceId,
                  payloadProjection.scopeId
                );
              if (tenantScopedScopeAuthorizationRow !== undefined) {
                assertScopeAuthorizationScopeAccess(
                  scopeAuthorization,
                  "upsert",
                  readScopeAuthorizationScopeAnchor(
                    tenantScopedScopeAuthorizationRow,
                    "Explicit scope authorization"
                  )
                );
              }
            }
            const idempotencyKey = resolveOptionalIdempotencyKey(
              request,
              "upsert"
            );
            let upsertRequestHashSha256: string | null = null;
            if (idempotencyKey !== null) {
              upsertRequestHashSha256 = toDeterministicUpsertRequestHash(
                request,
                payloadProjection
              );
              const idempotencyLedgerRow = selectIdempotencyLedgerStatement.get(
                request.spaceId,
                "upsert",
                idempotencyKey
              );
              if (idempotencyLedgerRow !== undefined) {
                const storedIdempotencyLedgerProjection =
                  readStorageIdempotencyLedgerProjection(
                    idempotencyLedgerRow,
                    "upsert"
                  );
                if (
                  storedIdempotencyLedgerProjection.requestHashSha256 !==
                  upsertRequestHashSha256
                ) {
                  const legacyUpsertRequestHashSha256 =
                    toLegacyDeterministicUpsertRequestHash(
                      request,
                      payloadProjection
                    );
                  if (
                    storedIdempotencyLedgerProjection.requestHashSha256 ===
                    legacyUpsertRequestHashSha256
                  ) {
                    return decodeStoredUpsertIdempotencyResponse(
                      storedIdempotencyLedgerProjection.responseJson,
                      request
                    );
                  }
                  if (
                    storedIdempotencyLedgerProjection.requestHashSha256 ===
                    payloadProjection.legacyUnsanitizedRequestHashSha256
                  ) {
                    return decodeStoredUpsertIdempotencyResponse(
                      storedIdempotencyLedgerProjection.responseJson,
                      request
                    );
                  }
                  throw toIdempotencyKeyConflictError(
                    "upsert",
                    idempotencyKey,
                    storedIdempotencyLedgerProjection.requestHashSha256,
                    upsertRequestHashSha256
                  );
                }

                return decodeStoredUpsertIdempotencyResponse(
                  storedIdempotencyLedgerProjection.responseJson,
                  request
                );
              }
            }
            const existingMemoryRow =
              selectExistingMemoryLayerAndPayloadStatement.get(
                request.spaceId,
                request.memoryId
              );
            if (existingMemoryRow !== undefined) {
              const existingMemoryLayer = readResolvedMemoryLayer(
                existingMemoryRow,
                "Existing memory"
              );
              if (existingMemoryLayer === "procedural") {
                const existingPayloadJson = readRowColumn(
                  existingMemoryRow,
                  "payload_json"
                );
                if (typeof existingPayloadJson !== "string") {
                  throw new Error(
                    "Existing memory payload_json is not a valid string."
                  );
                }
                const existingProvenanceJson =
                  readPersistedProvenanceJsonFromPayloadJson(
                    existingPayloadJson,
                    payloadEncryptionConfig
                  );
                if (existingProvenanceJson !== null) {
                  if (
                    existingProvenanceJson !== payloadProjection.provenanceJson
                  ) {
                    throw new StoragePayloadValidationFailure(
                      "Promoted memory provenance metadata is immutable once memory is procedural."
                    );
                  }
                }
              }
            }

            ensureTenantStatement.run(
              request.spaceId,
              request.spaceId,
              request.spaceId,
              tenantCreatedAtMillis,
              tenantUpdatedAtMillis
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
                        request.memoryId
                      )
                    : payloadProjection.scopeProjectId !== null
                      ? resolveProjectScopeId(
                          request.spaceId,
                          payloadProjection.scopeProjectId,
                          commonScopeId,
                          request.memoryId
                        )
                      : null;
                resolvedScopeId = resolveUserScopeId(
                  request.spaceId,
                  scopeUserId,
                  requestedUserParentScopeId,
                  commonScopeId,
                  request.memoryId
                );
              } else if (payloadProjection.scopeRoleId !== null) {
                resolvedScopeId = resolveJobRoleScopeId(
                  request.spaceId,
                  payloadProjection.scopeRoleId,
                  commonScopeId,
                  request.memoryId
                );
              } else if (payloadProjection.scopeProjectId !== null) {
                resolvedScopeId = resolveProjectScopeId(
                  request.spaceId,
                  payloadProjection.scopeProjectId,
                  commonScopeId,
                  request.memoryId
                );
              } else {
                resolvedScopeId = commonScopeId;
              }
            }
            if (payloadProjection.scopeId !== null) {
              const tenantScopedRow = selectTenantScopedScopeStatement.get(
                request.spaceId,
                resolvedScopeId
              );
              if (tenantScopedRow === undefined) {
                const foreignScopeOwnerRow =
                  selectForeignScopeOwnerStatement.get(
                    resolvedScopeId,
                    request.spaceId
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
                    "Explicit scopeId reference is owned by another tenant."
                  );
                }
              }
            }
            if (payloadProjection.supersedesMemoryId !== null) {
              const tenantScopedSupersedesRow = selectTenantMemoryStatement.get(
                request.spaceId,
                payloadProjection.supersedesMemoryId
              );
              if (tenantScopedSupersedesRow === undefined) {
                const foreignSupersedesOwnerRow =
                  selectForeignMemoryOwnerStatement.get(
                    payloadProjection.supersedesMemoryId,
                    request.spaceId
                  );
                if (foreignSupersedesOwnerRow !== undefined) {
                  const ownerTenantId = readOwnerTenantId(
                    foreignSupersedesOwnerRow
                  );
                  denyTenantIsolationViolation(
                    "upsert",
                    request.spaceId,
                    request.memoryId,
                    "supersedes_memory",
                    payloadProjection.supersedesMemoryId,
                    ownerTenantId,
                    "cross_tenant_reference",
                    "supersedesMemoryId references memory owned by another tenant."
                  );
                }
              }
            }

            const persistedPayloadJson = toStoredMemoryPayloadJson(
              payloadProjection.payloadJson,
              payloadEncryptionConfig
            );
            const upsertMemoryResult = upsertMemoryStatement.run(
              request.spaceId,
              request.memoryId,
              resolvedScopeId,
              request.layer,
              payloadProjection.memoryKind,
              payloadProjection.status,
              payloadProjection.title,
              persistedPayloadJson,
              payloadProjection.createdByUserId,
              payloadProjection.supersedesMemoryId,
              payloadProjection.createdAtMillis,
              payloadProjection.updatedAtMillis,
              payloadProjection.expiresAtMillis,
              payloadProjection.tombstonedAtMillis
            );
            const upsertChanges = toNonNegativeSafeInteger(
              readRowColumn(upsertMemoryResult, "changes"),
              "memory_items.upsert.changes"
            );
            if (upsertChanges > 0) {
              if (
                payloadEncryptionConfig.enabled &&
                scrubEncryptedMemoryFtsPayloadStatement !== null
              ) {
                // Prevent FTS payload indexing from ingesting ciphertext envelopes.
                scrubEncryptedMemoryFtsPayloadStatement.run(
                  request.spaceId,
                  request.memoryId
                );
              }
              deleteMemoryEvidenceLinksStatement.run(
                request.spaceId,
                request.memoryId
              );
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
                    evidencePointer.createdAtMillis
                  );
                  const persistedEvidenceRow =
                    selectEvidenceIdByNaturalKeyStatement.get(
                      request.spaceId,
                      evidencePointer.sourceKind,
                      evidencePointer.sourceRef,
                      evidencePointer.digestSha256
                    );
                  if (persistedEvidenceRow === undefined) {
                    throw new Error(
                      "Unable to resolve evidence_id after deterministic evidence upsert."
                    );
                  }
                  const persistedEvidenceId = readResolvedEvidenceId(
                    persistedEvidenceRow,
                    "Persisted evidence"
                  );
                  insertMemoryEvidenceLinkStatement.run(
                    request.spaceId,
                    request.memoryId,
                    persistedEvidenceId,
                    evidencePointer.relationKind,
                    payloadProjection.updatedAtMillis
                  );
                }
              }
            }

            const persistedRow = selectPersistedMemoryStatement.get(
              request.spaceId,
              request.memoryId
            );
            const persistedAtMillis = toNonNegativeSafeInteger(
              readRowColumn(persistedRow, "updated_at_ms"),
              "memory_items.updated_at_ms"
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
              })
            );

            const response = {
              spaceId: request.spaceId,
              memoryId: request.memoryId,
              accepted: true,
              persistedAtMillis,
              version: 1,
            } satisfies StorageUpsertResponse;
            if (idempotencyKey !== null && upsertRequestHashSha256 !== null) {
              const persistedIdempotencyLedgerProjection =
                persistIdempotencyLedgerEntry(
                  request.spaceId,
                  "upsert",
                  idempotencyKey,
                  upsertRequestHashSha256,
                  toStoredIdempotencyResponseJson(response),
                  response.persistedAtMillis
                );
              if (persistedIdempotencyLedgerProjection !== null) {
                return decodeStoredUpsertIdempotencyResponse(
                  persistedIdempotencyLedgerProjection.responseJson,
                  request
                );
              }
            }

            return response;
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
            const scopeAuthorization =
              resolveScopeAuthorizationContext(request);
            assertScopeAuthorizationTenantAccess(
              scopeAuthorization,
              "delete",
              request.spaceId
            );
            const existingMemoryScopeAuthorizationRow =
              selectTenantMemoryScopeAuthorizationStatement.get(
                request.spaceId,
                request.memoryId
              );
            if (existingMemoryScopeAuthorizationRow !== undefined) {
              assertScopeAuthorizationScopeAccess(
                scopeAuthorization,
                "delete",
                readScopeAuthorizationScopeAnchor(
                  existingMemoryScopeAuthorizationRow,
                  "Delete scope authorization"
                )
              );
            }
            const idempotencyKey = resolveOptionalIdempotencyKey(
              request,
              "delete"
            );
            let deleteRequestHashSha256: string | null = null;
            if (idempotencyKey !== null) {
              deleteRequestHashSha256 =
                toDeterministicDeleteRequestHash(request);
              const idempotencyLedgerRow = selectIdempotencyLedgerStatement.get(
                request.spaceId,
                "delete",
                idempotencyKey
              );
              if (idempotencyLedgerRow !== undefined) {
                const storedIdempotencyLedgerProjection =
                  readStorageIdempotencyLedgerProjection(
                    idempotencyLedgerRow,
                    "delete"
                  );
                if (
                  storedIdempotencyLedgerProjection.requestHashSha256 !==
                  deleteRequestHashSha256
                ) {
                  throw toIdempotencyKeyConflictError(
                    "delete",
                    idempotencyKey,
                    storedIdempotencyLedgerProjection.requestHashSha256,
                    deleteRequestHashSha256
                  );
                }

                return decodeStoredDeleteIdempotencyResponse(
                  storedIdempotencyLedgerProjection.responseJson,
                  request
                );
              }
            }
            const existingMemoryRow = existingMemoryScopeAuthorizationRow;
            const deleteResult = deleteMemoryStatement.run(
              request.spaceId,
              request.memoryId
            );
            const deletedCount = toNonNegativeSafeInteger(
              readRowColumn(deleteResult, "changes"),
              "sqlite delete changes"
            );
            if (deletedCount === 0) {
              let ownerTenantId: string | null = null;
              const foreignMemoryOwnerRow =
                selectForeignMemoryOwnerStatement.get(
                  request.memoryId,
                  request.spaceId
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
                    details:
                      "Delete request targeted memory owned by another tenant.",
                  })
                );
              }
              throw new MissingStorageDeleteFailure(ownerTenantId);
            }
            const deletedUpdatedAtMillis =
              existingMemoryRow === undefined
                ? 0
                : toNonNegativeSafeInteger(
                    readRowColumn(existingMemoryRow, "updated_at_ms"),
                    "memory_items.updated_at_ms"
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
              })
            );

            const response = {
              spaceId: request.spaceId,
              memoryId: request.memoryId,
              deleted: true,
            } satisfies StorageDeleteResponse;
            if (idempotencyKey !== null && deleteRequestHashSha256 !== null) {
              const persistedIdempotencyLedgerProjection =
                persistIdempotencyLedgerEntry(
                  request.spaceId,
                  "delete",
                  idempotencyKey,
                  deleteRequestHashSha256,
                  toStoredIdempotencyResponseJson(response),
                  deletedUpdatedAtMillis
                );
              if (persistedIdempotencyLedgerProjection !== null) {
                return decodeStoredDeleteIdempotencyResponse(
                  persistedIdempotencyLedgerProjection.responseJson,
                  request
                );
              }
            }

            return response;
          }),
        catch: (cause) => {
          persistDeleteFailureAuditEntry(cause, request);
          return mapDeleteFailure(cause, request);
        },
      }),
    exportSnapshot: (request) =>
      Effect.try({
        try: () =>
          withImmediateTransaction(database, () => {
            assertExpectedForeignKeysMode();
            const signingSecret = resolveSnapshotSigningSecret(
              request,
              "StorageSnapshotExportRequest.signatureSecret"
            );
            const snapshotData = exportSqliteStorageSnapshotData(database);
            const payload = serializeSqliteStorageSnapshotData(snapshotData);
            const response = {
              signatureAlgorithm: sqliteStorageSnapshotSignatureAlgorithm,
              payload,
              signature: createSqliteStorageSnapshotSignature(
                payload,
                signingSecret
              ),
              tableCount: snapshotData.tables.length,
              rowCount: countSqliteStorageSnapshotRows(snapshotData),
            } satisfies StorageSnapshotExportResponse;
            return response;
          }),
        catch: mapSnapshotExportFailure,
      }),
    importSnapshot: (request) =>
      Effect.try({
        try: () =>
          withImmediateTransaction(database, () => {
            assertExpectedForeignKeysMode();
            const signingSecret = resolveSnapshotSigningSecret(
              request,
              "StorageSnapshotImportRequest.signatureSecret"
            );
            normalizeSnapshotSignatureAlgorithm(request.signatureAlgorithm);
            const payload = normalizeSnapshotPayload(request.payload);
            const signatureHex = normalizeSnapshotSignatureHex(
              request.signature
            );
            if (
              !verifySqliteStorageSnapshotSignature(
                payload,
                signatureHex,
                signingSecret
              )
            ) {
              throw new ContractValidationError({
                contract: "StorageSnapshotImportRequest.signature",
                message: "Snapshot signature verification failed.",
                details:
                  "Provided signature does not match payload and secret using hmac-sha256.",
              });
            }

            const snapshotData = parseSqliteStorageSnapshotPayload(payload);
            const canonicalPayload =
              serializeSqliteStorageSnapshotData(snapshotData);
            if (canonicalPayload !== payload) {
              throw new ContractValidationError({
                contract: "StorageSnapshotImportRequest.payload",
                message:
                  "Snapshot payload must use deterministic canonical serialization.",
                details:
                  "Payload does not match canonical JSON encoding for the decoded snapshot document.",
              });
            }

            assertSqliteStorageSnapshotSchemaCompatibility(
              database,
              snapshotData
            );
            const existingSnapshotData =
              exportSqliteStorageSnapshotData(database);
            const existingCanonicalPayload =
              serializeSqliteStorageSnapshotData(existingSnapshotData);
            const responseBase = {
              imported: true,
              tableCount: snapshotData.tables.length,
              rowCount: countSqliteStorageSnapshotRows(snapshotData),
            };

            if (existingCanonicalPayload === canonicalPayload) {
              return {
                ...responseBase,
                replayed: true,
              } satisfies StorageSnapshotImportResponse;
            }

            applySqliteStorageSnapshotData(database, snapshotData);
            scrubEncryptedPayloadTextFromFts(
              database,
              payloadEncryptionConfig,
              memoryItemsFtsAvailable
            );
            return {
              ...responseBase,
              replayed: false,
            } satisfies StorageSnapshotImportResponse;
          }),
        catch: mapSnapshotImportFailure,
      }),
  };
};
