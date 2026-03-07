import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { test } from "@effect-native/bun-test";
import { Effect as EffectOriginal } from "effect";
import ts from "typescript";

import type { ContractValidationError } from "../../libs/shared/src/effect/errors.ts";
import type {
  SqliteBackupReplicationController as BackupReplicationController,
  SqliteBackupReplicationMetadata as BackupReplicationMetadata,
} from "../../libs/shared/src/effect/storage/sqlite/backup-replication.ts";
import { DatabaseSync } from "../../libs/shared/src/effect/storage/sqlite/database.ts";
import type {
  SqliteProvenanceHealthAlert,
  TenantIsolationViolationAuditEvent,
} from "../../libs/shared/src/effect/storage/sqlite/storage-repository.ts";
import { sqliteAll, sqliteGet } from "./sqlite-test-helpers.ts";

type RuntimeStorageService = {
  readonly upsertMemory: (
    request: Record<string, unknown>
  ) => EffectOriginal.Effect<any, any, never>;
  readonly deleteMemory: (
    request: Record<string, unknown>
  ) => EffectOriginal.Effect<any, any, never>;
  readonly exportSnapshot: (
    request: Record<string, unknown>
  ) => EffectOriginal.Effect<any, any, never>;
  readonly importSnapshot: (
    request: Record<string, unknown>
  ) => EffectOriginal.Effect<any, any, never>;
};
type StorageServiceModule = {
  readonly makeSqliteStorageService: (
    database: DatabaseSync,
    options?: unknown
  ) => RuntimeStorageService;
  readonly makeSqliteStorageLayer: (
    database: DatabaseSync,
    options?: unknown
  ) => any;
  readonly StorageServiceTag: any;
};
type StorageRepositoryModule = {
  readonly evaluateSqliteProvenanceHealth: (
    database: DatabaseSync,
    options?: unknown
  ) => any;
};
type TestEither<Left, Right = unknown> =
  | {
      readonly _tag: "Left";
      readonly left: Left;
    }
  | {
      readonly _tag: "Right";
      readonly right: Right;
    };

const either = <Success, Error>(
  effect: EffectOriginal.Effect<Success, Error, never>
): EffectOriginal.Effect<TestEither<Error, Success>, never, never> =>
  EffectOriginal.result(effect).pipe(
    EffectOriginal.map((result) =>
      result._tag === "Failure"
        ? ({ _tag: "Left", left: result.failure } as const)
        : ({ _tag: "Right", right: result.success } as const)
    )
  );

const Effect: any = { ...EffectOriginal, either };

const effectModuleDirectory = new URL(
  "../../libs/shared/src/effect/",
  import.meta.url
);

const transpileEffectModule = (
  sourceFilename: string,
  tempDirectory: string
) => {
  const sourceFileUrl = new URL(sourceFilename, effectModuleDirectory);
  const source = readFileSync(sourceFileUrl, "utf8");
  const transpiled = ts.transpileModule(source, {
    fileName: sourceFileUrl.pathname,
    reportDiagnostics: true,
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const diagnostics = transpiled.diagnostics ?? [];
  if (diagnostics.length > 0) {
    const diagnosticMessage = diagnostics
      .map((diagnostic) => {
        const messageText = ts.flattenDiagnosticMessageText(
          diagnostic.messageText,
          "\n"
        );
        const position =
          diagnostic.file === undefined || diagnostic.start === undefined
            ? sourceFilename
            : `${sourceFilename}:${diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1}`;
        return `${position} - ${messageText}`;
      })
      .join("\n");
    throw new Error(
      `TypeScript transpile diagnostics for ${sourceFilename}:\n${diagnosticMessage}`
    );
  }

  const outputFilename = join(
    tempDirectory,
    sourceFilename.replace(/\.ts$/, ".js")
  );
  mkdirSync(dirname(outputFilename), { recursive: true });
  writeFileSync(outputFilename, transpiled.outputText, "utf8");
};

const transpileManifest = Object.freeze([
  "contracts/ids.ts",
  "contracts/domains.ts",
  "contracts/services.ts",
  "contracts/validators.ts",
  "contracts/index.ts",
  "errors.ts",
  "services/runtime-persistence-service.ts",
  "storage/sqlite/schema-metadata.ts",
  "storage/sqlite/enterprise-schema.ts",
  "storage/sqlite/migrations.ts",
  "storage/sqlite/backup-replication.ts",
  "storage/sqlite/runtime-persistence-repository.ts",
  "storage/sqlite/snapshot-codec.ts",
  "storage/sqlite/storage-repository.ts",
  "storage/sqlite/index.ts",
  "storage/postgres/schema.ts",
  "storage/postgres/migrations.ts",
  "storage/postgres/storage-repository.ts",
  "storage/postgres/index.ts",
  "services/storage-service.ts",
]);

let storageServiceModulePromise: Promise<StorageServiceModule> | null = null;
let storageRepositoryModulePromise: Promise<StorageRepositoryModule> | null =
  null;
let transpiledDirectoryPath: string | undefined;
const expectString = (value: string | undefined): string => {
  assert.ok(typeof value === "string");
  return value;
};

const loadStorageServiceModule = async (): Promise<StorageServiceModule> => {
  if (!storageServiceModulePromise) {
    const tempRootDirectory = join(process.cwd(), "dist", "tmp");
    mkdirSync(tempRootDirectory, { recursive: true });
    transpiledDirectoryPath = mkdtempSync(
      join(tempRootDirectory, "ums-memory-storage-sqlite-")
    );

    for (const modulePath of transpileManifest) {
      transpileEffectModule(modulePath, transpiledDirectoryPath);
    }

    const storageServiceModuleUrl = pathToFileURL(
      join(transpiledDirectoryPath, "services/storage-service.js")
    ).href;
    storageServiceModulePromise = import(
      storageServiceModuleUrl
    ) as Promise<StorageServiceModule>;
  }

  return storageServiceModulePromise;
};

const loadStorageRepositoryModule =
  async (): Promise<StorageRepositoryModule> => {
    await loadStorageServiceModule();
    if (!storageRepositoryModulePromise) {
      const moduleUrl = pathToFileURL(
        join(
          expectString(transpiledDirectoryPath),
          "storage/sqlite/storage-repository.js"
        )
      ).href;
      storageRepositoryModulePromise = import(
        moduleUrl
      ) as Promise<StorageRepositoryModule>;
    }
    return storageRepositoryModulePromise;
  };

process.on("exit", () => {
  if (transpiledDirectoryPath) {
    rmSync(transpiledDirectoryPath, { recursive: true, force: true });
  }
});

const unwrapFailure = (eitherResult: TestEither<any>): any => {
  assert.equal(eitherResult?._tag, "Left");
  return expectSqliteRow(eitherResult.left);
};

const redactedTokenPatternByCategory = Object.freeze({
  SECRET: /^\[REDACTED_SECRET:[0-9a-f]{12,64}\]$/,
  EMAIL: /^\[REDACTED_EMAIL:[0-9a-f]{12,64}\]$/,
  PHONE: /^\[REDACTED_PHONE:[0-9a-f]{12,64}\]$/,
});

const containsRedactedTokenCategory = (
  text: string,
  category: keyof typeof redactedTokenPatternByCategory
) => text.includes(`[REDACTED_${category}:`);

const toSha256Hex = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const sqlitePayloadEncryptionEnvelopeFormat =
  "ums-memory/sqlite-memory-payload-encrypted/v1";
const sqlitePayloadEncryptionEnvelopeAlgorithm = "aes-256-gcm";

interface ScopeLatticeAnchorOptions {
  readonly projectIds?: readonly string[];
  readonly roleIds?: readonly string[];
  readonly userIds?: readonly string[];
}

type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

interface ContractErrorShape {
  readonly _tag?: string;
  readonly contract?: string;
  readonly details?: string;
  readonly message?: string;
}

type AuditEventRow = {
  readonly operation: string;
  readonly outcome: string;
  readonly owner_tenant_id: string | null;
  readonly reason: string;
  readonly recorded_at_ms?: number;
  readonly reference_id: string | null;
  readonly reference_kind: string | null;
};

type EvidenceLinkRow = {
  readonly evidence_id?: string;
  readonly memory_id: string;
  readonly relation_kind: string;
};

type EvidenceProvenanceRow = {
  readonly provenance_id: string;
  readonly source_ref: string;
};

type EvidenceRow = {
  readonly digest_sha256: string;
  readonly payload_json: string;
  readonly source_ref: string;
};

type IdempotencyLedgerRow = {
  readonly request_hash_sha256: string;
  readonly response_json: string;
};

type JoinedEvidenceRow = {
  readonly created_at_ms: number;
  readonly observed_at_ms: number;
  readonly relation_kind: string;
  readonly source_ref: string;
};

type PayloadJsonRow = {
  readonly payload_json: string;
};

type PayloadTextRow = {
  readonly payload_text: string;
};

type ProvenanceEnvelopeRow = {
  readonly agent_id: string;
  readonly batch_id: string;
  readonly conversation_id: string;
  readonly message_id: string;
  readonly project_id: string;
  readonly provenance_id: string;
  readonly role_id: string;
  readonly source_id: string;
  readonly user_id: string;
};

type ProvenanceLinkRow = {
  readonly details?: string;
  readonly memory_id?: string;
  readonly provenance_id: string;
  readonly source_id?: string;
  readonly batch_id?: string;
  readonly project_id?: string;
  readonly role_id?: string;
  readonly user_id?: string;
};

type RowCountRow = {
  readonly row_count: number;
};

type ReasonRow = {
  readonly reason: string;
};

type ScopeCountRow = {
  readonly row_count: number;
  readonly scope_level: string;
};

type ScopeIdAuditRow = {
  readonly created_by_user_id: string | null;
  readonly scope_id: string;
};

type ScopeMemoryRow = {
  readonly memory_id: string;
  readonly scope_id: string;
};

type ScopeRow = {
  readonly parent_scope_id: string | null;
  readonly scope_id: string;
};

type ScopeOnlyRow = {
  readonly scope_id: string;
};

type StorageMemoryRow = {
  readonly created_at_ms: number;
  readonly memory_kind: string;
  readonly memory_layer: string;
  readonly payload_json: string;
  readonly scope_id: string;
  readonly status: string;
  readonly title: string;
  readonly tombstoned_at_ms: number | null;
  readonly updated_at_ms: number;
};

type TitlePayloadRow = {
  readonly payload_json: string;
  readonly title: string;
};

type TitleUpdatedAtRow = {
  readonly title: string;
  readonly updated_at_ms: number;
};

type TombstonedMemoryRow = {
  readonly status: string;
  readonly title: string;
  readonly tombstoned_at_ms: number | null;
  readonly updated_at_ms: number;
};

const asContractErrorShape = (value: unknown): ContractErrorShape =>
  value && typeof value === "object" ? (value as ContractErrorShape) : {};

const expectSqliteRow = <TRow>(row: TRow | undefined): TRow => {
  assert.ok(row);
  return row;
};

const firstSqliteRow = <TRow>(rows: readonly TRow[]): TRow => {
  const row = rows[0];
  assert.ok(row);
  return row;
};

const toBase64EncryptionKey = (seedByte: number) =>
  Buffer.alloc(32, seedByte).toString("base64");

const readEncryptedPayloadEnvelope = (payloadJson: string) => {
  const parsedEnvelope = JSON.parse(payloadJson) as {
    readonly algorithm: string;
    readonly authTagBase64: string;
    readonly ciphertextBase64: string;
    readonly format: string;
    readonly ivBase64: string;
    readonly keyId: string;
    readonly version: number;
  };
  assert.equal(parsedEnvelope.format, sqlitePayloadEncryptionEnvelopeFormat);
  assert.equal(parsedEnvelope.version, 1);
  assert.equal(
    parsedEnvelope.algorithm,
    sqlitePayloadEncryptionEnvelopeAlgorithm
  );
  assert.equal(typeof parsedEnvelope.keyId, "string");
  assert.ok(parsedEnvelope.keyId.length > 0);
  assert.match(parsedEnvelope.ivBase64, /^[A-Za-z0-9+/]+={0,2}$/);
  assert.match(parsedEnvelope.authTagBase64, /^[A-Za-z0-9+/]+={0,2}$/);
  assert.match(parsedEnvelope.ciphertextBase64, /^[A-Za-z0-9+/]+={0,2}$/);
  return parsedEnvelope;
};

const toCanonicalJsonValue = (value: unknown): CanonicalJsonValue => {
  if (Array.isArray(value)) {
    return value.map((entry) => toCanonicalJsonValue(entry));
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort((left, right) => left.localeCompare(right))
        .map((key) => [key, toCanonicalJsonValue(record[key])])
    ) as CanonicalJsonValue;
  }
  return value as CanonicalJsonValue;
};

const toCanonicalPayloadJson = (payload: unknown) =>
  JSON.stringify(toCanonicalJsonValue(payload));

const seedScopeLatticeAnchors = (
  db: DatabaseSync,
  tenantId: string,
  {
    projectIds = [],
    roleIds = [],
    userIds = [],
  }: ScopeLatticeAnchorOptions = {}
) => {
  const now = 1_700_000_000_000;
  db.prepare(
    "INSERT OR IGNORE INTO tenants (tenant_id, tenant_slug, display_name, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?);"
  ).run(tenantId, tenantId, tenantId, now, now);

  for (const userId of userIds) {
    db.prepare(
      "INSERT OR IGNORE INTO users (tenant_id, user_id, email, display_name, status, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?);"
    ).run(
      tenantId,
      userId,
      `${userId}@example.com`,
      userId,
      "active",
      now,
      now
    );
  }

  for (const projectId of projectIds) {
    db.prepare(
      "INSERT OR IGNORE INTO projects (tenant_id, project_id, project_key, display_name, status, created_at_ms, archived_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?);"
    ).run(
      tenantId,
      projectId,
      `KEY_${projectId}`,
      projectId,
      "active",
      now,
      null
    );
  }

  for (const roleId of roleIds) {
    db.prepare(
      "INSERT OR IGNORE INTO roles (tenant_id, role_id, role_code, display_name, role_type, created_at_ms) VALUES (?, ?, ?, ?, ?, ?);"
    ).run(tenantId, roleId, `ROLE_${roleId}`, roleId, "project", now);
  }
};

const createDeterministicBackupClock = (startMillis = 1_700_000_000_000) => {
  let currentMillis = startMillis;
  return () => {
    const nextMillis = currentMillis;
    currentMillis += 1;
    return nextMillis;
  };
};

const createDeterministicIntervalScheduler = () => {
  let nextHandle = 0;
  const callbacksByHandle = new Map<number, () => void>();
  return {
    scheduler: {
      setInterval: (task: () => void) => {
        nextHandle += 1;
        callbacksByHandle.set(nextHandle, task);
        return nextHandle;
      },
      clearInterval: (handle: unknown) => {
        if (typeof handle === "number") {
          callbacksByHandle.delete(handle);
        }
      },
    },
    tick: () => {
      for (const callback of callbacksByHandle.values()) {
        callback();
      }
    },
    activeCount: () => callbacksByHandle.size,
  };
};

test("ums-memory-5cb.7: promoted procedural memory without evidence pointers is rejected", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const db = new DatabaseSync(":memory:");

  try {
    const storageService = storageServiceModule.makeSqliteStorageService(db);
    const upsertEither = Effect.runSync(
      Effect.either(
        storageService.upsertMemory({
          spaceId: "tenant-promoted-evidence-required",
          memoryId: "memory-procedural-without-evidence",
          layer: "procedural",
          payload: {
            title: "Promoted memory missing evidence",
            provenance: {
              source: "shadow-replay",
              decisionId: "decision-required",
            },
            updatedAtMillis: 1_700_000_010_001,
          },
        })
      )
    );
    const upsertFailure = unwrapFailure(upsertEither);

    assert.equal(upsertFailure._tag, "ContractValidationError");
    assert.equal(upsertFailure.contract, "StorageUpsertRequest.payload");
    assert.match(
      upsertFailure.details,
      /requires at least one evidence pointer/i
    );

    const evidenceRowCount = sqliteGet<RowCountRow>(
      db,
      "SELECT COUNT(*) AS row_count FROM evidence WHERE tenant_id = ?;",
      "tenant-promoted-evidence-required"
    );
    assert.ok(evidenceRowCount);
    assert.equal(Number(evidenceRowCount.row_count), 0);
  } finally {
    db.close();
  }
});

test("ums-memory-5cb.7: promoted procedural memory rejects conflicting relation kinds for the same deterministic evidence pointer", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const db = new DatabaseSync(":memory:");

  try {
    const storageService = storageServiceModule.makeSqliteStorageService(db);
    const upsertEither = Effect.runSync(
      Effect.either(
        storageService.upsertMemory({
          spaceId: "tenant-promoted-evidence-conflict",
          memoryId: "memory-procedural-evidence-conflict",
          layer: "procedural",
          payload: {
            title: "Promoted memory with conflicting evidence relation kinds",
            provenance: {
              source: "shadow-replay",
              decisionId: "decision-conflict",
            },
            evidencePointers: [
              {
                sourceKind: "event",
                sourceRef: "event://evt-conflict",
                digestSha256: "0".repeat(64),
                relationKind: "supports",
              },
              {
                sourceKind: "event",
                sourceRef: "event://evt-conflict",
                digestSha256: "0".repeat(64),
                relationKind: "contradicts",
              },
            ],
            updatedAtMillis: 1_700_000_011_001,
          },
        })
      )
    );
    const upsertFailure = unwrapFailure(upsertEither);

    assert.equal(upsertFailure._tag, "ContractValidationError");
    assert.equal(upsertFailure.contract, "StorageUpsertRequest.payload");
    assert.match(
      upsertFailure.details,
      /single relationKind per deterministic evidence key/i
    );
  } finally {
    db.close();
  }
});

test("ums-memory-5cb.7: promoted procedural memory writes evidence and memory_evidence_links idempotently", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const db = new DatabaseSync(":memory:");

  try {
    const storageService = storageServiceModule.makeSqliteStorageService(db);
    const upsertRequest = {
      spaceId: "tenant-promoted-evidence-links",
      memoryId: "memory-procedural-evidence-links",
      layer: "procedural",
      payload: {
        title: "Procedural memory with deterministic evidence links",
        provenance: {
          source: "shadow-replay",
          decisionId: "decision-evidence-links",
        },
        evidencePointers: [
          {
            sourceKind: "event",
            sourceRef: "event://evt-b",
            digestSha256: "b".repeat(64),
            relationKind: "supports",
            observedAtMillis: 1_700_000_020_010,
            payload: {
              eventId: "evt-b",
            },
          },
          {
            sourceKind: "event",
            sourceRef: "event://evt-a",
            digestSha256: "a".repeat(64),
            relationKind: "supports",
            observedAtMillis: 1_700_000_020_000,
            payload: {
              eventId: "evt-a",
            },
          },
          {
            sourceKind: "event",
            sourceRef: "event://evt-b",
            digestSha256: "b".repeat(64),
            relationKind: "supports",
            observedAtMillis: 1_700_000_020_010,
            payload: {
              eventId: "evt-b",
            },
          },
        ],
        updatedAtMillis: 1_700_000_020_100,
      },
    };

    const firstResponse = Effect.runSync(
      storageService.upsertMemory(upsertRequest)
    );
    const secondReplayResponse = Effect.runSync(
      storageService.upsertMemory(upsertRequest)
    );

    assert.equal(firstResponse.accepted, true);
    assert.equal(secondReplayResponse.accepted, true);

    const evidenceRows = sqliteAll<EvidenceRow>(
      db,
      [
        "SELECT source_kind, source_ref, digest_sha256, payload_json",
        "FROM evidence",
        "WHERE tenant_id = ?",
        "ORDER BY source_kind ASC, source_ref ASC, digest_sha256 ASC;",
      ].join("\n"),
      "tenant-promoted-evidence-links"
    );
    assert.equal(evidenceRows.length, 2);
    assert.deepEqual(
      evidenceRows.map((row) => row.source_ref),
      ["event://evt-a", "event://evt-b"]
    );
    assert.deepEqual(
      evidenceRows.map((row) => row.digest_sha256),
      ["a".repeat(64), "b".repeat(64)]
    );

    const linkRows = sqliteAll<EvidenceLinkRow>(
      db,
      [
        "SELECT memory_id, evidence_id, relation_kind",
        "FROM memory_evidence_links",
        "WHERE tenant_id = ?",
        "ORDER BY memory_id ASC, evidence_id ASC;",
      ].join("\n"),
      "tenant-promoted-evidence-links"
    );
    assert.equal(linkRows.length, 2);
    assert.ok(
      linkRows.every(
        (row) => row.memory_id === "memory-procedural-evidence-links"
      )
    );
    assert.ok(linkRows.every((row) => row.relation_kind === "supports"));
  } finally {
    db.close();
  }
});

