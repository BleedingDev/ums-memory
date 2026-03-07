import { mkdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { Effect, Layer, Predicate, Schema, ServiceMap } from "effect";

import {
  makeRuntimePersistenceServiceFromRepository,
  makeNoopRuntimePersistenceService,
  type RuntimePersistenceService,
} from "../../../libs/shared/src/effect/services/runtime-persistence-service.ts";
import { DatabaseSync } from "../../../libs/shared/src/effect/storage/sqlite/database.ts";
import {
  makeSqliteRuntimePersistenceRepository,
  type SqliteRuntimePersistenceRepository,
} from "../../../libs/shared/src/effect/storage/sqlite/index.ts";
import {
  executeOperation as executeCoreOperation,
  exportStoreSnapshot,
  importStoreSnapshot,
  listOperations as listCoreOperations,
  resetStore,
  resetPolicyPackPlugin,
  setPolicyPackPlugin,
} from "./core.ts";
import {
  DEFAULT_SHARED_STATE_FILE,
  executeOperationWithSharedState,
  resolveStateFilePath,
  withSharedStateLockEffect,
} from "./persistence.ts";

// Runtime operation persistence semantics and migration requirements:
// docs/runbooks/runtime-operation-persistence-map.md
// docs/adr/0008-single-runtime-storage-adapter-architecture.md
export const DEFAULT_RUNTIME_SERVICE_EXPORT = "createRuntimeService";
export const DEFAULT_RUNTIME_SERVICE_MODULE = "builtin:effect-runtime-service";
export const DEFAULT_RUNTIME_STATE_FILE =
  process.env["UMS_RUNTIME_STATE_FILE"] ??
  (process.env["UMS_STATE_FILE"]
    ? DEFAULT_SHARED_STATE_FILE
    : ".ums-runtime-state");
export const DEFAULT_POLICY_PACK_PLUGIN_EXPORT = "createPolicyPackPlugin";
export const RUNTIME_SERVICE_LOAD_ERROR_CODE = "RUNTIME_SERVICE_LOAD_ERROR";
export const RUNTIME_SERVICE_CONTRACT_ERROR_CODE =
  "RUNTIME_SERVICE_CONTRACT_ERROR";
const DEFAULT_RUNTIME_SCOPE_STORE_ID = "coding-agent";
const DEFAULT_RUNTIME_SCOPE_PROFILE = "__store_default__";
const SQLITE_RUNTIME_PERSISTENCE_SUFFIX = ".sqlite";
const NOOP_RUNTIME_PERSISTENCE_CACHE_KEY = "@ums/runtime-persistence/noop";
const RUNTIME_ERROR_CODE_PATTERN = /^([A-Z_]+):/;
const LEGACY_SHARED_STATE_FILE_BASENAME = basename(
  DEFAULT_SHARED_STATE_FILE
).toLowerCase();

type CodedError = Error & {
  code: string;
  cause?: unknown;
};

interface NoopRuntimePersistenceBinding {
  readonly mode: "noop";
  readonly database: null;
  readonly service: RuntimePersistenceService;
}

interface SqliteRuntimePersistenceBinding {
  readonly mode: "sqlite";
  readonly database: { readonly close: () => void } | null;
  readonly repository: SqliteRuntimePersistenceRepository;
  readonly service: RuntimePersistenceService;
}

type RuntimePersistenceBinding =
  | NoopRuntimePersistenceBinding
  | SqliteRuntimePersistenceBinding;

const UnknownRecordSchema = Schema.Record(Schema.String, Schema.Unknown);
const ErrorWithMessageSchema = Schema.Struct({
  message: Schema.String,
});
const CodedErrorLikeSchema = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
});
const RuntimeServiceCandidateSchema = Schema.Struct({
  listOperations: Schema.Unknown,
  executeOperation: Schema.Unknown,
});
const UnknownArraySchema = Schema.Array(Schema.Unknown);
const RuntimeStoreSnapshotSchema = Schema.Struct({
  stores: Schema.optional(UnknownRecordSchema),
});

