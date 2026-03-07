import { createHash, createHmac } from "node:crypto";

import { Effect, Inspectable, Predicate, Schema, SchemaIssue } from "effect";

import {
  StorageDeleteRequestSchema,
  type StorageSnapshotExportRequest,
  StorageSnapshotExportRequestSchema,
  type StorageSnapshotImportRequest,
  StorageUpsertRequestSchema,
} from "../../../libs/shared/src/effect/contracts/index.ts";
import {
  decodeUnknownEffect,
  decodeUnknownSync,
} from "../../../libs/shared/src/effect/contracts/validators.ts";
import {
  type StorageServiceError,
  ContractValidationError,
} from "../../../libs/shared/src/effect/errors.ts";
import {
  makePostgresStorageService,
  makeSqliteStorageService,
  type StorageService,
} from "../../../libs/shared/src/effect/services/storage-service.ts";
import {
  enterprisePostgresSchemaVersion,
  postgresStorageSnapshotFormat,
  type PostgresStorageSnapshotData,
  type PostgresStorageRepositoryDriver,
  type PostgresStoredIdempotencyRecord,
  type PostgresStoredMemoryRecord,
} from "../../../libs/shared/src/effect/storage/postgres/index.ts";
import { DatabaseSync } from "../../../libs/shared/src/effect/storage/sqlite/database.ts";
import { parseSqliteStorageSnapshotPayload } from "../../../libs/shared/src/effect/storage/sqlite/snapshot-codec.ts";

const STORAGE_DUALRUN_REQUEST_CONTRACT = "StorageDualRunRequest";
const STORAGE_DUALRUN_POSTGRES_SNAPSHOT_CONTRACT =
  "StorageDualRunPostgresSnapshot";
const STORAGE_DUALRUN_FIXTURE_SCHEMA_VERSION = "storage_parity_fixture.v1";
const DEFAULT_SNAPSHOT_SIGNATURE_SECRET = "storage-dualrun-snapshot-secret";

const StorageDualRunMismatchReasonCodeSchema = Schema.Literals([
  "version_field_divergence",
  "operation_result_mismatch",
  "snapshot_state_mismatch",
]);

const StorageUpsertOperationSchema = Schema.Struct({
  kind: Schema.Literal("upsert"),
  label: Schema.String,
  request: StorageUpsertRequestSchema,
});

const StorageDeleteOperationSchema = Schema.Struct({
  kind: Schema.Literal("delete"),
  label: Schema.String,
  request: StorageDeleteRequestSchema,
});

const StorageSnapshotOperationSchema = Schema.Struct({
  kind: Schema.Literal("snapshot_state"),
  label: Schema.String,
  request: Schema.optional(StorageSnapshotExportRequestSchema),
});

const StorageSnapshotRoundtripOperationSchema = Schema.Struct({
  kind: Schema.Literal("snapshot_roundtrip"),
  label: Schema.String,
  request: Schema.optional(StorageSnapshotExportRequestSchema),
});

export const StorageDualRunOperationSchema = Schema.Union([
  StorageUpsertOperationSchema,
  StorageDeleteOperationSchema,
  StorageSnapshotOperationSchema,
  StorageSnapshotRoundtripOperationSchema,
]);

export const StorageDualRunRequestSchema = Schema.Struct({
  suiteId: Schema.String,
  storeId: Schema.optional(Schema.String),
  waivers: Schema.optional(
    Schema.Array(StorageDualRunMismatchReasonCodeSchema)
  ),
  operations: Schema.Array(StorageDualRunOperationSchema),
});

export const StorageParityFixtureSchema = Schema.Struct({
  schemaVersion: Schema.Literal(STORAGE_DUALRUN_FIXTURE_SCHEMA_VERSION),
  fixtureId: Schema.String,
  description: Schema.String,
  request: StorageDualRunRequestSchema,
  expect: Schema.Struct({
    ok: Schema.Boolean,
    mismatchCount: Schema.Number,
    waivedMismatchCount: Schema.Number,
    mismatchReasonCodes: Schema.Array(StorageDualRunMismatchReasonCodeSchema),
  }),
});

