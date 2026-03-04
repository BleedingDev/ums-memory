import assert from "node:assert/strict";
import { constants as fsConstants } from "node:fs";
import { access, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { executeOperationWithSharedState } from "../src/persistence.ts";

function findDeadPid(): number {
  let candidate = process.pid + 100_000;
  while (candidate < 2_147_483_647) {
    try {
      process.kill(candidate, 0);
      candidate += 1;
      continue;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: unknown }).code === "EPERM"
      ) {
        candidate += 1;
        continue;
      }
      return candidate;
    }
  }
  return 2_147_483_647;
}

test("stale lock with dead pid is reclaimed before timeout", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "ums-persistence-lock-"));
  const stateFile = resolve(tempDir, "state.json");
  const lockPath = `${stateFile}.lock`;
  try {
    await writeFile(lockPath, `${findDeadPid()}\n`, "utf8");
    const result = await executeOperationWithSharedState({
      operation: "ingest",
      stateFile,
      executor: () => ({ ok: true }),
    });

    assert.deepEqual(result, { ok: true });
    await assert.rejects(access(lockPath, fsConstants.F_OK), /ENOENT/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("stale malformed lock older than threshold is reclaimed", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "ums-persistence-lock-"));
  const stateFile = resolve(tempDir, "state.json");
  const lockPath = `${stateFile}.lock`;
  try {
    await writeFile(lockPath, "not-a-pid\n", "utf8");
    const old = new Date(Date.now() - 5_000);
    await utimes(lockPath, old, old);

    const result = await executeOperationWithSharedState({
      operation: "ingest",
      stateFile,
      executor: () => ({ reclaimed: true }),
    });

    assert.deepEqual(result, { reclaimed: true });
    await assert.rejects(access(lockPath, fsConstants.F_OK), /ENOENT/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("concurrent stale-lock recovery preserves exclusive execution", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "ums-persistence-lock-"));
  const stateFile = resolve(tempDir, "state.json");
  const lockPath = `${stateFile}.lock`;
  try {
    await writeFile(lockPath, `${findDeadPid()}\n`, "utf8");

    let activeExecutions = 0;
    let maxConcurrentExecutions = 0;
    const runWithSharedLock = () =>
      executeOperationWithSharedState({
        operation: "ingest",
        stateFile,
        executor: async () => {
          activeExecutions += 1;
          maxConcurrentExecutions = Math.max(
            maxConcurrentExecutions,
            activeExecutions
          );
          await delay(20);
          activeExecutions -= 1;
          return { ok: true };
        },
      });

    const results = await Promise.all([
      runWithSharedLock(),
      runWithSharedLock(),
      runWithSharedLock(),
    ]);

    assert.deepEqual(results, [{ ok: true }, { ok: true }, { ok: true }]);
    assert.equal(maxConcurrentExecutions, 1);
    await assert.rejects(access(lockPath, fsConstants.F_OK), /ENOENT/);
    await assert.rejects(
      access(`${lockPath}.reclaim`, fsConstants.F_OK),
      /ENOENT/
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
