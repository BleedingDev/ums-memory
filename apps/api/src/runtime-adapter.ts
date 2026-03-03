import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  executeOperation,
  listOperations,
  resetPolicyPackPlugin,
  setPolicyPackPlugin,
} from "./core.ts";
import {
  DEFAULT_SHARED_STATE_FILE,
  executeOperationWithSharedState,
} from "./persistence.ts";

export const DEFAULT_RUNTIME_ADAPTER_EXPORT = "createRuntimeAdapter";
export const DEFAULT_RUNTIME_STATE_FILE = DEFAULT_SHARED_STATE_FILE;
export const DEFAULT_POLICY_PACK_PLUGIN_EXPORT = "createPolicyPackPlugin";

const RUNTIME_ADAPTER_LOAD_ERROR_CODE = "RUNTIME_ADAPTER_LOAD_ERROR";
const RUNTIME_ADAPTER_CONTRACT_ERROR_CODE = "RUNTIME_ADAPTER_CONTRACT_ERROR";
const LEGACY_RUNTIME_ADAPTER_SOURCE = "legacy-core-persistence";

interface RuntimeAdapterConfig {
  modulePath: string | null;
  exportName: string;
}

interface RuntimeAdapterListOptions {
  env?: NodeJS.ProcessEnv;
}

interface RuntimeAdapterExecuteOptions {
  operation?: unknown;
  requestBody?: unknown;
  stateFile?: string | null;
  env?: NodeJS.ProcessEnv;
  reload?: boolean;
}

interface RuntimeAdapter {
  source?: string;
  listOperations: (
    options?: RuntimeAdapterListOptions
  ) => Promise<unknown> | unknown;
  executeOperation: (
    options: {
      operation: string;
      requestBody?: unknown;
      stateFile?: string | null;
      env?: NodeJS.ProcessEnv;
    }
  ) => Promise<unknown> | unknown;
}

interface RuntimeAdapterFactoryInput {
  createLegacyRuntimeAdapter: () => RuntimeAdapter;
  defaultStateFile: string;
}

interface ResolveRuntimeAdapterOptions {
  env?: NodeJS.ProcessEnv;
  reload?: boolean;
}

interface CodedError extends Error {
  code: string;
  cause?: unknown;
}

interface PolicyPackPluginConfig {
  modulePath: string | null;
  exportName: string;
}

const LEGACY_RUNTIME_ADAPTER: RuntimeAdapter = Object.freeze({
  source: LEGACY_RUNTIME_ADAPTER_SOURCE,
  async listOperations({ env = process.env }: RuntimeAdapterListOptions = {}) {
    await configureLegacyPolicyPackPlugin(env);
    return listOperations();
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
    await configureLegacyPolicyPackPlugin(env);
    return executeOperationWithSharedState({
      operation,
      stateFile,
      executor: () => executeOperation(operation, requestBody),
    });
  },
});

let cachedRuntimeAdapterKey: string | undefined;
let cachedRuntimeAdapterPromise: Promise<RuntimeAdapter> | undefined;
let cachedPolicyPackPluginKey: string | undefined;
let cachedPolicyPackPluginPromise: Promise<void> | undefined;

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

function getRuntimeAdapterConfig(
  env: NodeJS.ProcessEnv = process.env
): RuntimeAdapterConfig {
  return {
    modulePath: asNonEmptyString(env["UMS_RUNTIME_ADAPTER_MODULE"]),
    exportName:
      asNonEmptyString(env["UMS_RUNTIME_ADAPTER_EXPORT"]) ??
      DEFAULT_RUNTIME_ADAPTER_EXPORT,
  };
}