test("ums-memory-i6m.3: storage upsert persists deterministic provenance envelope and linkage rows", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const db = new DatabaseSync(":memory:");
  const tenantId = "tenant-i6m3-provenance-links";
  const projectId = "project-i6m3";
  const roleId = "role-i6m3";
  const userId = "user-i6m3";

  try {
    const storageService = storageServiceModule.makeSqliteStorageService(db);
    seedScopeLatticeAnchors(db, tenantId, {
      projectIds: [projectId],
      roleIds: [roleId],
      userIds: [userId],
    });
    const provenanceEnvelope = {
      tenantId,
      projectId,
      roleId,
      userId,
      agentId: "agent-i6m3",
      conversationId: "conversation-i6m3",
      messageId: "message-i6m3",
      sourceId: "source-i6m3",
      batchId: "batch-i6m3",
    };

    const firstUpsertRequest = {
      spaceId: tenantId,
      memoryId: "memory-i6m3-provenance",
      layer: "procedural",
      payload: {
        title: "Procedural memory with canonical provenance lineage",
        provenance: provenanceEnvelope,
        evidencePointers: [
          {
            sourceKind: "event",
            sourceRef: "event://evt-i6m3-a",
            digestSha256: "a".repeat(64),
            relationKind: "supports",
          },
          {
            sourceKind: "event",
            sourceRef: "event://evt-i6m3-b",
            digestSha256: "b".repeat(64),
            relationKind: "supports",
          },
        ],
        updatedAtMillis: 1_700_000_021_100,
      },
    };

    Effect.runSync(storageService.upsertMemory(firstUpsertRequest));
    Effect.runSync(
      storageService.upsertMemory({
        ...firstUpsertRequest,
        payload: {
          ...firstUpsertRequest.payload,
          title: "Procedural memory after deterministic provenance replay",
          updatedAtMillis: 1_700_000_021_200,
        },
      })
    );

    const provenanceRows = sqliteAll<ProvenanceEnvelopeRow>(
      db,
      [
        "SELECT provenance_id, project_id, role_id, user_id, agent_id, conversation_id, message_id, source_id, batch_id",
        "FROM provenance_envelopes",
        "WHERE tenant_id = ?",
        "ORDER BY provenance_id ASC;",
      ].join("\n"),
      tenantId
    );
    assert.equal(provenanceRows.length, 1);
    const provenanceRow = firstSqliteRow(provenanceRows);
    const provenanceId = String(provenanceRow.provenance_id);
    assert.equal(provenanceRow.project_id, projectId);
    assert.equal(provenanceRow.role_id, roleId);
    assert.equal(provenanceRow.user_id, userId);
    assert.equal(provenanceRow.agent_id, "agent-i6m3");
    assert.equal(provenanceRow.conversation_id, "conversation-i6m3");
    assert.equal(provenanceRow.message_id, "message-i6m3");
    assert.equal(provenanceRow.source_id, "source-i6m3");
    assert.equal(provenanceRow.batch_id, "batch-i6m3");

    const memoryProvenanceLinks = sqliteAll<ProvenanceLinkRow>(
      db,
      [
        "SELECT memory_id, provenance_id",
        "FROM memory_provenance_links",
        "WHERE tenant_id = ? AND memory_id = ?",
        "ORDER BY provenance_id ASC;",
      ].join("\n"),
      tenantId,
      "memory-i6m3-provenance"
    );
    assert.deepEqual(
      memoryProvenanceLinks.map((row) => ({
        memory_id: String(row.memory_id),
        provenance_id: String(row.provenance_id),
      })),
      [
        {
          memory_id: "memory-i6m3-provenance",
          provenance_id: provenanceId,
        },
      ]
    );

    const evidenceProvenanceLinks = sqliteAll<EvidenceProvenanceRow>(
      db,
      [
        "SELECT e.source_ref, epl.provenance_id",
        "FROM evidence_provenance_links epl",
        "INNER JOIN evidence e ON e.tenant_id = epl.tenant_id AND e.evidence_id = epl.evidence_id",
        "WHERE epl.tenant_id = ?",
        "ORDER BY e.source_ref ASC;",
      ].join("\n"),
      tenantId
    );
    assert.deepEqual(
      evidenceProvenanceLinks.map((row) => row.source_ref),
      ["event://evt-i6m3-a", "event://evt-i6m3-b"]
    );
    assert.ok(
      evidenceProvenanceLinks.every((row) => row.provenance_id === provenanceId)
    );
  } finally {
    db.close();
  }
});

test("ums-memory-i6m.3: storage upsert rejects provenance envelopes with mismatched tenantId", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const db = new DatabaseSync(":memory:");

  try {
    const storageService = storageServiceModule.makeSqliteStorageService(db);
    const upsertEither = Effect.runSync(
      Effect.either(
        storageService.upsertMemory({
          spaceId: "tenant-i6m3-provenance-tenant-a",
          memoryId: "memory-i6m3-provenance-tenant-mismatch",
          layer: "episodic",
          payload: {
            title: "Provenance tenant mismatch",
            provenance: {
              tenantId: "tenant-i6m3-provenance-tenant-b",
              sourceId: "source-i6m3-tenant-mismatch",
            },
            updatedAtMillis: 1_700_000_021_300,
          },
        })
      )
    );
    const upsertFailure = unwrapFailure(upsertEither);

    assert.equal(upsertFailure._tag, "ContractValidationError");
    assert.equal(upsertFailure.contract, "StorageUpsertRequest.payload");
    assert.match(
      upsertFailure.details,
      /tenantId .* must match request\.spaceId/i
    );
  } finally {
    db.close();
  }
});

test("ums-memory-i6m.4: storage upsert enforces provenance-required policy for enterprise writes", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const db = new DatabaseSync(":memory:");

  try {
    const tenantId = "tenant-i6m4-provenance-policy";
    const storageService = storageServiceModule.makeSqliteStorageService(db, {
      provenancePolicy: {
        requireOnWrite: true,
        requiredDimensions: ["agentId", "sourceId"],
      },
    });

    const missingEnvelope = Effect.runSync(
      Effect.either(
        storageService.upsertMemory({
          spaceId: tenantId,
          memoryId: "memory-i6m4-missing-envelope",
          layer: "episodic",
          payload: {
            title: "Provenance envelope missing should fail policy",
            updatedAtMillis: 1_700_000_021_350,
          },
        })
      )
    );
    const missingEnvelopeFailure = unwrapFailure(missingEnvelope);
    assert.equal(missingEnvelopeFailure._tag, "ContractValidationError");
    assert.match(
      missingEnvelopeFailure.details,
      /payload\.provenance is required for enterprise writes/i
    );

    const missingRequiredDimension = Effect.runSync(
      Effect.either(
        storageService.upsertMemory({
          spaceId: tenantId,
          memoryId: "memory-i6m4-missing-dimension",
          layer: "episodic",
          payload: {
            title: "Provenance sourceId missing should fail policy",
            provenance: {
              tenantId,
              agentId: "agent-i6m4",
            },
            updatedAtMillis: 1_700_000_021_360,
          },
        })
      )
    );
    const missingRequiredDimensionFailure = unwrapFailure(
      missingRequiredDimension
    );
    assert.equal(
      missingRequiredDimensionFailure._tag,
      "ContractValidationError"
    );
    assert.match(
      missingRequiredDimensionFailure.details,
      /payload\.provenance\.sourceId is required/i
    );

    const accepted = Effect.runSync(
      storageService.upsertMemory({
        spaceId: tenantId,
        memoryId: "memory-i6m4-accepted",
        layer: "episodic",
        payload: {
          title: "Provenance policy accepted write",
          provenance: {
            tenantId,
            agentId: "agent-i6m4",
            sourceId: "source-i6m4",
          },
          updatedAtMillis: 1_700_000_021_370,
        },
      })
    );
    assert.equal(accepted.accepted, true);
  } finally {
    db.close();
  }
});

test("ums-memory-i6m.8: sqlite repository runOnInit backfills provenance rows deterministically for legacy records", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const db = new DatabaseSync(":memory:");

  try {
    const tenantId = "tenant-i6m8-backfill";
    const memoryId = "memory-i6m8-legacy";
    const storageService = storageServiceModule.makeSqliteStorageService(db);
    seedScopeLatticeAnchors(db, tenantId, {
      projectIds: ["project-i6m8"],
      roleIds: ["role-i6m8"],
      userIds: ["user-i6m8"],
    });

    Effect.runSync(
      storageService.upsertMemory({
        spaceId: tenantId,
        memoryId,
        layer: "procedural",
        payload: {
          title: "Legacy procedural memory without provenance envelope",
          scope: {
            projectId: "project-i6m8",
            roleId: "role-i6m8",
            userId: "user-i6m8",
          },
          evidencePointers: [
            {
              sourceKind: "event",
              sourceRef: "event://evt-i6m8-a",
              relationKind: "supports",
            },
          ],
          updatedAtMillis: 1_700_000_021_380,
        },
      })
    );

    db.prepare(
      "DELETE FROM memory_provenance_links WHERE tenant_id = ? AND memory_id = ?;"
    ).run(tenantId, memoryId);
    db.prepare(
      [
        "DELETE FROM evidence_provenance_links",
        "WHERE tenant_id = ?",
        "  AND provenance_id NOT IN (SELECT provenance_id FROM memory_provenance_links WHERE tenant_id = ?);",
      ].join("\n")
    ).run(tenantId, tenantId);
    db.prepare(
      "DELETE FROM provenance_envelopes WHERE tenant_id = ? AND provenance_id NOT IN (SELECT provenance_id FROM memory_provenance_links WHERE tenant_id = ?);"
    ).run(tenantId, tenantId);

    storageServiceModule.makeSqliteStorageService(db, {
      applyMigrations: false,
      provenanceBackfill: {
        runOnInit: true,
        defaultSourceIdPrefix: "legacy-backfill",
        defaultBatchId: "batch-i6m8",
      },
    });

    const provenanceRows = sqliteAll<ProvenanceLinkRow>(
      db,
      [
        "SELECT p.provenance_id, p.source_id, p.batch_id, p.project_id, p.role_id, p.user_id",
        "FROM provenance_envelopes p",
        "INNER JOIN memory_provenance_links mpl ON mpl.tenant_id = p.tenant_id AND mpl.provenance_id = p.provenance_id",
        "WHERE p.tenant_id = ? AND mpl.memory_id = ?",
        "ORDER BY p.provenance_id ASC;",
      ].join("\n"),
      tenantId,
      memoryId
    );
    assert.equal(provenanceRows.length, 1);
    const provenanceRow = firstSqliteRow(provenanceRows);
    assert.equal(provenanceRow.source_id, `legacy-backfill:${memoryId}`);
    assert.equal(provenanceRow.batch_id, "batch-i6m8");
    assert.equal(provenanceRow.project_id, "project-i6m8");
    assert.equal(provenanceRow.role_id, "role-i6m8");
    assert.equal(provenanceRow.user_id, "user-i6m8");

    const evidenceLinkRows = sqliteAll<EvidenceProvenanceRow>(
      db,
      [
        "SELECT e.source_ref, epl.provenance_id",
        "FROM evidence_provenance_links epl",
        "INNER JOIN evidence e ON e.tenant_id = epl.tenant_id AND e.evidence_id = epl.evidence_id",
        "WHERE epl.tenant_id = ?",
        "ORDER BY e.source_ref ASC;",
      ].join("\n"),
      tenantId
    );
    assert.equal(evidenceLinkRows.length, 1);
    const evidenceLinkRow = firstSqliteRow(evidenceLinkRows);
    assert.equal(evidenceLinkRow.source_ref, "event://evt-i6m8-a");
    assert.equal(evidenceLinkRow.provenance_id, provenanceRow.provenance_id);

    const auditRows = sqliteAll<ProvenanceLinkRow>(
      db,
      [
        "SELECT details",
        "FROM audit_events",
        "WHERE tenant_id = ? AND memory_id = ? AND operation = 'upsert'",
        "ORDER BY recorded_at_ms ASC;",
      ].join("\n"),
      tenantId,
      memoryId
    );
    assert.ok(
      auditRows.some((row) =>
        String(row.details).startsWith("provenance_backfill:")
      )
    );
  } finally {
    db.close();
  }
});

test("ums-memory-i6m.6: provenance health counters and alerts detect missing links, lineage breaks, and normalization rejects", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const storageRepositoryModule = await loadStorageRepositoryModule();
  const db = new DatabaseSync(":memory:");

  try {
    const tenantId = "tenant-i6m6-health";
    const storageService = storageServiceModule.makeSqliteStorageService(db);
    seedScopeLatticeAnchors(db, tenantId, {
      projectIds: ["project-i6m6"],
      roleIds: ["role-i6m6"],
      userIds: ["user-i6m6"],
    });

    Effect.runSync(
      storageService.upsertMemory({
        spaceId: tenantId,
        memoryId: "memory-i6m6-missing-link",
        layer: "procedural",
        payload: {
          title: "Memory that will lose memory_provenance_links row",
          scope: {
            projectId: "project-i6m6",
            roleId: "role-i6m6",
            userId: "user-i6m6",
          },
          provenance: {
            tenantId,
            projectId: "project-i6m6",
            roleId: "role-i6m6",
            userId: "user-i6m6",
            agentId: "agent-i6m6-a",
            sourceId: "source-i6m6-a",
          },
          evidencePointers: [
            {
              sourceKind: "event",
              sourceRef: "event://evt-i6m6-a",
              relationKind: "supports",
            },
          ],
          updatedAtMillis: 1_700_000_022_000,
        },
      })
    );

    Effect.runSync(
      storageService.upsertMemory({
        spaceId: tenantId,
        memoryId: "memory-i6m6-lineage-break",
        layer: "procedural",
        payload: {
          title:
            "Memory that will keep memory provenance but lose evidence provenance link",
          scope: {
            projectId: "project-i6m6",
            roleId: "role-i6m6",
            userId: "user-i6m6",
          },
          provenance: {
            tenantId,
            projectId: "project-i6m6",
            roleId: "role-i6m6",
            userId: "user-i6m6",
            agentId: "agent-i6m6-b",
            sourceId: "source-i6m6-b",
          },
          evidencePointers: [
            {
              sourceKind: "event",
              sourceRef: "event://evt-i6m6-b",
              relationKind: "supports",
            },
          ],
          updatedAtMillis: 1_700_000_022_100,
        },
      })
    );

    db.prepare(
      "DELETE FROM memory_provenance_links WHERE tenant_id = ? AND memory_id = ?;"
    ).run(tenantId, "memory-i6m6-missing-link");
    db.prepare(
      [
        "DELETE FROM evidence_provenance_links",
        "WHERE tenant_id = ?",
        "  AND evidence_id IN (",
        "    SELECT evidence_id",
        "    FROM memory_evidence_links",
        "    WHERE tenant_id = ? AND memory_id = ?",
        "  );",
      ].join("\n")
    ).run(tenantId, tenantId, "memory-i6m6-lineage-break");

    const invalidEither = Effect.runSync(
      Effect.either(
        storageService.upsertMemory({
          spaceId: tenantId,
          memoryId: "memory-i6m6-reject",
          layer: "working",
          payload: {
            title: "Invalid provenance reject sample",
            provenance: {
              tenantId: "tenant-other",
              sourceId: "source-i6m6-reject",
            },
            updatedAtMillis: 1_700_000_022_200,
          },
        })
      )
    );
    const invalidFailure = unwrapFailure(invalidEither);
    assert.equal(invalidFailure._tag, "ContractValidationError");
    assert.match(invalidFailure.details, /payload\.provenance\.tenantId/i);
    db.prepare(
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
    ).run(
      "audit:i6m6-normalization-reject",
      tenantId,
      "memory-i6m6-normalization-reject",
      "upsert",
      "denied",
      "updated",
      "payload.provenance.tenantId mismatch in test normalization reject sample.",
      null,
      null,
      null,
      1_700_000_022_210
    );

    const healthReport = storageRepositoryModule.evaluateSqliteProvenanceHealth(
      db,
      {
        criticalThresholds: {
          missingProvenanceLinks: 1,
          lineageBreaks: 1,
          normalizationRejects: 1,
        },
      }
    );
    assert.equal(healthReport.counters.scannedMemoryRows, 2);
    assert.equal(healthReport.counters.missingProvenanceLinks, 1);
    assert.equal(healthReport.counters.lineageBreaks, 1);
    assert.ok(healthReport.counters.normalizationRejects >= 1);

    const alertByCode = Object.fromEntries(
      healthReport.alerts.map((alert: any) => [alert.code, alert])
    );
    assert.equal(alertByCode["missing_provenance_links"]?.severity, "critical");
    assert.equal(alertByCode["lineage_breaks"]?.severity, "critical");
    assert.equal(alertByCode["normalization_rejects"]?.severity, "critical");
  } finally {
    db.close();
  }
});

test("ums-memory-5cb.7: promoted procedural memory merges explicit pointers with evidenceEventIds and evidenceEpisodeIds deterministically", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const db = new DatabaseSync(":memory:");

  try {
    const storageService = storageServiceModule.makeSqliteStorageService(db);
    const updatedAtMillis = 1_700_000_024_200;
    Effect.runSync(
      storageService.upsertMemory({
        spaceId: "tenant-promoted-evidence-fallbacks",
        memoryId: "memory-procedural-evidence-fallbacks",
        layer: "procedural",
        payload: {
          title:
            "Procedural memory with explicit and inferred evidence pointers",
          provenance: {
            source: "shadow-replay",
            decisionId: "decision-fallbacks",
          },
          evidencePointers: [
            {
              sourceKind: "event",
              sourceRef: "event://evt-explicit",
              digestSha256: "1".repeat(64),
              relationKind: "supersedes",
            },
          ],
          evidenceEventIds: ["evt-generated"],
          evidenceEpisodeIds: ["evt-episode"],
          updatedAtMillis,
        },
      })
    );

    const joinedRows = sqliteAll<JoinedEvidenceRow>(
      db,
      [
        "SELECT e.source_ref, e.observed_at_ms, e.created_at_ms, l.relation_kind",
        "FROM evidence e",
        "INNER JOIN memory_evidence_links l ON l.tenant_id = e.tenant_id AND l.evidence_id = e.evidence_id",
        "WHERE e.tenant_id = ? AND l.memory_id = ?",
        "ORDER BY e.source_ref ASC;",
      ].join("\n"),
      "tenant-promoted-evidence-fallbacks",
      "memory-procedural-evidence-fallbacks"
    );

    assert.equal(joinedRows.length, 3);
    assert.deepEqual(
      joinedRows.map((row) => row.source_ref),
      ["event://evt-episode", "event://evt-explicit", "event://evt-generated"]
    );
    assert.deepEqual(
      joinedRows.map((row) => row.relation_kind),
      ["supports", "supersedes", "supports"]
    );
    assert.ok(
      joinedRows.every(
        (row) =>
          Number(row.observed_at_ms) === updatedAtMillis &&
          Number(row.created_at_ms) === updatedAtMillis
      )
    );
  } finally {
    db.close();
  }
});

test("ums-memory-5cb.7: promoted procedural memory reconciles evidence links on pointer removal or relation updates", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const db = new DatabaseSync(":memory:");

  try {
    const storageService = storageServiceModule.makeSqliteStorageService(db);
    Effect.runSync(
      storageService.upsertMemory({
        spaceId: "tenant-promoted-evidence-reconcile",
        memoryId: "memory-procedural-evidence-reconcile",
        layer: "procedural",
        payload: {
          title: "Procedural memory with mutable pointer set",
          provenance: {
            source: "shadow-replay",
            decisionId: "decision-reconcile",
          },
          evidencePointers: [
            {
              sourceKind: "event",
              sourceRef: "event://evt-a",
              digestSha256: "d".repeat(64),
              relationKind: "supports",
            },
            {
              sourceKind: "event",
              sourceRef: "event://evt-b",
              digestSha256: "e".repeat(64),
              relationKind: "contradicts",
            },
          ],
          updatedAtMillis: 1_700_000_025_100,
        },
      })
    );

    Effect.runSync(
      storageService.upsertMemory({
        spaceId: "tenant-promoted-evidence-reconcile",
        memoryId: "memory-procedural-evidence-reconcile",
        layer: "procedural",
        payload: {
          title: "Procedural memory after evidence reconciliation",
          provenance: {
            source: "shadow-replay",
            decisionId: "decision-reconcile",
          },
          evidencePointers: [
            {
              sourceKind: "event",
              sourceRef: "event://evt-a",
              digestSha256: "d".repeat(64),
              relationKind: "supersedes",
            },
          ],
          updatedAtMillis: 1_700_000_025_200,
        },
      })
    );

    const linkRows = sqliteAll<
      EvidenceLinkRow & { readonly source_ref: string }
    >(
      db,
      [
        "SELECT e.source_ref, l.relation_kind",
        "FROM memory_evidence_links l",
        "INNER JOIN evidence e ON e.tenant_id = l.tenant_id AND e.evidence_id = l.evidence_id",
        "WHERE l.tenant_id = ? AND l.memory_id = ?",
        "ORDER BY e.source_ref ASC;",
      ].join("\n"),
      "tenant-promoted-evidence-reconcile",
      "memory-procedural-evidence-reconcile"
    );
    const normalizedLinkRows = linkRows.map((row) => ({
      source_ref: row.source_ref,
      relation_kind: row.relation_kind,
    }));
    assert.deepEqual(normalizedLinkRows, [
      {
        source_ref: "event://evt-a",
        relation_kind: "supersedes",
      },
    ]);
  } finally {
    db.close();
  }
});

test("ums-memory-5cb.7: stale procedural replay does not rewrite evidence links when memory upsert is ignored", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const db = new DatabaseSync(":memory:");

  try {
    const storageService = storageServiceModule.makeSqliteStorageService(db);
    const latestUpdatedAtMillis = 1_700_000_026_200;
    const staleUpdatedAtMillis = 1_700_000_026_100;

    const latestResponse = Effect.runSync(
      storageService.upsertMemory({
        spaceId: "tenant-promoted-evidence-stale-replay",
        memoryId: "memory-procedural-evidence-stale-replay",
        layer: "procedural",
        payload: {
          title: "Procedural memory latest pointer set",
          provenance: {
            source: "shadow-replay",
            decisionId: "decision-stale-replay",
          },
          evidencePointers: [
            {
              sourceKind: "event",
              sourceRef: "event://evt-latest",
              digestSha256: "2".repeat(64),
              relationKind: "supports",
            },
          ],
          updatedAtMillis: latestUpdatedAtMillis,
        },
      })
    );

    const staleReplayResponse = Effect.runSync(
      storageService.upsertMemory({
        spaceId: "tenant-promoted-evidence-stale-replay",
        memoryId: "memory-procedural-evidence-stale-replay",
        layer: "procedural",
        payload: {
          title: "Procedural memory stale pointer set",
          provenance: {
            source: "shadow-replay",
            decisionId: "decision-stale-replay",
          },
          evidencePointers: [
            {
              sourceKind: "event",
              sourceRef: "event://evt-stale",
              digestSha256: "3".repeat(64),
              relationKind: "contradicts",
            },
          ],
          updatedAtMillis: staleUpdatedAtMillis,
        },
      })
    );

    assert.equal(latestResponse.persistedAtMillis, latestUpdatedAtMillis);
    assert.equal(staleReplayResponse.persistedAtMillis, latestUpdatedAtMillis);

    const linkRows = sqliteAll<
      EvidenceLinkRow & { readonly source_ref: string }
    >(
      db,
      [
        "SELECT e.source_ref, l.relation_kind",
        "FROM memory_evidence_links l",
        "INNER JOIN evidence e ON e.tenant_id = l.tenant_id AND e.evidence_id = l.evidence_id",
        "WHERE l.tenant_id = ? AND l.memory_id = ?",
        "ORDER BY e.source_ref ASC;",
      ].join("\n"),
      "tenant-promoted-evidence-stale-replay",
      "memory-procedural-evidence-stale-replay"
    );
    const normalizedLinkRows = linkRows.map((row) => ({
      source_ref: row.source_ref,
      relation_kind: row.relation_kind,
    }));
    assert.deepEqual(normalizedLinkRows, [
      {
        source_ref: "event://evt-latest",
        relation_kind: "supports",
      },
    ]);
  } finally {
    db.close();
  }
});

