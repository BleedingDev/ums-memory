import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { Cause, Effect, Option } from "effect";

import { makeNoopStorageService } from "../services/storage-service.js";
import {
  createStorageServiceFromAdapterRegistry,
  listStorageAdapterIds,
  makeSqliteStorageAdapterRegistration,
  makeStorageAdapterRegistry,
  resolveStorageAdapterRegistration,
  StorageAdapterIdValidationError,
  type StorageAdapterRegistration,
  StorageAdapterDuplicateIdError,
  StorageAdapterUnknownIdError,
} from "./adapter-registry.js";

const makeNoopAdapterRegistration = (
  id: string
): StorageAdapterRegistration => ({
  id,
  create: () => Effect.succeed(makeNoopStorageService()),
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
      makeNoopAdapterRegistration("zeta"),
      makeNoopAdapterRegistration("alpha"),
      makeNoopAdapterRegistration("beta"),
    ])
  );

  assert.deepEqual(listStorageAdapterIds(registry), ["alpha", "beta", "zeta"]);
  assert.deepEqual(listStorageAdapterIds(registry), ["alpha", "beta", "zeta"]);
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
