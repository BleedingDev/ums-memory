import type { DatabaseSync } from "node:sqlite";
import { Context, Effect, Layer } from "effect";

import type {
  StorageDeleteRequest,
  StorageDeleteResponse,
  StorageUpsertRequest,
  StorageUpsertResponse,
} from "../contracts/index.js";
import { ContractValidationError, type StorageServiceError } from "../errors.js";
import {
  makeSqliteStorageRepository,
  type SqliteStorageRepositoryOptions,
} from "../storage/sqlite/index.js";

export type {
  StorageDeleteRequest,
  StorageDeleteResponse,
  StorageUpsertRequest,
  StorageUpsertResponse,
} from "../contracts/index.js";

export interface StorageService {
  readonly upsertMemory: (
    request: StorageUpsertRequest,
  ) => Effect.Effect<StorageUpsertResponse, StorageServiceError>;
  readonly deleteMemory: (
    request: StorageDeleteRequest,
  ) => Effect.Effect<StorageDeleteResponse, StorageServiceError>;
}

export interface StorageRepository {
  readonly upsertMemory: (
    request: StorageUpsertRequest,
  ) => Effect.Effect<StorageUpsertResponse, StorageServiceError>;
  readonly deleteMemory: (
    request: StorageDeleteRequest,
  ) => Effect.Effect<StorageDeleteResponse, StorageServiceError>;
}

export const StorageServiceTag = Context.GenericTag<StorageService>("@ums/effect/StorageService");

export const makeNoopStorageService = (): StorageService => ({
  upsertMemory: (request) =>
    Effect.succeed({
      spaceId: request.spaceId,
      memoryId: request.memoryId,
      accepted: true,
      persistedAtMillis: 0,
      version: 1,
    }),
  deleteMemory: (request) =>
    Effect.succeed({
      spaceId: request.spaceId,
      memoryId: request.memoryId,
      deleted: true,
    }),
});

export const makeStorageServiceFromRepository = (
  repository: StorageRepository,
): StorageService => ({
  upsertMemory: (request) => repository.upsertMemory(request),
  deleteMemory: (request) => repository.deleteMemory(request),
});

// Unsafe synchronous constructor; prefer makeSqliteStorageServiceEffect/makeSqliteStorageLayer
// for typed initialization failures in the Effect error channel.
export const makeSqliteStorageService = (
  database: DatabaseSync,
  options: SqliteStorageRepositoryOptions = {},
): StorageService =>
  makeStorageServiceFromRepository(makeSqliteStorageRepository(database, options));

const toStorageInitializationError = (cause: unknown): ContractValidationError => {
  if (cause instanceof ContractValidationError) {
    return cause;
  }

  return new ContractValidationError({
    contract: "StorageServiceInitialization",
    message: "Failed to initialize SQLite storage service",
    details:
      cause instanceof Error ? cause.message : `Unknown initialization failure: ${String(cause)}`,
  });
};

export const makeSqliteStorageServiceEffect = (
  database: DatabaseSync,
  options: SqliteStorageRepositoryOptions = {},
): Effect.Effect<StorageService, StorageServiceError> =>
  Effect.try({
    try: () => makeSqliteStorageService(database, options),
    catch: toStorageInitializationError,
  });

export const noopStorageLayer: Layer.Layer<StorageService> = Layer.succeed(
  StorageServiceTag,
  makeNoopStorageService(),
);

export const makeSqliteStorageLayer = (
  database: DatabaseSync,
  options: SqliteStorageRepositoryOptions = {},
): Layer.Layer<StorageService, StorageServiceError> =>
  Layer.effect(StorageServiceTag, makeSqliteStorageServiceEffect(database, options));

export const deterministicTestStorageLayer: Layer.Layer<StorageService> = noopStorageLayer;
