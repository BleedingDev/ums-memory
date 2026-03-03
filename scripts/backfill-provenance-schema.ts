import { DatabaseSync } from "node:sqlite";

import {
  backfillSqliteProvenanceSchema,
  makeSqliteStorageRepository,
} from "../libs/shared/src/effect/storage/sqlite/index.js";

const parseArgValue = (
  args: readonly string[],
  flag: string
): string | null => {
  const index = args.indexOf(flag);
  if (index === -1) {
    return null;
  }
  const value = args[index + 1];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
};

const printUsage = (): void => {
  process.stdout.write(
    [
      "Usage: node --import tsx scripts/backfill-provenance-schema.ts --db <sqlite-file>",
      "",
      "Optional:",
      "  --source-prefix <prefix>   Default provenance sourceId prefix (default: backfill)",
      "  --batch-id <batch-id>      Default provenance batchId (default: v1)",
    ].join("\n")
  );
  process.stdout.write("\n");
};

const run = (): void => {
  const args = process.argv.slice(2);
  const dbPath = parseArgValue(args, "--db");
  if (dbPath === null) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const sourcePrefix = parseArgValue(args, "--source-prefix") ?? "backfill";
  const batchId = parseArgValue(args, "--batch-id") ?? "v1";

  const database = new DatabaseSync(dbPath);
  try {
    // Ensure schema/runtime guardrails are initialized before backfill execution.
    makeSqliteStorageRepository(database, {
      applyMigrations: true,
    });

    const summary = backfillSqliteProvenanceSchema(database, {
      applyMigrations: false,
      provenanceBackfill: {
        runOnInit: false,
        defaultSourceIdPrefix: sourcePrefix,
        defaultBatchId: batchId,
      },
    });
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } finally {
    database.close();
  }
};

run();
