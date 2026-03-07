import { createHash } from "node:crypto";

import { Deferred, Effect, Predicate, Result, Schema } from "effect";

import {
  ContractValidationError,
  RuntimePersistenceExecutionError,
  type RuntimePersistenceServiceError,
} from "../../errors.js";
import type {
  RuntimePersistenceExecutionRequest,
  RuntimePersistenceRepository,
} from "../../services/runtime-persistence-service.js";
import type { DatabaseSync } from "./database.ts";

const runtimePersistenceLedgerTable = "runtime_persistence_ledger";
const runtimePersistenceSnapshotTable = "runtime_persistence_snapshot";
const defaultUnscopedRuntimePersistenceKey = "@ums/runtime/unscoped";
const sha256HexPattern = /^[0-9a-f]{64}$/i;
const UnknownRecordSchema = Schema.Record(Schema.String, Schema.Unknown);
const ErrorWithMessageSchema = Schema.Struct({
  message: Schema.String,
});
const CodedErrorSchema = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
});
const ContractValidationErrorSchema = Schema.Struct({
  _tag: Schema.Literal("ContractValidationError"),
  contract: Schema.String,
  message: Schema.String,
  details: Schema.String,
});
const RuntimePersistenceExecutionErrorSchema = Schema.Struct({
  _tag: Schema.Literal("RuntimePersistenceExecutionError"),
  operation: Schema.String,
  code: Schema.optional(Schema.String),
  message: Schema.String,
  details: Schema.String,
});

type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

interface ValidatedRuntimePersistenceRequest<TResponse> {
  readonly execute: () => Promise<TResponse> | TResponse;
  readonly operation: string;
  readonly requestBodyJson: string;
  readonly scopeKey: string;
}

interface PersistedExecutionMiss {
  readonly found: false;
}

interface PersistedExecutionHit<TResponse> {
  readonly found: true;
  readonly response: TResponse;
}

type PersistedExecutionLookup<TResponse> =
  | PersistedExecutionMiss
  | PersistedExecutionHit<TResponse>;

interface InFlightExecutionRegistration<TResponse> {
  readonly deferred: Deferred.Deferred<
    TResponse,
    RuntimePersistenceServiceError
  >;
  readonly isOwner: boolean;
}

export interface SqliteRuntimePersistenceRepositoryOptions {
  readonly now?: () => number;
  readonly unscopedKey?: string;
}

export interface SqliteRuntimePersistenceExecutionRecord {
  readonly operation: string;
  readonly persistedAtMillis: number;
  readonly requestBody: unknown;
  readonly requestDigestSha256: string;
  readonly response: unknown;
  readonly scopeKey: string;
}

export interface SqliteRuntimePersistenceExecutionFilter {
  readonly operation?: string | null;
  readonly scopeKey?: string | null;
}

export interface SqliteRuntimePersistenceRepository extends RuntimePersistenceRepository {
  readonly listPersistedExecutions: (
    filter?: SqliteRuntimePersistenceExecutionFilter
  ) => Effect.Effect<
    readonly SqliteRuntimePersistenceExecutionRecord[],
    RuntimePersistenceServiceError
  >;
  readonly loadPersistedSnapshot: () => Effect.Effect<
    Record<string, unknown> | null,
    RuntimePersistenceServiceError
  >;
  readonly persistSnapshot: (
    snapshot: Record<string, unknown>
  ) => Effect.Effect<void, RuntimePersistenceServiceError>;
}

const isUnknownRecord = Schema.is(UnknownRecordSchema);
const isErrorWithMessage = Schema.is(ErrorWithMessageSchema);
const isCodedError = Schema.is(CodedErrorSchema);
const isContractValidationError = Schema.is(ContractValidationErrorSchema);
const isRuntimePersistenceExecutionError = Schema.is(
  RuntimePersistenceExecutionErrorSchema
);
const isTaggedContractValidationError = (
  cause: unknown
): cause is ContractValidationError => isContractValidationError(cause);
const isTaggedRuntimePersistenceExecutionError = (
  cause: unknown
): cause is RuntimePersistenceExecutionError =>
  isRuntimePersistenceExecutionError(cause);

