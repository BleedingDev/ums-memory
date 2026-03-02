import type { DatabaseSync } from "node:sqlite";
import { Effect, Schema } from "effect";

import { ContractValidationError, type StorageServiceError } from "../errors.js";
import {
  makeSqliteStorageServiceEffect,
  type StorageService,
} from "../services/storage-service.js";
import type { SqliteStorageRepositoryOptions } from "./sqlite/index.js";

const storageAdapterIdPattern = /^[a-z](?:[a-z0-9-]*[a-z0-9])?$/;

const compareStorageAdapterIds = (left: string, right: string): number => {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
};

const freezeAdapterIds = (adapterIds: readonly string[]): readonly string[] =>
  Object.freeze([...adapterIds]) as readonly string[];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const hasFunctionProperty = (value: unknown, propertyName: string): boolean => {
  if (!isRecord(value)) {
    return false;
  }

  return typeof value[propertyName] === "function";
};

const isDatabaseSync = (value: unknown): value is DatabaseSync =>
  hasFunctionProperty(value, "exec") &&
  hasFunctionProperty(value, "prepare") &&
  hasFunctionProperty(value, "close");

const sqliteAdapterConfigurationContract = "SqliteStorageAdapterConfiguration";

const sqliteAdapterConfigurationError = (details: string): ContractValidationError =>
  new ContractValidationError({
    contract: sqliteAdapterConfigurationContract,
    message: "Invalid sqlite storage adapter configuration.",
    details,
  });

const decodeSqliteStorageAdapterConfiguration = (
  configuration: unknown,
): Effect.Effect<SqliteStorageAdapterConfiguration, ContractValidationError> => {
  if (!isRecord(configuration)) {
    return Effect.fail(
      sqliteAdapterConfigurationError(
        "Expected a configuration object with a 'database' property.",
      ),
    );
  }

  const database = configuration["database"];
  if (!isDatabaseSync(database)) {
    return Effect.fail(
      sqliteAdapterConfigurationError(
        "configuration.database must be a DatabaseSync-compatible object.",
      ),
    );
  }

  const options = configuration["options"];
  if (options !== undefined && !isRecord(options)) {
    return Effect.fail(
      sqliteAdapterConfigurationError("configuration.options must be an object when provided."),
    );
  }

  if (options === undefined) {
    return Effect.succeed({ database });
  }

  return Effect.succeed({
    database,
    options: options as SqliteStorageRepositoryOptions,
  });
};

const storageAdapterIdValidationHint =
  "Use lowercase ASCII letters, digits, and internal hyphens (for example: sqlite, postgres-readonly).";

export class StorageAdapterIdValidationError extends Schema.TaggedError<StorageAdapterIdValidationError>()(
  "StorageAdapterIdValidationError",
  {
    adapterId: Schema.String,
    message: Schema.String,
  },
) {}

export class StorageAdapterDuplicateIdError extends Schema.TaggedError<StorageAdapterDuplicateIdError>()(
  "StorageAdapterDuplicateIdError",
  {
    adapterId: Schema.String,
    message: Schema.String,
  },
) {}

export class StorageAdapterUnknownIdError extends Schema.TaggedError<StorageAdapterUnknownIdError>()(
  "StorageAdapterUnknownIdError",
  {
    adapterId: Schema.String,
    availableAdapterIds: Schema.Array(Schema.String),
    message: Schema.String,
  },
) {}

export type StorageAdapterRegistryConstructionError =
  | StorageAdapterIdValidationError
  | StorageAdapterDuplicateIdError;

export type StorageAdapterResolveError =
  | StorageAdapterIdValidationError
  | StorageAdapterUnknownIdError;

export type StorageAdapterCreateError = StorageAdapterResolveError | StorageServiceError;

export interface StorageAdapterRegistration {
  readonly id: string;
  readonly create: (configuration: unknown) => Effect.Effect<StorageService, StorageServiceError>;
}

export interface StorageAdapterRegistry {
  readonly registrations: ReadonlyMap<string, StorageAdapterRegistration>;
  readonly adapterIds: readonly string[];
}