const PostgresStorageSnapshotSchema = Schema.Struct({
  format: Schema.Literal(postgresStorageSnapshotFormat),
  schemaVersion: Schema.Literal(enterprisePostgresSchemaVersion),
  tables: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      columns: Schema.Array(Schema.String),
      rows: Schema.Array(
        Schema.Array(Schema.Union([Schema.String, Schema.Number, Schema.Null]))
      ),
    })
  ),
});

const ContractValidationErrorShape = Schema.Struct({
  _tag: Schema.Literal("ContractValidationError"),
  contract: Schema.String,
  message: Schema.optional(Schema.String),
  details: Schema.optional(Schema.String),
});

const StorageConflictErrorShape = Schema.Struct({
  _tag: Schema.Literal("StorageConflictError"),
  spaceId: Schema.String,
  memoryId: Schema.String,
  message: Schema.optional(Schema.String),
});

const StorageNotFoundErrorShape = Schema.Struct({
  _tag: Schema.Literal("StorageNotFoundError"),
  spaceId: Schema.String,
  memoryId: Schema.String,
  message: Schema.optional(Schema.String),
});

const isContractValidationError = Schema.is(ContractValidationErrorShape);
const isStorageConflictError = Schema.is(StorageConflictErrorShape);
const isStorageNotFoundError = Schema.is(StorageNotFoundErrorShape);

type SchemaWithoutContext<A, I = A> = Schema.Codec<A, I, never, never>;

export type StorageDualRunMismatchReasonCode = Schema.Schema.Type<
  typeof StorageDualRunMismatchReasonCodeSchema
>;
export type StorageDualRunOperation = Schema.Schema.Type<
  typeof StorageDualRunOperationSchema
>;
export type StorageDualRunRequest = Schema.Schema.Type<
  typeof StorageDualRunRequestSchema
>;
export type StorageParityFixture = Schema.Schema.Type<
  typeof StorageParityFixtureSchema
>;

export interface StorageDualRunMismatch {
  readonly operationIndex: number;
  readonly label: string;
  readonly reasonCode: StorageDualRunMismatchReasonCode;
  readonly waived: boolean;
  readonly sqlite: unknown;
  readonly postgres: unknown;
}

export interface StorageDualRunOperationReport {
  readonly operationIndex: number;
  readonly kind: StorageDualRunOperation["kind"];
  readonly label: string;
  readonly ok: boolean;
  readonly mismatches: readonly StorageDualRunMismatch[];
  readonly sqlite: unknown;
  readonly postgres: unknown;
}

export interface StorageDualRunReport {
  readonly operation: "storage_dualrun";
  readonly suiteId: string;
  readonly storeId: string;
  readonly ok: boolean;
  readonly operationCount: number;
  readonly mismatchCount: number;
  readonly waivedMismatchCount: number;
  readonly mismatchReasonCodes: readonly StorageDualRunMismatchReasonCode[];
  readonly operations: readonly StorageDualRunOperationReport[];
  readonly mismatches: readonly StorageDualRunMismatch[];
  readonly requestDigest: string;
  readonly observability: {
    readonly tracePayload: {
      readonly suiteId: string;
      readonly storeId: string;
      readonly operationCount: number;
      readonly mismatchCount: number;
      readonly waivedMismatchCount: number;
      readonly mismatchReasonCodes: readonly StorageDualRunMismatchReasonCode[];
      readonly requestDigest: string;
    };
  };
}

type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

interface NormalizedMemoryRow {
  readonly spaceId: string;
  readonly memoryId: string;
  readonly layer: string;
  readonly payload: CanonicalJsonValue;
  readonly version: number | null;
}

interface NormalizedIdempotencyRow {
  readonly spaceId: string;
  readonly operation: string;
  readonly idempotencyKey: string;
  readonly response: CanonicalJsonValue;
}