test("ums-memory-5cb.7: promoted procedural provenance metadata is immutable on replay/update", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const db = new DatabaseSync(":memory:");

  try {
    const storageService = storageServiceModule.makeSqliteStorageService(db);
    Effect.runSync(
      storageService.upsertMemory({
        spaceId: "tenant-promoted-provenance-immutable",
        memoryId: "memory-procedural-provenance-immutable",
        layer: "procedural",
        payload: {
          title: "Procedural provenance baseline",
          provenance: {
            source: "shadow-replay",
            decisionId: "decision-1",
          },
          evidencePointers: [
            {
              sourceKind: "event",
              sourceRef: "event://evt-provenance",
              digestSha256: "c".repeat(64),
              relationKind: "supports",
            },
          ],
          updatedAtMillis: 1_700_000_030_100,
        },
      })
    );

    const upsertEither = Effect.runSync(
      Effect.either(
        storageService.upsertMemory({
          spaceId: "tenant-promoted-provenance-immutable",
          memoryId: "memory-procedural-provenance-immutable",
          layer: "procedural",
          payload: {
            title: "Procedural provenance replay should fail",
            provenance: {
              source: "shadow-replay",
              decisionId: "decision-2",
            },
            evidencePointers: [
              {
                sourceKind: "event",
                sourceRef: "event://evt-provenance",
                digestSha256: "c".repeat(64),
                relationKind: "supports",
              },
            ],
            updatedAtMillis: 1_700_000_030_200,
          },
        })
      )
    );
    const upsertFailure = unwrapFailure(upsertEither);

    assert.equal(upsertFailure._tag, "ContractValidationError");
    assert.equal(upsertFailure.contract, "StorageUpsertRequest.payload");
    assert.match(upsertFailure.details, /provenance metadata is immutable/i);

    const persistedPayloadRow = expectSqliteRow(
      sqliteGet<PayloadJsonRow>(
        db,
        "SELECT payload_json FROM memory_items WHERE tenant_id = ? AND memory_id = ?;",
        "tenant-promoted-provenance-immutable",
        "memory-procedural-provenance-immutable"
      )
    );
    const persistedPayload = JSON.parse(persistedPayloadRow.payload_json);
    assert.equal(persistedPayload.provenance.decisionId, "decision-1");
  } finally {
    db.close();
  }
});

test("ums-memory-5cb.7: procedural provenance immutability rejects updates that differ only in redacted values", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const db = new DatabaseSync(":memory:");

  try {
    const storageService = storageServiceModule.makeSqliteStorageService(db);
    Effect.runSync(
      storageService.upsertMemory({
        spaceId: "tenant-promoted-provenance-redaction-immutable",
        memoryId: "memory-procedural-provenance-redaction-immutable",
        layer: "procedural",
        payload: {
          title: "Procedural provenance redaction baseline",
          provenance: {
            source: "shadow-replay",
            ownerEmail: "alpha@example.com",
          },
          evidencePointers: [
            {
              sourceKind: "event",
              sourceRef: "event://evt-provenance-redaction",
              digestSha256: "9".repeat(64),
              relationKind: "supports",
            },
          ],
          updatedAtMillis: 1_700_000_030_150,
        },
      })
    );

    const upsertEither = Effect.runSync(
      Effect.either(
        storageService.upsertMemory({
          spaceId: "tenant-promoted-provenance-redaction-immutable",
          memoryId: "memory-procedural-provenance-redaction-immutable",
          layer: "procedural",
          payload: {
            title: "Procedural provenance redaction changed value",
            provenance: {
              source: "shadow-replay",
              ownerEmail: "beta@example.com",
            },
            evidencePointers: [
              {
                sourceKind: "event",
                sourceRef: "event://evt-provenance-redaction",
                digestSha256: "9".repeat(64),
                relationKind: "supports",
              },
            ],
            updatedAtMillis: 1_700_000_030_151,
          },
        })
      )
    );
    const upsertFailure = unwrapFailure(upsertEither);

    assert.equal(upsertFailure._tag, "ContractValidationError");
    assert.equal(upsertFailure.contract, "StorageUpsertRequest.payload");
    assert.match(upsertFailure.details, /provenance metadata is immutable/i);
  } finally {
    db.close();
  }
});

test("ums-memory-5cb.7: procedural provenance immutability allows unchanged provenance with redactable values", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const db = new DatabaseSync(":memory:");

  try {
    const storageService = storageServiceModule.makeSqliteStorageService(db);
    const request = {
      spaceId: "tenant-promoted-provenance-redaction-unchanged",
      memoryId: "memory-procedural-provenance-redaction-unchanged",
      layer: "procedural",
      payload: {
        title: "Procedural provenance unchanged baseline",
        provenance: {
          source: "shadow-replay",
          ownerEmail: "alpha@example.com",
        },
        evidencePointers: [
          {
            sourceKind: "event",
            sourceRef: "event://evt-provenance-unchanged",
            digestSha256: "8".repeat(64),
            relationKind: "supports",
          },
        ],
        updatedAtMillis: 1_700_000_030_180,
      },
    };

    const firstResponse = Effect.runSync(storageService.upsertMemory(request));
    const replayResponse = Effect.runSync(
      storageService.upsertMemory({
        ...request,
        payload: {
          ...request.payload,
          title: "Procedural provenance unchanged replay title update",
          updatedAtMillis: 1_700_000_030_181,
        },
      })
    );

    assert.equal(firstResponse.accepted, true);
    assert.equal(replayResponse.accepted, true);
  } finally {
    db.close();
  }
});

test("ums-memory-5cb.7: procedural provenance immutability allows unchanged metadata.provenance with redactable values", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const db = new DatabaseSync(":memory:");

  try {
    const storageService = storageServiceModule.makeSqliteStorageService(db);
    const request = {
      spaceId: "tenant-promoted-provenance-metadata-unchanged",
      memoryId: "memory-procedural-provenance-metadata-unchanged",
      layer: "procedural",
      payload: {
        title: "Procedural metadata provenance baseline",
        metadata: {
          provenance: {
            source: "shadow-replay",
            ownerEmail: "alpha@example.com",
          },
        },
        evidencePointers: [
          {
            sourceKind: "event",
            sourceRef: "event://evt-provenance-metadata-unchanged",
            digestSha256: "7".repeat(64),
            relationKind: "supports",
          },
        ],
        updatedAtMillis: 1_700_000_030_190,
      },
    };

    const firstResponse = Effect.runSync(storageService.upsertMemory(request));
    const replayResponse = Effect.runSync(
      storageService.upsertMemory({
        ...request,
        payload: {
          ...request.payload,
          title: "Procedural metadata provenance replay title update",
          updatedAtMillis: 1_700_000_030_191,
        },
      })
    );

    assert.equal(firstResponse.accepted, true);
    assert.equal(replayResponse.accepted, true);
  } finally {
    db.close();
  }
});

test("ums-memory-5cb.7: procedural provenance redaction is stable when replaying persisted redacted secret tokens", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const db = new DatabaseSync(":memory:");

  try {
    const storageService = storageServiceModule.makeSqliteStorageService(db);
    Effect.runSync(
      storageService.upsertMemory({
        spaceId: "tenant-provenance-redacted-token-replay",
        memoryId: "memory-provenance-redacted-token-replay",
        layer: "procedural",
        payload: {
          title: "Procedural provenance token baseline",
          provenance: {
            source: "shadow-replay",
            accessToken: "alpha-secret",
          },
          evidencePointers: [
            {
              sourceKind: "event",
              sourceRef: "event://evt-provenance-redacted-token-replay",
              digestSha256: "1".repeat(64),
              relationKind: "supports",
            },
          ],
          updatedAtMillis: 1_700_000_030_195,
        },
      })
    );

    const firstPersistedPayloadRow = expectSqliteRow(
      sqliteGet<PayloadJsonRow>(
        db,
        "SELECT payload_json FROM memory_items WHERE tenant_id = ? AND memory_id = ?;",
        "tenant-provenance-redacted-token-replay",
        "memory-provenance-redacted-token-replay"
      )
    );
    const firstPersistedPayload = JSON.parse(
      firstPersistedPayloadRow.payload_json
    );
    assert.match(
      firstPersistedPayload.provenance.accessToken,
      redactedTokenPatternByCategory.SECRET
    );
    const firstRedactedToken = firstPersistedPayload.provenance.accessToken;

    const replayResponse = Effect.runSync(
      storageService.upsertMemory({
        spaceId: "tenant-provenance-redacted-token-replay",
        memoryId: "memory-provenance-redacted-token-replay",
        layer: "procedural",
        payload: {
          ...firstPersistedPayload,
          title: "Procedural provenance token replay update",
          updatedAtMillis: 1_700_000_030_196,
        },
      })
    );
    assert.equal(replayResponse.accepted, true);

    const replayPersistedPayloadRow = expectSqliteRow(
      sqliteGet<PayloadJsonRow>(
        db,
        "SELECT payload_json FROM memory_items WHERE tenant_id = ? AND memory_id = ?;",
        "tenant-provenance-redacted-token-replay",
        "memory-provenance-redacted-token-replay"
      )
    );
    const replayPersistedPayload = JSON.parse(
      replayPersistedPayloadRow.payload_json
    );
    assert.equal(
      replayPersistedPayload.provenance.accessToken,
      firstRedactedToken
    );
  } finally {
    db.close();
  }
});

test("ums-memory-5cb.7: procedural provenance immutability tolerates legacy unsanitized persisted payload values", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const db = new DatabaseSync(":memory:");

  try {
    const storageService = storageServiceModule.makeSqliteStorageService(db);
    Effect.runSync(
      storageService.upsertMemory({
        spaceId: "tenant-provenance-legacy-unsanitized",
        memoryId: "memory-provenance-legacy-unsanitized",
        layer: "procedural",
        payload: {
          title: "Legacy-style procedural provenance baseline",
          provenance: {
            source: "shadow-replay",
            ownerEmail: "alpha@example.com",
          },
          evidencePointers: [
            {
              sourceKind: "event",
              sourceRef: "event://evt-provenance-legacy-unsanitized",
              digestSha256: "2".repeat(64),
              relationKind: "supports",
            },
          ],
          updatedAtMillis: 1_700_000_030_197,
        },
      })
    );

    const persistedPayloadRow = expectSqliteRow(
      sqliteGet<PayloadJsonRow>(
        db,
        "SELECT payload_json FROM memory_items WHERE tenant_id = ? AND memory_id = ?;",
        "tenant-provenance-legacy-unsanitized",
        "memory-provenance-legacy-unsanitized"
      )
    );
    const legacyPayload = JSON.parse(persistedPayloadRow.payload_json);
    legacyPayload.provenance.ownerEmail = "alpha@example.com";
    db.prepare(
      "UPDATE memory_items SET payload_json = ? WHERE tenant_id = ? AND memory_id = ?;"
    ).run(
      JSON.stringify(legacyPayload),
      "tenant-provenance-legacy-unsanitized",
      "memory-provenance-legacy-unsanitized"
    );

    const replayResponse = Effect.runSync(
      storageService.upsertMemory({
        spaceId: "tenant-provenance-legacy-unsanitized",
        memoryId: "memory-provenance-legacy-unsanitized",
        layer: "procedural",
        payload: {
          title: "Legacy-style provenance replay",
          provenance: {
            source: "shadow-replay",
            ownerEmail: "alpha@example.com",
          },
          evidencePointers: [
            {
              sourceKind: "event",
              sourceRef: "event://evt-provenance-legacy-unsanitized",
              digestSha256: "2".repeat(64),
              relationKind: "supports",
            },
          ],
          updatedAtMillis: 1_700_000_030_198,
        },
      })
    );
    assert.equal(replayResponse.accepted, true);

    const replayPersistedPayloadRow = expectSqliteRow(
      sqliteGet<PayloadJsonRow>(
        db,
        "SELECT payload_json FROM memory_items WHERE tenant_id = ? AND memory_id = ?;",
        "tenant-provenance-legacy-unsanitized",
        "memory-provenance-legacy-unsanitized"
      )
    );
    const replayPersistedPayload = JSON.parse(
      replayPersistedPayloadRow.payload_json
    );
    assert.match(
      replayPersistedPayload.provenance.ownerEmail,
      redactedTokenPatternByCategory.EMAIL
    );
    assert.ok(
      !replayPersistedPayloadRow.payload_json.includes("alpha@example.com")
    );
  } finally {
    db.close();
  }
});

test("ums-memory-5cb.7: promoted procedural memory can set provenance metadata once when legacy payload has none", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const db = new DatabaseSync(":memory:");

  try {
    const storageService = storageServiceModule.makeSqliteStorageService(db);
    Effect.runSync(
      storageService.upsertMemory({
        spaceId: "tenant-promoted-provenance-bootstrap",
        memoryId: "memory-procedural-provenance-bootstrap",
        layer: "procedural",
        payload: {
          title: "Legacy procedural memory without provenance",
          evidencePointers: [
            {
              sourceKind: "event",
              sourceRef: "event://evt-bootstrap",
              digestSha256: "f".repeat(64),
              relationKind: "supports",
            },
          ],
          updatedAtMillis: 1_700_000_040_100,
        },
      })
    );

    const replayResponse = Effect.runSync(
      storageService.upsertMemory({
        spaceId: "tenant-promoted-provenance-bootstrap",
        memoryId: "memory-procedural-provenance-bootstrap",
        layer: "procedural",
        payload: {
          title: "Procedural memory after provenance bootstrap",
          provenance: {
            source: "shadow-replay",
            decisionId: "decision-bootstrap",
          },
          evidencePointers: [
            {
              sourceKind: "event",
              sourceRef: "event://evt-bootstrap",
              digestSha256: "f".repeat(64),
              relationKind: "supports",
            },
          ],
          updatedAtMillis: 1_700_000_040_200,
        },
      })
    );

    assert.equal(replayResponse.accepted, true);
    const persistedPayloadRow = expectSqliteRow(
      sqliteGet<PayloadJsonRow>(
        db,
        "SELECT payload_json FROM memory_items WHERE tenant_id = ? AND memory_id = ?;",
        "tenant-promoted-provenance-bootstrap",
        "memory-procedural-provenance-bootstrap"
      )
    );
    const persistedPayload = JSON.parse(persistedPayloadRow.payload_json);
    assert.equal(persistedPayload.provenance.decisionId, "decision-bootstrap");
  } finally {
    db.close();
  }
});

test("ums-memory-5cb.4: sqlite storage service resolves common/project/job_role/user scopes when scopeId is omitted", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const db = new DatabaseSync(":memory:");

  try {
    const storageService = storageServiceModule.makeSqliteStorageService(db);
    const tenantId = "tenant-scope-lattice";
    const projectId = "project-alpha";
    const roleId = "role-editor";
    const userId = "user-learner";
    seedScopeLatticeAnchors(db, tenantId, {
      projectIds: [projectId],
      roleIds: [roleId],
      userIds: [userId],
    });

    Effect.runSync(
      storageService.upsertMemory({
        spaceId: tenantId,
        memoryId: "memory-common",
        layer: "working",
        payload: {
          title: "Common fallback write",
          updatedAtMillis: 1_700_000_000_001,
        },
      })
    );
    Effect.runSync(
      storageService.upsertMemory({
        spaceId: tenantId,
        memoryId: "memory-project",
        layer: "working",
        payload: {
          title: "Project anchored write",
          scope: {
            projectId,
          },
          updatedAtMillis: 1_700_000_000_002,
        },
      })
    );
    Effect.runSync(
      storageService.upsertMemory({
        spaceId: tenantId,
        memoryId: "memory-role",
        layer: "working",
        payload: {
          title: "Role anchored write",
          scope: {
            roleId,
          },
          updatedAtMillis: 1_700_000_000_003,
        },
      })
    );
    Effect.runSync(
      storageService.upsertMemory({
        spaceId: tenantId,
        memoryId: "memory-user",
        layer: "working",
        payload: {
          title: "User anchored write",
          scope: {
            userId,
          },
          updatedAtMillis: 1_700_000_000_004,
        },
      })
    );

    const persistedScopeRows = sqliteAll<ScopeMemoryRow>(
      db,
      "SELECT memory_id, scope_id FROM memory_items WHERE tenant_id = ? ORDER BY memory_id ASC;",
      tenantId
    );
    const scopeIdByMemoryId = new Map(
      persistedScopeRows.map((row) => [row.memory_id, row.scope_id])
    );
    assert.equal(scopeIdByMemoryId.get("memory-common"), `common:${tenantId}`);
    assert.equal(
      scopeIdByMemoryId.get("memory-project"),
      `project:${tenantId}:${projectId}`
    );
    assert.equal(
      scopeIdByMemoryId.get("memory-role"),
      `job_role:${tenantId}:${roleId}`
    );
    assert.equal(
      scopeIdByMemoryId.get("memory-user"),
      `user:${tenantId}:${userId}`
    );

    const commonScopeRow = sqliteGet<ScopeRow>(
      db,
      "SELECT scope_id, parent_scope_id FROM scopes WHERE tenant_id = ? AND scope_level = 'common';",
      tenantId
    );
    const projectScopeRow = sqliteGet<ScopeRow>(
      db,
      "SELECT scope_id, parent_scope_id FROM scopes WHERE tenant_id = ? AND scope_level = 'project' AND project_id = ?;",
      tenantId,
      projectId
    );
    const roleScopeRow = sqliteGet<ScopeRow>(
      db,
      "SELECT scope_id, parent_scope_id FROM scopes WHERE tenant_id = ? AND scope_level = 'job_role' AND role_id = ?;",
      tenantId,
      roleId
    );
    const userScopeRow = sqliteGet<ScopeRow>(
      db,
      "SELECT scope_id, parent_scope_id FROM scopes WHERE tenant_id = ? AND scope_level = 'user' AND user_id = ?;",
      tenantId,
      userId
    );

    assert.ok(commonScopeRow);
    assert.ok(projectScopeRow);
    assert.ok(roleScopeRow);
    assert.ok(userScopeRow);
    assert.equal(commonScopeRow.scope_id, `common:${tenantId}`);
    assert.equal(commonScopeRow.parent_scope_id, null);
    assert.equal(projectScopeRow.parent_scope_id, commonScopeRow.scope_id);
    assert.equal(roleScopeRow.parent_scope_id, commonScopeRow.scope_id);
    assert.equal(userScopeRow.parent_scope_id, commonScopeRow.scope_id);
  } finally {
    db.close();
  }
});

test("ums-memory-5cb.4: sqlite storage service applies deterministic precedence and stable scope reuse", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const db = new DatabaseSync(":memory:");

  try {
    const storageService = storageServiceModule.makeSqliteStorageService(db);
    const tenantId = "tenant-scope-precedence";
    const projectId = "project-saturn";
    const roleId = "role-mentor";
    const userId = "user-priority";
    seedScopeLatticeAnchors(db, tenantId, {
      projectIds: [projectId],
      roleIds: [roleId],
      userIds: [userId],
    });

    Effect.runSync(
      storageService.upsertMemory({
        spaceId: tenantId,
        memoryId: "memory-user-priority",
        layer: "working",
        payload: {
          title: "User wins over role and project",
          scope: {
            userId,
            roleId,
            projectId,
          },
          updatedAtMillis: 1_700_000_000_101,
        },
      })
    );
    Effect.runSync(
      storageService.upsertMemory({
        spaceId: tenantId,
        memoryId: "memory-user-replay",
        layer: "working",
        payload: {
          title: "Replay with user-only anchor must reuse existing user scope",
          scope: {
            userId,
          },
          updatedAtMillis: 1_700_000_000_102,
        },
      })
    );
    Effect.runSync(
      storageService.upsertMemory({
        spaceId: tenantId,
        memoryId: "memory-role-priority",
        layer: "working",
        payload: {
          title: "Role wins over project",
          scope: {
            roleId,
            projectId,
          },
          updatedAtMillis: 1_700_000_000_103,
        },
      })
    );
    Effect.runSync(
      storageService.upsertMemory({
        spaceId: tenantId,
        memoryId: "memory-project-priority",
        layer: "working",
        payload: {
          title: "Project wins over common",
          scope: {
            projectId,
          },
          updatedAtMillis: 1_700_000_000_104,
        },
      })
    );

    const scopeIdRows = sqliteAll<ScopeMemoryRow>(
      db,
      "SELECT memory_id, scope_id FROM memory_items WHERE tenant_id = ? ORDER BY memory_id ASC;",
      tenantId
    );
    const scopeIdByMemoryId = new Map(
      scopeIdRows.map((row) => [row.memory_id, row.scope_id])
    );
    assert.equal(
      scopeIdByMemoryId.get("memory-user-priority"),
      `user:${tenantId}:${userId}`
    );
    assert.equal(
      scopeIdByMemoryId.get("memory-user-replay"),
      `user:${tenantId}:${userId}`
    );
    assert.equal(
      scopeIdByMemoryId.get("memory-role-priority"),
      `job_role:${tenantId}:${roleId}`
    );
    assert.equal(
      scopeIdByMemoryId.get("memory-project-priority"),
      `project:${tenantId}:${projectId}`
    );

    const userScopeRow = sqliteGet<ScopeRow>(
      db,
      "SELECT scope_id, parent_scope_id FROM scopes WHERE tenant_id = ? AND scope_level = 'user' AND user_id = ?;",
      tenantId,
      userId
    );
    assert.ok(userScopeRow);
    assert.equal(userScopeRow.scope_id, `user:${tenantId}:${userId}`);
    assert.equal(
      userScopeRow.parent_scope_id,
      `job_role:${tenantId}:${roleId}`
    );

    const scopeCountRows = sqliteAll<ScopeCountRow>(
      db,
      "SELECT scope_level, COUNT(*) AS row_count FROM scopes WHERE tenant_id = ? GROUP BY scope_level ORDER BY scope_level ASC;",
      tenantId
    );
    const rowCountByScopeLevel = new Map(
      scopeCountRows.map((row) => [row.scope_level, Number(row.row_count)])
    );
    assert.equal(rowCountByScopeLevel.get("common"), 1);
    assert.equal(rowCountByScopeLevel.get("project"), 1);
    assert.equal(rowCountByScopeLevel.get("job_role"), 1);
    assert.equal(rowCountByScopeLevel.get("user"), 1);
  } finally {
    db.close();
  }
});

