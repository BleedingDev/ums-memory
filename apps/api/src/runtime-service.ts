import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { Effect, Layer, ServiceMap } from "effect";

import {
  executeOperation as executeCoreOperation,
  listOperations as listCoreOperations,
  resetPolicyPackPlugin,
  setPolicyPackPlugin,
} from "./core.ts";
import {
  DEFAULT_SHARED_STATE_FILE,
  executeOperationWithSharedState,
} from "./persistence.ts";

// Runtime operation persistence semantics and migration requirements:
// docs/runbooks/runtime-operation-persistence-map.md
// docs/adr/0008-single-runtime-storage-adapter-architecture.md
export const DEFAULT_RUNTIME_SERVICE_EXPORT = "createRuntimeService";
export const DEFAULT_RUNTIME_SERVICE_MODULE = "builtin:effect-runtime-service";
export const DEFAULT_RUNTIME_STATE_FILE = DEFAULT_SHARED_STATE_FILE;
export const DEFAULT_POLICY_PACK_PLUGIN_EXPORT = "createPolicyPackPlugin";
export const RUNTIME_SERVICE_LOAD_ERROR_CODE = "RUNTIME_SERVICE_LOAD_ERROR";
export const RUNTIME_SERVICE_CONTRACT_ERROR_CODE =
  "RUNTIME_SERVICE_CONTRACT_ERROR";

type CodedError = Error & {
  code: string;
  cause?: unknown;
};

let cachedRuntimeServiceKey: string | undefined;
let cachedRuntimeServicePromise:
  | Promise<ReturnType<typeof createDefaultRuntimeService>>
  | undefined;

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
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

function isCodedError(error: unknown, expectedCode: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as CodedError).code === expectedCode
  );
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

async function resolvePolicyPackPlugin(
  env: NodeJS.ProcessEnv
): Promise<unknown | null> {
  const modulePath = asNonEmptyString(env["UMS_POLICY_PACK_PLUGIN_MODULE"]);
  if (!modulePath) {
    return null;
  }
  const exportName =
    asNonEmptyString(env["UMS_POLICY_PACK_PLUGIN_EXPORT"]) ??
    DEFAULT_POLICY_PACK_PLUGIN_EXPORT;

  const moduleSpecifier = toModuleSpecifier(modulePath);
  let pluginModule: Record<string, unknown>;
  try {
    pluginModule = (await import(moduleSpecifier)) as Record<string, unknown>;
  } catch (error) {
    throw toCodedError(
      `Failed to load policy pack plugin '${modulePath}#${exportName}': ${
        error instanceof Error ? error.message : String(error)
      }`,
      RUNTIME_SERVICE_LOAD_ERROR_CODE,
      error
    );
  }

  const exportedValue =
    pluginModule[exportName] ??
    (exportName === DEFAULT_POLICY_PACK_PLUGIN_EXPORT
      ? pluginModule["default"]
      : undefined);

  if (exportedValue === null || exportedValue === undefined) {
    throw toRuntimeServiceContractError(
      `Policy pack plugin module '${modulePath}' does not export '${exportName}'.`
    );
  }

  return typeof exportedValue === "function"
    ? await (exportedValue as () => unknown | Promise<unknown>)()
    : exportedValue;
}

async function configurePolicyPackPlugin(
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const plugin = await resolvePolicyPackPlugin(env);
  if (plugin === null) {
    resetPolicyPackPlugin();
    return;
  }
  try {
    setPolicyPackPlugin(plugin);
  } catch (error) {
    throw toRuntimeServiceContractError(
      `Policy pack plugin contract is invalid: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

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
      await configurePolicyPackPlugin(env);
      return executeOperationWithSharedState({
        operation,
        stateFile,
        executor: () => executeCoreOperation(operation, requestBody),
      });
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
  if (typeof service !== "object" || service === null) {
    throw toRuntimeServiceContractError(
      `Runtime service '${source}' must resolve to an object.`
    );
  }
  const candidate = service as {
    source?: string;
    listOperations?: unknown;
    executeOperation?: unknown;
  };
  if (typeof candidate.listOperations !== "function") {
    throw toRuntimeServiceContractError(
      `Runtime service '${source}' must expose listOperations().`
    );
  }
  if (typeof candidate.executeOperation !== "function") {
    throw toRuntimeServiceContractError(
      `Runtime service '${source}' must expose executeOperation().`
    );
  }
  return candidate as RuntimeServiceValue;
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
  let runtimeModule: Record<string, unknown>;
  if (config.modulePath === DEFAULT_RUNTIME_SERVICE_MODULE) {
    runtimeModule = {
      [DEFAULT_RUNTIME_SERVICE_EXPORT]: createDefaultRuntimeService,
      default: createDefaultRuntimeService,
    };
  } else {
    const moduleSpecifier = toModuleSpecifier(config.modulePath);
    runtimeModule = (await import(moduleSpecifier)) as Record<string, unknown>;
  }

  const exportedValue =
    runtimeModule[config.exportName] ??
    (config.exportName === DEFAULT_RUNTIME_SERVICE_EXPORT
      ? runtimeModule["default"]
      : undefined);
  if (exportedValue === null || exportedValue === undefined) {
    throw toRuntimeServiceContractError(
      `Runtime service module '${config.modulePath}' does not export '${config.exportName}'.`
    );
  }

  const maybeService =
    typeof exportedValue === "function"
      ? await (
          exportedValue as () =>
            | RuntimeServiceValue
            | Promise<RuntimeServiceValue>
        )()
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
    return error as CodedError;
  }
  return toCodedError(
    `Failed to load runtime service '${config.modulePath}#${config.exportName}': ${
      error instanceof Error ? error.message : String(error)
    }`,
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

  const nextRuntimeServicePromise = (async () => {
    try {
      return await resolveRuntimeServiceFromModule(config);
    } catch (error) {
      cachedRuntimeServiceKey = undefined;
      cachedRuntimeServicePromise = undefined;
      throw toRuntimeServiceLoadError(config, error);
    }
  })();

  cachedRuntimeServiceKey = cacheKey;
  cachedRuntimeServicePromise = nextRuntimeServicePromise;
  return nextRuntimeServicePromise;
}

export function clearRuntimeServiceCache(): void {
  cachedRuntimeServiceKey = undefined;
  cachedRuntimeServicePromise = undefined;
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
          ? (error as CodedError)
          : toCodedError(
              error instanceof Error ? error.message : String(error),
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
          ? (error as CodedError)
          : toCodedError(
              error instanceof Error ? error.message : String(error),
              RUNTIME_SERVICE_CONTRACT_ERROR_CODE,
              error
            ),
    });
    if (!Array.isArray(operations)) {
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