export interface StorageAdapterCreateRequest {
  readonly adapterId: string;
  readonly configuration?: unknown;
}

export interface SqliteStorageAdapterConfiguration {
  readonly database: DatabaseSync;
  readonly options?: SqliteStorageRepositoryOptions;
}

export const sqliteStorageAdapterId = "sqlite";

export const validateStorageAdapterId = (
  adapterId: string,
): Effect.Effect<string, StorageAdapterIdValidationError> => {
  const trimmedAdapterId = adapterId.trim();

  if (trimmedAdapterId.length === 0) {
    return Effect.fail(
      new StorageAdapterIdValidationError({
        adapterId,
        message: `Storage adapter ID cannot be empty. ${storageAdapterIdValidationHint}`,
      }),
    );
  }

  if (trimmedAdapterId !== adapterId) {
    return Effect.fail(
      new StorageAdapterIdValidationError({
        adapterId,
        message: `Storage adapter ID cannot include leading or trailing whitespace. ${storageAdapterIdValidationHint}`,
      }),
    );
  }

  if (!storageAdapterIdPattern.test(trimmedAdapterId)) {
    return Effect.fail(
      new StorageAdapterIdValidationError({
        adapterId,
        message: `Storage adapter ID '${adapterId}' is invalid. ${storageAdapterIdValidationHint}`,
      }),
    );
  }

  return Effect.succeed(trimmedAdapterId);
};

export const makeStorageAdapterRegistry = (
  registrations: Iterable<StorageAdapterRegistration>,
): Effect.Effect<StorageAdapterRegistry, StorageAdapterRegistryConstructionError> =>
  Effect.gen(function* () {
    const registrationsById = new Map<string, StorageAdapterRegistration>();

    for (const registration of registrations) {
      const validatedAdapterId = yield* validateStorageAdapterId(registration.id);

      if (registrationsById.has(validatedAdapterId)) {
        return yield* Effect.fail(
          new StorageAdapterDuplicateIdError({
            adapterId: validatedAdapterId,
            message: `Storage adapter ID '${validatedAdapterId}' is already registered.`,
          }),
        );
      }

      registrationsById.set(validatedAdapterId, {
        ...registration,
        id: validatedAdapterId,
      });
    }

    return {
      registrations: registrationsById,
      adapterIds: freezeAdapterIds([...registrationsById.keys()].sort(compareStorageAdapterIds)),
    };
  });

export const listStorageAdapterIds = (registry: StorageAdapterRegistry): readonly string[] =>
  freezeAdapterIds(registry.adapterIds);

export const resolveStorageAdapterRegistration = (
  registry: StorageAdapterRegistry,
  adapterId: string,
): Effect.Effect<StorageAdapterRegistration, StorageAdapterResolveError> =>
  Effect.gen(function* () {
    const validatedAdapterId = yield* validateStorageAdapterId(adapterId);
    const registration = registry.registrations.get(validatedAdapterId);

    if (registration === undefined) {
      return yield* Effect.fail(
        new StorageAdapterUnknownIdError({
          adapterId: validatedAdapterId,
          availableAdapterIds: [...registry.adapterIds],
          message: `Storage adapter '${validatedAdapterId}' is not registered.`,
        }),
      );
    }

    return registration;
  });

export const createStorageServiceFromAdapterRegistry = (
  registry: StorageAdapterRegistry,
  request: StorageAdapterCreateRequest,
): Effect.Effect<StorageService, StorageAdapterCreateError> =>
  resolveStorageAdapterRegistration(registry, request.adapterId).pipe(
    Effect.flatMap((registration) => registration.create(request.configuration)),
  );

export const makeSqliteStorageAdapterRegistration = (
  adapterId: string = sqliteStorageAdapterId,
): StorageAdapterRegistration => ({
  id: adapterId,
  create: (configuration) =>
    Effect.gen(function* () {
      const sqliteConfiguration = yield* decodeSqliteStorageAdapterConfiguration(configuration);
      return yield* makeSqliteStorageServiceEffect(
        sqliteConfiguration.database,
        sqliteConfiguration.options,
      );
    }),
});