interface NormalizedSnapshotState {
  readonly memories: readonly NormalizedMemoryRow[];
  readonly idempotencyLedger: readonly NormalizedIdempotencyRow[];
}

interface Harness {
  readonly sqlite: {
    readonly database: DatabaseSync;
    readonly service: StorageService;
  };
  readonly postgres: {
    readonly service: StorageService;
  };
}

interface InMemoryPostgresDriverState {
  readonly memories: Map<string, PostgresStoredMemoryRecord>;
  readonly idempotency: Map<string, PostgresStoredIdempotencyRecord>;
}

const decodeStorageDualRunRequest = decodeUnknownSync(
  StorageDualRunRequestSchema as unknown as SchemaWithoutContext<StorageDualRunRequest>
);
export const decodeStorageParityFixture = decodeUnknownSync(
  StorageParityFixtureSchema as unknown as SchemaWithoutContext<StorageParityFixture>
);
const decodePostgresStorageSnapshot = decodeUnknownEffect(
  PostgresStorageSnapshotSchema,
  STORAGE_DUALRUN_POSTGRES_SNAPSHOT_CONTRACT
);

const stableStringify = (value: unknown): string => {
  if (Predicate.isNullish(value)) {
    return "null";
  }

  if (
    Predicate.isString(value) ||
    Predicate.isNumber(value) ||
    Predicate.isBoolean(value)
  ) {
    return JSON.stringify(value) ?? "null";
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort((left, right) => left.localeCompare(right));
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
};

const formatSchemaError = (error: unknown): string => {
  const formatter = SchemaIssue.makeFormatterDefault();
  if (SchemaIssue.isIssue(error)) {
    return formatter(error);
  }
  if (Schema.isSchemaError(error)) {
    return formatter(error.issue);
  }
  if (Predicate.isError(error)) {
    return error.message;
  }
  return Inspectable.toStringUnknown(error);
};

const toStorageDualRunContractError = (
  contract: string,
  error: unknown
): ContractValidationError =>
  new ContractValidationError({
    contract,
    message: `Contract validation failed for ${contract}.`,
    details: formatSchemaError(error),
  });

const toCanonicalJsonValue = (value: unknown): CanonicalJsonValue => {
  if (Predicate.isNullish(value)) {
    return null;
  }
  if (
    Predicate.isString(value) ||
    Predicate.isNumber(value) ||
    Predicate.isBoolean(value)
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry) => toCanonicalJsonValue(entry)));
  }

  const record = value as Record<string, unknown>;
  return Object.freeze(
    Object.fromEntries(
      Object.keys(record)
        .sort((left, right) => left.localeCompare(right))
        .map((key) => [key, toCanonicalJsonValue(record[key])])
    )
  ) as CanonicalJsonValue;
};

const parseJsonValue = (raw: string): CanonicalJsonValue =>
  Effect.runSync(
    Effect.try({
      try: () => JSON.parse(raw) as unknown,
      catch: () => raw,
    }).pipe(Effect.map((parsed) => toCanonicalJsonValue(parsed)))
  );

const findColumnIndex = (
  columns: readonly string[],
  candidates: readonly string[]
): number =>
  candidates
    .map((candidate) => columns.indexOf(candidate))
    .find((index) => index >= 0) ?? -1;

const readRowValue = (
  row: readonly (string | number | null)[],
  columns: readonly string[],
  candidates: readonly string[]
): string | number | null => {
  const index = findColumnIndex(columns, candidates);
  return index >= 0 ? (row[index] ?? null) : null;
};

const compareNormalizedRows = <Row extends Record<string, unknown>>(
  left: Row,
  right: Row
): number => stableStringify(left).localeCompare(stableStringify(right));