const toContractValidationError = (
  message: string,
  details: string
): ContractValidationError =>
  new ContractValidationError({
    contract: "RuntimePersistenceExecutionRequest",
    message,
    details,
  });

const toExecutionError = (
  operation: string,
  cause: unknown
): RuntimePersistenceExecutionError =>
  new RuntimePersistenceExecutionError({
    operation,
    message: "Runtime persistence executor failed.",
    details: isErrorWithMessage(cause) ? cause.message : String(cause),
  });

const normalizeExecutorFailure = (
  operation: string,
  cause: unknown
): RuntimePersistenceServiceError => {
  if (isTaggedContractValidationError(cause)) {
    return cause;
  }
  if (isTaggedRuntimePersistenceExecutionError(cause)) {
    return cause;
  }
  if (isCodedError(cause)) {
    return new RuntimePersistenceExecutionError({
      operation,
      code: cause.code,
      message: cause.message,
      details: cause.code,
    });
  }
  return toExecutionError(operation, cause);
};

const normalizeOperation = (operation: unknown): string =>
  Predicate.isString(operation) ? operation.trim().toLowerCase() : "";

const sortCanonicalJsonValue = (
  value: CanonicalJsonValue
): CanonicalJsonValue => {
  if (Array.isArray(value)) {
    return value.map((entry) => sortCanonicalJsonValue(entry));
  }

  if (isUnknownRecord(value)) {
    const record = value as Readonly<Record<string, CanonicalJsonValue>>;
    return Object.fromEntries(
      Object.entries(record)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entryValue]) => [key, sortCanonicalJsonValue(entryValue)])
    ) as CanonicalJsonValue;
  }

  return value;
};

const canonicalizeJson = (
  value: unknown,
  {
    allowUndefinedAsNull,
    failureMessage,
  }: {
    readonly allowUndefinedAsNull: boolean;
    readonly failureMessage: string;
  }
): string => {
  const normalizedValue =
    value === undefined && allowUndefinedAsNull ? null : value;
  const serializedResult = Result.try({
    try: () => JSON.stringify(normalizedValue),
    catch: (cause) =>
      new Error(
        `${failureMessage} ${isErrorWithMessage(cause) ? cause.message : String(cause)}`
      ),
  });
  if (Result.isFailure(serializedResult)) {
    throw serializedResult.failure;
  }

  const serializedJson = serializedResult.success;
  if (serializedJson === undefined) {
    throw new Error(failureMessage);
  }

  const parsedResult = Result.try({
    try: () => JSON.parse(serializedJson) as CanonicalJsonValue,
    catch: (cause) =>
      new Error(
        `${failureMessage} ${isErrorWithMessage(cause) ? cause.message : String(cause)}`
      ),
  });
  if (Result.isFailure(parsedResult)) {
    throw parsedResult.failure;
  }

  return JSON.stringify(sortCanonicalJsonValue(parsedResult.success));
};

const parsePersistedJson = (
  jsonText: string,
  {
    fieldName,
    operation,
  }: {
    readonly fieldName: string;
    readonly operation: string;
  }
): unknown => {
  const parsedResult = Result.try({
    try: () => JSON.parse(jsonText) as unknown,
    catch: (cause) =>
      new Error(
        `Persisted ${fieldName} is not valid JSON for ${operation}. ${
          isErrorWithMessage(cause) ? cause.message : String(cause)
        }`
      ),
  });
  if (Result.isFailure(parsedResult)) {
    throw parsedResult.failure;
  }
  return parsedResult.success;
};

