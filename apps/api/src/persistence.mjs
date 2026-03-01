import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { exportStoreSnapshot, importStoreSnapshot } from "./core.mjs";

export const DEFAULT_SHARED_STATE_FILE = process.env.UMS_STATE_FILE ?? ".ums-state.json";

const LOCK_TIMEOUT_MS = Number.parseInt(process.env.UMS_STATE_LOCK_TIMEOUT_MS ?? "8000", 10);
const LOCK_RETRY_MS = Number.parseInt(process.env.UMS_STATE_LOCK_RETRY_MS ?? "25", 10);
const READ_ONLY_OPERATIONS = new Set([
  "context",
  "validate",
  "audit",
  "export",
  "doctor",
  "policy_audit_export",
]);

function normalizeOperation(operation) {
  return typeof operation === "string" ? operation.trim().toLowerCase() : "";
}

function hasStateFile(stateFile) {
  return typeof stateFile === "string" && stateFile.trim().length > 0;
}

function sleep(delayMs) {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, delayMs);
  });
}

export function resolveStateFilePath(stateFile = DEFAULT_SHARED_STATE_FILE) {
  if (!hasStateFile(stateFile)) {
    return null;
  }
  return resolve(stateFile.trim());
}

async function readSnapshotFromFile(stateFilePath) {
  try {
    const raw = await readFile(stateFilePath, "utf8");
    if (!raw.trim()) {
      return { stores: {} };
    }
    return JSON.parse(raw);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { stores: {} };
    }
    if (error instanceof SyntaxError) {
      const parseError = new Error(`State file is not valid JSON: ${stateFilePath}`);
      parseError.code = "STATE_FILE_CORRUPT";
      throw parseError;
    }
    throw error;
  }
}

async function writeSnapshotAtomic(stateFilePath, snapshot) {
  await mkdir(dirname(stateFilePath), { recursive: true });
  const tempPath = `${stateFilePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tempPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    await rename(tempPath, stateFilePath);
  } finally {
    await rm(tempPath, { force: true }).catch(() => {});
  }
}

async function acquireLock(lockPath, timeoutMs, retryMs) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      const lockHandle = await open(lockPath, "wx");
      await lockHandle.writeFile(`${process.pid}\n`, "utf8");
      return lockHandle;
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) {
        throw error;
      }
      if (Date.now() >= deadline) {
        const timeoutError = new Error(`Timed out acquiring state lock: ${lockPath}`);
        timeoutError.code = "STATE_LOCK_TIMEOUT";
        throw timeoutError;
      }
      await sleep(retryMs);
    }
  }
}

async function withExclusiveLock(stateFilePath, fn) {
  const lockPath = `${stateFilePath}.lock`;
  await mkdir(dirname(stateFilePath), { recursive: true });
  const lockHandle = await acquireLock(lockPath, LOCK_TIMEOUT_MS, LOCK_RETRY_MS);
  try {
    return await fn();
  } finally {
    await lockHandle.close().catch(() => {});
    await rm(lockPath, { force: true }).catch(() => {});
  }
}

async function hydrateStoreFromSnapshot(stateFilePath) {
  const snapshot = await readSnapshotFromFile(stateFilePath);
  importStoreSnapshot(snapshot);
}

async function persistStoreSnapshot(stateFilePath) {
  const snapshot = exportStoreSnapshot();
  await writeSnapshotAtomic(stateFilePath, snapshot);
}

export async function executeOperationWithSharedState({
  operation,
  stateFile = DEFAULT_SHARED_STATE_FILE,
  executor,
}) {
  if (typeof executor !== "function") {
    throw new Error("executeOperationWithSharedState requires an executor function.");
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