function getPolicyPackPluginConfig(
  env: NodeJS.ProcessEnv = process.env
): PolicyPackPluginConfig {
  return {
    modulePath: asNonEmptyString(env["UMS_POLICY_PACK_PLUGIN_MODULE"]),
    exportName:
      asNonEmptyString(env["UMS_POLICY_PACK_PLUGIN_EXPORT"]) ??
      DEFAULT_POLICY_PACK_PLUGIN_EXPORT,
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

function assertRuntimeAdapter(adapter: unknown, source: string): RuntimeAdapter {
  if (typeof adapter !== "object" || adapter === null) {
    throw toContractError(
      `Runtime adapter '${source}' must resolve to an object.`
    );
  }

  const candidate = adapter as Partial<RuntimeAdapter>;
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

  return candidate as RuntimeAdapter;
}

async function resolveRuntimeAdapterFromModule(
  config: RuntimeAdapterConfig
): Promise<RuntimeAdapter> {
  if (config.modulePath === null) {
    return LEGACY_RUNTIME_ADAPTER;
  }

  const moduleSpecifier = toModuleSpecifier(config.modulePath);
  const runtimeModule = (await import(moduleSpecifier)) as Record<
    string,
    unknown
  >;
  const exportedValue =
    runtimeModule[config.exportName] ??
    (config.exportName === DEFAULT_RUNTIME_ADAPTER_EXPORT
      ? runtimeModule["default"]
      : undefined);

  if (exportedValue == null) {
    throw toContractError(
      `Runtime adapter module '${config.modulePath}' does not export '${config.exportName}'.`
    );
  }

  const maybeAdapter =
    typeof exportedValue === "function"
      ? await (
          exportedValue as (
            input: RuntimeAdapterFactoryInput
          ) => RuntimeAdapter | Promise<RuntimeAdapter>
        )({
          createLegacyRuntimeAdapter,
          defaultStateFile: DEFAULT_RUNTIME_STATE_FILE,
        })
      : exportedValue;

  return assertRuntimeAdapter(
    maybeAdapter,
    `${config.modulePath}#${config.exportName}`
  );
}

function makeRuntimeAdapterCacheKey(config: RuntimeAdapterConfig): string {
  return `${config.modulePath ?? LEGACY_RUNTIME_ADAPTER_SOURCE}#${config.exportName}`;
}

function makePolicyPackPluginCacheKey(config: PolicyPackPluginConfig): string {
  return `${config.modulePath ?? "noop-policy-pack-plugin"}#${config.exportName}`;
}

function toAdapterLoadError(
  config: RuntimeAdapterConfig,
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

function toPolicyPackPluginLoadError(
  config: PolicyPackPluginConfig,
  error: unknown
): CodedError {
  if (isCodedError(error, RUNTIME_ADAPTER_CONTRACT_ERROR_CODE)) {
    return error as CodedError;
  }
  return toCodedError(
    `Failed to load policy pack plugin '${config.modulePath}#${config.exportName}': ${
      error instanceof Error ? error.message : String(error)
    }`,
    RUNTIME_ADAPTER_LOAD_ERROR_CODE,
    error
  );
}

async function resolvePolicyPackPluginFromModule(
  config: PolicyPackPluginConfig
): Promise<unknown> {
  if (config.modulePath === null) {
    return undefined;
  }

  const moduleSpecifier = toModuleSpecifier(config.modulePath);
  const pluginModule = (await import(moduleSpecifier)) as Record<
    string,
    unknown
  >;
  const exportedValue =
    pluginModule[config.exportName] ??
    (config.exportName === DEFAULT_POLICY_PACK_PLUGIN_EXPORT
      ? pluginModule["default"]
      : undefined);

  if (exportedValue == null) {
    throw toContractError(
      `Policy pack plugin module '${config.modulePath}' does not export '${config.exportName}'.`
    );
  }

  if (typeof exportedValue === "function") {
    return await (exportedValue as () => Promise<unknown> | unknown)();
  }
  return exportedValue;
}

async function configureLegacyPolicyPackPlugin(
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const config = getPolicyPackPluginConfig(env);
  const cacheKey = makePolicyPackPluginCacheKey(config);
  if (
    cachedPolicyPackPluginPromise !== undefined &&
    cachedPolicyPackPluginKey === cacheKey
  ) {
    return cachedPolicyPackPluginPromise;
  }

  const configurePromise = (async () => {
    if (config.modulePath === null) {
      resetPolicyPackPlugin();
      return;
    }

    try {
      const plugin = await resolvePolicyPackPluginFromModule(config);
      setPolicyPackPlugin(plugin);
    } catch (error) {
      resetPolicyPackPlugin();
      throw toPolicyPackPluginLoadError(config, error);
    }
  })();

  cachedPolicyPackPluginKey = cacheKey;
  cachedPolicyPackPluginPromise = configurePromise.catch((error: unknown) => {
    cachedPolicyPackPluginKey = undefined;
    cachedPolicyPackPluginPromise = undefined;
    throw error;
  });
  return cachedPolicyPackPluginPromise;
}

export function createLegacyRuntimeAdapter(): RuntimeAdapter {
  return LEGACY_RUNTIME_ADAPTER;
}

export async function resolveRuntimeAdapter(
  { env = process.env, reload = false }: ResolveRuntimeAdapterOptions = {}
): Promise<RuntimeAdapter> {
  const config = getRuntimeAdapterConfig(env);
  const cacheKey = makeRuntimeAdapterCacheKey(config);

  if (reload) {
    cachedPolicyPackPluginKey = undefined;
    cachedPolicyPackPluginPromise = undefined;
  }

  if (
    !reload &&
    cachedRuntimeAdapterPromise !== undefined &&
    cachedRuntimeAdapterKey === cacheKey
  ) {
    return cachedRuntimeAdapterPromise;
  }

  const nextAdapterPromise = (async () => {
    if (config.modulePath === null) {
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

export async function listRuntimeOperations(
  options: ResolveRuntimeAdapterOptions = {}
): Promise<string[]> {
  const { env = process.env, reload = false } = options;
  const adapter = await resolveRuntimeAdapter({ env, reload });
  const operations = await adapter.listOperations({ env });
  if (!Array.isArray(operations)) {
    throw toContractError(
      "Runtime adapter listOperations() must return an array."
    );
  }
  return operations.map((entry) => normalizeOperationName(entry)).filter(Boolean);
}

export async function executeRuntimeOperation(
  options: RuntimeAdapterExecuteOptions = {}
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
  cachedPolicyPackPluginKey = undefined;
  cachedPolicyPackPluginPromise = undefined;
}