const normalizeSqliteSnapshotState = (
  payload: string
): NormalizedSnapshotState => {
  const snapshot = parseSqliteStorageSnapshotPayload(payload);
  const memoryTable = snapshot.tables.find(
    (table) => table.name === "memory_items"
  );
  const idempotencyTable = snapshot.tables.find(
    (table) => table.name === "storage_idempotency_ledger"
  );

  const memories = Object.freeze(
    (memoryTable?.rows ?? [])
      .map((row) => {
        const columns = memoryTable?.columns ?? [];
        return Object.freeze({
          spaceId: String(
            readRowValue(row, columns, ["space_id", "tenant_id"])
          ),
          memoryId: String(readRowValue(row, columns, ["memory_id"])),
          layer: String(readRowValue(row, columns, ["memory_layer", "layer"])),
          payload: toCanonicalJsonValue(
            stripAdapterSpecificFields(
              parseJsonValue(
                String(readRowValue(row, columns, ["payload_json"]))
              )
            )
          ),
          version: Predicate.isNumber(readRowValue(row, columns, ["version"]))
            ? Number(readRowValue(row, columns, ["version"]))
            : null,
        });
      })
      .sort(compareNormalizedRows)
  );

  const idempotencyLedger = Object.freeze(
    (idempotencyTable?.rows ?? [])
      .map((row) => {
        const columns = idempotencyTable?.columns ?? [];
        return Object.freeze({
          spaceId: String(
            readRowValue(row, columns, ["space_id", "tenant_id"])
          ),
          operation: String(readRowValue(row, columns, ["operation"])),
          idempotencyKey: String(
            readRowValue(row, columns, ["idempotency_key"])
          ),
          response: toCanonicalJsonValue(
            stripAdapterSpecificFields(
              parseJsonValue(
                String(readRowValue(row, columns, ["response_json"]))
              )
            )
          ),
        });
      })
      .sort(compareNormalizedRows)
  );

  return Object.freeze({
    memories,
    idempotencyLedger,
  });
};

const normalizePostgresSnapshotState = (
  payload: string
): Effect.Effect<NormalizedSnapshotState, ContractValidationError> =>
  Effect.try({
    try: () => JSON.parse(payload) as unknown,
    catch: (error) =>
      toStorageDualRunContractError(
        STORAGE_DUALRUN_POSTGRES_SNAPSHOT_CONTRACT,
        error
      ),
  }).pipe(
    Effect.flatMap((parsed) => decodePostgresStorageSnapshot(parsed)),
    Effect.map((snapshot) => {
      const memoryTable = snapshot.tables.find(
        (table) => table.name === "memory_items"
      );
      const idempotencyTable = snapshot.tables.find(
        (table) => table.name === "storage_idempotency_ledger"
      );

      const memories = Object.freeze(
        (memoryTable?.rows ?? [])
          .map((row) => {
            const columns = memoryTable?.columns ?? [];
            return Object.freeze({
              spaceId: String(readRowValue(row, columns, ["space_id"])),
              memoryId: String(readRowValue(row, columns, ["memory_id"])),
              layer: String(readRowValue(row, columns, ["memory_layer"])),
              payload: toCanonicalJsonValue(
                stripAdapterSpecificFields(
                  parseJsonValue(
                    String(readRowValue(row, columns, ["payload_json"]))
                  )
                )
              ),
              version: Predicate.isNumber(
                readRowValue(row, columns, ["version"])
              )
                ? Number(readRowValue(row, columns, ["version"]))
                : null,
            });
          })
          .sort(compareNormalizedRows)
      );

      const idempotencyLedger = Object.freeze(
        (idempotencyTable?.rows ?? [])
          .map((row) => {
            const columns = idempotencyTable?.columns ?? [];
            return Object.freeze({
              spaceId: String(readRowValue(row, columns, ["space_id"])),
              operation: String(readRowValue(row, columns, ["operation"])),
              idempotencyKey: String(
                readRowValue(row, columns, ["idempotency_key"])
              ),
              response: toCanonicalJsonValue(
                stripAdapterSpecificFields(
                  parseJsonValue(
                    String(readRowValue(row, columns, ["response_json"]))
                  )
                )
              ),
            });
          })
          .sort(compareNormalizedRows)
      );

      return Object.freeze({
        memories,
        idempotencyLedger,
      });
    })
  );

