import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import { test } from "@effect-native/bun-test";
import { Effect, Schema } from "effect";

import {
  MemoryIdSchema,
  type MemoryId,
  SpaceIdSchema,
  type SpaceId,
} from "../../libs/shared/src/effect/contracts/index.ts";
import { makeStorageServiceFromRepository } from "../../libs/shared/src/effect/services/storage-service.ts";
import {
  enterprisePostgresSchemaVersion,
  makePostgresStorageRepository,
  postgresStorageSnapshotFormat,
  postgresStorageSnapshotSignatureAlgorithm,
  type PostgresStorageRepositoryDriver,
  type PostgresStorageSnapshotData,
  type PostgresStorageSnapshotTable,
  type PostgresStoredIdempotencyRecord,
  type PostgresStoredMemoryRecord,
} from "../../libs/shared/src/effect/storage/postgres/index.ts";

const decodeSpaceId = Schema.decodeUnknownSync(SpaceIdSchema);
const decodeMemoryId = Schema.decodeUnknownSync(MemoryIdSchema);
const asSpaceId = (value: string): SpaceId => decodeSpaceId(value);
const asMemoryId = (value: string): MemoryId => decodeMemoryId(value);
const ContractValidationErrorShape = Schema.Struct({
  _tag: Schema.Literal("ContractValidationError"),
  contract: Schema.String,
  message: Schema.String,
  details: Schema.String,
});
const StorageNotFoundErrorShape = Schema.Struct({
  _tag: Schema.Literal("StorageNotFoundError"),
  spaceId: SpaceIdSchema,
  memoryId: MemoryIdSchema,
  message: Schema.String,
});
const isContractValidationError = Schema.is(ContractValidationErrorShape);
const isStorageNotFoundError = Schema.is(StorageNotFoundErrorShape);
const upsertDeterministicTestName =
  "ums-memory-onf.2: postgres repository upserts " +
  "deterministically and increments version";
const idempotencyReplayTestName =
  "ums-memory-onf.2: postgres repository replays " +
  "idempotent upserts and rejects hash drift";
const deleteReplayTestName =
  "ums-memory-onf.2: postgres repository deletes memories " +
  "and preserves delete idempotency replay";
const snapshotRoundtripTestName =
  "ums-memory-onf.2: postgres repository exports and imports " +
  "canonical signed snapshots";
const signSnapshotPayload = (payload: string, secret: string): string =>
  createHmac("sha256", secret).update(payload).digest("hex");

const runEither = <Success, Error>(effect: Effect.Effect<Success, Error>) =>
  Effect.runPromise(
    Effect.result(effect).pipe(
      Effect.map((result) =>
        result._tag === "Failure"
          ? { _tag: "Left" as const, left: result.failure }
          : { _tag: "Right" as const, right: result.success }
      )
    )
  );

const createDeterministicClock = (startAt = 1_710_000_000_000) => {
  let currentMillis = startAt;
  return () => {
    const nextMillis = currentMillis;
    currentMillis += 1;
    return nextMillis;
  };
};

type InMemoryPostgresDriver = PostgresStorageRepositoryDriver & {
  readonly state: {
    readonly memories: Map<string, PostgresStoredMemoryRecord>;
    readonly idempotency: Map<string, PostgresStoredIdempotencyRecord>;
  };
};

const memoryKey = (spaceId: SpaceId, memoryId: MemoryId) =>
  `${spaceId}::${memoryId}`;

const ledgerKey = (
  spaceId: SpaceId,
  operation: "upsert" | "delete",
  idempotencyValue: string
) => `${spaceId}::${operation}::${idempotencyValue}`;

const snapshotColumns = Object.freeze({
  memory_items: [
    "space_id",
    "memory_id",
    "memory_layer",
    "payload_json",
    "persisted_at_ms",
    "version",
  ],
  storage_idempotency_ledger: [
    "space_id",
    "operation",
    "idempotency_key",
    "request_hash_sha256",
    "response_json",
  ],
});

