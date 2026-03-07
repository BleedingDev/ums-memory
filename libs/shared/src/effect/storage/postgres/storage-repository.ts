import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { Effect, Schema, SchemaIssue } from "effect";

import {
  type MemoryLayer,
  MemoryLayerSchema,
  type StorageDeleteRequest,
  StorageDeleteResponseSchema,
  type StorageSnapshotExportRequest,
  StorageSnapshotExportRequestSchema,
  StorageSnapshotExportResponseSchema,
  type StorageSnapshotImportRequest,
  StorageSnapshotImportRequestSchema,
  StorageSnapshotImportResponseSchema,
  type StorageUpsertRequest,
  StorageUpsertResponseSchema,
  type SpaceId,
  SpaceIdSchema,
  type MemoryId,
  MemoryIdSchema,
  decodeStorageDeleteRequestEffect,
  decodeStorageUpsertRequestEffect,
} from "../../contracts/index.js";
import {
  ContractValidationError,
  StorageNotFoundError,
  type StorageServiceError,
} from "../../errors.js";
import type { StorageRepository } from "../../services/storage-service.js";
import {
  enterprisePostgresSchemaVersion,
  enterprisePostgresTableNames,
  type EnterprisePostgresTableName,
} from "./schema.js";

const NonEmptyTrimmedStringSchema = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty()
);
const NonNegativeSafeIntegerSchema = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0)
);
const Sha256HexSchema = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
const StorageOperationSchema = Schema.Literals(["upsert", "delete"]);
const SnapshotCellValueSchema = Schema.Union([
  Schema.Null,
  Schema.String,
  NonNegativeSafeIntegerSchema,
]);
const UnknownRecordSchema = Schema.Record(Schema.String, Schema.Unknown);
const ErrorWithMessageSchema = Schema.Struct({
  message: Schema.String,
});

const isUnknownRecord = Schema.is(UnknownRecordSchema);
const isString = Schema.is(Schema.String);
const isBoolean = Schema.is(Schema.Boolean);
const isNumber = Schema.is(Schema.Number);
const isErrorWithMessage = Schema.is(ErrorWithMessageSchema);

export const postgresStorageSnapshotFormat =
  "ums-memory/postgres-storage-snapshot/v1";
export const postgresStorageSnapshotSignatureAlgorithm = "hmac-sha256";

export interface PostgresStorageSnapshotTable {
  readonly name: EnterprisePostgresTableName;
  readonly columns: readonly string[];
  readonly rows: readonly (readonly (string | number | null)[])[];
}

export interface PostgresStorageSnapshotData {
  readonly format: typeof postgresStorageSnapshotFormat;
  readonly schemaVersion: typeof enterprisePostgresSchemaVersion;
  readonly tables: readonly PostgresStorageSnapshotTable[];
}

export interface PostgresStoredMemoryRecord {
  readonly spaceId: SpaceId;
  readonly memoryId: MemoryId;
  readonly layer: MemoryLayer;
  readonly payloadJson: string;
  readonly persistedAtMillis: number;
  readonly version: number;
}

export interface PostgresStoredIdempotencyRecord {
  readonly spaceId: SpaceId;
  readonly operation: "upsert" | "delete";
  readonly idempotencyKey: string;
  readonly requestHashSha256: string;
  readonly responseJson: string;
}

export interface PostgresStorageRepositoryDriver {
  readonly getMemory: (
    spaceId: SpaceId,
    memoryId: MemoryId
  ) => Effect.Effect<PostgresStoredMemoryRecord | null, StorageServiceError>;
  readonly upsertMemory: (
    record: PostgresStoredMemoryRecord
  ) => Effect.Effect<PostgresStoredMemoryRecord, StorageServiceError>;
  readonly deleteMemory: (
    spaceId: SpaceId,
    memoryId: MemoryId
  ) => Effect.Effect<boolean, StorageServiceError>;
  readonly getIdempotency: (
    spaceId: SpaceId,
    operation: "upsert" | "delete",
    idempotencyKey: string
  ) => Effect.Effect<
    PostgresStoredIdempotencyRecord | null,
    StorageServiceError
  >;
  readonly putIdempotency: (
    record: PostgresStoredIdempotencyRecord
  ) => Effect.Effect<void, StorageServiceError>;
  readonly exportSnapshot: () => Effect.Effect<
    PostgresStorageSnapshotData,
    StorageServiceError
  >;
  readonly importSnapshot: (
    snapshot: PostgresStorageSnapshotData
  ) => Effect.Effect<void, StorageServiceError>;
}