test("ums-memory-5cb.4: createdByUserId remains audit-only and does not select scope", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const db = new DatabaseSync(":memory:");

  try {
    const storageService = storageServiceModule.makeSqliteStorageService(db);
    const tenantId = "tenant-scope-metadata";
    const projectId = "project-meta";
    const roleId = "role-meta";
    const userId = "user-meta";
    seedScopeLatticeAnchors(db, tenantId, {
      projectIds: [projectId],
      roleIds: [roleId],
      userIds: [userId],
    });

    Effect.runSync(
      storageService.upsertMemory({
        spaceId: tenantId,
        memoryId: "memory-metadata-opaque",
        layer: "working",
        payload: {
          title: "createdByUserId should not select scope",
          projectHint: projectId,
          roleHint: roleId,
          userHint: userId,
          createdByUserId: userId,
          updatedAtMillis: 1_700_000_000_150,
        },
      })
    );

    const persistedRow = expectSqliteRow(
      sqliteGet<ScopeIdAuditRow>(
        db,
        "SELECT scope_id, created_by_user_id FROM memory_items WHERE tenant_id = ? AND memory_id = ?;",
        tenantId,
        "memory-metadata-opaque"
      )
    );
    assert.equal(persistedRow.scope_id, `common:${tenantId}`);
    assert.equal(persistedRow.created_by_user_id, userId);
  } finally {
    db.close();
  }
});

test("ums-memory-5cb.4: conflicting user parent anchors fail deterministically", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const db = new DatabaseSync(":memory:");

  try {
    const storageService = storageServiceModule.makeSqliteStorageService(db);
    const tenantId = "tenant-scope-conflict";
    const projectId = "project-conflict";
    const roleId = "role-conflict";
    const userId = "user-conflict";
    seedScopeLatticeAnchors(db, tenantId, {
      projectIds: [projectId],
      roleIds: [roleId],
      userIds: [userId],
    });

    Effect.runSync(
      storageService.upsertMemory({
        spaceId: tenantId,
        memoryId: "memory-user-role-parent",
        layer: "working",
        payload: {
          title: "Creates user scope with role parent",
          scope: {
            userId,
            roleId,
          },
          updatedAtMillis: 1_700_000_000_160,
        },
      })
    );

    const conflictEither = Effect.runSync(
      Effect.either(
        storageService.upsertMemory({
          spaceId: tenantId,
          memoryId: "memory-user-project-parent",
          layer: "working",
          payload: {
            title: "Conflicting parent anchor",
            scope: {
              userId,
              projectId,
            },
            updatedAtMillis: 1_700_000_000_161,
          },
        })
      )
    );
    const conflictFailure = unwrapFailure(conflictEither);

    assert.equal(conflictFailure._tag, "ContractValidationError");
    assert.equal(conflictFailure.contract, "StorageUpsertRequest.payload");
    assert.match(conflictFailure.details, /anchors conflict/i);
  } finally {
    db.close();
  }
});

test("ums-memory-5cb.4: accepts legacy root scopeId when payload.scope is absent", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const db = new DatabaseSync(":memory:");

  try {
    const storageService = storageServiceModule.makeSqliteStorageService(db);
    const tenantId = "tenant-scope-legacy";
    const commonScopeId = `common:${tenantId}`;

    Effect.runSync(
      storageService.upsertMemory({
        spaceId: tenantId,
        memoryId: "memory-bootstrap-common",
        layer: "working",
        payload: {
          title: "Bootstrap common scope",
          updatedAtMillis: 1_700_000_000_169,
        },
      })
    );
    Effect.runSync(
      storageService.upsertMemory({
        spaceId: tenantId,
        memoryId: "memory-legacy-root-scope-id",
        layer: "working",
        payload: {
          title: "Legacy root scope key stays supported",
          scopeId: commonScopeId,
          updatedAtMillis: 1_700_000_000_170,
        },
      })
    );

    const persistedRow = expectSqliteRow(
      sqliteGet<ScopeOnlyRow>(
        db,
        "SELECT scope_id FROM memory_items WHERE tenant_id = ? AND memory_id = ?;",
        tenantId,
        "memory-legacy-root-scope-id"
      )
    );
    assert.equal(persistedRow.scope_id, commonScopeId);
  } finally {
    db.close();
  }
});

test("ums-memory-5cb.4: rejects invalid payload.scope shapes and mixed legacy controls", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const db = new DatabaseSync(":memory:");

  try {
    const storageService = storageServiceModule.makeSqliteStorageService(db);
    const invalidRequests = [
      {
        memoryId: "memory-scope-mixed-legacy",
        payload: {
          title: "Legacy root scope key cannot mix with payload.scope controls",
          scopeId: "common:tenant-scope-shape",
          scope: {
            userId: "user-shape",
          },
          updatedAtMillis: 1_700_000_000_170,
        },
      },
      {
        memoryId: "memory-scope-null",
        payload: {
          title: "Invalid null scope",
          scope: null,
          updatedAtMillis: 1_700_000_000_171,
        },
      },
      {
        memoryId: "memory-scope-array",
        payload: {
          title: "Invalid array scope",
          scope: [],
          updatedAtMillis: 1_700_000_000_172,
        },
      },
      {
        memoryId: "memory-scope-string",
        payload: {
          title: "Invalid string scope",
          scope: "invalid",
          updatedAtMillis: 1_700_000_000_173,
        },
      },
    ];

    for (const invalidRequest of invalidRequests) {
      const upsertEither = Effect.runSync(
        Effect.either(
          storageService.upsertMemory({
            spaceId: "tenant-scope-shape",
            memoryId: invalidRequest.memoryId,
            layer: "working",
            payload: invalidRequest.payload,
          })
        )
      );
      const upsertFailure = unwrapFailure(upsertEither);

      assert.equal(upsertFailure._tag, "ContractValidationError");
      assert.equal(upsertFailure.contract, "StorageUpsertRequest.payload");
      assert.match(upsertFailure.details, /payload\.scope|cannot be combined/i);
    }
  } finally {
    db.close();
  }
});

test("ums-memory-5cb.4: rejects any project/role/user scope anchors with contract validation errors", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const db = new DatabaseSync(":memory:");

  try {
    const storageService = storageServiceModule.makeSqliteStorageService(db);
    const invalidAnchoredRequests = [
      {
        memoryId: "memory-project-anchor-missing",
        payload: {
          title: "Project anchor must exist",
          scope: {
            projectId: "project-missing",
          },
          updatedAtMillis: 1_700_000_000_180,
        },
        expectedAnchor: "project",
      },
      {
        memoryId: "memory-role-anchor-missing",
        payload: {
          title: "Role anchor must exist",
          scope: {
            roleId: "role-missing",
          },
          updatedAtMillis: 1_700_000_000_181,
        },
        expectedAnchor: "role",
      },
      {
        memoryId: "memory-user-anchor-missing",
        payload: {
          title: "User anchor must exist",
          scope: {
            userId: "user-missing",
          },
          updatedAtMillis: 1_700_000_000_182,
        },
        expectedAnchor: "user",
      },
    ];

    for (const requestUnderTest of invalidAnchoredRequests) {
      const upsertEither = Effect.runSync(
        Effect.either(
          storageService.upsertMemory({
            spaceId: "tenant-missing-anchors",
            memoryId: requestUnderTest.memoryId,
            layer: "working",
            payload: requestUnderTest.payload,
          })
        )
      );
      const upsertFailure = unwrapFailure(upsertEither);

      assert.equal(upsertFailure._tag, "ContractValidationError");
      assert.equal(upsertFailure.contract, "StorageUpsertRequest.payload");
      assert.match(
        upsertFailure.details,
        new RegExp(
          `(unknown|any) tenant ${requestUnderTest.expectedAnchor} anchor`,
          "i"
        )
      );
    }
  } finally {
    db.close();
  }
});

test("ums-memory-5cb.4: rejects mixed explicit scopeId and scope anchors", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const db = new DatabaseSync(":memory:");

  try {
    const storageService = storageServiceModule.makeSqliteStorageService(db);
    const upsertEither = Effect.runSync(
      Effect.either(
        storageService.upsertMemory({
          spaceId: "tenant-scope-mixed",
          memoryId: "memory-mixed-scope-controls",
          layer: "working",
          payload: {
            title: "Invalid mixed scope controls",
            scope: {
              scopeId: "user:tenant-scope-mixed:user-a",
              userId: "user-a",
            },
            updatedAtMillis: 1_700_000_000_174,
          },
        })
      )
    );
    const upsertFailure = unwrapFailure(upsertEither);

    assert.equal(upsertFailure._tag, "ContractValidationError");
    assert.equal(upsertFailure.contract, "StorageUpsertRequest.payload");
    assert.match(upsertFailure.details, /cannot be combined/i);
  } finally {
    db.close();
  }
});

test("ums-memory-a9v.2: sqlite storage upsert enforces scope authorization for anchors and explicit scopeId", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const db = new DatabaseSync(":memory:");

  try {
    const storageService = storageServiceModule.makeSqliteStorageService(db);
    const tenantId = "tenant-scope-authz-upsert";
    const projectId = "project-authz-upsert";
    const roleId = "role-authz-upsert";
    const userId = "user-authz-upsert";
    seedScopeLatticeAnchors(db, tenantId, {
      projectIds: [projectId],
      roleIds: [roleId],
      userIds: [userId],
    });

    Effect.runSync(
      storageService.upsertMemory({
        spaceId: tenantId,
        memoryId: "memory-authz-role-bootstrap",
        layer: "working",
        payload: {
          title:
            "bootstrap role scope for explicit scopeId authorization checks",
          scope: {
            roleId,
          },
          updatedAtMillis: 1_700_000_000_200,
        },
      })
    );

    const denyScopeAuthorization = {
      tenantId,
      projectIds: [projectId],
      userIds: [userId],
    };
    const deniedRoleAnchorEither = Effect.runSync(
      Effect.either(
        storageService.upsertMemory({
          spaceId: tenantId,
          memoryId: "memory-authz-denied-role-anchor",
          layer: "working",
          payload: {
            title: "role anchor should be denied by scope authorization matrix",
            scope: {
              roleId,
            },
            updatedAtMillis: 1_700_000_000_201,
          },
          scopeAuthorization: denyScopeAuthorization,
        })
      )
    );
    const deniedRoleAnchorFailure = unwrapFailure(deniedRoleAnchorEither);
    assert.equal(deniedRoleAnchorFailure._tag, "ContractValidationError");
    assert.equal(
      deniedRoleAnchorFailure.contract,
      "StorageScopeAuthorizationGuardrail"
    );
    assert.match(deniedRoleAnchorFailure.details, /role anchor/i);

    const roleScopeId = `job_role:${tenantId}:${roleId}`;
    const deniedScopeIdEither = Effect.runSync(
      Effect.either(
        storageService.upsertMemory({
          spaceId: tenantId,
          memoryId: "memory-authz-denied-explicit-scope-id",
          layer: "working",
          payload: {
            title:
              "explicit role scopeId should be denied by scope authorization matrix",
            scopeId: roleScopeId,
            updatedAtMillis: 1_700_000_000_202,
          },
          scopeAuthorization: denyScopeAuthorization,
        })
      )
    );
    const deniedScopeIdFailure = unwrapFailure(deniedScopeIdEither);
    assert.equal(deniedScopeIdFailure._tag, "ContractValidationError");
    assert.equal(
      deniedScopeIdFailure.contract,
      "StorageScopeAuthorizationGuardrail"
    );
    assert.match(deniedScopeIdFailure.details, /scope .*job_role/i);

    const acceptedProjectResponse = Effect.runSync(
      storageService.upsertMemory({
        spaceId: tenantId,
        memoryId: "memory-authz-allowed-project-anchor",
        layer: "working",
        payload: {
          title:
            "project anchor should be allowed by scope authorization matrix",
          scope: {
            projectId,
          },
          updatedAtMillis: 1_700_000_000_203,
        },
        scopeAuthorization: denyScopeAuthorization,
      })
    );
    assert.equal(acceptedProjectResponse.accepted, true);

    const persistedScopeRow = expectSqliteRow(
      sqliteGet<ScopeOnlyRow>(
        db,
        "SELECT scope_id FROM memory_items WHERE tenant_id = ? AND memory_id = ?;",
        tenantId,
        "memory-authz-allowed-project-anchor"
      )
    );
    assert.equal(
      persistedScopeRow.scope_id,
      `project:${tenantId}:${projectId}`
    );
  } finally {
    db.close();
  }
});

test("ums-memory-a9v.2: sqlite storage delete enforces scope authorization using target memory scope anchors", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const db = new DatabaseSync(":memory:");

  try {
    const storageService = storageServiceModule.makeSqliteStorageService(db);
    const tenantId = "tenant-scope-authz-delete";
    const projectId = "project-authz-delete";
    const roleId = "role-authz-delete";
    seedScopeLatticeAnchors(db, tenantId, {
      projectIds: [projectId],
      roleIds: [roleId],
    });

    Effect.runSync(
      storageService.upsertMemory({
        spaceId: tenantId,
        memoryId: "memory-authz-delete-project",
        layer: "working",
        payload: {
          title: "project scoped delete authorization",
          scope: {
            projectId,
          },
          updatedAtMillis: 1_700_000_000_210,
        },
      })
    );
    Effect.runSync(
      storageService.upsertMemory({
        spaceId: tenantId,
        memoryId: "memory-authz-delete-role",
        layer: "working",
        payload: {
          title: "role scoped delete authorization",
          scope: {
            roleId,
          },
          updatedAtMillis: 1_700_000_000_211,
        },
      })
    );

    const projectOnlyAuthorization = {
      tenantId,
      projectIds: [projectId],
    };
    const deniedDeleteEither = Effect.runSync(
      Effect.either(
        storageService.deleteMemory({
          spaceId: tenantId,
          memoryId: "memory-authz-delete-role",
          scopeAuthorization: projectOnlyAuthorization,
        })
      )
    );
    const deniedDeleteFailure = unwrapFailure(deniedDeleteEither);
    assert.equal(deniedDeleteFailure._tag, "ContractValidationError");
    assert.equal(
      deniedDeleteFailure.contract,
      "StorageScopeAuthorizationGuardrail"
    );
    assert.match(deniedDeleteFailure.details, /scope .*job_role/i);

    const allowedDeleteResponse = Effect.runSync(
      storageService.deleteMemory({
        spaceId: tenantId,
        memoryId: "memory-authz-delete-project",
        scopeAuthorization: projectOnlyAuthorization,
      })
    );
    assert.deepEqual(allowedDeleteResponse, {
      spaceId: tenantId,
      memoryId: "memory-authz-delete-project",
      deleted: true,
    });

    const remainingMemoryRows = sqliteAll<{ readonly memory_id: string }>(
      db,
      "SELECT memory_id FROM memory_items WHERE tenant_id = ? ORDER BY memory_id ASC;",
      tenantId
    );
    assert.deepEqual(
      remainingMemoryRows.map((row) => row.memory_id),
      ["memory-authz-delete-role"]
    );
  } finally {
    db.close();
  }
});

test("ums-memory-5cb.5: upsert denies cross-tenant references and emits audit events", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const db = new DatabaseSync(":memory:");

  try {
    const tenantIsolationEvents: any[] = [];
    const storageService = storageServiceModule.makeSqliteStorageService(db, {
      onTenantIsolationViolation: (event: any) => {
        tenantIsolationEvents.push(event);
      },
    });
    const ownerTenantId = "tenant-owner-guardrail";
    const requesterTenantId = "tenant-requester-guardrail";
    const projectId = "project-cross-tenant";
    const ownerUserId = "user-owner-guardrail";

    seedScopeLatticeAnchors(db, ownerTenantId, {
      projectIds: [projectId],
      userIds: [ownerUserId],
    });
    Effect.runSync(
      storageService.upsertMemory({
        spaceId: ownerTenantId,
        memoryId: "memory-owner-base",
        layer: "working",
        payload: {
          title: "Owner baseline memory",
          updatedAtMillis: 1_700_000_000_190,
        },
      })
    );

    const projectAnchorEither = Effect.runSync(
      Effect.either(
        storageService.upsertMemory({
          spaceId: requesterTenantId,
          memoryId: "memory-cross-project-anchor",
          layer: "working",
          payload: {
            title: "Cross-tenant project anchor",
            scope: {
              projectId,
            },
            updatedAtMillis: 1_700_000_000_191,
          },
        })
      )
    );
    const projectAnchorFailure = unwrapFailure(projectAnchorEither);
    assert.equal(projectAnchorFailure._tag, "ContractValidationError");
    assert.equal(
      projectAnchorFailure.contract,
      "StorageTenantIsolationGuardrail"
    );

    const scopeIdEither = Effect.runSync(
      Effect.either(
        storageService.upsertMemory({
          spaceId: requesterTenantId,
          memoryId: "memory-cross-scope-id",
          layer: "working",
          payload: {
            title: "Cross-tenant explicit scope",
            scopeId: `common:${ownerTenantId}`,
            updatedAtMillis: 1_700_000_000_192,
          },
        })
      )
    );
    const scopeIdFailure = unwrapFailure(scopeIdEither);
    assert.equal(scopeIdFailure._tag, "ContractValidationError");
    assert.equal(scopeIdFailure.contract, "StorageTenantIsolationGuardrail");

    const supersedesEither = Effect.runSync(
      Effect.either(
        storageService.upsertMemory({
          spaceId: requesterTenantId,
          memoryId: "memory-cross-supersedes",
          layer: "working",
          payload: {
            title: "Cross-tenant supersedes reference",
            supersedesMemoryId: "memory-owner-base",
            updatedAtMillis: 1_700_000_000_193,
          },
        })
      )
    );
    const supersedesFailure = unwrapFailure(supersedesEither);
    assert.equal(supersedesFailure._tag, "ContractValidationError");
    assert.equal(supersedesFailure.contract, "StorageTenantIsolationGuardrail");

    const repeatedProjectAnchorEither = Effect.runSync(
      Effect.either(
        storageService.upsertMemory({
          spaceId: requesterTenantId,
          memoryId: "memory-cross-project-anchor",
          layer: "working",
          payload: {
            title: "Cross-tenant project anchor",
            scope: {
              projectId,
            },
            updatedAtMillis: 1_700_000_000_191,
          },
        })
      )
    );
    const repeatedProjectAnchorFailure = unwrapFailure(
      repeatedProjectAnchorEither
    );
    assert.equal(repeatedProjectAnchorFailure._tag, "ContractValidationError");
    assert.equal(
      repeatedProjectAnchorFailure.contract,
      "StorageTenantIsolationGuardrail"
    );

    assert.equal(tenantIsolationEvents.length, 4);
    assert.equal(tenantIsolationEvents[0].operation, "upsert");
    assert.equal(tenantIsolationEvents[0].spaceId, requesterTenantId);
    assert.equal(
      tenantIsolationEvents[0].memoryId,
      "memory-cross-project-anchor"
    );
    assert.equal(tenantIsolationEvents[0].referenceKind, "project");
    assert.equal(tenantIsolationEvents[0].referenceId, projectId);
    assert.equal(tenantIsolationEvents[0].ownerTenantId, ownerTenantId);
    assert.equal(tenantIsolationEvents[0].reason, "cross_tenant_reference");

    assert.equal(tenantIsolationEvents[1].operation, "upsert");
    assert.equal(tenantIsolationEvents[1].spaceId, requesterTenantId);
    assert.equal(tenantIsolationEvents[1].memoryId, "memory-cross-scope-id");
    assert.equal(tenantIsolationEvents[1].referenceKind, "scope");
    assert.equal(
      tenantIsolationEvents[1].referenceId,
      `common:${ownerTenantId}`
    );
    assert.equal(tenantIsolationEvents[1].ownerTenantId, ownerTenantId);
    assert.equal(tenantIsolationEvents[1].reason, "cross_tenant_reference");

    assert.equal(tenantIsolationEvents[2].operation, "upsert");
    assert.equal(tenantIsolationEvents[2].spaceId, requesterTenantId);
    assert.equal(tenantIsolationEvents[2].memoryId, "memory-cross-supersedes");
    assert.equal(tenantIsolationEvents[2].referenceKind, "supersedes_memory");
    assert.equal(tenantIsolationEvents[2].referenceId, "memory-owner-base");
    assert.equal(tenantIsolationEvents[2].ownerTenantId, ownerTenantId);
    assert.equal(tenantIsolationEvents[2].reason, "cross_tenant_reference");
    assert.equal(tenantIsolationEvents[3].operation, "upsert");
    assert.equal(tenantIsolationEvents[3].spaceId, requesterTenantId);
    assert.equal(
      tenantIsolationEvents[3].memoryId,
      "memory-cross-project-anchor"
    );
    assert.equal(tenantIsolationEvents[3].referenceKind, "project");
    assert.equal(tenantIsolationEvents[3].referenceId, projectId);
    assert.equal(tenantIsolationEvents[3].ownerTenantId, ownerTenantId);
    assert.equal(tenantIsolationEvents[3].reason, "cross_tenant_reference");

    const persistedAuditRows = sqliteAll<AuditEventRow>(
      db,
      [
        "SELECT operation, outcome, reason, reference_kind, reference_id, owner_tenant_id",
        "FROM audit_events",
        "WHERE tenant_id = ?",
        "ORDER BY event_id ASC;",
      ].join("\n"),
      requesterTenantId
    );
    assert.equal(persistedAuditRows.length, 4);
    assert.ok(persistedAuditRows.every((row) => row.operation === "upsert"));
    assert.ok(persistedAuditRows.every((row) => row.outcome === "denied"));
    assert.ok(
      persistedAuditRows.every((row) => row.reason === "cross_tenant_reference")
    );
    assert.equal(
      persistedAuditRows.filter((row) => row.reference_kind === "project")
        .length,
      2
    );
    assert.ok(
      persistedAuditRows.every((row) => row.owner_tenant_id === ownerTenantId)
    );
  } finally {
    db.close();
  }
});

test("ums-memory-5cb.5: delete keeps not-found semantics and audits cross-tenant probes", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const db = new DatabaseSync(":memory:");

  try {
    const tenantIsolationEvents: any[] = [];
    const storageService = storageServiceModule.makeSqliteStorageService(db, {
      onTenantIsolationViolation: (event: any) => {
        tenantIsolationEvents.push(event);
      },
    });
    const ownerTenantId = "tenant-owner-delete";
    const requesterTenantId = "tenant-requester-delete";
    const memoryId = "memory-cross-delete-probe";

    Effect.runSync(
      storageService.upsertMemory({
        spaceId: ownerTenantId,
        memoryId,
        layer: "working",
        payload: {
          title: "Owner delete probe memory",
          updatedAtMillis: 1_700_000_000_194,
        },
      })
    );

    const deleteEither = Effect.runSync(
      Effect.either(
        storageService.deleteMemory({
          spaceId: requesterTenantId,
          memoryId,
        })
      )
    );
    const deleteFailure = unwrapFailure(deleteEither);
    assert.equal(deleteFailure._tag, "StorageNotFoundError");
    assert.equal(deleteFailure.spaceId, requesterTenantId);
    assert.equal(deleteFailure.memoryId, memoryId);

    assert.equal(tenantIsolationEvents.length, 1);
    assert.equal(tenantIsolationEvents[0].operation, "delete");
    assert.equal(tenantIsolationEvents[0].spaceId, requesterTenantId);
    assert.equal(tenantIsolationEvents[0].memoryId, memoryId);
    assert.equal(tenantIsolationEvents[0].referenceKind, "memory");
    assert.equal(tenantIsolationEvents[0].referenceId, memoryId);
    assert.equal(tenantIsolationEvents[0].ownerTenantId, ownerTenantId);
    assert.equal(tenantIsolationEvents[0].reason, "cross_tenant_delete_probe");

    const persistedAuditRows = sqliteAll<AuditEventRow>(
      db,
      [
        "SELECT operation, outcome, reason, reference_kind, reference_id, owner_tenant_id",
        "FROM audit_events",
        "WHERE tenant_id = ? AND memory_id = ?;",
      ].join("\n"),
      requesterTenantId,
      memoryId
    );
    assert.equal(persistedAuditRows.length, 1);
    const persistedAuditRow = firstSqliteRow(persistedAuditRows);
    assert.equal(persistedAuditRow.operation, "delete");
    assert.equal(persistedAuditRow.outcome, "not_found");
    assert.equal(persistedAuditRow.reason, "cross_tenant_delete_probe");
    assert.equal(persistedAuditRow.reference_kind, "memory");
    assert.equal(persistedAuditRow.reference_id, memoryId);
    assert.equal(persistedAuditRow.owner_tenant_id, ownerTenantId);
  } finally {
    db.close();
  }
});

