import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  executeOperation,
  listOperations,
  resetPolicyPackPlugin,
  setPolicyPackPlugin,
} from "./core.ts";
import { executeOperationWithSharedState } from "./persistence.ts";

const DEFAULT_POLICY_PACK_PLUGIN_EXPORT = "createPolicyPackPlugin";
const RUNTIME_ADAPTER_LOAD_ERROR_CODE = "RUNTIME_ADAPTER_LOAD_ERROR";
const RUNTIME_ADAPTER_CONTRACT_ERROR_CODE = "RUNTIME_ADAPTER_CONTRACT_ERROR";

type CodedError = Error & {
  code: string;
  cause?: unknown;
};

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeOperationName(operation: unknown): string {
  return String(operation ?? "")
    .trim()
    .toLowerCase();
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
      RUNTIME_ADAPTER_LOAD_ERROR_CODE,
      error
    );
  }

  const exportedValue =
    pluginModule[exportName] ??
    (exportName === DEFAULT_POLICY_PACK_PLUGIN_EXPORT
      ? pluginModule["default"]
      : undefined);

  if (exportedValue === null || exportedValue === undefined) {
    throw toCodedError(
      `Policy pack plugin module '${modulePath}' does not export '${exportName}'.`,
      RUNTIME_ADAPTER_CONTRACT_ERROR_CODE
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
    throw toCodedError(
      `Policy pack plugin contract is invalid: ${
        error instanceof Error ? error.message : String(error)
      }`,
      RUNTIME_ADAPTER_CONTRACT_ERROR_CODE,
      error
    );
  }
}

export function createRuntimeAdapter() {
  return {
    source: "effect-runtime-adapter",
    listOperations() {
      return listOperations();
    },
    async executeOperation({
      operation,
      requestBody,
      stateFile,
      env = process.env,
    }: {
      operation?: unknown;
      requestBody?: unknown;
      stateFile?: string | null;
      env?: NodeJS.ProcessEnv;
    }) {
      const normalizedOperation = normalizeOperationName(operation);
      await configurePolicyPackPlugin(env);
      return executeOperationWithSharedState({
        operation: normalizedOperation,
        stateFile,
        executor: () => executeOperation(normalizedOperation, requestBody),
      });
    },
  };
}

export default createRuntimeAdapter;