export interface PostgresStorageRepositoryOptions {
  readonly now?: () => number;
}

const PostgresStoredMemoryRecordSchema = Schema.Struct({
  spaceId: SpaceIdSchema,
  memoryId: MemoryIdSchema,
  layer: MemoryLayerSchema,
  payloadJson: Schema.String,
  persistedAtMillis: NonNegativeSafeIntegerSchema,
  version: NonNegativeSafeIntegerSchema,
});

const PostgresStoredIdempotencyRecordSchema = Schema.Struct({
  spaceId: SpaceIdSchema,
  operation: StorageOperationSchema,
  idempotencyKey: NonEmptyTrimmedStringSchema,
  requestHashSha256: Sha256HexSchema,
  responseJson: Schema.String,
});

const PostgresStorageSnapshotTableSchema = Schema.Struct({
  name: NonEmptyTrimmedStringSchema,
  columns: Schema.Array(NonEmptyTrimmedStringSchema),
  rows: Schema.Array(Schema.Array(SnapshotCellValueSchema)),
});

const PostgresStorageSnapshotDataSchema = Schema.Struct({
  format: Schema.Literal(postgresStorageSnapshotFormat),
  schemaVersion: Schema.Literal(enterprisePostgresSchemaVersion),
  tables: Schema.Array(PostgresStorageSnapshotTableSchema),
});

type SchemaWithoutContext<A, I = A> = Schema.Codec<A, I, never, never>;

const decodeUnknownEffect = <A, I>(
  schema: SchemaWithoutContext<A, I>,
  contract: string
) => {
  const decode = Schema.decodeUnknownEffect(schema);

  return (input: unknown): Effect.Effect<A, ContractValidationError> =>
    decode(input).pipe(
      Effect.mapError(
        (error) =>
          new ContractValidationError({
            contract,
            message: `Contract validation failed for ${contract}`,
            details: formatSchemaError(error),
          })
      )
    );
};

const decodeStoredMemoryRecordEffect = decodeUnknownEffect(
  PostgresStoredMemoryRecordSchema,
  "PostgresStoredMemoryRecord"
);
const decodeStoredIdempotencyRecordEffect = decodeUnknownEffect(
  PostgresStoredIdempotencyRecordSchema,
  "PostgresStoredIdempotencyRecord"
);
const decodeSnapshotExportRequestEffect = decodeUnknownEffect(
  StorageSnapshotExportRequestSchema,
  "StorageSnapshotExportRequest"
);
const decodeSnapshotImportRequestEffect = decodeUnknownEffect(
  StorageSnapshotImportRequestSchema,
  "StorageSnapshotImportRequest"
);
const decodeSnapshotExportResponseEffect = decodeUnknownEffect(
  StorageSnapshotExportResponseSchema,
  "StorageSnapshotExportResponse"
);
const decodeSnapshotImportResponseEffect = decodeUnknownEffect(
  StorageSnapshotImportResponseSchema,
  "StorageSnapshotImportResponse"
);
const decodeUpsertResponseEffect = decodeUnknownEffect(
  StorageUpsertResponseSchema,
  "StorageUpsertResponse"
);
const decodeDeleteResponseEffect = decodeUnknownEffect(
  StorageDeleteResponseSchema,
  "StorageDeleteResponse"
);
const decodeSnapshotDataEffect = decodeUnknownEffect(
  PostgresStorageSnapshotDataSchema,
  "PostgresStorageSnapshotData"
);

const postgresTableNameSet = new Set<string>(enterprisePostgresTableNames);
const postgresTableNameOrder = new Map(
  enterprisePostgresTableNames.map((tableName, index) => [tableName, index])
);
const postgresSnapshotTableColumns = Object.freeze({
  memory_items: Object.freeze([
    "space_id",
    "memory_id",
    "memory_layer",
    "payload_json",
    "persisted_at_ms",
    "version",
  ]),
  storage_idempotency_ledger: Object.freeze([
    "space_id",
    "operation",
    "idempotency_key",
    "request_hash_sha256",
    "response_json",
  ]),
});

type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

const compareStringsAscending = (left: string, right: string): number =>
  left.localeCompare(right);