const createInMemoryPostgresDriver = (): InMemoryPostgresDriver => {
  const memories = new Map<string, PostgresStoredMemoryRecord>();
  const idempotency = new Map<string, PostgresStoredIdempotencyRecord>();

  const buildSnapshotTables = (): readonly PostgresStorageSnapshotTable[] =>
    Object.freeze([
      Object.freeze({
        name: "memory_items",
        columns: snapshotColumns.memory_items,
        rows: Object.freeze(
          [...memories.values()].map((record) =>
            Object.freeze([
              record.spaceId,
              record.memoryId,
              record.layer,
              record.payloadJson,
              record.persistedAtMillis,
              record.version,
            ])
          )
        ),
      }),
      Object.freeze({
        name: "storage_idempotency_ledger",
        columns: snapshotColumns.storage_idempotency_ledger,
        rows: Object.freeze(
          [...idempotency.values()].map((record) =>
            Object.freeze([
              record.spaceId,
              record.operation,
              record.idempotencyKey,
              record.requestHashSha256,
              record.responseJson,
            ])
          )
        ),
      }),
    ]);

  const parseSnapshot = (
    snapshot: PostgresStorageSnapshotData
  ): {
    readonly memories: readonly PostgresStoredMemoryRecord[];
    readonly idempotency: readonly PostgresStoredIdempotencyRecord[];
  } => {
    const memoryTable = snapshot.tables.find(
      (table) => table.name === "memory_items"
    );
    const idempotencyTable = snapshot.tables.find(
      (table) => table.name === "storage_idempotency_ledger"
    );

    return {
      memories: Object.freeze(
        (memoryTable?.rows ?? []).map((row) => ({
          spaceId: row[0] as SpaceId,
          memoryId: row[1] as MemoryId,
          layer: row[2] as PostgresStoredMemoryRecord["layer"],
          payloadJson: row[3] as string,
          persistedAtMillis: row[4] as number,
          version: row[5] as number,
        }))
      ),
      idempotency: Object.freeze(
        (idempotencyTable?.rows ?? []).map((row) => ({
          spaceId: row[0] as SpaceId,
          operation: row[1] as "upsert" | "delete",
          idempotencyKey: row[2] as string,
          requestHashSha256: row[3] as string,
          responseJson: row[4] as string,
        }))
      ),
    };
  };

  return {
    state: {
      memories,
      idempotency,
    },
    getMemory: (spaceId, memoryId) =>
      Effect.succeed(memories.get(memoryKey(spaceId, memoryId)) ?? null),
    upsertMemory: (record) =>
      Effect.sync(() => {
        memories.set(memoryKey(record.spaceId, record.memoryId), record);
        return record;
      }),
    deleteMemory: (spaceId, memoryId) =>
      Effect.sync(() => memories.delete(memoryKey(spaceId, memoryId))),
    getIdempotency: (spaceId, operation, key) =>
      Effect.succeed(
        idempotency.get(ledgerKey(spaceId, operation, key)) ?? null
      ),
    putIdempotency: (record) =>
      Effect.sync(() => {
        idempotency.set(
          ledgerKey(record.spaceId, record.operation, record.idempotencyKey),
          record
        );
      }),
    exportSnapshot: () =>
      Effect.succeed({
        format: postgresStorageSnapshotFormat,
        schemaVersion: enterprisePostgresSchemaVersion,
        tables: buildSnapshotTables(),
      }),
    importSnapshot: (snapshot) =>
      Effect.sync(() => {
        memories.clear();
        idempotency.clear();
        const decoded = parseSnapshot(snapshot);
        for (const record of decoded.memories) {
          memories.set(memoryKey(record.spaceId, record.memoryId), record);
        }
        for (const record of decoded.idempotency) {
          idempotency.set(
            ledgerKey(record.spaceId, record.operation, record.idempotencyKey),
            record
          );
        }
      }),
  };
};