const stripAdapterSpecificFields = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((entry) => stripAdapterSpecificFields(entry));
  }
  if (Predicate.isNullish(value) || !Predicate.isObject(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort((left, right) => left.localeCompare(right))
      .filter(
        (key) =>
          key !== "version" &&
          key !== "persistedAtMillis" &&
          key !== "requestHashSha256"
      )
      .map((key) => [key, stripAdapterSpecificFields(record[key])])
  );
};

const makeRequestDigest = (request: StorageDualRunRequest): string =>
  createHash("sha256").update(stableStringify(request)).digest("hex");

interface CanonicalSnapshotSigningRequest {
  readonly signatureSecret: string;
}

const resolveSnapshotSignatureSecret = (
  request: StorageSnapshotExportRequest | undefined
): string => {
  if (!request) {
    return DEFAULT_SNAPSHOT_SIGNATURE_SECRET;
  }

  return (
    request.signatureSecret ??
    request.signature_secret ??
    DEFAULT_SNAPSHOT_SIGNATURE_SECRET
  );
};

const makeSnapshotExportRequest = (
  request: StorageSnapshotExportRequest | undefined
): CanonicalSnapshotSigningRequest => ({
  signatureSecret: resolveSnapshotSignatureSecret(request),
});

const normalizeStorageError = (error: unknown): CanonicalJsonValue => {
  if (isContractValidationError(error)) {
    return Object.freeze({
      _tag: error._tag,
      contract: error.contract,
    });
  }
  if (isStorageConflictError(error)) {
    return Object.freeze({
      _tag: error._tag,
      spaceId: error.spaceId,
      memoryId: error.memoryId,
    });
  }
  if (isStorageNotFoundError(error)) {
    return Object.freeze({
      _tag: error._tag,
      spaceId: error.spaceId,
      memoryId: error.memoryId,
    });
  }
  return Object.freeze({
    _tag: "UnknownStorageError",
    message: Predicate.isError(error)
      ? error.message
      : Inspectable.toStringUnknown(error),
  });
};

const toOutcome = <Success>(
  effect: Effect.Effect<Success, StorageServiceError>
): Effect.Effect<
  | { readonly _tag: "success"; readonly value: CanonicalJsonValue }
  | { readonly _tag: "failure"; readonly value: CanonicalJsonValue },
  never
> =>
  Effect.result(effect).pipe(
    Effect.map((result) =>
      result._tag === "Success"
        ? ({
            _tag: "success",
            value: toCanonicalJsonValue(result.success),
          } as const)
        : ({
            _tag: "failure",
            value: normalizeStorageError(result.failure),
          } as const)
    )
  );

const makeDriverKey = (spaceId: string, memoryId: string): string =>
  `${spaceId}::${memoryId}`;

const makeIdempotencyKey = (
  spaceId: string,
  operation: string,
  idempotencyKey: string
): string => `${spaceId}::${operation}::${idempotencyKey}`;

