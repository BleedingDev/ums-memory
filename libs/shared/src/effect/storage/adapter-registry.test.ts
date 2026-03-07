import assert from "node:assert/strict";

import { test } from "@effect-native/bun-test";
import { Cause, Effect, Option } from "effect";

import { makeNoopStorageService } from "../services/storage-service.js";
import {
  createStorageServiceFromAdapterRegistry,
  listStorageAdapterIds,
  makePostgresStorageAdapterRegistration,
  makeSqliteStorageAdapterRegistration,
  makeStorageAdapterRegistry,
  postgresStorageAdapterId,
  resolveStorageAdapterRegistration,
  StorageAdapterIdValidationError,
  type StorageAdapterRegistration,
  StorageAdapterDuplicateIdError,
  StorageAdapterUnknownIdError,
} from "./adapter-registry.js";
import type { PostgresStorageRepositoryDriver } from "./postgres/index.js";
import {
  enterprisePostgresSchemaVersion,
  postgresStorageSnapshotFormat,
} from "./postgres/index.js";
import { DatabaseSync } from "./sqlite/database.ts";

const makeNoopAdapterRegistration = (
  id: string
): StorageAdapterRegistration => ({
  id,
  create: () => Effect.succeed(makeNoopStorageService()),
});

const makeNoopPostgresDriver = (): PostgresStorageRepositoryDriver => ({
  getMemory: () => Effect.succeed(null),
  upsertMemory: (record) => Effect.succeed(record),
  deleteMemory: () => Effect.succeed(true),
  getIdempotency: () => Effect.succeed(null),
  putIdempotency: () => Effect.void,
  exportSnapshot: () =>
    Effect.succeed({
      format: postgresStorageSnapshotFormat,
      schemaVersion: enterprisePostgresSchemaVersion,
      tables: [],
    }),
  importSnapshot: () => Effect.void,
});

const expectFailure = async <A, E>(effect: Effect.Effect<A, E>): Promise<E> => {
  const exit = await Effect.runPromiseExit(effect);

  if (exit._tag === "Failure") {
    const failure = Cause.findErrorOption(exit.cause);
    return Option.match(failure, {
      onNone: () => assert.fail("Expected Effect to fail with a typed error."),
      onSome: (error) => error,
    });
  }

  assert.fail("Expected Effect to fail.");
};

void test("makeStorageAdapterRegistry rejects duplicate adapter IDs", async () => {
  const duplicateError = await expectFailure(
    makeStorageAdapterRegistry([
      makeNoopAdapterRegistration("sqlite"),
      makeNoopAdapterRegistration("sqlite"),
    ])
  );

  assert.ok(duplicateError instanceof StorageAdapterDuplicateIdError);
  assert.equal(duplicateError.adapterId, "sqlite");
});

void test("resolveStorageAdapterRegistration fails for unknown adapter IDs", async () => {
  const registry = await Effect.runPromise(
    makeStorageAdapterRegistry([makeNoopAdapterRegistration("sqlite")])
  );

  const unknownError = await expectFailure(
    resolveStorageAdapterRegistration(registry, "postgres")
  );
  assert.ok(unknownError instanceof StorageAdapterUnknownIdError);
  assert.equal(unknownError.adapterId, "postgres");
  assert.deepEqual(unknownError.availableAdapterIds, ["sqlite"]);
});

void test("listStorageAdapterIds returns deterministic sorted IDs", async () => {
  const registry = await Effect.runPromise(
    makeStorageAdapterRegistry([
      makeSqliteStorageAdapterRegistration(),
      makePostgresStorageAdapterRegistration(),
      makeNoopAdapterRegistration("archive"),
    ])
  );

  assert.deepEqual(listStorageAdapterIds(registry), [
    "archive",
    "postgres",
    "sqlite",
  ]);
  assert.deepEqual(listStorageAdapterIds(registry), [
    "archive",
    "postgres",
    "sqlite",
  ]);
});

void test("sqlite adapter registration can create a working storage service", async () => {
  const database = new DatabaseSync(":memory:");

  try {
    const registry = await Effect.runPromise(
      makeStorageAdapterRegistry([makeSqliteStorageAdapterRegistration()])
    );

    const storageService = await Effect.runPromise(
      createStorageServiceFromAdapterRegistry(registry, {
        adapterId: "sqlite",
        configuration: { database },
      })
    );

    const snapshot = await Effect.runPromise(
      storageService.exportSnapshot({
        signatureSecret: "sqlite-test-secret",
      })
    );

    assert.equal(snapshot.signatureAlgorithm, "hmac-sha256");
    assert.ok(
      snapshot.payload.includes("ums-memory/sqlite-storage-snapshot/v1")
    );
    assert.ok(snapshot.tableCount > 0);
  } finally {
    database.close();
  }
});

void test("postgres adapter registration can create a working storage service", async () => {
  const registry = await Effect.runPromise(
    makeStorageAdapterRegistry([makePostgresStorageAdapterRegistration()])
  );

  const storageService = await Effect.runPromise(
    createStorageServiceFromAdapterRegistry(registry, {
      adapterId: postgresStorageAdapterId,
      configuration: {
        driver: makeNoopPostgresDriver(),
      },
    })
  );

  const snapshot = await Effect.runPromise(
    storageService.exportSnapshot({
      signature_secret: "postgres-test-secret",
    })
  );

  assert.equal(snapshot.signatureAlgorithm, "hmac-sha256");
  assert.ok(
    snapshot.payload.includes("ums-memory/postgres-storage-snapshot/v1")
  );
  assert.equal(snapshot.tableCount, 0);
});

void test("resolveStorageAdapterRegistration rejects invalid adapter ID format", async () => {
  const registry = await Effect.runPromise(
    makeStorageAdapterRegistry([makeNoopAdapterRegistration("sqlite")])
  );

  const validationError = await expectFailure(
    resolveStorageAdapterRegistration(registry, " SQLite ")
  );

  assert.ok(validationError instanceof StorageAdapterIdValidationError);
  assert.equal(validationError.adapterId, " SQLite ");
});

void test("sqlite adapter registration rejects missing database configuration", async () => {
  const registry = await Effect.runPromise(
    makeStorageAdapterRegistry([makeSqliteStorageAdapterRegistration()])
  );

  const configurationError = await expectFailure(
    createStorageServiceFromAdapterRegistry(registry, {
      adapterId: "sqlite",
      configuration: {},
    })
  );

  assert.equal(configurationError._tag, "ContractValidationError");
  assert.equal(
    configurationError.contract,
    "SqliteStorageAdapterConfiguration"
  );
});

void test("postgres adapter registration rejects missing driver configuration", async () => {
  const registry = await Effect.runPromise(
    makeStorageAdapterRegistry([makePostgresStorageAdapterRegistration()])
  );

  const configurationError = await expectFailure(
    createStorageServiceFromAdapterRegistry(registry, {
      adapterId: postgresStorageAdapterId,
      configuration: {},
    })
  );

  assert.equal(configurationError._tag, "ContractValidationError");
  assert.equal(
    configurationError.contract,
    "PostgresStorageAdapterConfiguration"
  );
});