const validateScopeKey = (
  scopeKey: unknown,
  unscopedKey: string
): Effect.Effect<string, ContractValidationError> => {
  if (scopeKey === undefined || scopeKey === null) {
    return Effect.succeed(unscopedKey);
  }

  if (!Predicate.isString(scopeKey)) {
    return Effect.fail(
      toContractValidationError(
        "Runtime persistence scopeKey must be a string when provided.",
        "Provide scopeKey as a non-empty string or omit it to use the deterministic unscoped key."
      )
    );
  }

  const normalizedScopeKey = scopeKey.trim();
  return Effect.succeed(
    normalizedScopeKey.length > 0 ? normalizedScopeKey : unscopedKey
  );
};

const validateRequest = <TResponse>(
  request: RuntimePersistenceExecutionRequest<TResponse>,
  unscopedKey: string
): Effect.Effect<
  ValidatedRuntimePersistenceRequest<TResponse>,
  RuntimePersistenceServiceError
> =>
  Effect.gen(function* () {
    const operation = normalizeOperation(request.operation);
    if (!operation) {
      return yield* Effect.fail(
        toContractValidationError(
          "Runtime persistence operation must be a non-empty string.",
          "Provide a normalized runtime operation name."
        )
      );
    }

    if (!Predicate.isFunction(request.execute)) {
      return yield* Effect.fail(
        toContractValidationError(
          "Runtime persistence request must provide an executor function.",
          "The execute field must be a function returning the operation result."
        )
      );
    }

    const scopeKey = yield* validateScopeKey(request.scopeKey, unscopedKey);

    const requestBodyJson = yield* Effect.try({
      try: () =>
        canonicalizeJson(request.requestBody, {
          allowUndefinedAsNull: true,
          failureMessage:
            "Runtime persistence requestBody must be JSON serializable for deterministic digesting.",
        }),
      catch: (cause) =>
        toContractValidationError(
          "Runtime persistence requestBody must be JSON serializable.",
          isErrorWithMessage(cause) ? cause.message : String(cause)
        ),
    });

    return {
      execute: request.execute,
      operation,
      requestBodyJson,
      scopeKey,
    } satisfies ValidatedRuntimePersistenceRequest<TResponse>;
  });

const computeRequestDigest = <TResponse>(
  request: ValidatedRuntimePersistenceRequest<TResponse>
): string =>
  createHash("sha256")
    .update(
      JSON.stringify({
        operation: request.operation,
        requestBodyJson: request.requestBodyJson,
        scopeKey: request.scopeKey,
      })
    )
    .digest("hex");

const computeExecutionCacheKey = <TResponse>(
  request: ValidatedRuntimePersistenceRequest<TResponse>,
  requestDigestSha256: string
): string =>
  `${request.scopeKey}\u0000${request.operation}\u0000${requestDigestSha256}`;

const readStringColumn = (
  row: unknown,
  column: string,
  operation: string
): string => {
  if (!isUnknownRecord(row) || !Object.hasOwn(row, column)) {
    throw new Error(
      `Persisted runtime row for ${operation} is missing required column "${column}".`
    );
  }

  const value = row[column];
  if (!Predicate.isString(value)) {
    throw new Error(
      `Persisted runtime column "${column}" for ${operation} must decode to a string value.`
    );
  }

  return value;
};

const readPersistedAtMillis = (row: unknown, operation: string): number => {
  if (!isUnknownRecord(row) || !Object.hasOwn(row, "persisted_at_ms")) {
    throw new Error(
      `Persisted runtime column "persisted_at_ms" for ${operation} must decode to a number.`
    );
  }

  const persistedAtMillis = row["persisted_at_ms"];
  if (!Predicate.isNumber(persistedAtMillis)) {
    throw new Error(
      `Persisted runtime column "persisted_at_ms" for ${operation} must decode to a number.`
    );
  }
  if (!Number.isSafeInteger(persistedAtMillis) || persistedAtMillis < 0) {
    throw new Error(
      `Persisted runtime column "persisted_at_ms" for ${operation} must be a non-negative safe integer.`
    );
  }

  return persistedAtMillis;
};