test(upsertDeterministicTestName, async () => {
  const driver = createInMemoryPostgresDriver();
  const storageService = makeStorageServiceFromRepository(
    makePostgresStorageRepository(driver, {
      now: createDeterministicClock(),
    })
  );

  const first = await Effect.runPromise(
    storageService.upsertMemory({
      spaceId: asSpaceId("tenant-postgres"),
      memoryId: asMemoryId("memory-1"),
      layer: "working",
      payload: {
        title: "deterministic payload",
        weight: 1.5,
      },
    })
  );
  const second = await Effect.runPromise(
    storageService.upsertMemory({
      spaceId: asSpaceId("tenant-postgres"),
      memoryId: asMemoryId("memory-1"),
      layer: "working",
      payload: {
        weight: 2.25,
        title: "deterministic payload",
      },
    })
  );

  assert.deepEqual(first, {
    spaceId: "tenant-postgres",
    memoryId: "memory-1",
    accepted: true,
    persistedAtMillis: 1_710_000_000_000,
    version: 1,
  });
  assert.deepEqual(second, {
    spaceId: "tenant-postgres",
    memoryId: "memory-1",
    accepted: true,
    persistedAtMillis: 1_710_000_000_001,
    version: 2,
  });
  assert.equal(driver.state.memories.size, 1);
  assert.equal(
    driver.state.memories.get("tenant-postgres::memory-1")?.payloadJson,
    JSON.stringify({
      title: "deterministic payload",
      weight: 2.25,
    })
  );
});

test(idempotencyReplayTestName, async () => {
  const driver = createInMemoryPostgresDriver();
  const storageService = makeStorageServiceFromRepository(
    makePostgresStorageRepository(driver, {
      now: createDeterministicClock(),
    })
  );

  const first = await Effect.runPromise(
    storageService.upsertMemory({
      spaceId: asSpaceId("tenant-postgres"),
      memoryId: asMemoryId("memory-idem"),
      layer: "procedural",
      payload: {
        title: "stable",
        count: 1,
      },
      idempotencyKey: "upsert-1",
    })
  );
  const replay = await Effect.runPromise(
    storageService.upsertMemory({
      spaceId: asSpaceId("tenant-postgres"),
      memoryId: asMemoryId("memory-idem"),
      layer: "procedural",
      payload: {
        count: 1,
        title: "stable",
      },
      idempotencyKey: "upsert-1",
    })
  );
  const drift = await runEither(
    storageService.upsertMemory({
      spaceId: asSpaceId("tenant-postgres"),
      memoryId: asMemoryId("memory-idem"),
      layer: "procedural",
      payload: {
        title: "changed",
        count: 2,
      },
      idempotencyKey: "upsert-1",
    })
  );

  assert.deepEqual(replay, first);
  assert.equal(driver.state.memories.size, 1);
  assert.equal(driver.state.idempotency.size, 1);
  assert.equal(drift._tag, "Left");
  assert.ok(isContractValidationError(drift.left));
  assert.equal(drift.left.contract, "StorageUpsertRequest.idempotencyKey");
});

test("ums-memory-onf.2: postgres repository rejects mismatched idempotency aliases", async () => {
  const driver = createInMemoryPostgresDriver();
  const storageService = makeStorageServiceFromRepository(
    makePostgresStorageRepository(driver, {
      now: createDeterministicClock(),
    })
  );

  const conflictingAliases = await runEither(
    storageService.upsertMemory({
      spaceId: asSpaceId("tenant-postgres"),
      memoryId: asMemoryId("memory-alias"),
      layer: "working",
      payload: {
        title: "alias mismatch",
      },
      idempotencyKey: "camel-key",
      idempotency_key: "snake-key",
    })
  );

  assert.equal(conflictingAliases._tag, "Left");
  assert.ok(isContractValidationError(conflictingAliases.left));
  assert.equal(
    conflictingAliases.left.contract,
    "StorageUpsertRequest.idempotencyKey"
  );
});

