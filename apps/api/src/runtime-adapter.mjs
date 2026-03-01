import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { executeOperation, listOperations } from "./core.mjs";
import { DEFAULT_SHARED_STATE_FILE, executeOperationWithSharedState } from "./persistence.mjs";

export const DEFAULT_RUNTIME_ADAPTER_EXPORT = "createRuntimeAdapter";
export const DEFAULT_RUNTIME_STATE_FILE = DEFAULT_SHARED_STATE_FILE;

const RUNTIME_ADAPTER_LOAD_ERROR_CODE = "RUNTIME_ADAPTER_LOAD_ERROR";
const RUNTIME_ADAPTER_CONTRACT_ERROR_CODE = "RUNTIME_ADAPTER_CONTRACT_ERROR";
const LEGACY_RUNTIME_ADAPTER_SOURCE = "legacy-core-persistence";
const LEGACY_RUNTIME_ADAPTER = Object.freeze({
  source: LEGACY_RUNTIME_ADAPTER_SOURCE,
  listOperations() {
    return listOperations();
  },
  async executeOperation({ operation, requestBody, stateFile = DEFAULT_RUNTIME_STATE_FILE }) {
    return executeOperationWithSharedState({
      operation,
      stateFile,
      executor: () => executeOperation(operation, requestBody),
    });
  },
});

let cachedRuntimeAdapterKey;
let cachedRuntimeAdapterPromise;

function asNonEmptyString(value) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized ? normalized : null;
}

function getRuntimeAdapterConfig(env = process.env) {
  return {
    modulePath: asNonEmptyString(env.UMS_RUNTIME_ADAPTER_MODULE),
    exportName: asNonEmptyString(env.UMS_RUNTIME_ADAPTER_EXPORT) ?? DEFAULT_RUNTIME_ADAPTER_EXPORT,
  };
}

function toModuleSpecifier(modulePath) {
  if (modulePath.startsWith(".") || modulePath.startsWith("/") || isAbsolute(modulePath)) {
    const absolutePath = isAbsolute(modulePath) ? modulePath : resolve(process.cwd(), modulePath);
    return pathToFileURL(absolutePath).href;
  }
  return modulePath;
}

function normalizeOperationName(operation) {
  return String(operation ?? "").trim().toLowerCase();
}

function toContractError(message) {
  const error = new TypeError(message);
  error.code = RUNTIME_ADAPTER_CONTRACT_ERROR_CODE;
  return error;
}

function assertRuntimeAdapter(adapter, source) {
  if (!adapter || typeof adapter !== "object") {
    throw toContractError(`Runtime adapter '${source}' must resolve to an object.`);
  }
  if (typeof adapter.listOperations !== "function") {
    throw toContractError(`Runtime adapter '${source}' must expose listOperations().`);
  }
  if (typeof adapter.executeOperation !== "function") {
    throw toContractError(`Runtime adapter '${source}' must expose executeOperation().`);
  }
  return adapter;
}

async function resolveRuntimeAdapterFromModule({ modulePath, exportName }) {
  const moduleSpecifier = toModuleSpecifier(modulePath);
  const runtimeModule = await import(moduleSpecifier);
  const exportedValue =
    runtimeModule[exportName] ??
    (exportName === DEFAULT_RUNTIME_ADAPTER_EXPORT ? runtimeModule.default : undefined);

  if (exportedValue == null) {
    throw toContractError(
      `Runtime adapter module '${modulePath}' does not export '${exportName}'.`,
    );
  }

  const maybeAdapter =
    typeof exportedValue === "function"
      ? await exportedValue({
          createLegacyRuntimeAdapter,
          defaultStateFile: DEFAULT_RUNTIME_STATE_FILE,
        })
      : exportedValue;

  return assertRuntimeAdapter(maybeAdapter, `${modulePath}#${exportName}`);
}

function makeCacheKey({ modulePath, exportName }) {
  return `${modulePath ?? LEGACY_RUNTIME_ADAPTER_SOURCE}#${exportName}`;
}

function toAdapterLoadError(config, error) {
  if (error && typeof error === "object" && error.code === RUNTIME_ADAPTER_CONTRACT_ERROR_CODE) {
    return error;
  }
  const wrapped = new Error(
    `Failed to load runtime adapter '${config.modulePath}#${config.exportName}': ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  wrapped.code = RUNTIME_ADAPTER_LOAD_ERROR_CODE;
  wrapped.cause = error;
  return wrapped;
}

export function createLegacyRuntimeAdapter() {
  return LEGACY_RUNTIME_ADAPTER;
}

export async function resolveRuntimeAdapter({ env = process.env, reload = false } = {}) {
  const config = getRuntimeAdapterConfig(env);
  const cacheKey = makeCacheKey(config);

  if (!reload && cachedRuntimeAdapterPromise && cachedRuntimeAdapterKey === cacheKey) {
    return cachedRuntimeAdapterPromise;
  }

  const nextAdapterPromise = (async () => {
    if (!config.modulePath) {
      return LEGACY_RUNTIME_ADAPTER;
    }
    try {
      return await resolveRuntimeAdapterFromModule(config);
    } catch (error) {
      throw toAdapterLoadError(config, error);
    }
  })();

  cachedRuntimeAdapterKey = cacheKey;
  cachedRuntimeAdapterPromise = nextAdapterPromise;
  return nextAdapterPromise;
}

/**
 * @param {{ env?: NodeJS.ProcessEnv, reload?: boolean }} [options]
 */
export async function listRuntimeOperations(options = {}) {
  const {
    env = process.env,
    reload = false,
  } = options;
  const adapter = await resolveRuntimeAdapter({ env, reload });
  const operations = await adapter.listOperations();
  if (!Array.isArray(operations)) {
    throw toContractError("Runtime adapter listOperations() must return an array.");
  }
  return operations.map(normalizeOperationName).filter(Boolean);
}

/**
 * @param {{
 *   operation?: string,
 *   requestBody?: unknown,
 *   stateFile?: string | null,
 *   env?: NodeJS.ProcessEnv,
 *   reload?: boolean
 * }} [options]
 */
export async function executeRuntimeOperation(options = {}) {
  const {
    operation,
    requestBody,
    stateFile = DEFAULT_RUNTIME_STATE_FILE,
    env = process.env,
    reload = false,
  } = options;
  const adapter = await resolveRuntimeAdapter({ env, reload });
  return adapter.executeOperation({
    operation: normalizeOperationName(operation),
    requestBody,
    stateFile,
  });
}

export function clearRuntimeAdapterCache() {
  cachedRuntimeAdapterKey = undefined;
  cachedRuntimeAdapterPromise = undefined;
}
