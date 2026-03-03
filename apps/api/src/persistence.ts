import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  exportStoreSnapshot as exportStoreSnapshotFromCore,
  importStoreSnapshot as importStoreSnapshotFromCore,
} from "./core.ts";

export const DEFAULT_SHARED_STATE_FILE =
  process.env["UMS_STATE_FILE"] ?? ".ums-state.json";

const LOCK_TIMEOUT_MS = Number.parseInt(
  process.env["UMS_STATE_LOCK_TIMEOUT_MS"] ?? "8000",
  10
);
const LOCK_RETRY_MS = Number.parseInt(
  process.env["UMS_STATE_LOCK_RETRY_MS"] ?? "25",
  10
);
const READ_ONLY_OPERATIONS = new Set([
  "context",
  "validate",
  "audit",
  "export",
  "doctor",
  "policy_audit_export",
]);

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

interface StoreSnapshot {
  stores: Record<string, JsonValue>;
}

interface ExecuteOperationWithSharedStateOptions<T> {
  operation?: string | null | undefined;
  stateFile?: string | null | undefined;
  executor: () => Promise<T> | T;
}

const exportStoreSnapshot = exportStoreSnapshotFromCore as () => StoreSnapshot;
const importStoreSnapshot = importStoreSnapshotFromCore as (
  snapshot: StoreSnapshot
) => void;

function normalizeOperation(operation: unknown): string {
  return typeof operation === "string" ? operation.trim().toLowerCase() : "";
}

function hasStateFile(stateFile: unknown): stateFile is string {
  return typeof stateFile === "string" && stateFile.trim().length > 0;
}

function sleep(delayMs: number): Promise<void> {
  return delay(delayMs);
}

function ignoreCleanupError(_error: unknown): void {
  void _error;
}

function withCode(error: Error, code: string): Error & { code: string } {
  return Object.assign(error, { code });
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
  );
}

export function resolveStateFilePath(
  stateFile: string | null | undefined = DEFAULT_SHARED_STATE_FILE
): string | null {
  if (!hasStateFile(stateFile)) {
    return null;
  }
  return resolve(stateFile.trim());
}

async function readSnapshotFromFile(
  stateFilePath: string
): Promise<StoreSnapshot> {
  try {
    const raw = await readFile(stateFilePath, "utf8");
    if (!raw.trim()) {
      return { stores: {} };
    }
    const parsed: unknown = JSON.parse(raw);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !("stores" in parsed) ||
      typeof parsed.stores !== "object" ||
      parsed.stores === null ||
      Array.isArray(parsed.stores)
    ) {
      return { stores: {} };
    }
    return parsed as StoreSnapshot;
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return { stores: {} };
    }
    if (error instanceof SyntaxError) {
      throw withCode(
        new Error(`State file is not valid JSON: ${stateFilePath}`),
        "STATE_FILE_CORRUPT"
      );
    }
    throw error;
  }
}

async function writeSnapshotAtomic(
  stateFilePath: string,
  snapshot: StoreSnapshot
): Promise<void> {
  await mkdir(dirname(stateFilePath), { recursive: true });
  const tempPath = `${stateFilePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tempPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    await rename(tempPath, stateFilePath);
  } finally {
    await rm(tempPath, { force: true }).catch(ignoreCleanupError);
  }
}

async function acquireLock(
  lockPath: string,
  timeoutMs: number,
  retryMs: number
): Promise<FileHandle> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      const lockHandle = await open(lockPath, "wx");
      await lockHandle.writeFile(`${process.pid}\n`, "utf8");
      return lockHandle;
    } catch (error) {
      if (!(isErrnoException(error) && error.code === "EEXIST")) {
        throw error;
      }
      if (Date.now() >= deadline) {
        throw withCode(
          new Error(`Timed out acquiring state lock: ${lockPath}`),
          "STATE_LOCK_TIMEOUT"
        );
      }
      await sleep(retryMs);
    }
  }
}

async function withExclusiveLock<T>(
  stateFilePath: string,
  fn: () => Promise<T>
): Promise<T> {
  const lockPath = `${stateFilePath}.lock`;
  await mkdir(dirname(stateFilePath), { recursive: true });
  const lockHandle = await acquireLock(
    lockPath,
    LOCK_TIMEOUT_MS,
    LOCK_RETRY_MS
  );
  try {
    return await fn();
  } finally {
    await lockHandle.close().catch(ignoreCleanupError);
    await rm(lockPath, { force: true }).catch(ignoreCleanupError);
  }
}

async function hydrateStoreFromSnapshot(stateFilePath: string): Promise<void> {
  const snapshot = await readSnapshotFromFile(stateFilePath);
  importStoreSnapshot(snapshot);
}

async function persistStoreSnapshot(stateFilePath: string): Promise<void> {
  const snapshot = exportStoreSnapshot();
  await writeSnapshotAtomic(stateFilePath, snapshot);
}

export async function executeOperationWithSharedState<T>({
  operation,
  stateFile = DEFAULT_SHARED_STATE_FILE,
  executor,
}: ExecuteOperationWithSharedStateOptions<T>): Promise<T> {
  if (typeof executor !== "function") {
    throw new Error(
      "executeOperationWithSharedState requires an executor function."
    );
  }

  const stateFilePath = resolveStateFilePath(stateFile);
  if (!stateFilePath) {
    return executor();
  }

  const op = normalizeOperation(operation);
  if (READ_ONLY_OPERATIONS.has(op)) {
    await hydrateStoreFromSnapshot(stateFilePath);
    return executor();
  }

  return withExclusiveLock(stateFilePath, async () => {
    await hydrateStoreFromSnapshot(stateFilePath);
    const result = await executor();
    await persistStoreSnapshot(stateFilePath);
    return result;
  });
}
