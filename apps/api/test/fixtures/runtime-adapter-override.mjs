import { createHash } from "node:crypto";

const SUPPORTED_OPERATIONS = Object.freeze(["context", "ingest"]);

function stableSortObject(value) {
  if (Array.isArray(value)) {
    return value.map(stableSortObject);
  }
  if (value && typeof value === "object") {
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = stableSortObject(value[key]);
    }
    return sorted;
  }
  return value;
}

function stableStringify(value) {
  return JSON.stringify(stableSortObject(value));
}

function digest(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

export function createDeterministicRuntimeAdapter() {
  return {
    listOperations() {
      return [...SUPPORTED_OPERATIONS];
    },
    async executeOperation({ operation, requestBody, stateFile }) {
      const normalizedOperation = String(operation ?? "").trim().toLowerCase();
      if (!SUPPORTED_OPERATIONS.includes(normalizedOperation)) {
        const error = new Error(`Unsupported operation: ${normalizedOperation}`);
        error.code = "UNSUPPORTED_OPERATION";
        throw error;
      }
      const normalizedRequest =
        requestBody && typeof requestBody === "object" && !Array.isArray(requestBody) ? requestBody : {};

      return {
        operation: normalizedOperation,
        adapterId: "deterministic-runtime-adapter",
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