const formatSchemaError = (error: unknown): string => {
  const formatter = SchemaIssue.makeFormatterDefault();
  if (SchemaIssue.isIssue(error)) {
    return formatter(error);
  }
  if (Schema.isSchemaError(error)) {
    return formatter(error.issue);
  }
  if (isErrorWithMessage(error)) {
    return error.message;
  }
  return String(error);
};

const toContractValidationError = (
  contract: string,
  message: string,
  details: string
): ContractValidationError =>
  new ContractValidationError({
    contract,
    message,
    details,
  });

const toSha256Hex = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const toSnapshotSignature = (payload: string, secret: string): string =>
  createHmac("sha256", secret).update(payload).digest("hex");

const verifySnapshotSignature = (
  payload: string,
  secret: string,
  signatureHex: string
): boolean => {
  const expectedSignature = Buffer.from(toSnapshotSignature(payload, secret));
  const providedSignature = Buffer.from(signatureHex);
  return (
    expectedSignature.byteLength === providedSignature.byteLength &&
    timingSafeEqual(expectedSignature, providedSignature)
  );
};

const canonicalizeJsonValue = (
  value: unknown,
  path: string
): Effect.Effect<CanonicalJsonValue, ContractValidationError> => {
  if (value === null) {
    return Effect.succeed(null);
  }

  if (isString(value) || isBoolean(value)) {
    return Effect.succeed(value);
  }

  if (isNumber(value)) {
    return Number.isFinite(value)
      ? Effect.succeed(value)
      : Effect.fail(
          toContractValidationError(
            path,
            "Expected a finite number.",
            `${path} must be a finite number.`
          )
        );
  }

  if (Array.isArray(value)) {
    return Effect.all(
      value.map((entry, index) =>
        canonicalizeJsonValue(entry, `${path}[${index}]`)
      )
    );
  }

  if (isUnknownRecord(value)) {
    return Effect.all(
      Object.keys(value)
        .sort(compareStringsAscending)
        .map((key) =>
          canonicalizeJsonValue(value[key], `${path}.${key}`).pipe(
            Effect.map((entryValue) => [key, entryValue] as const)
          )
        )
    ).pipe(Effect.map((entries) => Object.freeze(Object.fromEntries(entries))));
  }

  return Effect.fail(
    toContractValidationError(
      path,
      "Expected a canonical JSON value.",
      `${path} must contain only JSON-compatible records, arrays, strings, ` +
        "booleans, null, and finite numbers."
    )
  );
};

const canonicalizeJsonString = (
  value: unknown,
  path: string
): Effect.Effect<string, ContractValidationError> =>
  canonicalizeJsonValue(value, path).pipe(Effect.map(JSON.stringify));

const validateNow = (
  now: (() => number) | undefined
): Effect.Effect<number, ContractValidationError> => {
  const nowValue = (now ?? Date.now)();

  return Number.isSafeInteger(nowValue) && nowValue >= 0
    ? Effect.succeed(nowValue)
    : Effect.fail(
        toContractValidationError(
          "PostgresStorageRepositoryOptions.now",
          "Clock must return a non-negative safe integer.",
          `Received: ${String(nowValue)}`
        )
      );
};

const resolveOptionalIdempotencyKey = (
  request: StorageUpsertRequest | StorageDeleteRequest,
  operation: "upsert" | "delete"
): Effect.Effect<string | null, ContractValidationError> => {
  const contract =
    operation === "upsert"
      ? "StorageUpsertRequest.idempotencyKey"
      : "StorageDeleteRequest.idempotencyKey";
  const camelCaseValue =
    "idempotencyKey" in request ? request.idempotencyKey : undefined;
  const snakeCaseValue =
    "idempotency_key" in request ? request.idempotency_key : undefined;
  const decodeIdempotencyKey = (
    fieldName: "idempotencyKey" | "idempotency_key",
    value: unknown
  ): Effect.Effect<string | undefined, ContractValidationError> => {
    if (value === undefined) {
      return Effect.succeed(undefined);
    }

    return decodeUnknownEffect(
      NonEmptyTrimmedStringSchema,
      contract
    )(value).pipe(
      Effect.mapError(
        (error) =>
          new ContractValidationError({
            contract,
            message:
              "Idempotency key must be a non-empty trimmed string when provided.",
            details: `${fieldName}: ${error.details}`,
          })
      )
    );
  };

  return Effect.all({
    camelCase: decodeIdempotencyKey("idempotencyKey", camelCaseValue),
    snakeCase: decodeIdempotencyKey("idempotency_key", snakeCaseValue),
  }).pipe(
    Effect.flatMap(({ camelCase, snakeCase }) =>
      camelCase !== undefined &&
      snakeCase !== undefined &&
      camelCase !== snakeCase
        ? Effect.fail(
            new ContractValidationError({
              contract,
              message:
                "Idempotency key aliases must match when both are provided.",
              details:
                `idempotencyKey (${camelCase}) does not match ` +
                `idempotency_key (${snakeCase}).`,
            })
          )
        : Effect.succeed(camelCase ?? snakeCase ?? null)
    )
  );
};