const createInMemoryPostgresDriver = (): PostgresStorageRepositoryDriver => {
  const state: InMemoryPostgresDriverState = {
    memories: new Map(),
    idempotency: new Map(),
  };

  const exportSnapshot = (): PostgresStorageSnapshotData => {
    const memoryRows = [...state.memories.values()]
      .map((record) =>
        Object.freeze([
          record.spaceId,
          record.memoryId,
          record.layer,
          record.payloadJson,
          record.persistedAtMillis,
          record.version,
        ])
      )
      .sort((left, right) =>
        stableStringify(left).localeCompare(stableStringify(right))
      );
    const idempotencyRows = [...state.idempotency.values()]
      .map((record) =>
        Object.freeze([
          record.spaceId,
          record.operation,
          record.idempotencyKey,
          record.requestHashSha256,
          record.responseJson,
        ])
      )
      .sort((left, right) =>
        stableStringify(left).localeCompare(stableStringify(right))
      );

    return Object.freeze({
      format: postgresStorageSnapshotFormat,
      schemaVersion: enterprisePostgresSchemaVersion,
      tables: Object.freeze([
        Object.freeze({
          name: "memory_items" as const,
          columns: Object.freeze([
            "space_id",
            "memory_id",
            "memory_layer",
            "payload_json",
            "persisted_at_ms",
            "version",
          ]),
          rows: Object.freeze(memoryRows),
        }),
        Object.freeze({
          name: "storage_idempotency_ledger" as const,
          columns: Object.freeze([
            "space_id",
            "operation",
            "idempotency_key",
            "request_hash_sha256",
            "response_json",
          ]),
          rows: Object.freeze(idempotencyRows),
        }),
      ]),
    }) satisfies PostgresStorageSnapshotData;
  };

  return {
    getMemory: (spaceId, memoryId) =>
      Effect.succeed(
        state.memories.get(makeDriverKey(spaceId, memoryId)) ?? null
      ),
    upsertMemory: (record) =>
      Effect.succeed(
        (() => {
          state.memories.set(
            makeDriverKey(record.spaceId, record.memoryId),
            record
          );
          return record;
        })()
      ),
    deleteMemory: (spaceId, memoryId) =>
      Effect.succeed(state.memories.delete(makeDriverKey(spaceId, memoryId))),
    getIdempotency: (spaceId, operation, idempotencyKey) =>
      Effect.succeed(
        state.idempotency.get(
          makeIdempotencyKey(spaceId, operation, idempotencyKey)
        ) ?? null
      ),
    putIdempotency: (record) =>
      Effect.sync(() => {
        state.idempotency.set(
          makeIdempotencyKey(
            record.spaceId,
            record.operation,
            record.idempotencyKey
          ),
          record
        );
      }),
    exportSnapshot: () => Effect.succeed(exportSnapshot()),
    importSnapshot: (snapshot) =>
      Effect.sync(() => {
        state.memories.clear();
        state.idempotency.clear();
        for (const table of snapshot.tables) {
          if (table.name === "memory_items") {
            for (const row of table.rows) {
              state.memories.set(
                makeDriverKey(String(row[0]), String(row[1])),
                {
                  spaceId: String(
                    row[0]
                  ) as PostgresStoredMemoryRecord["spaceId"],
                  memoryId: String(
                    row[1]
                  ) as PostgresStoredMemoryRecord["memoryId"],
                  layer: String(row[2]) as PostgresStoredMemoryRecord["layer"],
                  payloadJson: String(row[3]),
                  persistedAtMillis: Number(row[4]),
                  version: Number(row[5]),
                }
              );
            }
          }
          if (table.name === "storage_idempotency_ledger") {
            for (const row of table.rows) {
              state.idempotency.set(
                makeIdempotencyKey(
                  String(row[0]),
                  String(row[1]),
                  String(row[2])
                ),
                {
                  spaceId: String(
                    row[0]
                  ) as PostgresStoredIdempotencyRecord["spaceId"],
                  operation: String(
                    row[1]
                  ) as PostgresStoredIdempotencyRecord["operation"],
                  idempotencyKey: String(row[2]),
                  requestHashSha256: String(row[3]),
                  responseJson: String(row[4]),
                }
              );
            }
          }
        }
      }),
  };
};

const withHarness = <Success, Error>(
  use: (harness: Harness) => Effect.Effect<Success, Error>
): Effect.Effect<Success, Error> =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const database = new DatabaseSync(":memory:");
      const sqlite = {
        database,
        service: makeSqliteStorageService(database),
      };
      const postgresDriver = createInMemoryPostgresDriver();
      const postgres = {
        service: makePostgresStorageService(postgresDriver),
      };
      return {
        sqlite,
        postgres,
      } satisfies Harness;
    }),
    use,
    (harness) =>
      Effect.sync(() => {
        harness.sqlite.database.close();
      })
  );

const exportComparableState = (
  adapter: "sqlite" | "postgres",
  service: StorageService,
  request: StorageSnapshotExportRequest | undefined
): Effect.Effect<
  NormalizedSnapshotState,
  ContractValidationError | StorageServiceError