test("ums-memory-5cb.3: sqlite storage service upsert maps payload deterministically and delete succeeds", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const db = new DatabaseSync(":memory:");

  try {
    const storageService = storageServiceModule.makeSqliteStorageService(db);
    const firstResponse = Effect.runSync(
      storageService.upsertMemory({
        spaceId: "tenant-storage",
        memoryId: "memory-a",
        layer: "working",
        payload: {
          updatedAtMillis: 1_700_000_000_200,
          title: "Deterministic Storage Item",
          memoryKind: "summary",
          nested: {
            zed: 3,
            alpha: 1,
          },
          createdAtMillis: 1_700_000_000_100,
          tags: ["alpha", "beta"],
        },
      })
    );
    assert.equal(firstResponse.spaceId, "tenant-storage");
    assert.equal(firstResponse.memoryId, "memory-a");
    assert.equal(firstResponse.accepted, true);
    assert.equal(firstResponse.persistedAtMillis, 1_700_000_000_200);
    assert.equal(firstResponse.version, 1);

    const initialPersistedRow = expectSqliteRow(
      sqliteGet<StorageMemoryRow>(
        db,
        [
          "SELECT",
          "  tenant_id,",
          "  memory_id,",
          "  scope_id,",
          "  memory_layer,",
          "  memory_kind,",
          "  status,",
          "  title,",
          "  payload_json,",
          "  created_at_ms,",
          "  updated_at_ms,",
          "  tombstoned_at_ms",
          "FROM memory_items",
          "WHERE tenant_id = ? AND memory_id = ?;",
        ].join("\n"),
        "tenant-storage",
        "memory-a"
      )
    );
    assert.equal(initialPersistedRow.scope_id, "common:tenant-storage");
    assert.equal(initialPersistedRow.memory_layer, "working");
    assert.equal(initialPersistedRow.memory_kind, "summary");
    assert.equal(initialPersistedRow.status, "active");
    assert.equal(initialPersistedRow.title, "Deterministic Storage Item");
    assert.equal(initialPersistedRow.created_at_ms, 1_700_000_000_100);
    assert.equal(initialPersistedRow.updated_at_ms, 1_700_000_000_200);
    assert.equal(initialPersistedRow.tombstoned_at_ms, null);
    assert.equal(
      initialPersistedRow.payload_json,
      '{"createdAtMillis":1700000000100,"memoryKind":"summary","nested":{"alpha":1,"zed":3},"tags":["alpha","beta"],"title":"Deterministic Storage Item","updatedAtMillis":1700000000200}'
    );

    const secondResponse = Effect.runSync(
      storageService.upsertMemory({
        spaceId: "tenant-storage",
        memoryId: "memory-a",
        layer: "working",
        payload: {
          title: "Deterministic Storage Item (tombstoned)",
          status: "tombstoned",
          createdAtMillis: 1_700_000_000_100,
          updatedAtMillis: 1_700_000_000_400,
          tombstonedAtMillis: 1_700_000_000_350,
        },
      })
    );

    assert.equal(secondResponse.accepted, true);
    assert.equal(secondResponse.persistedAtMillis, 1_700_000_000_400);
    assert.equal(secondResponse.version, 1);

    const staleReplayResponse = Effect.runSync(
      storageService.upsertMemory({
        spaceId: "tenant-storage",
        memoryId: "memory-a",
        layer: "working",
        payload: {
          title: "Stale Replay Should Not Override",
          status: "active",
          createdAtMillis: 1_700_000_000_100,
          updatedAtMillis: 1_700_000_000_300,
        },
      })
    );

    assert.equal(staleReplayResponse.accepted, true);
    assert.equal(staleReplayResponse.persistedAtMillis, 1_700_000_000_400);
    assert.equal(staleReplayResponse.version, 1);

    const equalTimestampReplayResponse = Effect.runSync(
      storageService.upsertMemory({
        spaceId: "tenant-storage",
        memoryId: "memory-a",
        layer: "working",
        payload: {
          title: "Equal Timestamp Replay Should Not Override",
          status: "active",
          createdAtMillis: 1_700_000_000_100,
          updatedAtMillis: 1_700_000_000_400,
        },
      })
    );

    assert.equal(equalTimestampReplayResponse.accepted, true);
    assert.equal(
      equalTimestampReplayResponse.persistedAtMillis,
      1_700_000_000_400
    );
    assert.equal(equalTimestampReplayResponse.version, 1);

    const duplicateStaleReplayResponse = Effect.runSync(
      storageService.upsertMemory({
        spaceId: "tenant-storage",
        memoryId: "memory-a",
        layer: "working",
        payload: {
          title: "Stale Replay Should Not Override",
          status: "active",
          createdAtMillis: 1_700_000_000_100,
          updatedAtMillis: 1_700_000_000_300,
        },
      })
    );
    assert.equal(duplicateStaleReplayResponse.accepted, true);
    assert.equal(
      duplicateStaleReplayResponse.persistedAtMillis,
      1_700_000_000_400
    );

    const duplicateEqualTimestampReplayResponse = Effect.runSync(
      storageService.upsertMemory({
        spaceId: "tenant-storage",
        memoryId: "memory-a",
        layer: "working",
        payload: {
          title: "Equal Timestamp Replay Should Not Override",
          status: "active",
          createdAtMillis: 1_700_000_000_100,
          updatedAtMillis: 1_700_000_000_400,
        },
      })
    );
    assert.equal(duplicateEqualTimestampReplayResponse.accepted, true);
    assert.equal(
      duplicateEqualTimestampReplayResponse.persistedAtMillis,
      1_700_000_000_400
    );

    const rowCountAfterUpsert = expectSqliteRow(
      sqliteGet<RowCountRow>(
        db,
        "SELECT COUNT(*) AS row_count FROM memory_items WHERE tenant_id = ? AND memory_id = ?;",
        "tenant-storage",
        "memory-a"
      )
    );
    assert.equal(rowCountAfterUpsert.row_count, 1);

    const tombstonedRow = expectSqliteRow(
      sqliteGet<TombstonedMemoryRow>(
        db,
        "SELECT status, title, updated_at_ms, tombstoned_at_ms FROM memory_items WHERE tenant_id = ? AND memory_id = ?;",
        "tenant-storage",
        "memory-a"
      )
    );
    assert.equal(tombstonedRow.status, "tombstoned");
    assert.equal(
      tombstonedRow.title,
      "Deterministic Storage Item (tombstoned)"
    );
    assert.equal(tombstonedRow.updated_at_ms, 1_700_000_000_400);
    assert.equal(tombstonedRow.tombstoned_at_ms, 1_700_000_000_350);

    const persistedPayloadRow = expectSqliteRow(
      sqliteGet<PayloadJsonRow>(
        db,
        "SELECT payload_json FROM memory_items WHERE tenant_id = ? AND memory_id = ?;",
        "tenant-storage",
        "memory-a"
      )
    );
    assert.equal(
      persistedPayloadRow.payload_json,
      '{"createdAtMillis":1700000000100,"status":"tombstoned","title":"Deterministic Storage Item (tombstoned)","tombstonedAtMillis":1700000000350,"updatedAtMillis":1700000000400}'
    );

    const deleteResponse = Effect.runSync(
      storageService.deleteMemory({
        spaceId: "tenant-storage",
        memoryId: "memory-a",
      })
    );
    assert.deepEqual(deleteResponse, {
      spaceId: "tenant-storage",
      memoryId: "memory-a",
      deleted: true,
    });

    const rowCountAfterDelete = expectSqliteRow(
      sqliteGet<RowCountRow>(
        db,
        "SELECT COUNT(*) AS row_count FROM memory_items WHERE tenant_id = ? AND memory_id = ?;",
        "tenant-storage",
        "memory-a"
      )
    );
    assert.equal(rowCountAfterDelete.row_count, 0);

    const persistedAuditRows = sqliteAll<AuditEventRow>(
      db,
      [
        "SELECT operation, outcome, reason, recorded_at_ms",
        "FROM audit_events",
        "WHERE tenant_id = ? AND memory_id = ?",
        "ORDER BY operation ASC, reason ASC;",
      ].join("\n"),
      "tenant-storage",
      "memory-a"
    );
    assert.equal(persistedAuditRows.length, 5);
    assert.deepEqual(
      persistedAuditRows.map((row) => row.reason),
      ["deleted", "equal_replay", "inserted", "stale_replay", "updated"]
    );
    assert.ok(persistedAuditRows.every((row) => row.outcome === "accepted"));
    assert.equal(
      persistedAuditRows.filter((row) => row.reason === "stale_replay").length,
      1
    );
    assert.equal(
      persistedAuditRows.filter((row) => row.reason === "equal_replay").length,
      1
    );
  } finally {
    db.close();
  }
});

test("ums-memory-5cb.3: sqlite storage service maps missing deletes to StorageNotFoundError", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const db = new DatabaseSync(":memory:");

  try {
    const storageService = storageServiceModule.makeSqliteStorageService(db);
    const deleteEither = Effect.runSync(
      Effect.either(
        storageService.deleteMemory({
          spaceId: "tenant-storage",
          memoryId: "any-memory",
        })
      )
    );
    const deleteFailure = unwrapFailure(deleteEither);

    assert.equal(deleteFailure._tag, "StorageNotFoundError");
    assert.equal(deleteFailure.spaceId, "tenant-storage");
    assert.equal(deleteFailure.memoryId, "any-memory");

    const replayDeleteEither = Effect.runSync(
      Effect.either(
        storageService.deleteMemory({
          spaceId: "tenant-storage",
          memoryId: "any-memory",
        })
      )
    );
    const replayDeleteFailure = unwrapFailure(replayDeleteEither);
    assert.equal(replayDeleteFailure._tag, "StorageNotFoundError");
    assert.equal(replayDeleteFailure.spaceId, "tenant-storage");
    assert.equal(replayDeleteFailure.memoryId, "any-memory");

    const persistedAuditRows = sqliteAll<AuditEventRow>(
      db,
      [
        "SELECT operation, outcome, reason, reference_kind, reference_id, owner_tenant_id",
        "FROM audit_events",
        "WHERE tenant_id = ? AND memory_id = ?;",
      ].join("\n"),
      "tenant-storage",
      "any-memory"
    );
    assert.equal(persistedAuditRows.length, 2);
    assert.ok(persistedAuditRows.every((row) => row.operation === "delete"));
    assert.ok(persistedAuditRows.every((row) => row.outcome === "not_found"));
    assert.ok(
      persistedAuditRows.every((row) => row.reason === "memory_not_found")
    );
    assert.ok(persistedAuditRows.every((row) => row.reference_kind === null));
    assert.ok(persistedAuditRows.every((row) => row.reference_id === null));
    assert.ok(persistedAuditRows.every((row) => row.owner_tenant_id === null));
  } finally {
    db.close();
  }
});

test("ums-memory-a9v.3: sqlite storage redacts secret and pii-like payload content before persistence", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const db = new DatabaseSync(":memory:");

  try {
    const storageService = storageServiceModule.makeSqliteStorageService(db);
    Effect.runSync(
      storageService.upsertMemory({
        spaceId: "tenant-redaction-basics",
        memoryId: "memory-redaction-basics",
        layer: "working",
        payload: {
          title: "Credential dump password=hunter2",
          notes:
            "Reach owner@example.com or +1 (415) 555-2671. api_key=alpha-secret token=beta-secret sk-abcdef1234567890 sk-proj-ABCDEF1234567890xyz",
          scope: {
            note: "scope contact owner@example.com token=scope-secret",
          },
          credentials: {
            password: "hunter2",
            token: "abc123",
          },
          updatedAtMillis: 1_700_000_110_100,
        },
      })
    );

    const persistedMemoryRow = expectSqliteRow(
      sqliteGet<TitlePayloadRow>(
        db,
        "SELECT title, payload_json FROM memory_items WHERE tenant_id = ? AND memory_id = ?;",
        "tenant-redaction-basics",
        "memory-redaction-basics"
      )
    );
    assert.match(
      persistedMemoryRow.title,
      /^Credential dump password=\[REDACTED_SECRET:[0-9a-f]{12,64}\]$/
    );

    const persistedPayload = JSON.parse(persistedMemoryRow.payload_json);
    const persistedPayloadJson = JSON.stringify(persistedPayload);
    assert.ok(containsRedactedTokenCategory(persistedPayloadJson, "SECRET"));
    assert.ok(containsRedactedTokenCategory(persistedPayloadJson, "EMAIL"));
    assert.ok(containsRedactedTokenCategory(persistedPayloadJson, "PHONE"));
    assert.ok(!persistedPayloadJson.includes("hunter2"));
    assert.ok(!persistedPayloadJson.includes("owner@example.com"));
    assert.ok(!persistedPayloadJson.includes("+1 (415) 555-2671"));
    assert.ok(!persistedPayloadJson.includes("alpha-secret"));
    assert.ok(!persistedPayloadJson.includes("beta-secret"));
    assert.ok(!persistedPayloadJson.includes("sk-abcdef1234567890"));
    assert.ok(!persistedPayloadJson.includes("sk-proj-ABCDEF1234567890xyz"));
    assert.ok(!persistedPayloadJson.includes("scope-secret"));
    assert.ok(
      !persistedPayloadJson.includes("scope contact owner@example.com")
    );
    assert.ok(!persistedPayloadJson.includes('"password":"hunter2"'));
    assert.ok(!persistedPayloadJson.includes('"token":"abc123"'));
    assert.match(
      persistedPayload.scope.note,
      /^scope contact \[REDACTED_EMAIL:[0-9a-f]{12,64}\] token=\[REDACTED_SECRET:[0-9a-f]{12,64}\]$/
    );
    assert.match(
      persistedPayload.credentials.password,
      redactedTokenPatternByCategory.SECRET
    );
    assert.match(
      persistedPayload.credentials.token,
      redactedTokenPatternByCategory.SECRET
    );
  } finally {
    db.close();
  }
});

test("ums-memory-a9v.3: sqlite storage redacts quoted multi-word secret assignments", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const db = new DatabaseSync(":memory:");

  try {
    const storageService = storageServiceModule.makeSqliteStorageService(db);
    Effect.runSync(
      storageService.upsertMemory({
        spaceId: "tenant-redaction-quoted-secret",
        memoryId: "memory-redaction-quoted-secret",
        layer: "working",
        payload: {
          title: 'Quoted passphrase="alpha beta gamma"',
          notes: "token='multi word secret value'",
          updatedAtMillis: 1_700_000_110_150,
        },
      })
    );

    const persistedMemoryRow = expectSqliteRow(
      sqliteGet<TitlePayloadRow>(
        db,
        "SELECT title, payload_json FROM memory_items WHERE tenant_id = ? AND memory_id = ?;",
        "tenant-redaction-quoted-secret",
        "memory-redaction-quoted-secret"
      )
    );
    assert.ok(!persistedMemoryRow.title.includes("alpha beta gamma"));
    assert.match(
      persistedMemoryRow.title,
      /^Quoted passphrase="\[REDACTED_SECRET:[0-9a-f]{12,64}\]"$/
    );
    assert.ok(
      !persistedMemoryRow.payload_json.includes("multi word secret value")
    );
    assert.ok(
      containsRedactedTokenCategory(persistedMemoryRow.payload_json, "SECRET")
    );
  } finally {
    db.close();
  }
});

test("ums-memory-a9v.3: sqlite storage does not over-redact benign token-like field names", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const db = new DatabaseSync(":memory:");

  try {
    const storageService = storageServiceModule.makeSqliteStorageService(db);
    Effect.runSync(
      storageService.upsertMemory({
        spaceId: "tenant-redaction-benign-field-names",
        memoryId: "memory-redaction-benign-field-names",
        layer: "working",
        payload: {
          title: "Benign field-name redaction boundaries",
          stats: {
            tokenCount: "42",
            detokenized: "hello-world",
            accessToken: "abc123",
          },
          updatedAtMillis: 1_700_000_110_160,
        },
      })
    );

    const persistedMemoryRow = expectSqliteRow(
      sqliteGet<PayloadJsonRow>(
        db,
        "SELECT payload_json FROM memory_items WHERE tenant_id = ? AND memory_id = ?;",
        "tenant-redaction-benign-field-names",
        "memory-redaction-benign-field-names"
      )
    );
    const persistedPayload = JSON.parse(persistedMemoryRow.payload_json);
    assert.equal(persistedPayload.stats.tokenCount, "42");
    assert.equal(persistedPayload.stats.detokenized, "hello-world");
    assert.match(
      persistedPayload.stats.accessToken,
      redactedTokenPatternByCategory.SECRET
    );
  } finally {
    db.close();
  }
});

test("ums-memory-a9v.3: sqlite storage keeps evidence traceability fields while redacting evidence payload content", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const db = new DatabaseSync(":memory:");

  try {
    const storageService = storageServiceModule.makeSqliteStorageService(db);
    Effect.runSync(
      storageService.upsertMemory({
        spaceId: "tenant-redaction-traceability",
        memoryId: "memory-redaction-traceability",
        layer: "procedural",
        payload: {
          title: "Procedural evidence redaction token=raw-secret",
          provenance: {
            source: "shadow-replay",
            decisionId: "decision-traceability",
          },
          evidencePointers: [
            {
              sourceKind: "event",
              sourceRef: "event://evt-trace-001",
              digestSha256: "a".repeat(64),
              relationKind: "supports",
              payload: {
                note: "Contact analyst@example.com at +1 650-555-0100 token=trace-secret",
                sourceRef: "mailto:analyst@example.com",
              },
            },
          ],
          updatedAtMillis: 1_700_000_110_200,
        },
      })
    );

    const evidenceRow = expectSqliteRow(
      sqliteGet<EvidenceRow>(
        db,
        [
          "SELECT source_ref, digest_sha256, payload_json",
          "FROM evidence",
          "WHERE tenant_id = ?;",
        ].join("\n"),
        "tenant-redaction-traceability"
      )
    );
    assert.equal(evidenceRow.source_ref, "event://evt-trace-001");
    assert.equal(evidenceRow.digest_sha256, "a".repeat(64));
    assert.ok(!evidenceRow.payload_json.includes("analyst@example.com"));
    assert.ok(!evidenceRow.payload_json.includes("+1 650-555-0100"));
    assert.ok(!evidenceRow.payload_json.includes("trace-secret"));
    assert.ok(containsRedactedTokenCategory(evidenceRow.payload_json, "EMAIL"));
    assert.ok(containsRedactedTokenCategory(evidenceRow.payload_json, "PHONE"));
    assert.ok(
      containsRedactedTokenCategory(evidenceRow.payload_json, "SECRET")
    );

    const persistedMemoryRow = expectSqliteRow(
      sqliteGet<PayloadJsonRow>(
        db,
        "SELECT payload_json FROM memory_items WHERE tenant_id = ? AND memory_id = ?;",
        "tenant-redaction-traceability",
        "memory-redaction-traceability"
      )
    );
    const persistedPayload = JSON.parse(persistedMemoryRow.payload_json);
    assert.equal(
      persistedPayload.evidencePointers[0].sourceRef,
      "event://evt-trace-001"
    );
    assert.equal(
      persistedPayload.evidencePointers[0].digestSha256,
      "a".repeat(64)
    );
    assert.ok(
      containsRedactedTokenCategory(
        persistedPayload.evidencePointers[0].payload.note,
        "EMAIL"
      )
    );
    assert.ok(
      containsRedactedTokenCategory(
        persistedPayload.evidencePointers[0].payload.note,
        "PHONE"
      )
    );
    assert.ok(
      containsRedactedTokenCategory(
        persistedPayload.evidencePointers[0].payload.note,
        "SECRET"
      )
    );
    assert.match(
      persistedPayload.evidencePointers[0].payload.sourceRef,
      /^mailto:\[REDACTED_EMAIL:[0-9a-f]{12,64}\]$/
    );

    const evidenceLinkRow = expectSqliteRow(
      sqliteGet<EvidenceLinkRow>(
        db,
        [
          "SELECT relation_kind",
          "FROM memory_evidence_links",
          "WHERE tenant_id = ? AND memory_id = ?;",
        ].join("\n"),
        "tenant-redaction-traceability",
        "memory-redaction-traceability"
      )
    );
    assert.equal(evidenceLinkRow.relation_kind, "supports");
  } finally {
    db.close();
  }
});