const isString = Schema.is(Schema.String);
const isUnknownRecord = Schema.is(UnknownRecordSchema);
const isErrorWithMessage = Schema.is(ErrorWithMessageSchema);
const isCodedErrorLike = Schema.is(CodedErrorLikeSchema);
const isRuntimeServiceCandidate = Schema.is(RuntimeServiceCandidateSchema);
const isUnknownArray = Schema.is(UnknownArraySchema);
const isRuntimeStoreSnapshot = Schema.is(RuntimeStoreSnapshotSchema);

let cachedRuntimeServiceKey: string | undefined;
let cachedRuntimeServicePromise:
  | Promise<ReturnType<typeof createDefaultRuntimeService>>
  | undefined;
const runtimePersistenceBindings = new Map<string, RuntimePersistenceBinding>();

function asNonEmptyString(value: unknown): string | null {
  if (!isString(value)) {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function toCodedError(
  message: string,
  code: string,
  cause?: unknown
): CodedError {
  const error = new Error(message) as CodedError;
  error.code = code;
  if (cause !== undefined) {
    error.cause = cause;
  }
  return error;
}

function isCodedError(
  error: unknown,
  expectedCode: string
): error is CodedError {
  return isCodedErrorLike(error) && error.code === expectedCode;
}

function toUnknownMessage(error: unknown): string {
  if (isErrorWithMessage(error)) {
    return error.message;
  }
  return String(error);
}

function normalizeCoreExecutionFailure(error: unknown): unknown {
  if (isCodedErrorLike(error)) {
    return error;
  }
  if (Predicate.isError(error)) {
    const matchedCode = error.message.match(RUNTIME_ERROR_CODE_PATTERN)?.[1];
    if (matchedCode) {
      return toCodedError(error.message, matchedCode, error);
    }
  }
  return error;
}

function toRuntimeServiceContractError(message: string): CodedError {
  return toCodedError(message, RUNTIME_SERVICE_CONTRACT_ERROR_CODE);
}

function toModuleSpecifier(modulePath: string): string {
  if (
    modulePath.startsWith(".") ||
    modulePath.startsWith("/") ||
    isAbsolute(modulePath)
  ) {
    const absolutePath = isAbsolute(modulePath)
      ? modulePath
      : resolve(process.cwd(), modulePath);
    return pathToFileURL(absolutePath).href;
  }
  return modulePath;
}

function normalizeOperationName(operation: unknown): string {
  return String(operation ?? "")
    .trim()
    .toLowerCase();
}

function normalizeScopeValue(value: unknown): string | null {
  if (!isString(value)) {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function deriveRuntimePersistenceScopeKey(requestBody: unknown): string {
  if (!isUnknownRecord(requestBody)) {
    return JSON.stringify([
      DEFAULT_RUNTIME_SCOPE_STORE_ID,
      DEFAULT_RUNTIME_SCOPE_PROFILE,
    ]);
  }

  const storeId =
    normalizeScopeValue(requestBody["storeId"]) ??
    normalizeScopeValue(requestBody["store"]) ??
    DEFAULT_RUNTIME_SCOPE_STORE_ID;
  const profile =
    normalizeScopeValue(requestBody["profile"]) ??
    DEFAULT_RUNTIME_SCOPE_PROFILE;

  return JSON.stringify([storeId, profile]);
}

function resolveRuntimePersistenceDatabasePath(
  stateFile: string | null | undefined
): string | null {
  if (isString(stateFile) && stateFile.trim() === ":memory:") {
    return ":memory:";
  }

  const resolvedStateFilePath = resolveStateFilePath(stateFile);
  if (resolvedStateFilePath === null) {
    return null;
  }

  return resolvedStateFilePath.endsWith(SQLITE_RUNTIME_PERSISTENCE_SUFFIX)
    ? resolvedStateFilePath
    : `${resolvedStateFilePath}${SQLITE_RUNTIME_PERSISTENCE_SUFFIX}`;
}

export function resolveRuntimeMaterializedStateFilePath(
  stateFile: string | null | undefined
): string | null {
  if (isString(stateFile) && stateFile.trim() === ":memory:") {
    return null;
  }

  const resolvedStateFilePath = resolveStateFilePath(stateFile);
  if (resolvedStateFilePath === null) {
    return null;
  }

  if (resolvedStateFilePath.endsWith(".json")) {
    return resolvedStateFilePath;
  }

  return resolvedStateFilePath.endsWith(SQLITE_RUNTIME_PERSISTENCE_SUFFIX)
    ? `${resolvedStateFilePath.slice(0, -SQLITE_RUNTIME_PERSISTENCE_SUFFIX.length)}.json`
    : `${resolvedStateFilePath}.json`;
}

function shouldUseSharedStateCompatibility(
  stateFile: string | null | undefined
): boolean {
  const resolvedStateFile = resolveStateFilePath(stateFile);
  return (
    resolvedStateFile !== null &&
    basename(resolvedStateFile).toLowerCase() ===
      LEGACY_SHARED_STATE_FILE_BASENAME
  );
}

function resolveRuntimePersistenceBinding(
  stateFile: string | null | undefined
): Effect.Effect<RuntimePersistenceBinding, CodedError> {
  const databasePath = resolveRuntimePersistenceDatabasePath(stateFile);
  const cacheKey = databasePath ?? NOOP_RUNTIME_PERSISTENCE_CACHE_KEY;
  const cachedBinding = runtimePersistenceBindings.get(cacheKey);
  if (cachedBinding !== undefined) {
    return Effect.succeed(cachedBinding);
  }

  return Effect.gen(function* () {
    if (databasePath === null) {
      const nextBinding = {
        mode: "noop",
        database: null,
        service: makeNoopRuntimePersistenceService(),
      } satisfies RuntimePersistenceBinding;
      runtimePersistenceBindings.set(cacheKey, nextBinding);
      return nextBinding;
    }

    if (databasePath !== ":memory:") {
      yield* Effect.tryPromise({
        try: () => mkdir(dirname(databasePath), { recursive: true }),
        catch: (cause) =>
          toCodedError(
            `Failed to initialize runtime persistence adapter '${databasePath}': ${toUnknownMessage(cause)}`,
            RUNTIME_SERVICE_LOAD_ERROR_CODE,
            cause
          ),
      });
    }

    const nextBinding = yield* Effect.try({
      try: () => {
        const database = new DatabaseSync(databasePath);
        const repository = makeSqliteRuntimePersistenceRepository(database);
        return {
          mode: "sqlite",
          database,
          repository,
          service: makeRuntimePersistenceServiceFromRepository(repository),
        } satisfies RuntimePersistenceBinding;
      },
      catch: (cause) =>
        toCodedError(
          `Failed to initialize runtime persistence adapter '${databasePath}': ${toUnknownMessage(cause)}`,
          RUNTIME_SERVICE_LOAD_ERROR_CODE,
          cause
        ),
    });

    runtimePersistenceBindings.set(cacheKey, nextBinding);
    return nextBinding;
  });
}

function resolveModuleExport(
  moduleRecord: Record<string, unknown>,
  {
    modulePath,
    exportName,
    defaultExportName,
    subject,
  }: {
    readonly modulePath: string;
    readonly exportName: string;
    readonly defaultExportName: string;
    readonly subject: string;
  }
): Effect.Effect<unknown, CodedError> {
  const exportedValue =
    moduleRecord[exportName] ??
    (exportName === defaultExportName ? moduleRecord["default"] : undefined);
  if (exportedValue === null || exportedValue === undefined) {
    return Effect.fail(
      toRuntimeServiceContractError(
        `${subject} module '${modulePath}' does not export '${exportName}'.`
      )
    );
  }
  return Effect.succeed(exportedValue);
}

function resolvePolicyPackPluginEffect(
  env: NodeJS.ProcessEnv
): Effect.Effect<unknown | null, CodedError> {
  const modulePath = asNonEmptyString(env["UMS_POLICY_PACK_PLUGIN_MODULE"]);
  if (!modulePath) {
    return Effect.succeed(null);
  }
  const exportName =
    asNonEmptyString(env["UMS_POLICY_PACK_PLUGIN_EXPORT"]) ??
    DEFAULT_POLICY_PACK_PLUGIN_EXPORT;

  const moduleSpecifier = toModuleSpecifier(modulePath);
  return Effect.tryPromise({
    try: () => import(moduleSpecifier) as Promise<Record<string, unknown>>,
    catch: (cause) =>
      toCodedError(
        `Failed to load policy pack plugin '${modulePath}#${exportName}': ${toUnknownMessage(cause)}`,
        RUNTIME_SERVICE_LOAD_ERROR_CODE,
        cause
      ),
  }).pipe(
    Effect.flatMap((pluginModule) =>
      resolveModuleExport(pluginModule, {
        modulePath,
        exportName,
        defaultExportName: DEFAULT_POLICY_PACK_PLUGIN_EXPORT,
        subject: "Policy pack plugin",
      })
    ),
    Effect.flatMap((exportedValue) =>
      Predicate.isFunction(exportedValue)
        ? Effect.tryPromise({
            try: async () => await exportedValue(),
            catch: (cause) =>
              toCodedError(
                `Policy pack plugin '${modulePath}#${exportName}' failed during initialization: ${toUnknownMessage(cause)}`,
                RUNTIME_SERVICE_LOAD_ERROR_CODE,
                cause
              ),
          })
        : Effect.succeed(exportedValue)
    )
  );
}

function configurePolicyPackPluginEffect(
  env: NodeJS.ProcessEnv = process.env
): Effect.Effect<void, CodedError> {
  return resolvePolicyPackPluginEffect(env).pipe(
    Effect.flatMap((plugin) =>
      plugin === null
        ? Effect.sync(resetPolicyPackPlugin)
        : Effect.try({
            try: () => setPolicyPackPlugin(plugin),
            catch: (cause) =>
              toRuntimeServiceContractError(
                `Policy pack plugin contract is invalid: ${toUnknownMessage(cause)}`
              ),
          })
    ),
    Effect.asVoid
  );
}

function executeCoreOperationEffect(
  operation: string,
  requestBody: unknown
): Effect.Effect<unknown, unknown> {
  return Effect.tryPromise({
    try: async () => await executeCoreOperation(operation, requestBody),
    catch: normalizeCoreExecutionFailure,
  });
}

const hydrateCoreStoreFromSnapshotEffect = (
  snapshot: Record<string, unknown> | null
): Effect.Effect<void, CodedError> =>
  Effect.try({
    try: () => {
      resetStore();
      if (snapshot) {
        importStoreSnapshot(snapshot);
      }
    },
    catch: (cause) =>
      toCodedError(
        `Failed to hydrate runtime snapshot: ${toUnknownMessage(cause)}`,
        RUNTIME_SERVICE_LOAD_ERROR_CODE,
        cause
      ),
  });

const loadPersistedRuntimeSnapshotEffect = (
  binding: SqliteRuntimePersistenceBinding
): Effect.Effect<Record<string, unknown> | null, CodedError> =>
  binding.repository.loadPersistedSnapshot().pipe(
    Effect.flatMap((snapshot) =>
      snapshot === null
        ? Effect.succeed(null)
        : isRuntimeStoreSnapshot(snapshot)
          ? Effect.succeed(snapshot)
          : Effect.fail(
              toRuntimeServiceContractError(
                "Persisted runtime snapshot must decode to the exported store snapshot shape."
              )
            )
    ),
    Effect.mapError((cause) =>
      isCodedError(cause, RUNTIME_SERVICE_CONTRACT_ERROR_CODE) ||
      isCodedError(cause, RUNTIME_SERVICE_LOAD_ERROR_CODE)
        ? cause
        : toCodedError(
            `Failed to load persisted runtime snapshot: ${toUnknownMessage(cause)}`,
            RUNTIME_SERVICE_LOAD_ERROR_CODE,
            cause
          )
    )
  );

const persistRuntimeSnapshotEffect = (
  binding: SqliteRuntimePersistenceBinding
): Effect.Effect<void, CodedError> =>
  binding.repository
    .persistSnapshot(exportStoreSnapshot() as Record<string, unknown>)
    .pipe(
      Effect.mapError((cause) =>
        isCodedError(cause, RUNTIME_SERVICE_CONTRACT_ERROR_CODE) ||
        isCodedError(cause, RUNTIME_SERVICE_LOAD_ERROR_CODE)
          ? cause
          : toCodedError(
              `Failed to persist runtime snapshot: ${toUnknownMessage(cause)}`,
              RUNTIME_SERVICE_LOAD_ERROR_CODE,
              cause
            )
      )
    );

const executeSqliteBackedOperationEffect = (input: {
  readonly binding: SqliteRuntimePersistenceBinding;
  readonly operation: string;
  readonly requestBody: unknown;
}): Effect.Effect<unknown, CodedError> =>
  Effect.gen(function* () {
    const snapshot = yield* loadPersistedRuntimeSnapshotEffect(input.binding);
    yield* hydrateCoreStoreFromSnapshotEffect(snapshot);
    const result = yield* executeCoreOperationEffect(
      input.operation,
      input.requestBody
    ).pipe(
      Effect.mapError((cause) =>
        isCodedErrorLike(cause)
          ? toCodedError(cause.message, cause.code, cause)
          : Predicate.isError(cause)
            ? toCodedError(toUnknownMessage(cause), "UMS_RUNTIME_ERROR", cause)
            : toCodedError(
                `Runtime persistence execution failed: ${toUnknownMessage(cause)}`,
                RUNTIME_SERVICE_LOAD_ERROR_CODE,
                cause
              )
      )
    );
    yield* persistRuntimeSnapshotEffect(input.binding);
    return result;
  });

function createDefaultRuntimeService() {
  return {
    source: "effect-runtime-service",
    listOperations(_options?: { env?: NodeJS.ProcessEnv }) {
      return listCoreOperations();
    },
    async executeOperation({
      operation,
      requestBody,
      stateFile = DEFAULT_RUNTIME_STATE_FILE,
      env = process.env,
    }: {
      operation: string;
      requestBody?: unknown;
      stateFile?: string | null;
      env?: NodeJS.ProcessEnv;
    }) {
      const normalizedOperation = normalizeOperationName(operation);
      await Effect.runPromise(configurePolicyPackPluginEffect(env));
      if (shouldUseSharedStateCompatibility(stateFile)) {
        return executeOperationWithSharedState({
          operation: normalizedOperation,
          stateFile,
          executor: () =>
            Effect.runPromise(
              executeCoreOperationEffect(normalizedOperation, requestBody)
            ),
        });
      }
      const runtimePersistenceBinding = await Effect.runPromise(
        resolveRuntimePersistenceBinding(stateFile)
      );
      if (runtimePersistenceBinding.mode === "noop") {
        return Effect.runPromise(
          runtimePersistenceBinding.service.execute({
            operation: normalizedOperation,
            requestBody,
            scopeKey: deriveRuntimePersistenceScopeKey(requestBody),
            execute: () =>
              Effect.runPromise(
                executeCoreOperationEffect(normalizedOperation, requestBody)
              ),
          })
        );
      }
      return Effect.runPromise(
        withSharedStateLockEffect({
          stateFile: stateFile === ":memory:" ? null : stateFile,
          effect: executeSqliteBackedOperationEffect({
            binding: runtimePersistenceBinding,
            operation: normalizedOperation,
            requestBody,
          }),
        })
      );
    },
  };
}

type RuntimeServiceValue = ReturnType<typeof createDefaultRuntimeService>;

export const RuntimeServiceTag = ServiceMap.Service<RuntimeServiceValue>(
  "@ums/api/RuntimeService"
);

function assertRuntimeService(
  service: unknown,
  source: string
): RuntimeServiceValue {
  if (!isRuntimeServiceCandidate(service)) {
    throw toRuntimeServiceContractError(
      `Runtime service '${source}' must resolve to an object.`
    );
  }
  if (!Predicate.isFunction(service.listOperations)) {
    throw toRuntimeServiceContractError(
      `Runtime service '${source}' must expose listOperations().`
    );
  }
  if (!Predicate.isFunction(service.executeOperation)) {
    throw toRuntimeServiceContractError(
      `Runtime service '${source}' must expose executeOperation().`
    );
  }
  return service as RuntimeServiceValue;
}

function getRuntimeServiceConfig(env: NodeJS.ProcessEnv = process.env): {
  modulePath: string;
  exportName: string;
} {
  return {
    modulePath:
      asNonEmptyString(env["UMS_RUNTIME_SERVICE_MODULE"]) ??
      DEFAULT_RUNTIME_SERVICE_MODULE,
    exportName:
      asNonEmptyString(env["UMS_RUNTIME_SERVICE_EXPORT"]) ??
      DEFAULT_RUNTIME_SERVICE_EXPORT,
  };
}

async function resolveRuntimeServiceFromModule(config: {
  modulePath: string;
  exportName: string;
}): Promise<RuntimeServiceValue> {
  const runtimeModule =
    config.modulePath === DEFAULT_RUNTIME_SERVICE_MODULE
      ? ({
          [DEFAULT_RUNTIME_SERVICE_EXPORT]: createDefaultRuntimeService,
          default: createDefaultRuntimeService,
        } satisfies Record<string, unknown>)
      : await Effect.runPromise(
          Effect.tryPromise({
            try: () =>
              import(toModuleSpecifier(config.modulePath)) as Promise<
                Record<string, unknown>
              >,
            catch: (cause) => toRuntimeServiceLoadError(config, cause),
          })
        );

  const exportedValue = await Effect.runPromise(
    resolveModuleExport(runtimeModule, {
      modulePath: config.modulePath,
      exportName: config.exportName,
      defaultExportName: DEFAULT_RUNTIME_SERVICE_EXPORT,
      subject: "Runtime service",
    })
  );

  const maybeService = Predicate.isFunction(exportedValue)
    ? await Effect.runPromise(
        Effect.tryPromise({
          try: () =>
            Promise.resolve(
              exportedValue() as
                | RuntimeServiceValue
                | Promise<RuntimeServiceValue>
            ),
          catch: (cause) => toRuntimeServiceLoadError(config, cause),
        })
      )
    : exportedValue;

  return assertRuntimeService(
    maybeService,
    `${config.modulePath}#${config.exportName}`
  );
}

function makeRuntimeServiceCacheKey(config: {
  modulePath: string;
  exportName: string;
}): string {
  return `${config.modulePath}#${config.exportName}`;
}

function toRuntimeServiceLoadError(
  config: { modulePath: string; exportName: string },
  error: unknown
): CodedError {
  if (isCodedError(error, RUNTIME_SERVICE_CONTRACT_ERROR_CODE)) {
    return error;
  }
  return toCodedError(
    `Failed to load runtime service '${config.modulePath}#${config.exportName}': ${toUnknownMessage(error)}`,
    RUNTIME_SERVICE_LOAD_ERROR_CODE,
    error
  );
}

export function resolveRuntimeService({
  env = process.env,
  reload = false,
}: {
  env?: NodeJS.ProcessEnv;
  reload?: boolean;
} = {}): Promise<RuntimeServiceValue> {
  const config = getRuntimeServiceConfig(env);
  const cacheKey = makeRuntimeServiceCacheKey(config);

  if (
    !reload &&
    cachedRuntimeServicePromise !== undefined &&
    cachedRuntimeServiceKey === cacheKey
  ) {
    return cachedRuntimeServicePromise;
  }

  const nextRuntimeServicePromise = Effect.runPromise(
    Effect.tryPromise({
      try: () => resolveRuntimeServiceFromModule(config),
      catch: (error) => {
        cachedRuntimeServiceKey = undefined;
        cachedRuntimeServicePromise = undefined;
        return toRuntimeServiceLoadError(config, error);
      },
    })
  );

  cachedRuntimeServiceKey = cacheKey;
  cachedRuntimeServicePromise = nextRuntimeServicePromise;
  return nextRuntimeServicePromise;
}

export function clearRuntimeServiceCache(): void {
  cachedRuntimeServiceKey = undefined;
  cachedRuntimeServicePromise = undefined;
  for (const binding of runtimePersistenceBindings.values()) {
    binding.database?.close();
  }
  runtimePersistenceBindings.clear();
}

export function makeRuntimeServiceLayer(
  options: {
    env?: NodeJS.ProcessEnv;
    reload?: boolean;
  } = {}
): Layer.Layer<RuntimeServiceValue, CodedError> {
  const { env = process.env, reload = false } = options;
  return Layer.effect(
    RuntimeServiceTag,
    Effect.tryPromise({
      try: () => resolveRuntimeService({ env, reload }),
      catch: (error) =>
        isCodedError(error, RUNTIME_SERVICE_CONTRACT_ERROR_CODE) ||
        isCodedError(error, RUNTIME_SERVICE_LOAD_ERROR_CODE)
          ? error
          : toCodedError(
              toUnknownMessage(error),
              RUNTIME_SERVICE_LOAD_ERROR_CODE,
              error
            ),
    })
  );
}

function resolveActiveRuntimeLayer(options: {
  env?: NodeJS.ProcessEnv;
  reload?: boolean;
  runtimeLayer?: Layer.Layer<RuntimeServiceValue, unknown>;
}): Layer.Layer<RuntimeServiceValue, unknown> {
  if (options.runtimeLayer !== undefined) {
    return options.runtimeLayer;
  }
  const layerOptions: {
    env?: NodeJS.ProcessEnv;
    reload?: boolean;
  } = {};
  if (options.env !== undefined) {
    layerOptions.env = options.env;
  }
  if (options.reload !== undefined) {
    layerOptions.reload = options.reload;
  }
  return makeRuntimeServiceLayer(layerOptions);
}

export function listRuntimeOperations(
  options: {
    env?: NodeJS.ProcessEnv;
    reload?: boolean;
    runtimeLayer?: Layer.Layer<RuntimeServiceValue, unknown>;
  } = {}
): Promise<string[]> {
  const { env = process.env } = options;
  const effect = Effect.gen(function* () {
    const runtimeService = yield* RuntimeServiceTag;
    const operations = yield* Effect.tryPromise({
      try: () => Promise.resolve(runtimeService.listOperations({ env })),
      catch: (error) =>
        isCodedError(error, RUNTIME_SERVICE_CONTRACT_ERROR_CODE) ||
        isCodedError(error, RUNTIME_SERVICE_LOAD_ERROR_CODE)
          ? error
          : toCodedError(
              toUnknownMessage(error),
              RUNTIME_SERVICE_CONTRACT_ERROR_CODE,
              error
            ),
    });
    if (!isUnknownArray(operations)) {
      return yield* Effect.fail(
        toRuntimeServiceContractError(
          "Runtime service listOperations() must return an array."
        )
      );
    }
    return operations
      .map((entry) => normalizeOperationName(entry))
      .filter(Boolean);
  });

  return Effect.runPromise(
    effect.pipe(Effect.provide(resolveActiveRuntimeLayer(options)))
  );
}

export function executeRuntimeOperation(
  options: {
    operation?: unknown;
    requestBody?: unknown;
    stateFile?: string | null;
    env?: NodeJS.ProcessEnv;
    reload?: boolean;
    runtimeLayer?: Layer.Layer<RuntimeServiceValue, unknown>;
  } = {}
): Promise<unknown> {
  const {
    operation,
    requestBody,
    stateFile = DEFAULT_RUNTIME_STATE_FILE,
    env = process.env,
  } = options;

  const effect = Effect.gen(function* () {
    const runtimeService = yield* RuntimeServiceTag;
    return yield* Effect.tryPromise({
      try: () =>
        Promise.resolve(
          runtimeService.executeOperation({
            operation: normalizeOperationName(operation),
            requestBody,
            stateFile,
            env,
          })
        ),
      catch: (error) =>
        isCodedError(error, RUNTIME_SERVICE_CONTRACT_ERROR_CODE) ||
        isCodedError(error, RUNTIME_SERVICE_LOAD_ERROR_CODE)
          ? (error as CodedError)
          : error,
    });
  });

  return Effect.runPromise(
    effect.pipe(Effect.provide(resolveActiveRuntimeLayer(options)))
  );
}

export function loadRuntimeStoreSnapshot(
  options: {
    stateFile?: string | null;
    env?: NodeJS.ProcessEnv;
    reload?: boolean;
    runtimeLayer?: Layer.Layer<RuntimeServiceValue, unknown>;
  } = {}
): Promise<Record<string, unknown>> {
  const { stateFile = DEFAULT_RUNTIME_STATE_FILE, env = process.env } = options;

  const effect = Effect.gen(function* () {
    const runtimeService = yield* RuntimeServiceTag;

    if (shouldUseSharedStateCompatibility(stateFile)) {
      const snapshot = yield* Effect.tryPromise({
        try: () =>
          Promise.resolve(
            runtimeService.executeOperation({
              operation: "runtime_snapshot_export",
              requestBody: {},
              stateFile,
              env,
            })
          ),
        catch: (error) =>
          isCodedError(error, RUNTIME_SERVICE_CONTRACT_ERROR_CODE) ||
          isCodedError(error, RUNTIME_SERVICE_LOAD_ERROR_CODE)
            ? (error as CodedError)
            : error,
      });

      if (!isRuntimeStoreSnapshot(snapshot)) {
        return yield* Effect.fail(
          toRuntimeServiceContractError(
            "Runtime snapshot export must return the exported store snapshot shape."
          )
        );
      }

      return snapshot;
    }

    const runtimePersistenceBinding =
      yield* resolveRuntimePersistenceBinding(stateFile);

    if (runtimePersistenceBinding.mode === "sqlite") {
      const snapshot = yield* loadPersistedRuntimeSnapshotEffect(
        runtimePersistenceBinding
      );
      return snapshot ?? { stores: {} };
    }

    const snapshot = yield* Effect.tryPromise({
      try: () =>
        Promise.resolve(
          runtimeService.executeOperation({
            operation: "runtime_snapshot_export",
            requestBody: {},
            stateFile,
            env,
          })
        ),
      catch: (error) =>
        isCodedError(error, RUNTIME_SERVICE_CONTRACT_ERROR_CODE) ||
        isCodedError(error, RUNTIME_SERVICE_LOAD_ERROR_CODE)
          ? (error as CodedError)
          : error,
    });

    if (!isRuntimeStoreSnapshot(snapshot)) {
      return yield* Effect.fail(
        toRuntimeServiceContractError(
          "Runtime snapshot export must return the exported store snapshot shape."
        )
      );
    }

    return snapshot;
  });

  return Effect.runPromise(
    effect.pipe(Effect.provide(resolveActiveRuntimeLayer(options)))
  );
}