> => {
  const exportRequest = makeSnapshotExportRequest(request);
  return Effect.flatMap(service.exportSnapshot(exportRequest), (response) =>
    adapter === "sqlite"
      ? Effect.succeed(normalizeSqliteSnapshotState(response.payload))
      : normalizePostgresSnapshotState(response.payload)
  );
};

const roundtripComparableState = (
  adapter: "sqlite" | "postgres",
  sourceService: StorageService,
  request: StorageSnapshotExportRequest | undefined
): Effect.Effect<
  CanonicalJsonValue,
  ContractValidationError | StorageServiceError
> => {
  const exportRequest = makeSnapshotExportRequest(request);
  return Effect.flatMap(
    sourceService.exportSnapshot(exportRequest),
    (snapshot) =>
      withHarness((freshHarness) => {
        const targetService =
          adapter === "sqlite"
            ? freshHarness.sqlite.service
            : freshHarness.postgres.service;

        return Effect.gen(function* () {
          const importRequest: StorageSnapshotImportRequest = {
            signatureSecret: exportRequest.signatureSecret,
            signatureAlgorithm: snapshot.signatureAlgorithm,
            payload: snapshot.payload,
            signature: snapshot.signature,
          };
          const importResponse =
            yield* targetService.importSnapshot(importRequest);
          const state = yield* exportComparableState(
            adapter,
            targetService,
            request
          );
          return normalizeComparableResult({
            importResponse: {
              imported: importResponse.imported,
              replayed: importResponse.replayed,
            },
            state,
          });
        });
      })
  );
};

export const classifyStorageDualRunMismatchReason = (
  sqlite: unknown,
  postgres: unknown
): StorageDualRunMismatchReasonCode => {
  if (
    stableStringify(stripAdapterSpecificFields(sqlite)) ===
    stableStringify(stripAdapterSpecificFields(postgres))
  ) {
    return "version_field_divergence";
  }
  if (
    isContractValidationError(sqlite) ||
    isContractValidationError(postgres) ||
    isStorageConflictError(sqlite) ||
    isStorageConflictError(postgres) ||
    isStorageNotFoundError(sqlite) ||
    isStorageNotFoundError(postgres)
  ) {
    return "operation_result_mismatch";
  }
  return "snapshot_state_mismatch";
};

const compareOperationResults = (
  request: StorageDualRunRequest,
  operationIndex: number,
  kind: StorageDualRunOperation["kind"],
  label: string,
  sqlite: unknown,
  postgres: unknown
): StorageDualRunOperationReport => {
  const sqliteDigest = stableStringify(sqlite);
  const postgresDigest = stableStringify(postgres);
  if (sqliteDigest === postgresDigest) {
    return Object.freeze({
      operationIndex,
      kind,
      label,
      ok: true,
      mismatches: Object.freeze([]),
      sqlite,
      postgres,
    });
  }

  const reasonCode = classifyStorageDualRunMismatchReason(sqlite, postgres);
  const mismatch: StorageDualRunMismatch = Object.freeze({
    operationIndex,
    label,
    reasonCode,
    waived: (request.waivers ?? []).includes(reasonCode),
    sqlite,
    postgres,
  });

  return Object.freeze({
    operationIndex,
    kind,
    label,
    ok: mismatch.waived,
    mismatches: Object.freeze([mismatch]),
    sqlite,
    postgres,
  });
};

const normalizeComparableResult = (value: unknown): CanonicalJsonValue =>
  toCanonicalJsonValue(stripAdapterSpecificFields(value));

const executeComparedOperation = (
  request: StorageDualRunRequest,
  harness: Harness,
  operation: StorageDualRunOperation,
  operationIndex: number
): Effect.Effect<
  StorageDualRunOperationReport,
  ContractValidationError | StorageServiceError