test("ums-memory-a9v.3: sqlite storage preserves ref/reference alias traceability fields on replay", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const db = new DatabaseSync(":memory:");

  try {
    const storageService = storageServiceModule.makeSqliteStorageService(db);
    Effect.runSync(
      storageService.upsertMemory({
        spaceId: "tenant-redaction-traceability-alias",
        memoryId: "memory-redaction-traceability-alias",
        layer: "procedural",
        payload: {
          title: "Procedural evidence alias replay baseline",
          provenance: {
            source: "shadow-replay",
            decisionId: "decision-traceability-alias",
          },
          evidencePointers: [
            {
              sourceKind: "event",
              ref: "mailto:analyst@example.com",
              relationKind: "supports",
              payload: {
                note: "token=alias-secret owner=analyst@example.com",
              },
            },
          ],
          updatedAtMillis: 1_700_000_110_220,
        },
      })
    );

    const persistedMemoryRow = expectSqliteRow(
      sqliteGet<PayloadJsonRow>(
        db,
        "SELECT payload_json FROM memory_items WHERE tenant_id = ? AND memory_id = ?;",
        "tenant-redaction-traceability-alias",
        "memory-redaction-traceability-alias"
      )
    );
    const persistedPayload = JSON.parse(persistedMemoryRow.payload_json);
    assert.equal(
      persistedPayload.evidencePointers[0].ref,
      "mailto:analyst@example.com"
    );

    const replayResponse = Effect.runSync(
      storageService.upsertMemory({
        spaceId: "tenant-redaction-traceability-alias",
        memoryId: "memory-redaction-traceability-alias",
        layer: "procedural",
        payload: {
          ...persistedPayload,
          updatedAtMillis: 1_700_000_110_221,
        },
      })
    );
    assert.equal(replayResponse.accepted, true);

    const sourceRefRows = sqliteAll<{ readonly source_ref: string }>(
      db,
      [
        "SELECT source_ref",
        "FROM evidence",
        "WHERE tenant_id = ?",
        "ORDER BY source_ref ASC;",
      ].join("\n"),
      "tenant-redaction-traceability-alias"
    );
    assert.equal(sourceRefRows.length, 1);
    const sourceRefRow = firstSqliteRow(sourceRefRows);
    assert.equal(sourceRefRow.source_ref, "mailto:analyst@example.com");
    assert.ok(!sourceRefRow.source_ref.includes("[REDACTED_"));
  } finally {
    db.close();
  }
});

test("ums-memory-a9v.3: sqlite storage preserves metadata.evidencePointers traceability fields while redacting nested payload content", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const db = new DatabaseSync(":memory:");

  try {
    const storageService = storageServiceModule.makeSqliteStorageService(db);
    const request = {
      spaceId: "tenant-redaction-metadata-pointers",
      memoryId: "memory-redaction-metadata-pointers",
      layer: "procedural",
      payload: {
        title: "Metadata evidence pointer redaction token=meta-secret",
        provenance: {
          source: "shadow-replay",
          decisionId: "decision-meta",
        },
        metadata: {
          evidencePointers: [
            {
              sourceKind: "event",
              sourceRef: "event://evt-meta-001",
              digestSha256: "d".repeat(64),
              relationKind: "supports",
              payload: {
                note: "Escalate to meta@example.com token=meta-secret",
              },
            },
          ],
        },
        updatedAtMillis: 1_700_000_110_250,
      },
    };

    const firstResponse = Effect.runSync(storageService.upsertMemory(request));
    const replayResponse = Effect.runSync(storageService.upsertMemory(request));
    assert.deepEqual(replayResponse, firstResponse);

    const persistedMemoryRow = expectSqliteRow(
      sqliteGet<PayloadJsonRow>(
        db,
        "SELECT payload_json FROM memory_items WHERE tenant_id = ? AND memory_id = ?;",
        "tenant-redaction-metadata-pointers",
        "memory-redaction-metadata-pointers"
      )
    );
    const persistedPayload = JSON.parse(persistedMemoryRow.payload_json);
    assert.equal(
      persistedPayload.metadata.evidencePointers[0].sourceRef,
      "event://evt-meta-001"
    );
    assert.equal(
      persistedPayload.metadata.evidencePointers[0].digestSha256,
      "d".repeat(64)
    );
    assert.ok(
      containsRedactedTokenCategory(
        persistedPayload.metadata.evidencePointers[0].payload.note,
        "EMAIL"
      )
    );
    assert.ok(
      containsRedactedTokenCategory(
        persistedPayload.metadata.evidencePointers[0].payload.note,
        "SECRET"
      )
    );
    assert.ok(
      !persistedPayload.metadata.evidencePointers[0].payload.note.includes(
        "meta@example.com"
      )
    );

    const evidenceRow = expectSqliteRow(
      sqliteGet<EvidenceRow>(
        db,
        [
          "SELECT source_ref, digest_sha256, payload_json",
          "FROM evidence",
          "WHERE tenant_id = ?;",
        ].join("\n"),
        "tenant-redaction-metadata-pointers"
      )
    );
    assert.equal(evidenceRow.source_ref, "event://evt-meta-001");
    assert.equal(evidenceRow.digest_sha256, "d".repeat(64));
    assert.ok(containsRedactedTokenCategory(evidenceRow.payload_json, "EMAIL"));
    assert.ok(
      containsRedactedTokenCategory(evidenceRow.payload_json, "SECRET")
    );
  } finally {
    db.close();
  }
});

test("ums-memory-a9v.3: sqlite storage replay from persisted payload keeps evidence digest identity when digest is initially omitted", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const db = new DatabaseSync(":memory:");

  try {
    const storageService = storageServiceModule.makeSqliteStorageService(db);
    Effect.runSync(
      storageService.upsertMemory({
        spaceId: "tenant-redaction-evidence-digest-replay",
        memoryId: "memory-redaction-evidence-digest-replay",
        layer: "procedural",
        payload: {
          title: "Procedural digest replay baseline",
          provenance: {
            source: "shadow-replay",
            decisionId: "digest-replay",
          },
          evidencePointers: [
            {
              sourceKind: "event",
              sourceRef: "event://evt-digest-replay-001",
              relationKind: "supports",
              payload: {
                note: "token=delta-secret owner=digest@example.com",
              },
            },
          ],
          updatedAtMillis: 1_700_000_110_280,
        },
      })
    );

    const persistedPayloadRow = expectSqliteRow(
      sqliteGet<PayloadJsonRow>(
        db,
        "SELECT payload_json FROM memory_items WHERE tenant_id = ? AND memory_id = ?;",
        "tenant-redaction-evidence-digest-replay",
        "memory-redaction-evidence-digest-replay"
      )
    );
    const persistedPayload = JSON.parse(persistedPayloadRow.payload_json);
    const persistedDigest = persistedPayload.evidencePointers[0].digestSha256;
    assert.match(String(persistedDigest), /^[0-9a-f]{64}$/);

    const replayResponse = Effect.runSync(
      storageService.upsertMemory({
        spaceId: "tenant-redaction-evidence-digest-replay",
        memoryId: "memory-redaction-evidence-digest-replay",
        layer: "procedural",
        payload: {
          ...persistedPayload,
          title: "Procedural digest replay update",
          updatedAtMillis: 1_700_000_110_281,
        },
      })
    );
    assert.equal(replayResponse.accepted, true);

    const evidenceDigestRows = sqliteAll<{ readonly digest_sha256: string }>(
      db,
      [
        "SELECT digest_sha256",
        "FROM evidence",
        "WHERE tenant_id = ? AND source_ref = ?",
        "ORDER BY digest_sha256 ASC;",
      ].join("\n"),
      "tenant-redaction-evidence-digest-replay",
      "event://evt-digest-replay-001"
    );
    assert.equal(evidenceDigestRows.length, 1);
    assert.equal(
      firstSqliteRow(evidenceDigestRows).digest_sha256,
      persistedDigest
    );
  } finally {
    db.close();
  }
});

test("ums-memory-a9v.3: sqlite storage redaction remains deterministic for idempotent replay of identical payload", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const db = new DatabaseSync(":memory:");

  try {
    const storageService = storageServiceModule.makeSqliteStorageService(db);
    const replayPayload = {
      title: "Replay password=hunter2",
      notes: "Escalate to replay@example.com or +1 415-555-0133. token=abc123",
      updatedAtMillis: 1_700_000_110_300,
    };

    const firstResponse = Effect.runSync(
      storageService.upsertMemory({
        spaceId: "tenant-redaction-idempotent",
        memoryId: "memory-redaction-idempotent",
        layer: "working",
        idempotency_key: "redaction-idempotency-key-001",
        payload: replayPayload,
      })
    );
    const replayResponse = Effect.runSync(
      storageService.upsertMemory({
        spaceId: "tenant-redaction-idempotent",
        memoryId: "memory-redaction-idempotent",
        layer: "working",
        idempotencyKey: "redaction-idempotency-key-001",
        payload: replayPayload,
      })
    );

    assert.deepEqual(replayResponse, firstResponse);

    const idempotencyRow = expectSqliteRow(
      sqliteGet<IdempotencyLedgerRow>(
        db,
        [
          "SELECT request_hash_sha256, response_json",
          "FROM storage_idempotency_ledger",
          "WHERE tenant_id = ? AND operation = 'upsert' AND idempotency_key = ?;",
        ].join("\n"),
        "tenant-redaction-idempotent",
        "redaction-idempotency-key-001"
      )
    );
    assert.match(String(idempotencyRow.request_hash_sha256), /^[0-9a-f]{64}$/i);
    assert.deepEqual(JSON.parse(idempotencyRow.response_json), firstResponse);

    const upsertAuditRows = sqliteAll<ReasonRow>(
      db,
      [
        "SELECT reason",
        "FROM audit_events",
        "WHERE tenant_id = ? AND memory_id = ? AND operation = 'upsert';",
      ].join("\n"),
      "tenant-redaction-idempotent",
      "memory-redaction-idempotent"
    );
    assert.equal(upsertAuditRows.length, 1);
    assert.equal(firstSqliteRow(upsertAuditRows).reason, "inserted");

    const persistedPayloadRow = expectSqliteRow(
      sqliteGet<PayloadJsonRow>(
        db,
        "SELECT payload_json FROM memory_items WHERE tenant_id = ? AND memory_id = ?;",
        "tenant-redaction-idempotent",
        "memory-redaction-idempotent"
      )
    );
    assert.ok(!persistedPayloadRow.payload_json.includes("hunter2"));
    assert.ok(!persistedPayloadRow.payload_json.includes("replay@example.com"));
    assert.ok(!persistedPayloadRow.payload_json.includes("+1 415-555-0133"));
    assert.ok(!persistedPayloadRow.payload_json.includes("abc123"));
    assert.ok(
      containsRedactedTokenCategory(persistedPayloadRow.payload_json, "SECRET")
    );
    assert.ok(
      containsRedactedTokenCategory(persistedPayloadRow.payload_json, "EMAIL")
    );
    assert.ok(
      containsRedactedTokenCategory(persistedPayloadRow.payload_json, "PHONE")
    );
  } finally {
    db.close();
  }
});

test("ums-memory-a9v.3: sqlite storage idempotency hash remains conflict-safe when secrets redact to the same token", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const db = new DatabaseSync(":memory:");

  try {
    const storageService = storageServiceModule.makeSqliteStorageService(db);
    Effect.runSync(
      storageService.upsertMemory({
        spaceId: "tenant-redaction-idempotency-collision",
        memoryId: "memory-redaction-idempotency-collision",
        layer: "working",
        idempotencyKey: "redaction-collision-key-001",
        payload: {
          title: "Collision baseline token=alpha-secret",
          updatedAtMillis: 1_700_000_110_400,
        },
      })
    );

    const conflictEither = Effect.runSync(
      Effect.either(
        storageService.upsertMemory({
          spaceId: "tenant-redaction-idempotency-collision",
          memoryId: "memory-redaction-idempotency-collision",
          layer: "working",
          idempotencyKey: "redaction-collision-key-001",
          payload: {
            title: "Collision baseline token=beta-secret",
            updatedAtMillis: 1_700_000_110_400,
          },
        })
      )
    );
    const conflictFailure = unwrapFailure(conflictEither);

    assert.equal(conflictFailure._tag, "ContractValidationError");
    assert.equal(
      conflictFailure.contract,
      "StorageUpsertRequest.idempotencyKey"
    );
    assert.match(conflictFailure.message, /reuse conflict/i);
  } finally {
    db.close();
  }
});

test("ums-memory-a9v.4: sqlite storage encrypts memory payload_json at rest and preserves deterministic idempotent replay", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const db = new DatabaseSync(":memory:");

  try {
    const storageService = storageServiceModule.makeSqliteStorageService(db, {
      encryptionAtRest: {
        enabled: true,
        activeKeyId: "key-v1",
        keyRing: {
          "key-v1": toBase64EncryptionKey(11),
        },
      },
    });

    const request = {
      spaceId: "tenant-a9v4-encrypted-persistence",
      memoryId: "memory-a9v4-encrypted-persistence",
      layer: "working",
      idempotencyKey: "a9v4-encrypted-idempotency-001",
      payload: {
        title: "Encrypted at-rest payload baseline",
        notes: "token=super-secret-value owner=atrest@example.com",
        updatedAtMillis: 1_700_000_130_001,
      },
    };

    const firstResponse = Effect.runSync(storageService.upsertMemory(request));
    const replayResponse = Effect.runSync(
      storageService.upsertMemory({
        ...request,
        idempotency_key: request.idempotencyKey,
      })
    );

    assert.deepEqual(replayResponse, firstResponse);

    const persistedRow = expectSqliteRow(
      sqliteGet<PayloadJsonRow>(
        db,
        "SELECT payload_json FROM memory_items WHERE tenant_id = ? AND memory_id = ?;",
        request.spaceId,
        request.memoryId
      )
    );
    assert.ok(
      !persistedRow.payload_json.includes("Encrypted at-rest payload baseline")
    );
    assert.ok(!persistedRow.payload_json.includes("super-secret-value"));
    assert.ok(!persistedRow.payload_json.includes("atrest@example.com"));
    const envelope = readEncryptedPayloadEnvelope(persistedRow.payload_json);
    assert.equal(envelope.keyId, "key-v1");
    const persistedFtsRow = expectSqliteRow(
      sqliteGet<PayloadTextRow>(
        db,
        [
          "SELECT payload_text FROM memory_items_fts",
          "WHERE rowid = (",
          "  SELECT rowid FROM memory_items WHERE tenant_id = ? AND memory_id = ?",
          "  LIMIT 1",
          ");",
        ].join("\n"),
        request.spaceId,
        request.memoryId
      )
    );
    assert.equal(persistedFtsRow.payload_text, "");

    const idempotencyRow = expectSqliteRow(
      sqliteGet<IdempotencyLedgerRow>(
        db,
        [
          "SELECT request_hash_sha256, response_json",
          "FROM storage_idempotency_ledger",
          "WHERE tenant_id = ? AND operation = 'upsert' AND idempotency_key = ?;",
        ].join("\n"),
        request.spaceId,
        request.idempotencyKey
      )
    );
    assert.match(String(idempotencyRow.request_hash_sha256), /^[0-9a-f]{64}$/);
    assert.deepEqual(JSON.parse(idempotencyRow.response_json), firstResponse);
  } finally {
    db.close();
  }
});

test("ums-memory-a9v.4: sqlite storage scrubs legacy FTS payload text when encryption-at-rest is enabled", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const db = new DatabaseSync(":memory:");

  try {
    const baselineService = storageServiceModule.makeSqliteStorageService(db);
    Effect.runSync(
      baselineService.upsertMemory({
        spaceId: "tenant-a9v4-fts-scrub",
        memoryId: "memory-a9v4-fts-scrub",
        layer: "working",
        payload: {
          title: "FTS scrub baseline",
          notes: "legacy plaintext payload term",
          updatedAtMillis: 1_700_000_130_050,
        },
      })
    );

    const ftsBefore = expectSqliteRow(
      sqliteGet<PayloadTextRow>(
        db,
        [
          "SELECT payload_text FROM memory_items_fts",
          "WHERE rowid = (",
          "  SELECT rowid FROM memory_items WHERE tenant_id = ? AND memory_id = ?",
          "  LIMIT 1",
          ");",
        ].join("\n"),
        "tenant-a9v4-fts-scrub",
        "memory-a9v4-fts-scrub"
      )
    );
    assert.match(ftsBefore.payload_text, /legacy plaintext payload term/i);

    storageServiceModule.makeSqliteStorageService(db, {
      applyMigrations: false,
      encryptionAtRest: {
        enabled: true,
        activeKeyId: "key-v1",
        keyRing: {
          "key-v1": toBase64EncryptionKey(55),
        },
      },
    });

    const ftsAfter = expectSqliteRow(
      sqliteGet<PayloadTextRow>(
        db,
        [
          "SELECT payload_text FROM memory_items_fts",
          "WHERE rowid = (",
          "  SELECT rowid FROM memory_items WHERE tenant_id = ? AND memory_id = ?",
          "  LIMIT 1",
          ");",
        ].join("\n"),
        "tenant-a9v4-fts-scrub",
        "memory-a9v4-fts-scrub"
      )
    );
    assert.equal(ftsAfter.payload_text, "");
  } finally {
    db.close();
  }
});

test("ums-memory-a9v.4: sqlite storage encryption startup tolerates missing FTS table when applyMigrations is false", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const db = new DatabaseSync(":memory:");

  try {
    storageServiceModule.makeSqliteStorageService(db);
    db.exec(
      [
        "DROP TRIGGER IF EXISTS trg_memory_items_fts_insert;",
        "DROP TRIGGER IF EXISTS trg_memory_items_fts_delete;",
        "DROP TRIGGER IF EXISTS trg_memory_items_fts_update;",
        "DROP TABLE IF EXISTS memory_items_fts;",
      ].join("\n")
    );

    assert.doesNotThrow(() => {
      storageServiceModule.makeSqliteStorageService(db, {
        applyMigrations: false,
        encryptionAtRest: {
          enabled: true,
          activeKeyId: "key-v1",
          keyRing: {
            "key-v1": toBase64EncryptionKey(77),
          },
        },
      });
    });
  } finally {
    db.close();
  }
});

test("ums-memory-a9v.4: sqlite storage decrypts older key ids from keyRing and re-encrypts with active rotation key", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const db = new DatabaseSync(":memory:");
  const oldKeyId = "key-2025";
  const rotatedKeyId = "key-2026";
  const oldKeyMaterial = toBase64EncryptionKey(22);
  const rotatedKeyMaterial = toBase64EncryptionKey(33);

  try {
    const firstService = storageServiceModule.makeSqliteStorageService(db, {
      encryptionAtRest: {
        enabled: true,
        activeKeyId: oldKeyId,
        keyRing: {
          [oldKeyId]: oldKeyMaterial,
        },
      },
    });

    Effect.runSync(
      firstService.upsertMemory({
        spaceId: "tenant-a9v4-rotation",
        memoryId: "memory-a9v4-rotation",
        layer: "procedural",
        payload: {
          title: "Rotation baseline",
          provenance: {
            source: "shadow-replay",
            decisionId: "decision-a9v4-rotation",
          },
          evidencePointers: [
            {
              sourceKind: "event",
              sourceRef: "event://evt-a9v4-rotation",
              digestSha256: "e".repeat(64),
              relationKind: "supports",
            },
          ],
          updatedAtMillis: 1_700_000_130_100,
        },
      })
    );

    const initialPersistedRow = expectSqliteRow(
      sqliteGet<PayloadJsonRow>(
        db,
        "SELECT payload_json FROM memory_items WHERE tenant_id = ? AND memory_id = ?;",
        "tenant-a9v4-rotation",
        "memory-a9v4-rotation"
      )
    );
    const initialEnvelope = readEncryptedPayloadEnvelope(
      initialPersistedRow.payload_json
    );
    assert.equal(initialEnvelope.keyId, oldKeyId);

    const rotatedService = storageServiceModule.makeSqliteStorageService(db, {
      applyMigrations: false,
      encryptionAtRest: {
        enabled: true,
        activeKeyId: rotatedKeyId,
        keyRing: {
          [oldKeyId]: oldKeyMaterial,
          [rotatedKeyId]: rotatedKeyMaterial,
        },
      },
    });

    const rotatedResponse = Effect.runSync(
      rotatedService.upsertMemory({
        spaceId: "tenant-a9v4-rotation",
        memoryId: "memory-a9v4-rotation",
        layer: "procedural",
        payload: {
          title: "Rotation update after key change",
          provenance: {
            source: "shadow-replay",
            decisionId: "decision-a9v4-rotation",
          },
          evidencePointers: [
            {
              sourceKind: "event",
              sourceRef: "event://evt-a9v4-rotation",
              digestSha256: "e".repeat(64),
              relationKind: "supports",
            },
          ],
          updatedAtMillis: 1_700_000_130_101,
        },
      })
    );
    assert.equal(rotatedResponse.accepted, true);
    assert.equal(rotatedResponse.persistedAtMillis, 1_700_000_130_101);

    const rotatedPersistedRow = expectSqliteRow(
      sqliteGet<PayloadJsonRow>(
        db,
        "SELECT payload_json FROM memory_items WHERE tenant_id = ? AND memory_id = ?;",
        "tenant-a9v4-rotation",
        "memory-a9v4-rotation"
      )
    );
    const rotatedEnvelope = readEncryptedPayloadEnvelope(
      rotatedPersistedRow.payload_json
    );
    assert.equal(rotatedEnvelope.keyId, rotatedKeyId);
  } finally {
    db.close();
  }
});

test("ums-memory-a9v.4: sqlite storage encryption config misconfiguration fails fast with strict contracts", async () => {
  const storageServiceModule = await loadStorageServiceModule();

  const assertMisconfiguration = (
    encryptionAtRestOptions: any,
    expectedContract: any,
    expectedMessagePattern: any
  ) => {
    const misconfiguredDb = new DatabaseSync(":memory:");
    try {
      assert.throws(
        () =>
          storageServiceModule.makeSqliteStorageService(misconfiguredDb, {
            encryptionAtRest: encryptionAtRestOptions,
          }),
        (error) => {
          const contractError = asContractErrorShape(error);
          assert.equal(contractError._tag, "ContractValidationError");
          assert.equal(contractError.contract, expectedContract);
          assert.match(contractError.message ?? "", expectedMessagePattern);
          return true;
        }
      );
    } finally {
      misconfiguredDb.close();
    }
  };

  assertMisconfiguration(
    {
      enabled: true,
      activeKeyId: "key-v1",
    },
    "SqliteStorageRepositoryOptions.encryptionAtRest.keyRing",
    /keyring/i
  );
  assertMisconfiguration(
    {
      enabled: true,
      activeKeyId: "missing-key",
      keyRing: {
        "key-v1": toBase64EncryptionKey(44),
      },
    },
    "SqliteStorageRepositoryOptions.encryptionAtRest.activeKeyId",
    /activekeyid/i
  );
  assertMisconfiguration(
    {
      enabled: false,
      activeKeyId: "key-v1",
      keyRing: {
        "key-v1": toBase64EncryptionKey(44),
      },
    },
    "SqliteStorageRepositoryOptions.encryptionAtRest.enabled",
    /enabled/i
  );
});