const readDigestColumn = (row: unknown, operation: string): string => {
  const requestDigestSha256 = readStringColumn(
    row,
    "request_digest_sha256",
    operation
  );

  if (!sha256HexPattern.test(requestDigestSha256)) {
    throw new Error(
      `Persisted runtime column "request_digest_sha256" for ${operation} must be a 64-character hexadecimal digest.`
    );
  }

  return requestDigestSha256;
};

const readPersistedResponseLookup = <TResponse>(
  row: unknown,
  operation: string
): PersistedExecutionLookup<TResponse> => {
  if (row === undefined || row === null) {
    return { found: false };
  }

  return {
    found: true,
    response: parsePersistedJson(
      readStringColumn(row, "response_json", operation),
      {
        fieldName: "response_json",
        operation,
      }
    ) as TResponse,
  };
};

const toExecutionRecord = (
  row: unknown
): SqliteRuntimePersistenceExecutionRecord => {
  const operation = readStringColumn(row, "operation", "runtime_persistence");
  return Object.freeze({
    operation,
    persistedAtMillis: readPersistedAtMillis(row, operation),
    requestBody: parsePersistedJson(
      readStringColumn(row, "request_body_json", operation),
      {
        fieldName: "request_body_json",
        operation,
      }
    ),
    requestDigestSha256: readDigestColumn(row, operation),
    response: parsePersistedJson(
      readStringColumn(row, "response_json", operation),
      {
        fieldName: "response_json",
        operation,
      }
    ),
    scopeKey: readStringColumn(row, "scope_key", operation),
  } satisfies SqliteRuntimePersistenceExecutionRecord);
};

const readChanges = (row: unknown, operation: string): number => {
  if (!isUnknownRecord(row) || !Object.hasOwn(row, "changes")) {
    throw new Error(
      `SQLite runtime persistence write result for ${operation} must expose "changes".`
    );
  }

  const changes = row["changes"];
  if (!Predicate.isNumber(changes)) {
    throw new Error(
      `SQLite runtime persistence write result for ${operation} must expose "changes".`
    );
  }
  if (!Number.isSafeInteger(changes) || changes < 0) {
    throw new Error(
      `SQLite runtime persistence write result "changes" for ${operation} must be >= 0.`
    );
  }

  return changes;
};