test(deleteReplayTestName, async () => {
  const driver = createInMemoryPostgresDriver();
  const storageService = makeStorageServiceFromRepository(
    makePostgresStorageRepository(driver, {
      now: createDeterministicClock(),
    })
  );

  await Effect.runPromise(
    storageService.upsertMemory({
      spaceId: asSpaceId("tenant-postgres"),
      memoryId: asMemoryId("memory-delete"),
      layer: "episodic",
      payload: {
        title: "delete me",
      },
    })
  );
  const firstDelete = await Effect.runPromise(
    storageService.deleteMemory({
      spaceId: asSpaceId("tenant-postgres"),
      memoryId: asMemoryId("memory-delete"),
      idempotencyKey: "delete-1",
    })
  );
  const replayDelete = await Effect.runPromise(
    storageService.deleteMemory({
      spaceId: asSpaceId("tenant-postgres"),
      memoryId: asMemoryId("memory-delete"),
      idempotencyKey: "delete-1",
    })
  );
  const missingDelete = await runEither(
    storageService.deleteMemory({
      spaceId: asSpaceId("tenant-postgres"),
      memoryId: asMemoryId("missing-memory"),
    })
  );

  assert.deepEqual(firstDelete, {
    spaceId: "tenant-postgres",
    memoryId: "memory-delete",
    deleted: true,
  });
  assert.deepEqual(replayDelete, firstDelete);
  assert.equal(driver.state.memories.size, 0);
  assert.equal(missingDelete._tag, "Left");
  assert.ok(isStorageNotFoundError(missingDelete.left));
  assert.equal(missingDelete.left._tag, "StorageNotFoundError");
});

test("ums-memory-onf.2: postgres repository rejects delete idempotency hash drift", async () => {
  const driver = createInMemoryPostgresDriver();
  const storageService = makeStorageServiceFromRepository(
    makePostgresStorageRepository(driver, {
      now: createDeterministicClock(),
    })
  );

  await Effect.runPromise(
    storageService.upsertMemory({
      spaceId: asSpaceId("tenant-postgres"),
      memoryId: asMemoryId("memory-delete-drift"),
      layer: "episodic",
      payload: {
        title: "delete drift",
      },
    })
  );
  await Effect.runPromise(
    storageService.deleteMemory({
      spaceId: asSpaceId("tenant-postgres"),
      memoryId: asMemoryId("memory-delete-drift"),
      idempotencyKey: "delete-drift",
    })
  );
  const drift = await runEither(
    storageService.deleteMemory({
      spaceId: asSpaceId("tenant-postgres"),
      memoryId: asMemoryId("memory-delete-different"),
      idempotencyKey: "delete-drift",
    })
  );

  assert.equal(drift._tag, "Left");
  assert.ok(isContractValidationError(drift.left));
  assert.equal(drift.left.contract, "StorageDeleteRequest.idempotencyKey");
});

test("ums-memory-onf.2: postgres repository rejects mismatched delete idempotency aliases", async () => {
  const driver = createInMemoryPostgresDriver();
  const storageService = makeStorageServiceFromRepository(
    makePostgresStorageRepository(driver, {
      now: createDeterministicClock(),
    })
  );

  const conflictingAliases = await runEither(
    storageService.deleteMemory({
      spaceId: asSpaceId("tenant-postgres"),
      memoryId: asMemoryId("memory-delete-alias"),
      idempotencyKey: "camel-delete-key",
      idempotency_key: "snake-delete-key",
    })
  );

  assert.equal(conflictingAliases._tag, "Left");
  assert.ok(isContractValidationError(conflictingAliases.left));
  assert.equal(
    conflictingAliases.left.contract,
    "StorageDeleteRequest.idempotencyKey"
  );
});