> => {
  const operationName = operation.kind;
  return Effect.gen(function* () {
    if (operationName === "upsert") {
      const sqliteOutcome = yield* toOutcome(
        harness.sqlite.service.upsertMemory(operation.request)
      );
      const postgresOutcome = yield* toOutcome(
        harness.postgres.service.upsertMemory(operation.request)
      );
      return compareOperationResults(
        request,
        operationIndex,
        operation.kind,
        operation.label,
        normalizeComparableResult(sqliteOutcome.value),
        normalizeComparableResult(postgresOutcome.value)
      );
    }

    if (operationName === "delete") {
      const sqliteOutcome = yield* toOutcome(
        harness.sqlite.service.deleteMemory(operation.request)
      );
      const postgresOutcome = yield* toOutcome(
        harness.postgres.service.deleteMemory(operation.request)
      );
      return compareOperationResults(
        request,
        operationIndex,
        operation.kind,
        operation.label,
        normalizeComparableResult(sqliteOutcome.value),
        normalizeComparableResult(postgresOutcome.value)
      );
    }

    if (operationName === "snapshot_state") {
      const sqlite = yield* exportComparableState(
        "sqlite",
        harness.sqlite.service,
        operation.request
      );
      const postgres = yield* exportComparableState(
        "postgres",
        harness.postgres.service,
        operation.request
      );
      return compareOperationResults(
        request,
        operationIndex,
        operation.kind,
        operation.label,
        sqlite,
        postgres
      );
    }

    const sqlite = yield* roundtripComparableState(
      "sqlite",
      harness.sqlite.service,
      operation.request
    );
    const postgres = yield* roundtripComparableState(
      "postgres",
      harness.postgres.service,
      operation.request
    );
    return compareOperationResults(
      request,
      operationIndex,
      operation.kind,
      operation.label,
      sqlite,
      postgres
    );
  });
};

export const evaluateStorageDualRun = Effect.fn("StorageDualRun.evaluate")(
  function* (input: unknown) {
    const request: StorageDualRunRequest = yield* Effect.try({
      try: () => decodeStorageDualRunRequest(input),
      catch: (error) =>
        toStorageDualRunContractError(STORAGE_DUALRUN_REQUEST_CONTRACT, error),
    });
    const requestDigest = makeRequestDigest(request);
    const storeId = request.storeId ?? "storage-dualrun";

    return yield* withHarness((harness) =>
      Effect.gen(function* () {
        const operationReports = yield* Effect.forEach(
          request.operations,
          (operation, operationIndex) =>
            executeComparedOperation(
              request,
              harness,
              operation,
              operationIndex
            )
        );
        const mismatches = operationReports.flatMap(
          (report) => report.mismatches
        );
        const mismatchReasonCodes = Object.freeze(
          [
            ...new Set<StorageDualRunMismatchReasonCode>(
              mismatches.map((mismatch) => mismatch.reasonCode)
            ),
          ].sort((left, right) => left.localeCompare(right))
        ) as readonly StorageDualRunMismatchReasonCode[];
        const mismatchCount = mismatches.filter(
          (mismatch) => !mismatch.waived
        ).length;
        const waivedMismatchCount = mismatches.filter(
          (mismatch) => mismatch.waived
        ).length;

        return Object.freeze({
          operation: "storage_dualrun",
          suiteId: request.suiteId,
          storeId,
          ok: mismatchCount === 0,
          operationCount: request.operations.length,
          mismatchCount,
          waivedMismatchCount,
          mismatchReasonCodes,
          operations: Object.freeze(operationReports),
          mismatches: Object.freeze(mismatches),
          requestDigest,
          observability: Object.freeze({
            tracePayload: Object.freeze({
              suiteId: request.suiteId,
              storeId,
              operationCount: request.operations.length,
              mismatchCount,
              waivedMismatchCount,
              mismatchReasonCodes,
              requestDigest,
            }),
          }),
        }) satisfies StorageDualRunReport;
      })
    );
  }
);

export const createStorageParityFixtureDigest = (
  fixture: StorageParityFixture
): string =>
  createHash("sha256").update(stableStringify(fixture)).digest("hex");

export const createStorageDualRunSnapshotSignature = (
  payload: string,
  secret: string
): string => createHmac("sha256", secret).update(payload).digest("hex");