test("ums-memory-a9v.4: sqlite storage snapshot import scrubs FTS payload text when encryption-at-rest is enabled", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const sourceDb = new DatabaseSync(":memory:");
  const targetDb = new DatabaseSync(":memory:");

  try {
    const sourceStorageService =
      storageServiceModule.makeSqliteStorageService(sourceDb);
    Effect.runSync(
      sourceStorageService.upsertMemory({
        spaceId: "tenant-a9v4-snapshot-fts",
        memoryId: "memory-a9v4-snapshot-fts",
        layer: "working",
        payload: {
          title: "Snapshot FTS encryption scrub baseline",
          notes: "snapshot plaintext payload token",
          updatedAtMillis: 1_700_000_130_200,
        },
      })
    );

    const exportedSnapshot = Effect.runSync(
      sourceStorageService.exportSnapshot({
        signatureSecret: "snapshot-secret-a9v4-fts",
      })
    );

    const targetStorageService = storageServiceModule.makeSqliteStorageService(
      targetDb,
      {
        encryptionAtRest: {
          enabled: true,
          activeKeyId: "key-v1",
          keyRing: {
            "key-v1": toBase64EncryptionKey(66),
          },
        },
      }
    );
    const importResponse = Effect.runSync(
      targetStorageService.importSnapshot({
        signatureSecret: "snapshot-secret-a9v4-fts",
        signatureAlgorithm: exportedSnapshot.signatureAlgorithm,
        payload: exportedSnapshot.payload,
        signature: exportedSnapshot.signature,
      })
    );
    assert.equal(importResponse.imported, true);
    assert.equal(importResponse.replayed, false);

    const importedFtsRow = expectSqliteRow(
      sqliteGet<PayloadTextRow>(
        targetDb,
        [
          "SELECT payload_text FROM memory_items_fts",
          "WHERE rowid = (",
          "  SELECT rowid FROM memory_items WHERE tenant_id = ? AND memory_id = ?",
          "  LIMIT 1",
          ");",
        ].join("\n"),
        "tenant-a9v4-snapshot-fts",
        "memory-a9v4-snapshot-fts"
      )
    );
    assert.equal(importedFtsRow.payload_text, "");
  } finally {
    sourceDb.close();
    targetDb.close();
  }
});

test("ums-memory-5cb.10: sqlite storage service replays upsert responses deterministically for matching idempotency keys", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const db = new DatabaseSync(":memory:");

  try {
    const storageService = storageServiceModule.makeSqliteStorageService(db);
    const firstResponse = Effect.runSync(
      storageService.upsertMemory({
        spaceId: "tenant-idempotency-upsert",
        memoryId: "memory-idempotency-upsert",
        layer: "working",
        idempotency_key: "upsert-key-001",
        payload: {
          title: "Idempotent upsert baseline",
          updatedAtMillis: 1_700_000_100_100,
        },
      })
    );
    const replayResponse = Effect.runSync(
      storageService.upsertMemory({
        spaceId: "tenant-idempotency-upsert",
        memoryId: "memory-idempotency-upsert",
        layer: "working",
        idempotencyKey: "upsert-key-001",
        payload: {
          title: "Idempotent upsert baseline",
          updatedAtMillis: 1_700_000_100_100,
        },
      })
    );

    assert.deepEqual(replayResponse, firstResponse);

    const upsertAuditRows = sqliteAll<ReasonRow>(
      db,
      [
        "SELECT reason FROM audit_events",
        "WHERE tenant_id = ? AND memory_id = ? AND operation = 'upsert'",
        "ORDER BY event_id ASC;",
      ].join("\n"),
      "tenant-idempotency-upsert",
      "memory-idempotency-upsert"
    );
    assert.deepEqual(
      upsertAuditRows.map((row) => row.reason),
      ["inserted"]
    );

    const idempotencyRow = expectSqliteRow(
      sqliteGet<IdempotencyLedgerRow>(
        db,
        [
          "SELECT request_hash_sha256, response_json",
          "FROM storage_idempotency_ledger",
          "WHERE tenant_id = ? AND operation = 'upsert' AND idempotency_key = ?;",
        ].join("\n"),
        "tenant-idempotency-upsert",
        "upsert-key-001"
      )
    );
    assert.match(String(idempotencyRow.request_hash_sha256), /^[0-9a-f]{64}$/i);
    assert.deepEqual(JSON.parse(idempotencyRow.response_json), firstResponse);
  } finally {
    db.close();
  }
});

test("ums-memory-5cb.10: sqlite storage service replays upsert for legacy idempotency request-hash rows", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const db = new DatabaseSync(":memory:");

  try {
    const storageService = storageServiceModule.makeSqliteStorageService(db);
    const request = {
      spaceId: "tenant-idempotency-upsert-legacy-hash",
      memoryId: "memory-idempotency-upsert-legacy-hash",
      layer: "working",
      idempotencyKey: "upsert-key-legacy-hash-001",
      payload: {
        title: "Idempotency legacy hash token=alpha-secret",
        notes: "Escalate to legacy-owner@example.com",
        updatedAtMillis: 1_700_000_100_150,
      },
    };

    const firstResponse = Effect.runSync(storageService.upsertMemory(request));

    const legacyRequestHashSha256 = toSha256Hex(
      JSON.stringify({
        operation: "upsert",
        spaceId: request.spaceId,
        memoryId: request.memoryId,
        layer: request.layer,
        payloadProjection: {
          scopeId: null,
          scopeProjectId: null,
          scopeRoleId: null,
          scopeUserId: null,
          memoryKind: "note",
          status: "active",
          title: request.payload.title,
          payloadJson: toCanonicalPayloadJson(request.payload),
          createdByUserId: null,
          supersedesMemoryId: null,
          createdAtMillis: request.payload.updatedAtMillis,
          updatedAtMillis: request.payload.updatedAtMillis,
          expiresAtMillis: null,
          tombstonedAtMillis: null,
          provenanceJson: null,
          evidencePointers: [],
        },
      })
    );
    db.prepare(
      [
        "UPDATE storage_idempotency_ledger",
        "SET request_hash_sha256 = ?",
        "WHERE tenant_id = ? AND operation = 'upsert' AND idempotency_key = ?;",
      ].join("\n")
    ).run(
      legacyRequestHashSha256,
      "tenant-idempotency-upsert-legacy-hash",
      "upsert-key-legacy-hash-001"
    );

    const replayResponse = Effect.runSync(storageService.upsertMemory(request));
    assert.deepEqual(replayResponse, firstResponse);
  } finally {
    db.close();
  }
});

test("ums-memory-5cb.10: sqlite storage service rejects upsert idempotency key reuse with mismatched request hash", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const db = new DatabaseSync(":memory:");

  try {
    const storageService = storageServiceModule.makeSqliteStorageService(db);
    Effect.runSync(
      storageService.upsertMemory({
        spaceId: "tenant-idempotency-upsert-conflict",
        memoryId: "memory-idempotency-upsert-conflict",
        layer: "working",
        idempotencyKey: "upsert-key-conflict-001",
        payload: {
          title: "Idempotent upsert conflict baseline",
          updatedAtMillis: 1_700_000_100_200,
        },
      })
    );

    const conflictEither = Effect.runSync(
      Effect.either(
        storageService.upsertMemory({
          spaceId: "tenant-idempotency-upsert-conflict",
          memoryId: "memory-idempotency-upsert-conflict",
          layer: "working",
          idempotencyKey: "upsert-key-conflict-001",
          payload: {
            title: "Idempotent upsert conflict changed payload",
            updatedAtMillis: 1_700_000_100_201,
          },
        })
      )
    );
    const conflictFailure = unwrapFailure(conflictEither);

    assert.equal(conflictFailure._tag, "ContractValidationError");
    assert.equal(
      conflictFailure.contract,
      "StorageUpsertRequest.idempotencyKey"
    );
    assert.match(conflictFailure.message, /reuse conflict/i);

    const persistedMemoryRow = expectSqliteRow(
      sqliteGet<TitleUpdatedAtRow>(
        db,
        "SELECT title, updated_at_ms FROM memory_items WHERE tenant_id = ? AND memory_id = ?;",
        "tenant-idempotency-upsert-conflict",
        "memory-idempotency-upsert-conflict"
      )
    );
    assert.equal(
      persistedMemoryRow.title,
      "Idempotent upsert conflict baseline"
    );
    assert.equal(Number(persistedMemoryRow.updated_at_ms), 1_700_000_100_200);
  } finally {
    db.close();
  }
});

test("ums-memory-5cb.10: sqlite storage service replays delete responses deterministically for matching idempotency keys", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const db = new DatabaseSync(":memory:");

  try {
    const storageService = storageServiceModule.makeSqliteStorageService(db);
    Effect.runSync(
      storageService.upsertMemory({
        spaceId: "tenant-idempotency-delete",
        memoryId: "memory-idempotency-delete",
        layer: "working",
        payload: {
          title: "Delete idempotency seed",
          updatedAtMillis: 1_700_000_100_300,
        },
      })
    );

    const firstDeleteResponse = Effect.runSync(
      storageService.deleteMemory({
        spaceId: "tenant-idempotency-delete",
        memoryId: "memory-idempotency-delete",
        idempotency_key: "delete-key-001",
      })
    );
    const replayDeleteResponse = Effect.runSync(
      storageService.deleteMemory({
        spaceId: "tenant-idempotency-delete",
        memoryId: "memory-idempotency-delete",
        idempotencyKey: "delete-key-001",
      })
    );

    assert.deepEqual(replayDeleteResponse, firstDeleteResponse);

    const deleteAuditRows = sqliteAll<ReasonRow>(
      db,
      [
        "SELECT reason FROM audit_events",
        "WHERE tenant_id = ? AND memory_id = ? AND operation = 'delete'",
        "ORDER BY event_id ASC;",
      ].join("\n"),
      "tenant-idempotency-delete",
      "memory-idempotency-delete"
    );
    assert.deepEqual(
      deleteAuditRows.map((row) => row.reason),
      ["deleted"]
    );

    const idempotencyRow = expectSqliteRow(
      sqliteGet<IdempotencyLedgerRow>(
        db,
        [
          "SELECT request_hash_sha256, response_json",
          "FROM storage_idempotency_ledger",
          "WHERE tenant_id = ? AND operation = 'delete' AND idempotency_key = ?;",
        ].join("\n"),
        "tenant-idempotency-delete",
        "delete-key-001"
      )
    );
    assert.match(String(idempotencyRow.request_hash_sha256), /^[0-9a-f]{64}$/i);
    assert.deepEqual(
      JSON.parse(idempotencyRow.response_json),
      firstDeleteResponse
    );
  } finally {
    db.close();
  }
});

test("ums-memory-5cb.10: sqlite storage service rejects delete idempotency key reuse with mismatched request hash", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const db = new DatabaseSync(":memory:");

  try {
    const storageService = storageServiceModule.makeSqliteStorageService(db);
    Effect.runSync(
      storageService.upsertMemory({
        spaceId: "tenant-idempotency-delete-conflict",
        memoryId: "memory-idempotency-delete-a",
        layer: "working",
        payload: {
          title: "Delete idempotency conflict seed A",
          updatedAtMillis: 1_700_000_100_400,
        },
      })
    );
    Effect.runSync(
      storageService.upsertMemory({
        spaceId: "tenant-idempotency-delete-conflict",
        memoryId: "memory-idempotency-delete-b",
        layer: "working",
        payload: {
          title: "Delete idempotency conflict seed B",
          updatedAtMillis: 1_700_000_100_401,
        },
      })
    );

    Effect.runSync(
      storageService.deleteMemory({
        spaceId: "tenant-idempotency-delete-conflict",
        memoryId: "memory-idempotency-delete-a",
        idempotencyKey: "delete-key-conflict-001",
      })
    );

    const conflictEither = Effect.runSync(
      Effect.either(
        storageService.deleteMemory({
          spaceId: "tenant-idempotency-delete-conflict",
          memoryId: "memory-idempotency-delete-b",
          idempotencyKey: "delete-key-conflict-001",
        })
      )
    );
    const conflictFailure = unwrapFailure(conflictEither);

    assert.equal(conflictFailure._tag, "ContractValidationError");
    assert.equal(
      conflictFailure.contract,
      "StorageDeleteRequest.idempotencyKey"
    );
    assert.match(conflictFailure.message, /reuse conflict/i);

    const remainingMemoryRow = expectSqliteRow(
      sqliteGet<{ readonly memory_id: string }>(
        db,
        "SELECT memory_id FROM memory_items WHERE tenant_id = ? AND memory_id = ?;",
        "tenant-idempotency-delete-conflict",
        "memory-idempotency-delete-b"
      )
    );
    assert.equal(remainingMemoryRow.memory_id, "memory-idempotency-delete-b");
  } finally {
    db.close();
  }
});

test("ums-memory-5cb.9: sqlite storage snapshot export is deterministic and signed", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const db = new DatabaseSync(":memory:");

  try {
    const storageService = storageServiceModule.makeSqliteStorageService(db);
    Effect.runSync(
      storageService.upsertMemory({
        spaceId: "tenant-snapshot-export",
        memoryId: "memory-snapshot-export",
        layer: "working",
        payload: {
          title: "Snapshot export baseline",
          updatedAtMillis: 1_700_000_200_100,
        },
      })
    );

    const firstExport = Effect.runSync(
      storageService.exportSnapshot({
        signatureSecret: "snapshot-secret-001",
      })
    );
    const secondExport = Effect.runSync(
      storageService.exportSnapshot({
        signature_secret: "snapshot-secret-001",
        signatureSecret: "snapshot-secret-001",
      })
    );

    assert.deepEqual(secondExport, firstExport);
    assert.equal(firstExport.signatureAlgorithm, "hmac-sha256");
    assert.match(firstExport.signature, /^[0-9a-f]{64}$/i);
    assert.ok(firstExport.tableCount > 0);
    assert.ok(firstExport.rowCount > 0);

    const payloadDocument = JSON.parse(firstExport.payload);
    assert.equal(
      payloadDocument.format,
      "ums-memory/sqlite-storage-snapshot/v1"
    );
    assert.equal(payloadDocument.userVersion, 6);
    assert.equal(payloadDocument.tables.length, firstExport.tableCount);
  } finally {
    db.close();
  }
});

test("ums-memory-5cb.9: sqlite storage snapshot import restores state and reports replay on identical payload", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const sourceDb = new DatabaseSync(":memory:");
  const targetDb = new DatabaseSync(":memory:");

  try {
    const sourceStorageService =
      storageServiceModule.makeSqliteStorageService(sourceDb);
    Effect.runSync(
      sourceStorageService.upsertMemory({
        spaceId: "tenant-snapshot-import",
        memoryId: "memory-snapshot-import",
        layer: "working",
        payload: {
          title: "Snapshot import seed",
          updatedAtMillis: 1_700_000_200_200,
        },
      })
    );
    Effect.runSync(
      sourceStorageService.upsertMemory({
        spaceId: "tenant-snapshot-import",
        memoryId: "memory-snapshot-import-procedural",
        layer: "procedural",
        payload: {
          title: "Snapshot import procedural seed",
          updatedAtMillis: 1_700_000_200_201,
          evidencePointers: [
            {
              sourceKind: "event",
              sourceRef: "event://snapshot-import-evidence-1",
              digestSha256: "1".repeat(64),
            },
          ],
        },
      })
    );

    const exportedSnapshot = Effect.runSync(
      sourceStorageService.exportSnapshot({
        signatureSecret: "snapshot-secret-002",
      })
    );

    const targetStorageService =
      storageServiceModule.makeSqliteStorageService(targetDb);
    const importResponse = Effect.runSync(
      targetStorageService.importSnapshot({
        signatureSecret: "snapshot-secret-002",
        signatureAlgorithm: exportedSnapshot.signatureAlgorithm,
        payload: exportedSnapshot.payload,
        signature: exportedSnapshot.signature,
      })
    );
    assert.deepEqual(importResponse, {
      imported: true,
      replayed: false,
      tableCount: exportedSnapshot.tableCount,
      rowCount: exportedSnapshot.rowCount,
    });

    const sourceCanonicalExport = Effect.runSync(
      sourceStorageService.exportSnapshot({
        signatureSecret: "snapshot-secret-002",
      })
    );
    const targetCanonicalExport = Effect.runSync(
      targetStorageService.exportSnapshot({
        signatureSecret: "snapshot-secret-002",
      })
    );
    assert.deepEqual(targetCanonicalExport, sourceCanonicalExport);

    const replayImportResponse = Effect.runSync(
      targetStorageService.importSnapshot({
        signatureSecret: "snapshot-secret-002",
        signatureAlgorithm: exportedSnapshot.signatureAlgorithm,
        payload: exportedSnapshot.payload,
        signature: exportedSnapshot.signature,
      })
    );
    assert.deepEqual(replayImportResponse, {
      imported: true,
      replayed: true,
      tableCount: exportedSnapshot.tableCount,
      rowCount: exportedSnapshot.rowCount,
    });
  } finally {
    sourceDb.close();
    targetDb.close();
  }
});

test("ums-memory-5cb.9: sqlite storage snapshot import rejects tampered signature payload combinations", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const sourceDb = new DatabaseSync(":memory:");
  const targetDb = new DatabaseSync(":memory:");

  try {
    const sourceStorageService =
      storageServiceModule.makeSqliteStorageService(sourceDb);
    Effect.runSync(
      sourceStorageService.upsertMemory({
        spaceId: "tenant-snapshot-signature",
        memoryId: "memory-snapshot-signature",
        layer: "working",
        payload: {
          title: "Snapshot signature baseline",
          updatedAtMillis: 1_700_000_200_300,
        },
      })
    );

    const exportedSnapshot = Effect.runSync(
      sourceStorageService.exportSnapshot({
        signatureSecret: "snapshot-secret-003",
      })
    );
    const tamperedPayload = exportedSnapshot.payload.replace(
      "Snapshot signature baseline",
      "Snapshot signature tampered"
    );

    const targetStorageService =
      storageServiceModule.makeSqliteStorageService(targetDb);
    const importEither = Effect.runSync(
      Effect.either(
        targetStorageService.importSnapshot({
          signatureSecret: "snapshot-secret-003",
          signatureAlgorithm: exportedSnapshot.signatureAlgorithm,
          payload: tamperedPayload,
          signature: exportedSnapshot.signature,
        })
      )
    );
    const importFailure = unwrapFailure(importEither);
    assert.equal(importFailure._tag, "ContractValidationError");
    assert.equal(
      importFailure.contract,
      "StorageSnapshotImportRequest.signature"
    );
    assert.match(importFailure.message, /verification failed/i);
  } finally {
    sourceDb.close();
    targetDb.close();
  }
});

test("ums-memory-5cb.3: sqlite storage service maps sqlite constraint failures to StorageConflictError", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const db = new DatabaseSync(":memory:");

  try {
    const storageService = storageServiceModule.makeSqliteStorageService(db);
    const upsertEither = Effect.runSync(
      Effect.either(
        storageService.upsertMemory({
          spaceId: "tenant-storage",
          memoryId: "memory-conflict",
          layer: "working",
          payload: {
            title: "Scope FK conflict",
            scope: {
              scopeId: "scope-missing",
            },
          },
        })
      )
    );
    const upsertFailure = unwrapFailure(upsertEither);

    assert.equal(upsertFailure._tag, "StorageConflictError");
    assert.equal(upsertFailure.spaceId, "tenant-storage");
    assert.equal(upsertFailure.memoryId, "memory-conflict");
    assert.match(upsertFailure.message, /constraint|foreign key/i);
  } finally {
    db.close();
  }
});

test("ums-memory-5cb.3: sqlite storage service maps trigger aborts to StorageConflictError", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const db = new DatabaseSync(":memory:");

  try {
    const storageService = storageServiceModule.makeSqliteStorageService(db);
    Effect.runSync(
      storageService.upsertMemory({
        spaceId: "tenant-storage",
        memoryId: "memory-cycle-a",
        layer: "working",
        payload: {
          title: "Cycle A",
          createdAtMillis: 100,
          updatedAtMillis: 100,
        },
      })
    );

    Effect.runSync(
      storageService.upsertMemory({
        spaceId: "tenant-storage",
        memoryId: "memory-cycle-b",
        layer: "working",
        payload: {
          title: "Cycle B",
          supersedesMemoryId: "memory-cycle-a",
          createdAtMillis: 110,
          updatedAtMillis: 110,
        },
      })
    );

    const upsertEither = Effect.runSync(
      Effect.either(
        storageService.upsertMemory({
          spaceId: "tenant-storage",
          memoryId: "memory-cycle-a",
          layer: "working",
          payload: {
            title: "Cycle A should fail",
            supersedesMemoryId: "memory-cycle-b",
            createdAtMillis: 100,
            updatedAtMillis: 120,
          },
        })
      )
    );
    const upsertFailure = unwrapFailure(upsertEither);

    assert.equal(upsertFailure._tag, "StorageConflictError");
    assert.equal(upsertFailure.spaceId, "tenant-storage");
    assert.equal(upsertFailure.memoryId, "memory-cycle-a");
    assert.match(upsertFailure.message, /constraint|abort|cycle/i);
  } finally {
    db.close();
  }
});

test("ums-memory-5cb.3: sqlite storage service maps payload validation failures to ContractValidationError", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const db = new DatabaseSync(":memory:");

  try {
    const storageService = storageServiceModule.makeSqliteStorageService(db);
    const upsertEither = Effect.runSync(
      Effect.either(
        storageService.upsertMemory({
          spaceId: "tenant-storage",
          memoryId: "memory-validation",
          layer: "working",
          payload: {
            title: "Invalid payload ordering",
            createdAtMillis: 2_000,
            updatedAtMillis: 1_000,
          },
        })
      )
    );
    const upsertFailure = unwrapFailure(upsertEither);

    assert.equal(upsertFailure._tag, "ContractValidationError");
    assert.equal(upsertFailure.contract, "StorageUpsertRequest.payload");
    assert.match(upsertFailure.details, /updatedAtMillis/i);
  } finally {
    db.close();
  }
});

test("ums-memory-5cb.3: sqlite storage service rejects non-plain-object payload values", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const db = new DatabaseSync(":memory:");

  try {
    const storageService = storageServiceModule.makeSqliteStorageService(db);
    const upsertEither = Effect.runSync(
      Effect.either(
        storageService.upsertMemory({
          spaceId: "tenant-storage",
          memoryId: "memory-invalid-object",
          layer: "working",
          payload: {
            title: "Invalid runtime object payload",
            nested: new Date(0),
          },
        })
      )
    );
    const upsertFailure = unwrapFailure(upsertEither);

    assert.equal(upsertFailure._tag, "ContractValidationError");
    assert.equal(upsertFailure.contract, "StorageUpsertRequest.payload");
    assert.match(upsertFailure.details, /plain JSON-compatible objects/i);
  } finally {
    db.close();
  }
});