test(snapshotRoundtripTestName, async () => {
  const sourceDriver = createInMemoryPostgresDriver();
  const sourceStorageService = makeStorageServiceFromRepository(
    makePostgresStorageRepository(sourceDriver, {
      now: createDeterministicClock(1_720_000_000_000),
    })
  );

  await Effect.runPromise(
    sourceStorageService.upsertMemory({
      spaceId: asSpaceId("tenant-postgres"),
      memoryId: asMemoryId("memory-snapshot"),
      layer: "working",
      payload: {
        nested: {
          alpha: 1,
        },
        title: "snapshot payload",
      },
      idempotencyKey: "snapshot-upsert",
    })
  );

  const exported = await Effect.runPromise(
    sourceStorageService.exportSnapshot({
      signatureSecret: "postgres-secret",
    })
  );
  const targetDriver = createInMemoryPostgresDriver();
  const targetStorageService = makeStorageServiceFromRepository(
    makePostgresStorageRepository(targetDriver, {
      now: createDeterministicClock(1_730_000_000_000),
    })
  );

  const imported = await Effect.runPromise(
    targetStorageService.importSnapshot({
      signatureSecret: "postgres-secret",
      signatureAlgorithm: postgresStorageSnapshotSignatureAlgorithm,
      payload: exported.payload,
      signature: exported.signature,
    })
  );
  const replayed = await Effect.runPromise(
    targetStorageService.importSnapshot({
      signatureSecret: "postgres-secret",
      signatureAlgorithm: postgresStorageSnapshotSignatureAlgorithm,
      payload: exported.payload,
      signature: exported.signature,
    })
  );
  const reexported = await Effect.runPromise(
    targetStorageService.exportSnapshot({
      signatureSecret: "postgres-secret",
    })
  );

  assert.equal(
    exported.signatureAlgorithm,
    postgresStorageSnapshotSignatureAlgorithm
  );
  assert.ok(exported.payload.includes(postgresStorageSnapshotFormat));
  assert.deepEqual(imported, {
    imported: true,
    replayed: false,
    tableCount: 2,
    rowCount: 2,
  });
  assert.deepEqual(replayed, {
    imported: true,
    replayed: true,
    tableCount: 2,
    rowCount: 2,
  });
  assert.equal(reexported.payload, exported.payload);
  assert.equal(reexported.signature, exported.signature);
});

test("ums-memory-onf.2: postgres repository accepts snapshot signing secret aliases", async () => {
  const sourceDriver = createInMemoryPostgresDriver();
  const sourceStorageService = makeStorageServiceFromRepository(
    makePostgresStorageRepository(sourceDriver, {
      now: createDeterministicClock(1_740_000_000_000),
    })
  );
  const targetDriver = createInMemoryPostgresDriver();
  const targetStorageService = makeStorageServiceFromRepository(
    makePostgresStorageRepository(targetDriver, {
      now: createDeterministicClock(1_750_000_000_000),
    })
  );

  await Effect.runPromise(
    sourceStorageService.upsertMemory({
      spaceId: asSpaceId("tenant-postgres"),
      memoryId: asMemoryId("memory-snapshot-alias"),
      layer: "working",
      payload: {
        title: "alias payload",
      },
    })
  );

  const exported = await Effect.runPromise(
    sourceStorageService.exportSnapshot({
      signature_secret: "postgres-secret",
    })
  );
  const imported = await Effect.runPromise(
    targetStorageService.importSnapshot({
      signature_secret: "postgres-secret",
      signatureAlgorithm: postgresStorageSnapshotSignatureAlgorithm,
      payload: exported.payload,
      signature: exported.signature,
    })
  );

  assert.equal(exported.signatureAlgorithm, "hmac-sha256");
  assert.deepEqual(imported, {
    imported: true,
    replayed: false,
    tableCount: 2,
    rowCount: 1,
  });
});

test("ums-memory-onf.2: postgres repository rejects mismatched snapshot signing secret aliases", async () => {
  const driver = createInMemoryPostgresDriver();
  const storageService = makeStorageServiceFromRepository(
    makePostgresStorageRepository(driver, {
      now: createDeterministicClock(),
    })
  );

  const conflictingAliases = await runEither(
    storageService.exportSnapshot({
      signatureSecret: "postgres-secret",
      signature_secret: "other-secret",
    })
  );

  assert.equal(conflictingAliases._tag, "Left");
  assert.ok(isContractValidationError(conflictingAliases.left));
  assert.equal(
    conflictingAliases.left.contract,
    "StorageSnapshotExportRequest.signatureSecret"
  );
});

test("ums-memory-onf.2: postgres repository rejects mismatched snapshot signing secret aliases during import", async () => {
  const driver = createInMemoryPostgresDriver();
  const storageService = makeStorageServiceFromRepository(
    makePostgresStorageRepository(driver, {
      now: createDeterministicClock(),
    })
  );
  const exported = await Effect.runPromise(
    storageService.exportSnapshot({
      signatureSecret: "postgres-secret",
    })
  );

  const conflictingAliases = await runEither(
    storageService.importSnapshot({
      signatureSecret: "postgres-secret",
      signature_secret: "other-secret",
      signatureAlgorithm: postgresStorageSnapshotSignatureAlgorithm,
      payload: exported.payload,
      signature: exported.signature,
    })
  );

  assert.equal(conflictingAliases._tag, "Left");
  assert.ok(isContractValidationError(conflictingAliases.left));
  assert.equal(
    conflictingAliases.left.contract,
    "StorageSnapshotImportRequest.signatureSecret"
  );
});