const parseOptionalSnapshotSigningSecret = (
  value: unknown,
  fieldName: "signatureSecret" | "signature_secret",
  contract:
    | "StorageSnapshotExportRequest.signatureSecret"
    | "StorageSnapshotImportRequest.signatureSecret"
): Effect.Effect<string | undefined, ContractValidationError> => {
  if (value === undefined) {
    return Effect.succeed(undefined);
  }

  return decodeUnknownEffect(
    NonEmptyTrimmedStringSchema,
    contract
  )(value).pipe(
    Effect.mapError(
      (error) =>
        new ContractValidationError({
          contract,
          message: "Snapshot signing secret must be a non-empty string.",
          details: `${fieldName}: ${error.details}`,
        })
    )
  );
};

const resolveSnapshotSigningSecret = (
  request: StorageSnapshotExportRequest | StorageSnapshotImportRequest,
  contract:
    | "StorageSnapshotExportRequest.signatureSecret"
    | "StorageSnapshotImportRequest.signatureSecret"
): Effect.Effect<string, ContractValidationError> =>
  Effect.all({
    camelCase: parseOptionalSnapshotSigningSecret(
      request.signatureSecret,
      "signatureSecret",
      contract
    ),
    snakeCase: parseOptionalSnapshotSigningSecret(
      request.signature_secret,
      "signature_secret",
      contract
    ),
  }).pipe(
    Effect.flatMap(({ camelCase, snakeCase }) =>
      camelCase !== undefined &&
      snakeCase !== undefined &&
      camelCase !== snakeCase
        ? Effect.fail(
            new ContractValidationError({
              contract,
              message:
                "Snapshot signing secret aliases must match when both are provided.",
              details:
                `signatureSecret (${camelCase}) does not match ` +
                `signature_secret (${snakeCase}).`,
            })
          )
        : Effect.succeed(camelCase ?? snakeCase)
    ),
    Effect.flatMap((resolvedSecret) =>
      resolvedSecret === undefined
        ? Effect.fail(
            new ContractValidationError({
              contract,
              message: "Snapshot signing secret is required.",
              details: "Provide signatureSecret or signature_secret.",
            })
          )
        : Effect.succeed(resolvedSecret)
    )
  );

const toDeterministicUpsertRequestHash = (
  request: StorageUpsertRequest,
  payloadJson: string
): string =>
  toSha256Hex(
    JSON.stringify({
      operation: "upsert",
      spaceId: request.spaceId,
      memoryId: request.memoryId,
      layer: request.layer,
      payloadJson,
    })
  );

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

const toIdempotencyConflictError = (
  operation: "upsert" | "delete",
  request: StorageUpsertRequest | StorageDeleteRequest,
  idempotencyKey: string,
  storedRequestHashSha256: string,
  incomingRequestHashSha256: string
): ContractValidationError =>
  new ContractValidationError({
    contract:
      operation === "upsert"
        ? "StorageUpsertRequest.idempotencyKey"
        : "StorageDeleteRequest.idempotencyKey",
    message: `Idempotency key reuse conflict for storage ${operation} request.`,
    details:
      `idempotencyKey "${idempotencyKey}" already maps to request hash ` +
      `${storedRequestHashSha256} and cannot be reused with hash ` +
      `${incomingRequestHashSha256} for ${request.spaceId}/${request.memoryId}.`,
  });

const decodeStoredReplayResponse = <A>(
  responseJson: string,
  contract: string,
  decode: (input: unknown) => Effect.Effect<A, ContractValidationError>
): Effect.Effect<A, ContractValidationError> =>
  Effect.try({
    try: () => JSON.parse(responseJson),
    catch: (cause) =>
      toContractValidationError(
        contract,
        "Stored idempotency response JSON is invalid.",
        isErrorWithMessage(cause) ? cause.message : String(cause)
      ),
  }).pipe(Effect.flatMap((parsed) => decode(parsed)));

