import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { test } from "@effect-native/bun-test";

const readRepoFile = async (relativePath: string): Promise<string> =>
  readFile(path.resolve(process.cwd(), relativePath), "utf8");

test("ums-memory-onf.6: cutover and rollback runbooks require explicit evidence artifacts", async () => {
  const migrationRunbook = await readRepoFile(
    "docs/runbooks/sqlite-to-postgres-migration-strategy.md"
  );
  const deployRunbook = await readRepoFile(
    "docs/runbooks/deploy-operations-compose-first.md"
  );
  const prelaunchChecklist = await readRepoFile(
    "docs/runbooks/prelaunch-strict-implementation-checklist.md"
  );
  const disasterRecoveryRunbook = await readRepoFile(
    "docs/runbooks/disaster-recovery-game-day-automation.md"
  );
  const drillScript = await readRepoFile("ops/run-dr-restore-drill.sh");

  assert.match(migrationRunbook, /## Required Evidence Before Primary Cutover/);
  assert.match(migrationRunbook, /bun scripts\/eval-storage-parity\.ts --json/);
  assert.match(migrationRunbook, /\/v1\/storage_dualrun/);
  assert.match(migrationRunbook, /manifest\.json/);
  assert.match(migrationRunbook, /attemptsUsed <= 2/);
  assert.match(migrationRunbook, /rollback rehearsal/i);
  assert.match(migrationRunbook, /rollback-redeploy-check\.txt/);
  assert.match(migrationRunbook, /rollback-api-root\.json/);
  assert.match(migrationRunbook, /rollback-metrics\.prom/);

  assert.match(deployRunbook, /## Postgres Cutover and Rollback Evidence/);
  assert.match(deployRunbook, /checksums\.txt/);
  assert.match(deployRunbook, /compose-logs-api-worker\.txt/);
  assert.match(deployRunbook, /requestDigest/);
  assert.match(deployRunbook, /rollback-redeploy-check\.txt/);
  assert.match(
    deployRunbook,
    /docker compose .*up --build -d --remove-orphans/
  );

  assert.match(
    prelaunchChecklist,
    /tests\/integration\/postgres-cutover-drill\.integration\.test\.ts/
  );
  assert.match(
    prelaunchChecklist,
    /docs\/runbooks\/disaster-recovery-game-day-automation\.md/
  );

  assert.match(disasterRecoveryRunbook, /manifest\.json/);
  assert.match(disasterRecoveryRunbook, /checksums\.txt/);
  assert.match(
    disasterRecoveryRunbook,
    /retry once with the previous known-good backup/i
  );

  assert.match(drillScript, /attemptsUsed/);
  assert.match(drillScript, /failureGate/);
  assert.match(drillScript, /Retrying drill with fallback backup/);
});
