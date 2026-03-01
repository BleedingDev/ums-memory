import { Context, Effect, Layer } from "effect";

import type {
  StorageDeleteRequest,
  StorageDeleteResponse,
  StorageUpsertRequest,
  StorageUpsertResponse,
} from "../contracts/index.js";
import type { StorageServiceError } from "../errors.js";

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

export const noopStorageLayer: Layer.Layer<StorageService> = Layer.succeed(
  StorageServiceTag,
  makeNoopStorageService(),
);

export const deterministicTestStorageLayer: Layer.Layer<StorageService> = noopStorageLayer;
