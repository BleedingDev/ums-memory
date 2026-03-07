import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { Effect } from "effect";

import {
  exportStoreSnapshot as exportStoreSnapshotFromCore,
  importStoreSnapshot as importStoreSnapshotFromCore,
} from "./core.ts";

export const DEFAULT_SHARED_STATE_FILE =
  process.env["UMS_STATE_FILE"] ?? ".ums-state.json";

function readPositiveIntEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (typeof value !== "string") {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const LOCK_TIMEOUT_MS = readPositiveIntEnv("UMS_STATE_LOCK_TIMEOUT_MS", 8000);
const LOCK_RETRY_MS = readPositiveIntEnv("UMS_STATE_LOCK_RETRY_MS", 25);
const LOCK_STALE_MS = readPositiveIntEnv("UMS_STATE_LOCK_STALE_MS", 1000);
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
  mode?: "stateful" | "lock-only";
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

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isErrnoException(error)) {
      return error.code === "EPERM";
    }
    return false;
  }
}

function parseLockPid(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (
        parsed &&
        typeof parsed === "object" &&
        "pid" in parsed &&
        Number.isInteger((parsed as { pid?: unknown }).pid) &&
        (parsed as { pid: number }).pid > 0
      ) {
        return (parsed as { pid: number }).pid;
      }
      return null;
    } catch {
      return null;
    }
  }

  const firstToken = trimmed.split(/\s+/, 1)[0] ?? "";
  const pid = Number.parseInt(firstToken, 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

async function canReclaimLockFile(lockPath: string): Promise<boolean> {
  let ownerPid: number | null = null;
  try {
    const raw = await readFile(lockPath, "utf8");
    ownerPid = parseLockPid(raw);
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }

  if (ownerPid !== null && isProcessAlive(ownerPid)) {
    return false;
  }

  if (ownerPid === null) {
    try {
      const metadata = await stat(lockPath);
      const ageMs = Date.now() - metadata.mtimeMs;
      if (ageMs < LOCK_STALE_MS) {
        return false;
      }
    } catch (error) {
      if (isErrnoException(error) && error.code === "ENOENT") {
        return false;
      }
      throw error;
    }
  }

  return true;
}

async function acquireReclaimLock(
  reclaimPath: string
): Promise<FileHandle | null> {
  const openReclaimHandle = async (): Promise<FileHandle> => {
    const handle = await open(reclaimPath, "wx");
    await handle.writeFile(`${process.pid}\n`, "utf8");
    return handle;
  };

  try {
    return await openReclaimHandle();
  } catch (error) {
    if (!(isErrnoException(error) && error.code === "EEXIST")) {
      throw error;
    }
  }

  if (!(await canReclaimLockFile(reclaimPath))) {
    return null;
  }
  await rm(reclaimPath, { force: true }).catch(ignoreCleanupError);

  try {
    return await openReclaimHandle();
  } catch (error) {
    if (isErrnoException(error) && error.code === "EEXIST") {
      return null;
    }
    throw error;
  }
}

async function reclaimStaleLock(lockPath: string): Promise<boolean> {
  const reclaimPath = `${lockPath}.reclaim`;
  const reclaimHandle = await acquireReclaimLock(reclaimPath);
  if (!reclaimHandle) {
    return false;
  }
  try {
    if (!(await canReclaimLockFile(lockPath))) {
      return false;
    }
    await rm(lockPath, { force: true }).catch(ignoreCleanupError);
    return true;
  } finally {
    await reclaimHandle.close().catch(ignoreCleanupError);
    await rm(reclaimPath, { force: true }).catch(ignoreCleanupError);
  }
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
      if (await reclaimStaleLock(lockPath)) {
        continue;
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

interface SharedStateLockLease {
  readonly lockHandle: FileHandle;
  readonly lockPath: string;
}

async function acquireSharedStateLockLease(
  stateFilePath: string
): Promise<SharedStateLockLease> {
  const lockPath = `${stateFilePath}.lock`;
  await mkdir(dirname(stateFilePath), { recursive: true });
  const lockHandle = await acquireLock(
    lockPath,
    LOCK_TIMEOUT_MS,
    LOCK_RETRY_MS
  );
  return {
    lockHandle,
    lockPath,
  };
}

async function releaseSharedStateLockLease(
  lease: SharedStateLockLease
): Promise<void> {
  await lease.lockHandle.close().catch(ignoreCleanupError);
  await rm(lease.lockPath, { force: true }).catch(ignoreCleanupError);
}

export function withSharedStateLockEffect<T>({
  stateFile = DEFAULT_SHARED_STATE_FILE,
  effect,
}: {
  readonly stateFile?: string | null | undefined;
  readonly effect: Effect.Effect<T, unknown>;
}): Effect.Effect<T, unknown> {
  const stateFilePath = resolveStateFilePath(stateFile);
  if (!stateFilePath) {
    return effect;
  }

  return Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => acquireSharedStateLockLease(stateFilePath),
      catch: (cause) => cause,
    }),
    () => effect,
    (lease) =>
      Effect.promise(() => releaseSharedStateLockLease(lease)).pipe(
        Effect.orDie
      )
  );
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
  mode = "stateful",
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

  if (mode === "lock-only") {
    return withExclusiveLock(stateFilePath, async () => executor());
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