test("ums-memory-onf.2: postgres repository requires a snapshot signing secret", async () => {
  const driver = createInMemoryPostgresDriver();
  const storageService = makeStorageServiceFromRepository(
    makePostgresStorageRepository(driver, {
      now: createDeterministicClock(),
    })
  );

  const missingSecret = await runEither(
    storageService.exportSnapshot({} as never)
  );

  assert.equal(missingSecret._tag, "Left");
  assert.ok(isContractValidationError(missingSecret.left));
  assert.equal(missingSecret.left.contract, "StorageSnapshotExportRequest");
});

test("ums-memory-onf.2: postgres repository rejects tampered snapshot signatures", async () => {
  const driver = createInMemoryPostgresDriver();
  const storageService = makeStorageServiceFromRepository(
    makePostgresStorageRepository(driver, {
      now: createDeterministicClock(),
    })
  );

  const exported = await Effect.runPromise(
    storageService.exportSnapshot({
      signatureSecret: "postgres-secret",
    })
  );
  const tampered = await runEither(
    storageService.importSnapshot({
      signatureSecret: "postgres-secret",
      signatureAlgorithm: postgresStorageSnapshotSignatureAlgorithm,
      payload: exported.payload,
      signature: exported.signature.replace(/.$/, "0"),
    })
  );

  assert.equal(tampered._tag, "Left");
  assert.ok(isContractValidationError(tampered.left));
  assert.equal(
    tampered.left.contract,
    "StorageSnapshotImportRequest.signature"
  );
});

test("ums-memory-onf.2: postgres repository rejects unsupported snapshot signature algorithms", async () => {
  const driver = createInMemoryPostgresDriver();
  const storageService = makeStorageServiceFromRepository(
    makePostgresStorageRepository(driver, {
      now: createDeterministicClock(),
    })
  );

  const exported = await Effect.runPromise(
    storageService.exportSnapshot({
      signatureSecret: "postgres-secret",
    })
  );
  const unsupported = await runEither(
    storageService.importSnapshot({
      signatureSecret: "postgres-secret",
      signatureAlgorithm: "hmac-sha256-invalid" as "hmac-sha256",
      payload: exported.payload,
      signature: exported.signature,
    })
  );

  assert.equal(unsupported._tag, "Left");
  assert.ok(isContractValidationError(unsupported.left));
  assert.equal(unsupported.left.contract, "StorageSnapshotImportRequest");
});

test("ums-memory-onf.2: postgres repository rejects non-canonical snapshot payloads even with a valid signature", async () => {
  const driver = createInMemoryPostgresDriver();
  const storageService = makeStorageServiceFromRepository(
    makePostgresStorageRepository(driver, {
      now: createDeterministicClock(),
    })
  );

  const payload = JSON.stringify({
    tables: [],
    format: postgresStorageSnapshotFormat,
    schemaVersion: enterprisePostgresSchemaVersion,
  });
  const nonCanonical = await runEither(
    storageService.importSnapshot({
      signatureSecret: "postgres-secret",
      signatureAlgorithm: postgresStorageSnapshotSignatureAlgorithm,
      payload,
      signature: signSnapshotPayload(payload, "postgres-secret"),
    })
  );

  assert.equal(nonCanonical._tag, "Left");
  assert.ok(isContractValidationError(nonCanonical.left));
  assert.equal(
    nonCanonical.left.contract,
    "StorageSnapshotImportRequest.payload"
  );
});

