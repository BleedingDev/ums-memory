import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createRuntimeAdapter as createEffectRuntimeAdapter } from "./effect-runtime-adapter.ts";
import { DEFAULT_SHARED_STATE_FILE } from "./persistence.ts";

export const DEFAULT_RUNTIME_ADAPTER_EXPORT = "createRuntimeAdapter";
export const DEFAULT_RUNTIME_ADAPTER_MODULE = "builtin:effect-runtime-adapter";
export const DEFAULT_RUNTIME_STATE_FILE = DEFAULT_SHARED_STATE_FILE;
export const DEFAULT_POLICY_PACK_PLUGIN_EXPORT = "createPolicyPackPlugin";

const RUNTIME_ADAPTER_LOAD_ERROR_CODE = "RUNTIME_ADAPTER_LOAD_ERROR";
const RUNTIME_ADAPTER_CONTRACT_ERROR_CODE = "RUNTIME_ADAPTER_CONTRACT_ERROR";

type CodedError = Error & {
  code: string;
  cause?: unknown;
};

type RuntimeAdapterValue = ReturnType<typeof assertRuntimeAdapter>;

let cachedRuntimeAdapterKey: string | undefined;
let cachedRuntimeAdapterPromise: Promise<RuntimeAdapterValue> | undefined;

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

function getRuntimeAdapterConfig(env: NodeJS.ProcessEnv = process.env): {
  modulePath: string;
  exportName: string;
} {
  return {
    modulePath:
      asNonEmptyString(env["UMS_RUNTIME_ADAPTER_MODULE"]) ??
      DEFAULT_RUNTIME_ADAPTER_MODULE,
    exportName:
      asNonEmptyString(env["UMS_RUNTIME_ADAPTER_EXPORT"]) ??
      DEFAULT_RUNTIME_ADAPTER_EXPORT,
  };
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

function toContractError(message: string): CodedError {
  return toCodedError(message, RUNTIME_ADAPTER_CONTRACT_ERROR_CODE);
}

function assertRuntimeAdapter(
  adapter: unknown,
  source: string
): {
  source?: string;
  listOperations: (
    options?: { env?: NodeJS.ProcessEnv } | undefined
  ) => Promise<unknown> | unknown;
  executeOperation: (options: {
    operation: string;
    requestBody?: unknown;
    stateFile?: string | null;
    env?: NodeJS.ProcessEnv;
  }) => Promise<unknown> | unknown;
} {
  if (typeof adapter !== "object" || adapter === null) {
    throw toContractError(
      `Runtime adapter '${source}' must resolve to an object.`
    );
  }

  const candidate = adapter as {
    source?: string;
    listOperations?: unknown;
    executeOperation?: unknown;
  };
  if (typeof candidate.listOperations !== "function") {
    throw toContractError(
      `Runtime adapter '${source}' must expose listOperations().`
    );
  }
  if (typeof candidate.executeOperation !== "function") {
    throw toContractError(
      `Runtime adapter '${source}' must expose executeOperation().`
    );
  }

  return candidate as RuntimeAdapterValue;
}

async function resolveRuntimeAdapterFromModule(config: {
  modulePath: string;
  exportName: string;
}): Promise<RuntimeAdapterValue> {
  let runtimeModule: Record<string, unknown>;
  if (config.modulePath === DEFAULT_RUNTIME_ADAPTER_MODULE) {
    runtimeModule = {
      [DEFAULT_RUNTIME_ADAPTER_EXPORT]: createEffectRuntimeAdapter,
      default: createEffectRuntimeAdapter,
    };
  } else {
    const moduleSpecifier = toModuleSpecifier(config.modulePath);
    runtimeModule = (await import(moduleSpecifier)) as Record<string, unknown>;
  }
  const exportedValue =
    runtimeModule[config.exportName] ??
    (config.exportName === DEFAULT_RUNTIME_ADAPTER_EXPORT
      ? runtimeModule["default"]
      : undefined);

  if (exportedValue === null || exportedValue === undefined) {
    throw toContractError(
      `Runtime adapter module '${config.modulePath}' does not export '${config.exportName}'.`
    );
  }

  const maybeAdapter =
    typeof exportedValue === "function"
      ? await (
          exportedValue as () =>
            | RuntimeAdapterValue
            | Promise<RuntimeAdapterValue>
        )()
      : exportedValue;

  return assertRuntimeAdapter(
    maybeAdapter,
    `${config.modulePath}#${config.exportName}`
  );
}

function makeRuntimeAdapterCacheKey(config: {
  modulePath: string;
  exportName: string;
}): string {
  return `${config.modulePath}#${config.exportName}`;
}

function toAdapterLoadError(
  config: { modulePath: string; exportName: string },
  error: unknown
): CodedError {
  if (isCodedError(error, RUNTIME_ADAPTER_CONTRACT_ERROR_CODE)) {
    return error as CodedError;
  }
  return toCodedError(
    `Failed to load runtime adapter '${config.modulePath}#${config.exportName}': ${
      error instanceof Error ? error.message : String(error)
    }`,
    RUNTIME_ADAPTER_LOAD_ERROR_CODE,
    error
  );
}

export function resolveRuntimeAdapter({
  env = process.env,
  reload = false,
}: {
  env?: NodeJS.ProcessEnv;
  reload?: boolean;
} = {}): Promise<RuntimeAdapterValue> {
  const config = getRuntimeAdapterConfig(env);
  const cacheKey = makeRuntimeAdapterCacheKey(config);

  if (
    !reload &&
    cachedRuntimeAdapterPromise !== undefined &&
    cachedRuntimeAdapterKey === cacheKey
  ) {
    return cachedRuntimeAdapterPromise;
  }

  const nextAdapterPromise = (async () => {
    try {
      return await resolveRuntimeAdapterFromModule(config);
    } catch (error) {
      cachedRuntimeAdapterKey = undefined;
      cachedRuntimeAdapterPromise = undefined;
      throw toAdapterLoadError(config, error);
    }
  })();

  cachedRuntimeAdapterKey = cacheKey;
  cachedRuntimeAdapterPromise = nextAdapterPromise;
  return nextAdapterPromise;
}

export async function listRuntimeOperations(
  options: {
    env?: NodeJS.ProcessEnv;
    reload?: boolean;
  } = {}
): Promise<string[]> {
  const { env = process.env, reload = false } = options;
  const adapter = await resolveRuntimeAdapter({ env, reload });
  const operations = await adapter.listOperations({ env });
  if (!Array.isArray(operations)) {
    throw toContractError(
      "Runtime adapter listOperations() must return an array."
    );
  }
  return operations
    .map((entry) => normalizeOperationName(entry))
    .filter(Boolean);
}

export async function executeRuntimeOperation(
  options: {
    operation?: unknown;
    requestBody?: unknown;
    stateFile?: string | null;
    env?: NodeJS.ProcessEnv;
    reload?: boolean;
  } = {}
): Promise<unknown> {
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
    env,
  });
}

export function clearRuntimeAdapterCache(): void {
  cachedRuntimeAdapterKey = undefined;
  cachedRuntimeAdapterPromise = undefined;
}