export const makeSqliteRuntimePersistenceRepository = (
  database: DatabaseSync,
  options: SqliteRuntimePersistenceRepositoryOptions = {}
): SqliteRuntimePersistenceRepository => {
  const now = options.now ?? (() => Date.now());
  const unscopedKey =
    Predicate.isString(options.unscopedKey) &&
    options.unscopedKey.trim().length > 0
      ? options.unscopedKey.trim()
      : defaultUnscopedRuntimePersistenceKey;
  const inFlightExecutions = new Map<
    string,
    Deferred.Deferred<unknown, RuntimePersistenceServiceError>
  >();

  database.exec(
    [
      `CREATE TABLE IF NOT EXISTS ${runtimePersistenceLedgerTable} (`,
      "  scope_key TEXT NOT NULL,",
      "  operation TEXT NOT NULL,",
      "  request_digest_sha256 TEXT NOT NULL,",
      "  request_body_json TEXT NOT NULL,",
      "  response_json TEXT NOT NULL,",
      "  persisted_at_ms INTEGER NOT NULL,",
      "  PRIMARY KEY (scope_key, operation, request_digest_sha256),",
      "  CHECK (length(trim(scope_key)) > 0),",
      "  CHECK (length(trim(operation)) > 0),",
      "  CHECK (length(request_digest_sha256) = 64),",
      "  CHECK (request_digest_sha256 NOT GLOB '*[^0-9A-Fa-f]*'),",
      "  CHECK (persisted_at_ms >= 0)",
      ");",
      `CREATE INDEX IF NOT EXISTS idx_${runtimePersistenceLedgerTable}_ordering`,
      `ON ${runtimePersistenceLedgerTable} (`,
      "  scope_key ASC,",
      "  operation ASC,",
      "  persisted_at_ms ASC,",
      "  request_digest_sha256 ASC",
      ");",
      `CREATE TABLE IF NOT EXISTS ${runtimePersistenceSnapshotTable} (`,
      "  singleton_key INTEGER PRIMARY KEY CHECK (singleton_key = 1),",
      "  snapshot_json TEXT NOT NULL,",
      "  updated_at_ms INTEGER NOT NULL,",
      "  CHECK (updated_at_ms >= 0)",
      ");",
    ].join("\n")
  );

  const selectPersistedExecutionStatement = database.prepare(
    [
      "SELECT response_json",
      `FROM ${runtimePersistenceLedgerTable}`,
      "WHERE scope_key = ?",
      "  AND operation = ?",
      "  AND request_digest_sha256 = ?",
      "ORDER BY persisted_at_ms ASC, request_digest_sha256 ASC",
      "LIMIT 1;",
    ].join("\n")
  );

  const insertPersistedExecutionStatement = database.prepare(
    [
      `INSERT OR IGNORE INTO ${runtimePersistenceLedgerTable} (`,
      "  scope_key,",
      "  operation,",
      "  request_digest_sha256,",
      "  request_body_json,",
      "  response_json,",
      "  persisted_at_ms",
      ") VALUES (?, ?, ?, ?, ?, ?);",
    ].join("\n")
  );

  const selectPersistedSnapshotStatement = database.prepare(
    [
      "SELECT snapshot_json",
      `FROM ${runtimePersistenceSnapshotTable}`,
      "WHERE singleton_key = 1",
      "LIMIT 1;",
    ].join("\n")
  );

  const upsertPersistedSnapshotStatement = database.prepare(
    [
      `INSERT INTO ${runtimePersistenceSnapshotTable} (`,
      "  singleton_key,",
      "  snapshot_json,",
      "  updated_at_ms",
      ") VALUES (1, ?, ?)",
      "ON CONFLICT(singleton_key) DO UPDATE SET",
      "  snapshot_json = excluded.snapshot_json,",
      "  updated_at_ms = excluded.updated_at_ms;",
    ].join("\n")
  );

  const getOrCreateInFlightExecution = <TResponse>(
    executionCacheKey: string
  ): Effect.Effect<InFlightExecutionRegistration<TResponse>> =>
    Effect.sync(() => {
      const existingExecution = inFlightExecutions.get(executionCacheKey) as
        | Deferred.Deferred<TResponse, RuntimePersistenceServiceError>
        | undefined;

      if (existingExecution) {
        return {
          deferred: existingExecution,
          isOwner: false,
        } satisfies InFlightExecutionRegistration<TResponse>;
      }

      const deferred = Deferred.makeUnsafe<
        TResponse,
        RuntimePersistenceServiceError
      >();
      inFlightExecutions.set(
        executionCacheKey,
        deferred as Deferred.Deferred<unknown, RuntimePersistenceServiceError>
      );

      return {
        deferred,
        isOwner: true,
      } satisfies InFlightExecutionRegistration<TResponse>;
    });

  const clearInFlightExecution = <TResponse>(
    executionCacheKey: string,
    deferred: Deferred.Deferred<TResponse, RuntimePersistenceServiceError>
  ): Effect.Effect<void> =>
    Effect.sync(() => {
      if (inFlightExecutions.get(executionCacheKey) === deferred) {
        inFlightExecutions.delete(executionCacheKey);
      }
    });

  const lookupPersistedExecution = <TResponse>(
    request: ValidatedRuntimePersistenceRequest<TResponse>,
    requestDigestSha256: string
  ): Effect.Effect<
    PersistedExecutionLookup<TResponse>,
    RuntimePersistenceExecutionError
  > =>
    Effect.try({
      try: () =>
        readPersistedResponseLookup<TResponse>(
          selectPersistedExecutionStatement.get(
            request.scopeKey,
            request.operation,
            requestDigestSha256
          ),
          request.operation
        ),
      catch: (cause) => toExecutionError(request.operation, cause),
    });

  const executeAndPersist = <TResponse>(
    request: ValidatedRuntimePersistenceRequest<TResponse>,
    requestDigestSha256: string
  ): Effect.Effect<TResponse, RuntimePersistenceServiceError> =>
    Effect.gen(function* () {
      const response = yield* Effect.tryPromise({
        try: async () => (await request.execute()) as TResponse,
        catch: (cause) => normalizeExecutorFailure(request.operation, cause),
      });

      const responseJson = yield* Effect.try({
        try: () =>
          canonicalizeJson(response, {
            allowUndefinedAsNull: false,
            failureMessage:
              "Runtime persistence response must be JSON serializable for deterministic replay.",
          }),
        catch: (cause) => toExecutionError(request.operation, cause),
      });

      return yield* Effect.try({
        try: () => {
          const persistedAtMillis = now();
          if (
            !Number.isSafeInteger(persistedAtMillis) ||
            persistedAtMillis < 0
          ) {
            throw new Error(
              "SqliteRuntimePersistenceRepositoryOptions.now() must return a non-negative safe integer."
            );
          }

          const insertResult = insertPersistedExecutionStatement.run(
            request.scopeKey,
            request.operation,
            requestDigestSha256,
            request.requestBodyJson,
            responseJson,
            persistedAtMillis
          );

          if (readChanges(insertResult, request.operation) > 0) {
            return response;
          }

          const replayedExecution = readPersistedResponseLookup<TResponse>(
            selectPersistedExecutionStatement.get(
              request.scopeKey,
              request.operation,
              requestDigestSha256
            ),
            request.operation
          );
          if (!replayedExecution.found) {
            throw new Error(
              "Unable to resolve runtime persistence ledger row after deterministic INSERT OR IGNORE replay."
            );
          }

          return replayedExecution.response;
        },
        catch: (cause) => toExecutionError(request.operation, cause),
      });
    });

  const startInFlightExecution = <TResponse>(
    executionCacheKey: string,
    deferred: Deferred.Deferred<TResponse, RuntimePersistenceServiceError>,
    request: ValidatedRuntimePersistenceRequest<TResponse>,
    requestDigestSha256: string
  ): Effect.Effect<void> =>
    Deferred.into(
      executeAndPersist(request, requestDigestSha256).pipe(
        Effect.ensuring(clearInFlightExecution(executionCacheKey, deferred))
      ),
      deferred
    ).pipe(Effect.forkDetach({ startImmediately: true }), Effect.asVoid);

  const execute = <TResponse>(
    request: RuntimePersistenceExecutionRequest<TResponse>
  ): Effect.Effect<TResponse, RuntimePersistenceServiceError> =>
    Effect.gen(function* () {
      const validatedRequest = yield* validateRequest(request, unscopedKey);
      const requestDigestSha256 = computeRequestDigest(validatedRequest);
      const executionCacheKey = computeExecutionCacheKey(
        validatedRequest,
        requestDigestSha256
      );

      const persistedExecution = yield* lookupPersistedExecution(
        validatedRequest,
        requestDigestSha256
      );

      if (persistedExecution.found) {
        return persistedExecution.response;
      }

      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const registration =
            yield* getOrCreateInFlightExecution<TResponse>(executionCacheKey);

          if (registration.isOwner) {
            yield* startInFlightExecution(
              executionCacheKey,
              registration.deferred,
              validatedRequest,
              requestDigestSha256
            );
          }

          return yield* restore(Deferred.await(registration.deferred));
        })
      );
    });

  const listPersistedExecutions = (
    filter: SqliteRuntimePersistenceExecutionFilter = {}
  ): Effect.Effect<
    readonly SqliteRuntimePersistenceExecutionRecord[],
    RuntimePersistenceServiceError
  > =>
    Effect.gen(function* () {
      const whereClauses: string[] = [];
      const parameters: string[] = [];
      const normalizedScopeKey =
        filter.scopeKey === undefined || filter.scopeKey === null
          ? undefined
          : yield* validateScopeKey(filter.scopeKey, unscopedKey);

      if (normalizedScopeKey !== undefined) {
        whereClauses.push("scope_key = ?");
        parameters.push(normalizedScopeKey);
      }

      if (filter.operation !== undefined && filter.operation !== null) {
        const normalizedOperation = normalizeOperation(filter.operation);
        if (!normalizedOperation) {
          return yield* Effect.fail(
            toContractValidationError(
              "Runtime persistence filter.operation must be a non-empty string when provided.",
              "Provide operation as a normalized runtime operation name or omit the filter."
            )
          );
        }
        whereClauses.push("operation = ?");
        parameters.push(normalizedOperation);
      }

      return yield* Effect.try({
        try: () => {
          const sql = [
            [
              "SELECT scope_key, operation, request_digest_sha256,",
              "request_body_json, response_json, persisted_at_ms",
            ].join(" "),
            `FROM ${runtimePersistenceLedgerTable}`,
            whereClauses.length > 0
              ? `WHERE ${whereClauses.join(" AND ")}`
              : "",
            "ORDER BY scope_key ASC, operation ASC, persisted_at_ms ASC, request_digest_sha256 ASC;",
          ]
            .filter((entry) => entry.length > 0)
            .join("\n");

          const rows = database
            .prepare(sql)
            .all(...parameters) as readonly unknown[];
          return Object.freeze(rows.map((row) => toExecutionRecord(row)));
        },
        catch: (cause) => toExecutionError("runtime_persistence", cause),
      });
    });

  const loadPersistedSnapshot = (): Effect.Effect<
    Record<string, unknown> | null,
    RuntimePersistenceServiceError
  > =>
    Effect.try({
      try: () => {
        const row = selectPersistedSnapshotStatement.get() as
          | Record<string, unknown>
          | undefined;
        if (!row) {
          return null;
        }

        const snapshotJson = row["snapshot_json"];
        if (!Predicate.isString(snapshotJson)) {
          throw new Error(
            "Persisted runtime snapshot must expose a string snapshot_json column."
          );
        }

        const snapshot = parsePersistedJson(snapshotJson, {
          fieldName: "snapshot_json",
          operation: "runtime_snapshot",
        });
        if (!isUnknownRecord(snapshot)) {
          throw new Error(
            "Persisted runtime snapshot must decode to a top-level object."
          );
        }

        return snapshot;
      },
      catch: (cause) => toExecutionError("runtime_snapshot", cause),
    });

  const persistSnapshot = (
    snapshot: Record<string, unknown>
  ): Effect.Effect<void, RuntimePersistenceServiceError> =>
    Effect.try({
      try: () => {
        const snapshotJson = canonicalizeJson(snapshot, {
          allowUndefinedAsNull: false,
          failureMessage:
            "Runtime persistence snapshot must be JSON serializable.",
        });
        const persistedAtMillis = now();
        if (!Number.isSafeInteger(persistedAtMillis) || persistedAtMillis < 0) {
          throw new Error(
            "SqliteRuntimePersistenceRepositoryOptions.now() must return a non-negative safe integer."
          );
        }
        upsertPersistedSnapshotStatement.run(snapshotJson, persistedAtMillis);
      },
      catch: (cause) => toExecutionError("runtime_snapshot", cause),
    });

  return {
    execute,
    listPersistedExecutions,
    loadPersistedSnapshot,
    persistSnapshot,
  } satisfies SqliteRuntimePersistenceRepository;
};