test("ums-memory-5cb.3: sqlite storage service rejects non-record root payload values", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const db = new DatabaseSync(":memory:");

  try {
    const storageService = storageServiceModule.makeSqliteStorageService(db);
    const invalidPayloads = [null, [], "invalid-root"];

    for (const invalidPayload of invalidPayloads) {
      const upsertEither = Effect.runSync(
        Effect.either(
          storageService.upsertMemory({
            spaceId: "tenant-storage",
            memoryId: `memory-invalid-root-${String(invalidPayload)}`,
            layer: "working",
            payload: invalidPayload,
          })
        )
      );
      const upsertFailure = unwrapFailure(upsertEither);

      assert.equal(upsertFailure._tag, "ContractValidationError");
      assert.equal(upsertFailure.contract, "StorageUpsertRequest.payload");
      assert.match(upsertFailure.details, /plain object record/i);
    }
  } finally {
    db.close();
  }
});

test("ums-memory-5cb.3: sqlite storage service maps non-constraint runtime failures to ContractValidationError", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const db = new DatabaseSync(":memory:");
  const storageService = storageServiceModule.makeSqliteStorageService(db);

  db.close();

  const upsertEither = Effect.runSync(
    Effect.either(
      storageService.upsertMemory({
        spaceId: "tenant-storage",
        memoryId: "memory-runtime-failure",
        layer: "working",
        payload: {
          title: "Runtime failure",
          updatedAtMillis: 9_000,
        },
      })
    )
  );
  const upsertFailure = unwrapFailure(upsertEither);

  assert.equal(upsertFailure._tag, "ContractValidationError");
  assert.equal(upsertFailure.contract, "StorageRuntimeFailure");
});

test("ums-memory-5cb.3: sqlite storage layer provides StorageServiceTag wiring", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const db = new DatabaseSync(":memory:");

  try {
    const response = Effect.runSync(
      Effect.gen(function* () {
        const storageService = yield* storageServiceModule.StorageServiceTag;
        return yield* storageService.upsertMemory({
          spaceId: "tenant-layer",
          memoryId: "memory-layer",
          layer: "working",
          payload: {
            title: "Layer-wired upsert",
            updatedAtMillis: 2_000,
          },
        });
      }).pipe(Effect.provide(storageServiceModule.makeSqliteStorageLayer(db)))
    );

    assert.equal(response.accepted, true);
    assert.equal(response.persistedAtMillis, 2_000);
    assert.equal(response.memoryId, "memory-layer");
  } finally {
    db.close();
  }
});

test("ums-memory-5cb.3: sqlite storage repository options allow explicit migration/fk modes", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const db = new DatabaseSync(":memory:");
  const fkDisabledDb = new DatabaseSync(":memory:");

  try {
    const bootstrapService = storageServiceModule.makeSqliteStorageService(db);
    Effect.runSync(
      bootstrapService.upsertMemory({
        spaceId: "tenant-options",
        memoryId: "memory-bootstrap",
        layer: "working",
        payload: {
          title: "Bootstrap",
          updatedAtMillis: 1_000,
        },
      })
    );

    const noMigrationService = storageServiceModule.makeSqliteStorageService(
      db,
      {
        applyMigrations: false,
      }
    );
    const noMigrationResponse = Effect.runSync(
      noMigrationService.upsertMemory({
        spaceId: "tenant-options",
        memoryId: "memory-no-migration",
        layer: "working",
        payload: {
          title: "No migration option path",
          updatedAtMillis: 1_100,
        },
      })
    );
    assert.equal(noMigrationResponse.accepted, true);
    assert.equal(noMigrationResponse.persistedAtMillis, 1_100);

    const foreignKeysDisabledService =
      storageServiceModule.makeSqliteStorageService(fkDisabledDb, {
        enforceForeignKeys: false,
      });
    const fkDisabledResponse = Effect.runSync(
      foreignKeysDisabledService.upsertMemory({
        spaceId: "tenant-options",
        memoryId: "memory-fk-off",
        layer: "working",
        payload: {
          scope: {
            scopeId: "scope-not-created",
          },
          title: "Foreign key disabled option path",
          updatedAtMillis: 1_200,
        },
      })
    );
    assert.equal(fkDisabledResponse.accepted, true);
    assert.equal(fkDisabledResponse.persistedAtMillis, 1_200);
  } finally {
    db.close();
    fkDisabledDb.close();
  }
});

test("ums-memory-5cb.3: sqlite storage layer maps initialization failures to ContractValidationError", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const db = new DatabaseSync(":memory:");

  try {
    const program = Effect.gen(function* () {
      const storageService = yield* storageServiceModule.StorageServiceTag;
      return yield* storageService.upsertMemory({
        spaceId: "tenant-layer-failure",
        memoryId: "memory-layer-failure",
        layer: "working",
        payload: {
          title: "This call should never execute",
        },
      });
    }).pipe(
      Effect.provide(
        storageServiceModule.makeSqliteStorageLayer(db, {
          applyMigrations: false,
        })
      )
    );

    const result = Effect.runSync(Effect.either(program));
    const failure = unwrapFailure(result);
    assert.equal(failure._tag, "ContractValidationError");
    assert.equal(failure.contract, "StorageServiceInitialization");
    assert.match(failure.details, /no such table/i);
  } finally {
    db.close();
  }
});

test("ums-memory-5cb.3: sqlite storage repository rejects conflicting foreign key mode on shared connection", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const db = new DatabaseSync(":memory:");

  try {
    storageServiceModule.makeSqliteStorageService(db, {
      enforceForeignKeys: true,
    });

    assert.throws(
      () =>
        storageServiceModule.makeSqliteStorageService(db, {
          enforceForeignKeys: false,
        }),
      /immutable|foreign_keys/i
    );
  } finally {
    db.close();
  }
});

test("ums-memory-5cb.3: sqlite storage repository honors PRAGMA foreign_keys with readBigInts mode", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const db = new DatabaseSync(":memory:", { readBigInts: true });

  try {
    const storageService = storageServiceModule.makeSqliteStorageService(db, {
      enforceForeignKeys: true,
    });
    const response = Effect.runSync(
      storageService.upsertMemory({
        spaceId: "tenant-bigint",
        memoryId: "memory-bigint",
        layer: "working",
        payload: {
          title: "BigInt PRAGMA compatibility",
          updatedAtMillis: 5_000,
        },
      })
    );

    assert.equal(response.accepted, true);
    assert.equal(response.persistedAtMillis, 5_000);
  } finally {
    db.close();
  }
});

test("ums-memory-5cb.3: sqlite storage repository re-applies foreign key enforcement after external PRAGMA drift", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const db = new DatabaseSync(":memory:");

  try {
    storageServiceModule.makeSqliteStorageService(db, {
      enforceForeignKeys: true,
    });

    db.exec("PRAGMA foreign_keys = OFF;");

    const storageService = storageServiceModule.makeSqliteStorageService(db, {
      applyMigrations: false,
      enforceForeignKeys: true,
    });

    const upsertEither = Effect.runSync(
      Effect.either(
        storageService.upsertMemory({
          spaceId: "tenant-drift",
          memoryId: "memory-drift",
          layer: "working",
          payload: {
            scope: {
              scopeId: "scope-not-created",
            },
            title: "Foreign key should be re-enforced",
            updatedAtMillis: 8_000,
          },
        })
      )
    );
    const upsertFailure = unwrapFailure(upsertEither);

    assert.equal(upsertFailure._tag, "StorageConflictError");
    assert.match(upsertFailure.message, /constraint|foreign key/i);
  } finally {
    db.close();
  }
});

test("ums-memory-5cb.3: sqlite storage repository detects foreign key drift on live service instances", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const db = new DatabaseSync(":memory:");

  try {
    const storageService = storageServiceModule.makeSqliteStorageService(db, {
      enforceForeignKeys: true,
    });
    db.exec("PRAGMA foreign_keys = OFF;");

    const upsertEither = Effect.runSync(
      Effect.either(
        storageService.upsertMemory({
          spaceId: "tenant-drift-live",
          memoryId: "memory-drift-live",
          layer: "working",
          payload: {
            scope: {
              scopeId: "scope-not-created",
            },
            title: "Live service drift check",
            updatedAtMillis: 10_000,
          },
        })
      )
    );
    const upsertFailure = unwrapFailure(upsertEither);

    assert.equal(upsertFailure._tag, "ContractValidationError");
    assert.equal(
      upsertFailure.contract,
      "SqliteStorageRepositoryOptions.enforceForeignKeys"
    );
    assert.match(upsertFailure.message, /drift detected/i);
  } finally {
    db.close();
  }
});

test("ums-memory-5cb.3: sqlite storage repository preserves drift contract error on delete path", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const db = new DatabaseSync(":memory:");

  try {
    const storageService = storageServiceModule.makeSqliteStorageService(db, {
      enforceForeignKeys: true,
    });
    Effect.runSync(
      storageService.upsertMemory({
        spaceId: "tenant-drift-delete",
        memoryId: "memory-drift-delete",
        layer: "working",
        payload: {
          title: "Delete drift fixture",
          updatedAtMillis: 11_000,
        },
      })
    );

    db.exec("PRAGMA foreign_keys = OFF;");

    const deleteEither = Effect.runSync(
      Effect.either(
        storageService.deleteMemory({
          spaceId: "tenant-drift-delete",
          memoryId: "memory-drift-delete",
        })
      )
    );
    const deleteFailure = unwrapFailure(deleteEither);

    assert.equal(deleteFailure._tag, "ContractValidationError");
    assert.equal(
      deleteFailure.contract,
      "SqliteStorageRepositoryOptions.enforceForeignKeys"
    );
    assert.match(deleteFailure.message, /drift detected/i);
  } finally {
    db.close();
  }
});

test("ums-memory-yji.4: sqlite storage repository enables WAL journal mode when configured", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const tempRootDirectory = join(process.cwd(), "dist", "tmp");
  mkdirSync(tempRootDirectory, { recursive: true });
  const fixtureDirectory = mkdtempSync(
    join(tempRootDirectory, "ums-memory-wal-mode-")
  );
  const sqlitePath = join(fixtureDirectory, "storage.sqlite");
  const db = new DatabaseSync(sqlitePath);

  try {
    storageServiceModule.makeSqliteStorageService(db, {
      wal: {
        enabled: true,
      },
    });

    const journalModeRow = expectSqliteRow(
      sqliteGet<{ readonly journal_mode: string }>(db, "PRAGMA journal_mode;")
    );
    assert.equal(String(journalModeRow.journal_mode).toLowerCase(), "wal");
  } finally {
    db.close();
    rmSync(fixtureDirectory, { recursive: true, force: true });
  }
});

test("ums-memory-yji.4: sqlite backup replication creates deterministic snapshots and enforces retention", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const tempRootDirectory = join(process.cwd(), "dist", "tmp");
  mkdirSync(tempRootDirectory, { recursive: true });
  const fixtureDirectory = mkdtempSync(
    join(tempRootDirectory, "ums-memory-backup-retention-")
  );
  const sqlitePath = join(fixtureDirectory, "storage.sqlite");
  const backupDirectory = join(fixtureDirectory, "backups");
  const db = new DatabaseSync(sqlitePath);
  const observedMetadata: BackupReplicationMetadata[] = [];
  const replicationControllers: BackupReplicationController[] = [];

  try {
    const storageService = storageServiceModule.makeSqliteStorageService(db, {
      backupReplication: {
        directoryPath: backupDirectory,
        filePrefix: "snapshot",
        retentionMaxSnapshots: 2,
        autoStart: false,
        clock: createDeterministicBackupClock(1_700_001_000_000),
        onReplicated: (metadata: any) => observedMetadata.push(metadata),
        onControllerReady: (controller: any) => {
          replicationControllers.push(
            controller as BackupReplicationController
          );
        },
      },
    });
    const controller = replicationControllers[0];
    assert.ok(controller);

    Effect.runSync(
      storageService.upsertMemory({
        spaceId: "tenant-backup-retention",
        memoryId: "memory-backup-retention",
        layer: "working",
        payload: {
          title: "Backup retention fixture",
          updatedAtMillis: 1_700_001_000_010,
        },
      })
    );

    const firstSnapshot = controller.replicateNow();
    const secondSnapshot = controller.replicateNow();
    const thirdSnapshot = controller.replicateNow();

    const snapshotFiles = readdirSync(backupDirectory)
      .filter((filename) => filename.endsWith(".sqlite"))
      .sort((left, right) => left.localeCompare(right));
    assert.deepEqual(snapshotFiles, [
      secondSnapshot.snapshotFilename,
      thirdSnapshot.snapshotFilename,
    ]);
    assert.equal(firstSnapshot.sequence, 1);
    assert.equal(secondSnapshot.sequence, 2);
    assert.equal(thirdSnapshot.sequence, 3);
    assert.deepEqual(thirdSnapshot.deletedSnapshotFilenames, [
      firstSnapshot.snapshotFilename,
    ]);
    assert.deepEqual(
      observedMetadata.map((metadata) => metadata.sequence),
      [1, 2, 3]
    );
  } finally {
    replicationControllers[0]?.stop();
    db.close();
    rmSync(fixtureDirectory, { recursive: true, force: true });
  }
});

test("ums-memory-yji.4: sqlite backup replication interval invokes callback metadata and is stoppable", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const tempRootDirectory = join(process.cwd(), "dist", "tmp");
  mkdirSync(tempRootDirectory, { recursive: true });
  const fixtureDirectory = mkdtempSync(
    join(tempRootDirectory, "ums-memory-backup-interval-")
  );
  const sqlitePath = join(fixtureDirectory, "storage.sqlite");
  const backupDirectory = join(fixtureDirectory, "backups");
  const db = new DatabaseSync(sqlitePath);
  const schedulerHarness = createDeterministicIntervalScheduler();
  const observedMetadata: BackupReplicationMetadata[] = [];
  const replicationControllers: BackupReplicationController[] = [];

  try {
    storageServiceModule.makeSqliteStorageService(db, {
      backupReplication: {
        directoryPath: backupDirectory,
        filePrefix: "interval",
        intervalMillis: 5,
        retentionMaxSnapshots: 5,
        clock: createDeterministicBackupClock(1_700_002_000_000),
        scheduler: schedulerHarness.scheduler,
        onReplicated: (metadata: any) => observedMetadata.push(metadata),
        onControllerReady: (controller: any) => {
          replicationControllers.push(
            controller as BackupReplicationController
          );
        },
      },
    });
    const controller = replicationControllers[0];
    assert.ok(controller);
    assert.equal(controller.isRunning(), true);
    assert.equal(schedulerHarness.activeCount(), 1);

    schedulerHarness.tick();
    schedulerHarness.tick();

    assert.equal(observedMetadata.length, 2);
    assert.ok(
      observedMetadata.every((metadata) => metadata.trigger === "interval")
    );
    const firstMetadata = observedMetadata[0];
    assert.ok(firstMetadata);
    assert.equal(firstMetadata.sequence, 1);
    assert.equal(firstMetadata.retainedSnapshotCount, 1);
    assert.deepEqual(firstMetadata.deletedSnapshotFilenames, []);
    assert.match(
      firstMetadata.snapshotFilename,
      /^interval-\d{13}-\d{6}\.sqlite$/
    );

    controller.stop();
    assert.equal(controller.isRunning(), false);
    assert.equal(schedulerHarness.activeCount(), 0);

    schedulerHarness.tick();
    assert.equal(observedMetadata.length, 2);
  } finally {
    replicationControllers[0]?.stop();
    db.close();
    rmSync(fixtureDirectory, { recursive: true, force: true });
  }
});

test("ums-memory-yji.4: interval backup reports errors and stops scheduler on closed database misuse", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const tempRootDirectory = join(process.cwd(), "dist", "tmp");
  mkdirSync(tempRootDirectory, { recursive: true });
  const fixtureDirectory = mkdtempSync(
    join(tempRootDirectory, "ums-memory-backup-interval-error-")
  );
  const sqlitePath = join(fixtureDirectory, "storage.sqlite");
  const backupDirectory = join(fixtureDirectory, "backups");
  const db = new DatabaseSync(sqlitePath);
  const schedulerHarness = createDeterministicIntervalScheduler();
  const observedErrors: any[] = [];
  const replicationControllers: BackupReplicationController[] = [];

  try {
    storageServiceModule.makeSqliteStorageService(db, {
      backupReplication: {
        directoryPath: backupDirectory,
        filePrefix: "interval-error",
        intervalMillis: 5,
        scheduler: schedulerHarness.scheduler,
        onReplicationError: (
          error: ContractValidationError,
          context: { readonly trigger: string }
        ) => {
          observedErrors.push({
            tag: error._tag,
            contract: error.contract,
            details: error.details,
            trigger: context.trigger,
          });
        },
        onControllerReady: (controller: any) => {
          replicationControllers.push(
            controller as BackupReplicationController
          );
        },
      },
    });
    const controller = replicationControllers[0];
    assert.ok(controller);
    assert.equal(controller.isRunning(), true);
    assert.equal(schedulerHarness.activeCount(), 1);

    db.close();
    schedulerHarness.tick();

    assert.equal(observedErrors.length, 1);
    assert.equal(observedErrors[0].tag, "ContractValidationError");
    assert.equal(
      observedErrors[0].contract,
      "SqliteStorageRepositoryOptions.backupReplication.snapshot"
    );
    assert.equal(observedErrors[0].trigger, "interval");
    assert.match(observedErrors[0].details, /SQLITE_MISUSE|closed|not open/i);
    assert.equal(controller.isRunning(), false);
    assert.equal(schedulerHarness.activeCount(), 0);
  } finally {
    replicationControllers[0]?.stop();
    try {
      db.close();
    } catch {}
    rmSync(fixtureDirectory, { recursive: true, force: true });
  }
});

test("ums-memory-yji.4: sqlite backup replication remains a no-op when strategy is unconfigured", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const tempRootDirectory = join(process.cwd(), "dist", "tmp");
  mkdirSync(tempRootDirectory, { recursive: true });
  const fixtureDirectory = mkdtempSync(
    join(tempRootDirectory, "ums-memory-backup-noop-")
  );
  const sqlitePath = join(fixtureDirectory, "storage.sqlite");
  const unusedBackupDirectory = join(fixtureDirectory, "backups-unused");
  const db = new DatabaseSync(sqlitePath);

  try {
    const storageService = storageServiceModule.makeSqliteStorageService(db);
    const response = Effect.runSync(
      storageService.upsertMemory({
        spaceId: "tenant-backup-noop",
        memoryId: "memory-backup-noop",
        layer: "working",
        payload: {
          title: "No-op backup fixture",
          updatedAtMillis: 1_700_003_000_001,
        },
      })
    );
    assert.equal(response.accepted, true);
    assert.equal(existsSync(unusedBackupDirectory), false);
  } finally {
    db.close();
    rmSync(fixtureDirectory, { recursive: true, force: true });
  }
});

test("ums-memory-yji.4: sqlite backup replication restores sequence state and retention across restart", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const tempRootDirectory = join(process.cwd(), "dist", "tmp");
  mkdirSync(tempRootDirectory, { recursive: true });
  const fixtureDirectory = mkdtempSync(
    join(tempRootDirectory, "ums-memory-backup-restart-")
  );
  const sqlitePath = join(fixtureDirectory, "storage.sqlite");
  const backupDirectory = join(fixtureDirectory, "backups");
  const firstDb = new DatabaseSync(sqlitePath);
  let secondDb: DatabaseSync | null = null;
  const firstControllers: BackupReplicationController[] = [];
  const secondControllers: BackupReplicationController[] = [];

  try {
    storageServiceModule.makeSqliteStorageService(firstDb, {
      backupReplication: {
        directoryPath: backupDirectory,
        filePrefix: "restart",
        retentionMaxSnapshots: 2,
        autoStart: false,
        clock: createDeterministicBackupClock(1_700_004_000_000),
        onControllerReady: (controller: any) => {
          firstControllers.push(controller as BackupReplicationController);
        },
      },
    });
    const initialController = firstControllers[0];
    assert.ok(initialController);

    const firstSnapshot = initialController.replicateNow();
    const secondSnapshot = initialController.replicateNow();
    assert.equal(firstSnapshot.sequence, 1);
    assert.equal(secondSnapshot.sequence, 2);
    initialController.stop();
    firstDb.close();

    secondDb = new DatabaseSync(sqlitePath);
    storageServiceModule.makeSqliteStorageService(secondDb, {
      backupReplication: {
        directoryPath: backupDirectory,
        filePrefix: "restart",
        retentionMaxSnapshots: 2,
        autoStart: false,
        clock: createDeterministicBackupClock(1_700_004_000_100),
        onControllerReady: (controller: any) => {
          secondControllers.push(controller as BackupReplicationController);
        },
      },
    });
    const resumedController = secondControllers[0];
    assert.ok(resumedController);

    const thirdSnapshot = resumedController.replicateNow();
    assert.equal(thirdSnapshot.sequence, 3);
    assert.deepEqual(thirdSnapshot.deletedSnapshotFilenames, [
      firstSnapshot.snapshotFilename,
    ]);

    const snapshotFiles = readdirSync(backupDirectory)
      .filter((filename) => filename.endsWith(".sqlite"))
      .sort((left, right) => left.localeCompare(right));
    assert.deepEqual(snapshotFiles, [
      secondSnapshot.snapshotFilename,
      thirdSnapshot.snapshotFilename,
    ]);

    resumedController.stop();
    secondDb.close();
  } finally {
    firstControllers[0]?.stop();
    secondControllers[0]?.stop();
    try {
      firstDb.close();
    } catch {}
    try {
      secondDb?.close();
    } catch {}
    rmSync(fixtureDirectory, { recursive: true, force: true });
  }
});

test("ums-memory-yji.4: sqlite backup replication rejects unsafe filePrefix path traversal input", async () => {
  const storageServiceModule = await loadStorageServiceModule();
  const tempRootDirectory = join(process.cwd(), "dist", "tmp");
  mkdirSync(tempRootDirectory, { recursive: true });
  const fixtureDirectory = mkdtempSync(
    join(tempRootDirectory, "ums-memory-backup-prefix-")
  );
  const sqlitePath = join(fixtureDirectory, "storage.sqlite");
  const backupDirectory = join(fixtureDirectory, "backups");
  const db = new DatabaseSync(sqlitePath);

  try {
    assert.throws(
      () =>
        storageServiceModule.makeSqliteStorageService(db, {
          backupReplication: {
            directoryPath: backupDirectory,
            filePrefix: "../escape",
            autoStart: false,
          },
        }),
      (error) => {
        const contractError = asContractErrorShape(error);
        assert.equal(contractError._tag, "ContractValidationError");
        assert.equal(
          contractError.contract,
          "SqliteStorageRepositoryOptions.backupReplication.filePrefix"
        );
        assert.match(
          contractError.details ?? "",
          /must not contain path separators/i
        );
        return true;
      }
    );
  } finally {
    db.close();
    rmSync(fixtureDirectory, { recursive: true, force: true });
  }
});
