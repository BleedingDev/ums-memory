import { createHash } from "node:crypto";
const SUPPORTED_OPERATIONS = Object.freeze(["context", "ingest"]);

function stableSortObject(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableSortObject);
  }
  if (value && typeof value === "object") {
    const sorted: Record<string, any> = {};
    for (const key of Object.keys(value).sort()) {
      const record = value as Record<string, unknown>;
      sorted[key] = stableSortObject(record[key]);
    }
    return sorted;
  }
  return value;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(stableSortObject(value));
}

function digest(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

interface RuntimeServiceExecuteRequest {
  readonly operation?: unknown;
  readonly requestBody?: unknown;
  readonly stateFile?: unknown;
}

export function createDeterministicRuntimeService() {
  return {
    listOperations() {
      return [...SUPPORTED_OPERATIONS];
    },
    async executeOperation({
      operation,
      requestBody,
      stateFile,
    }: RuntimeServiceExecuteRequest) {
      const normalizedOperation = String(operation ?? "")
        .trim()
        .toLowerCase();
      if (!SUPPORTED_OPERATIONS.includes(normalizedOperation)) {
        const error = new Error(
          `Unsupported operation: ${normalizedOperation}`
        ) as Error & { code?: string };
        error.code = "UNSUPPORTED_OPERATION";
        throw error;
      }
      const normalizedRequest =
        requestBody &&
        typeof requestBody === "object" &&
        !Array.isArray(requestBody)
          ? requestBody
          : {};

      return {
        operation: normalizedOperation,
        runtimeServiceId: "deterministic-runtime-service",
        request: normalizedRequest,
        stateFile: typeof stateFile === "string" ? stateFile : null,
        requestDigest: digest({
          operation: normalizedOperation,
          request: normalizedRequest,
          stateFile: typeof stateFile === "string" ? stateFile : null,
        }),
      };
    },
  };
}