const normalizeSnapshotTable = (
  table: Schema.Schema.Type<typeof PostgresStorageSnapshotTableSchema>
): Effect.Effect<PostgresStorageSnapshotTable, ContractValidationError> => {
  if (!postgresTableNameSet.has(table.name)) {
    return Effect.fail(
      toContractValidationError(
        "PostgresStorageSnapshotData.tables.name",
        "Unknown Postgres snapshot table.",
        `Table '${table.name}' is not part of the enterprise Postgres schema.`
      )
    );
  }

  const columns = Object.freeze([...table.columns]);
  const expectedColumns =
    table.name in postgresSnapshotTableColumns
      ? postgresSnapshotTableColumns[
          table.name as keyof typeof postgresSnapshotTableColumns
        ]
      : undefined;

  if (
    expectedColumns !== undefined &&
    JSON.stringify(columns) !== JSON.stringify(expectedColumns)
  ) {
    return Effect.fail(
      toContractValidationError(
        "PostgresStorageSnapshotData.tables.columns",
        "Snapshot columns must match the repository contract.",
        `Table '${table.name}' declared columns ${JSON.stringify(columns)} but expected ${JSON.stringify(expectedColumns)}.`
      )
    );
  }

  return Effect.all(
    [...table.rows].map((row, rowIndex) =>
      row.length === columns.length
        ? Effect.succeed(
            Object.freeze([...row]) as readonly (string | number | null)[]
          )
        : Effect.fail(
            toContractValidationError(
              "PostgresStorageSnapshotData.tables.rows",
              "Snapshot rows must match the declared column count.",
              `Table '${table.name}' row ${rowIndex} has ${row.length} values but ${columns.length} columns were declared.`
            )
          )
    )
  ).pipe(
    Effect.map((normalizedRows) =>
      Object.freeze(
        [...normalizedRows].sort((left, right) =>
          JSON.stringify(left).localeCompare(JSON.stringify(right))
        )
      )
    ),
    Effect.map(
      (rows) =>
        Object.freeze({
          name: table.name as EnterprisePostgresTableName,
          columns,
          rows,
        }) as PostgresStorageSnapshotTable
    )
  );
};

const normalizeSnapshotData = (
  snapshotData: unknown
): Effect.Effect<PostgresStorageSnapshotData, ContractValidationError> =>
  decodeSnapshotDataEffect(snapshotData).pipe(
    Effect.flatMap((decoded) =>
      Effect.all(
        decoded.tables.map((table) => normalizeSnapshotTable(table))
      ).pipe(
        Effect.flatMap((tables) => {
          const duplicateTableNames = tables.reduce<readonly string[]>(
            (duplicates, table, index) =>
              tables.findIndex((candidate) => candidate.name === table.name) !==
              index
                ? Object.freeze([...duplicates, table.name])
                : duplicates,
            Object.freeze([])
          );

          return duplicateTableNames.length > 0
            ? Effect.fail(
                toContractValidationError(
                  "PostgresStorageSnapshotData.tables",
                  "Snapshot table names must be unique.",
                  `Duplicate tables: ${duplicateTableNames.join(", ")}`
                )
              )
            : Effect.succeed(
                Object.freeze({
                  format: postgresStorageSnapshotFormat,
                  schemaVersion: enterprisePostgresSchemaVersion,
                  tables: Object.freeze(
                    [...tables].sort(
                      (left, right) =>
                        (postgresTableNameOrder.get(left.name) ??
                          Number.MAX_SAFE_INTEGER) -
                        (postgresTableNameOrder.get(right.name) ??
                          Number.MAX_SAFE_INTEGER)
                    )
                  ),
                }) satisfies PostgresStorageSnapshotData
              );
        })
      )
    )
  );

const serializeSnapshotData = (
  snapshotData: PostgresStorageSnapshotData
): Effect.Effect<string, ContractValidationError> =>
  canonicalizeJsonString(snapshotData, "PostgresStorageSnapshotData");

const countSnapshotRows = (snapshotData: PostgresStorageSnapshotData): number =>
  snapshotData.tables.reduce((total, table) => total + table.rows.length, 0);