test("ums-memory-onf.2: postgres repository rejects snapshot payloads with unknown tables", async () => {
  const driver = createInMemoryPostgresDriver();
  const storageService = makeStorageServiceFromRepository(
    makePostgresStorageRepository(driver, {
      now: createDeterministicClock(),
    })
  );

  const payload = JSON.stringify({
    format: postgresStorageSnapshotFormat,
    schemaVersion: enterprisePostgresSchemaVersion,
    tables: [
      {
        name: "unknown_table",
        columns: ["id"],
        rows: [["row-1"]],
      },
    ],
  });
  const unknownTable = await runEither(
    storageService.importSnapshot({
      signatureSecret: "postgres-secret",
      signatureAlgorithm: postgresStorageSnapshotSignatureAlgorithm,
      payload,
      signature: signSnapshotPayload(payload, "postgres-secret"),
    })
  );

  assert.equal(unknownTable._tag, "Left");
  assert.ok(isContractValidationError(unknownTable.left));
  assert.equal(
    unknownTable.left.contract,
    "PostgresStorageSnapshotData.tables.name"
  );
});

test("ums-memory-onf.2: postgres repository rejects snapshot payloads with duplicate table entries", async () => {
  const driver = createInMemoryPostgresDriver();
  const storageService = makeStorageServiceFromRepository(
    makePostgresStorageRepository(driver, {
      now: createDeterministicClock(),
    })
  );

  const payload = JSON.stringify({
    format: postgresStorageSnapshotFormat,
    schemaVersion: enterprisePostgresSchemaVersion,
    tables: [
      {
        name: "memory_items",
        columns: snapshotColumns.memory_items,
        rows: [],
      },
      {
        name: "memory_items",
        columns: snapshotColumns.memory_items,
        rows: [],
      },
    ],
  });
  const duplicateTables = await runEither(
    storageService.importSnapshot({
      signatureSecret: "postgres-secret",
      signatureAlgorithm: postgresStorageSnapshotSignatureAlgorithm,
      payload,
      signature: signSnapshotPayload(payload, "postgres-secret"),
    })
  );

  assert.equal(duplicateTables._tag, "Left");
  assert.ok(isContractValidationError(duplicateTables.left));
  assert.equal(
    duplicateTables.left.contract,
    "PostgresStorageSnapshotData.tables"
  );
});

test("ums-memory-onf.2: postgres repository rejects snapshot rows with mismatched column counts", async () => {
  const driver = createInMemoryPostgresDriver();
  const storageService = makeStorageServiceFromRepository(
    makePostgresStorageRepository(driver, {
      now: createDeterministicClock(),
    })
  );

  const payload = JSON.stringify({
    format: postgresStorageSnapshotFormat,
    schemaVersion: enterprisePostgresSchemaVersion,
    tables: [
      {
        name: "memory_items",
        columns: snapshotColumns.memory_items,
        rows: [["tenant-postgres"]],
      },
    ],
  });
  const malformedRows = await runEither(
    storageService.importSnapshot({
      signatureSecret: "postgres-secret",
      signatureAlgorithm: postgresStorageSnapshotSignatureAlgorithm,
      payload,
      signature: signSnapshotPayload(payload, "postgres-secret"),
    })
  );

  assert.equal(malformedRows._tag, "Left");
  assert.ok(isContractValidationError(malformedRows.left));
  assert.equal(
    malformedRows.left.contract,
    "PostgresStorageSnapshotData.tables.rows"
  );
});

test("ums-memory-onf.2: postgres repository rejects snapshot tables with mismatched column definitions", async () => {
  const driver = createInMemoryPostgresDriver();
  const storageService = makeStorageServiceFromRepository(
    makePostgresStorageRepository(driver, {
      now: createDeterministicClock(),
    })
  );

  const payload = JSON.stringify({
    format: postgresStorageSnapshotFormat,
    schemaVersion: enterprisePostgresSchemaVersion,
    tables: [
      {
        name: "memory_items",
        columns: ["memory_id", "space_id", "memory_layer"],
        rows: [["memory-1", "tenant-postgres", "working"]],
      },
    ],
  });
  const malformedColumns = await runEither(
    storageService.importSnapshot({
      signatureSecret: "postgres-secret",
      signatureAlgorithm: postgresStorageSnapshotSignatureAlgorithm,
      payload,
      signature: signSnapshotPayload(payload, "postgres-secret"),
    })
  );

  assert.equal(malformedColumns._tag, "Left");
  assert.ok(isContractValidationError(malformedColumns.left));
  assert.equal(
    malformedColumns.left.contract,
    "PostgresStorageSnapshotData.tables.columns"
  );
});