export const makePostgresStorageRepository = (
  driver: PostgresStorageRepositoryDriver,
  options: PostgresStorageRepositoryOptions = {}
): StorageRepository => {
  const upsertMemory = Effect.fn("PostgresStorageRepository.upsertMemory")(
    function* (requestInput: StorageUpsertRequest) {
      const request = yield* decodeStorageUpsertRequestEffect(requestInput);
      const payloadJson = yield* canonicalizeJsonString(
        request.payload,
        "StorageUpsertRequest.payload"
      );
      const persistedAtMillis = yield* validateNow(options.now);
      const idempotencyKey = yield* resolveOptionalIdempotencyKey(
        request,
        "upsert"
      );
      const requestHashSha256 = toDeterministicUpsertRequestHash(
        request,
        payloadJson
      );

      if (idempotencyKey !== null) {
        const storedReplay = yield* driver.getIdempotency(
          request.spaceId,
          "upsert",
          idempotencyKey
        );

        if (storedReplay !== null) {
          const validatedReplay =
            yield* decodeStoredIdempotencyRecordEffect(storedReplay);
          if (validatedReplay.requestHashSha256 !== requestHashSha256) {
            return yield* Effect.fail(
              toIdempotencyConflictError(
                "upsert",
                request,
                idempotencyKey,
                validatedReplay.requestHashSha256,
                requestHashSha256
              )
            );
          }

          return yield* decodeStoredReplayResponse(
            validatedReplay.responseJson,
            "PostgresStoredIdempotencyRecord.responseJson",
            decodeUpsertResponseEffect
          );
        }
      }

      const existingRecord = yield* driver.getMemory(
        request.spaceId,
        request.memoryId
      );
      const validatedExistingRecord =
        existingRecord === null
          ? null
          : yield* decodeStoredMemoryRecordEffect(existingRecord);
      const nextVersion =
        validatedExistingRecord === null
          ? 1
          : validatedExistingRecord.version + 1;
      const storedRecord = yield* driver
        .upsertMemory({
          spaceId: request.spaceId,
          memoryId: request.memoryId,
          layer: request.layer,
          payloadJson,
          persistedAtMillis,
          version: nextVersion,
        })
        .pipe(
          Effect.flatMap((record) => decodeStoredMemoryRecordEffect(record))
        );
      const response = yield* decodeUpsertResponseEffect({
        spaceId: storedRecord.spaceId,
        memoryId: storedRecord.memoryId,
        accepted: true,
        persistedAtMillis: storedRecord.persistedAtMillis,
        version: storedRecord.version,
      });

      if (idempotencyKey !== null) {
        yield* driver
          .putIdempotency({
            spaceId: request.spaceId,
            operation: "upsert",
            idempotencyKey,
            requestHashSha256,
            responseJson: JSON.stringify(response),
          })
          .pipe(Effect.asVoid);
      }

      return response;
    }
  );

  const deleteMemory = Effect.fn("PostgresStorageRepository.deleteMemory")(
    function* (requestInput: StorageDeleteRequest) {
      const request = yield* decodeStorageDeleteRequestEffect(requestInput);
      const idempotencyKey = yield* resolveOptionalIdempotencyKey(
        request,
        "delete"
      );
      const requestHashSha256 = toDeterministicDeleteRequestHash(request);

      if (idempotencyKey !== null) {
        const storedReplay = yield* driver.getIdempotency(
          request.spaceId,
          "delete",
          idempotencyKey
        );

        if (storedReplay !== null) {
          const validatedReplay =
            yield* decodeStoredIdempotencyRecordEffect(storedReplay);
          if (validatedReplay.requestHashSha256 !== requestHashSha256) {
            return yield* Effect.fail(
              toIdempotencyConflictError(
                "delete",
                request,
                idempotencyKey,
                validatedReplay.requestHashSha256,
                requestHashSha256
              )
            );
          }

          return yield* decodeStoredReplayResponse(
            validatedReplay.responseJson,
            "PostgresStoredIdempotencyRecord.responseJson",
            decodeDeleteResponseEffect
          );
        }
      }

      const deleted = yield* driver.deleteMemory(
        request.spaceId,
        request.memoryId
      );

      if (!deleted) {
        return yield* Effect.fail(
          new StorageNotFoundError({
            spaceId: request.spaceId,
            memoryId: request.memoryId,
            message:
              `Memory '${request.memoryId}' was not found in ` +
              `space '${request.spaceId}'.`,
          })
        );
      }

      const response = yield* decodeDeleteResponseEffect({
        spaceId: request.spaceId,
        memoryId: request.memoryId,
        deleted: true,
      });

      if (idempotencyKey !== null) {
        yield* driver
          .putIdempotency({
            spaceId: request.spaceId,
            operation: "delete",
            idempotencyKey,
            requestHashSha256,
            responseJson: JSON.stringify(response),
          })
          .pipe(Effect.asVoid);
      }

      return response;
    }
  );

  const exportSnapshot = Effect.fn("PostgresStorageRepository.exportSnapshot")(
    function* (requestInput: StorageSnapshotExportRequest) {
      const request = yield* decodeSnapshotExportRequestEffect(requestInput);
      const signingSecret = yield* resolveSnapshotSigningSecret(
        request,
        "StorageSnapshotExportRequest.signatureSecret"
      );
      const snapshotData = yield* driver
        .exportSnapshot()
        .pipe(Effect.flatMap((snapshot) => normalizeSnapshotData(snapshot)));
      const payload = yield* serializeSnapshotData(snapshotData);
      return yield* decodeSnapshotExportResponseEffect({
        signatureAlgorithm: postgresStorageSnapshotSignatureAlgorithm,
        payload,
        signature: toSnapshotSignature(payload, signingSecret),
        tableCount: snapshotData.tables.length,
        rowCount: countSnapshotRows(snapshotData),
      });
    }
  );

  const importSnapshot = Effect.fn("PostgresStorageRepository.importSnapshot")(
    function* (requestInput: StorageSnapshotImportRequest) {
      const request = yield* decodeSnapshotImportRequestEffect(requestInput);
      const signingSecret = yield* resolveSnapshotSigningSecret(
        request,
        "StorageSnapshotImportRequest.signatureSecret"
      );
      if (
        request.signatureAlgorithm !== postgresStorageSnapshotSignatureAlgorithm
      ) {
        return yield* Effect.fail(
          new ContractValidationError({
            contract: "StorageSnapshotImportRequest.signatureAlgorithm",
            message: "Unsupported snapshot signature algorithm.",
            details:
              `Expected '${postgresStorageSnapshotSignatureAlgorithm}' ` +
              `but received '${request.signatureAlgorithm}'.`,
          })
        );
      }

      const payload = request.payload;
      if (!verifySnapshotSignature(payload, signingSecret, request.signature)) {
        return yield* Effect.fail(
          new ContractValidationError({
            contract: "StorageSnapshotImportRequest.signature",
            message: "Snapshot signature verification failed.",
            details:
              "Provided signature does not match payload and secret using hmac-sha256.",
          })
        );
      }

      const decodedSnapshot = yield* Effect.try({
        try: () => JSON.parse(payload),
        catch: (cause) =>
          new ContractValidationError({
            contract: "StorageSnapshotImportRequest.payload",
            message: "Snapshot payload is not valid JSON.",
            details: isErrorWithMessage(cause) ? cause.message : String(cause),
          }),
      }).pipe(Effect.flatMap((parsed) => normalizeSnapshotData(parsed)));
      const canonicalPayload = yield* serializeSnapshotData(decodedSnapshot);
      if (canonicalPayload !== payload) {
        return yield* Effect.fail(
          new ContractValidationError({
            contract: "StorageSnapshotImportRequest.payload",
            message:
              "Snapshot payload must use deterministic canonical serialization.",
            details:
              "Payload does not match canonical JSON encoding for the " +
              "decoded snapshot document.",
          })
        );
      }

      const existingSnapshot = yield* driver
        .exportSnapshot()
        .pipe(Effect.flatMap((snapshot) => normalizeSnapshotData(snapshot)));
      const existingPayload = yield* serializeSnapshotData(existingSnapshot);
      const baseResponse = {
        imported: true,
        tableCount: decodedSnapshot.tables.length,
        rowCount: countSnapshotRows(decodedSnapshot),
      } as const;

      if (existingPayload === canonicalPayload) {
        return yield* decodeSnapshotImportResponseEffect({
          ...baseResponse,
          replayed: true,
        });
      }

      yield* driver.importSnapshot(decodedSnapshot);

      return yield* decodeSnapshotImportResponseEffect({
        ...baseResponse,
        replayed: false,
      });
    }
  );

  return {
    upsertMemory: (request) => upsertMemory(request),
    deleteMemory: (request) => deleteMemory(request),
    exportSnapshot: (request) => exportSnapshot(request),
    importSnapshot: (request) => importSnapshot(request),
  };
};
