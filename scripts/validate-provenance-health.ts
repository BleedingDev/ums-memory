import { DatabaseSync } from "../libs/shared/src/effect/storage/sqlite/database.ts";
import {
  evaluateSqliteProvenanceHealth,
  makeSqliteStorageRepository,
  type SqliteProvenanceHealthCriticalThresholds,
} from "../libs/shared/src/effect/storage/sqlite/index.js";

const RESULT_SCHEMA_VERSION = "provenance_health_validation.v1";

interface ParsedArgs {
  readonly dbPath: string | null;
  readonly asJson: boolean;
  readonly help: boolean;
  readonly criticalMissingProvenanceLinks: number | undefined;
  readonly criticalLineageBreaks: number | undefined;
  readonly criticalNormalizationRejects: number | undefined;
}

const parsePositiveInteger = (value: string, flag: string): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive safe integer.`);
  }
  return parsed;
};

const parseArgs = (argv: readonly string[]): ParsedArgs => {
  let dbPath: string | null = null;
  let asJson = false;
  let help = false;
  let criticalMissingProvenanceLinks: number | undefined;
  let criticalLineageBreaks: number | undefined;
  let criticalNormalizationRejects: number | undefined;

  const args = [...argv];
  while (args.length > 0) {
    const token = args.shift();
    if (token === undefined) {
      continue;
    }
    if (token === "--help" || token === "-h") {
      help = true;
      continue;
    }
    if (token === "--json") {
      asJson = true;
      continue;
    }
    if (token === "--db") {
      const value = args.shift();
      if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error("--db requires a non-empty value.");
      }
      dbPath = value.trim();
      continue;
    }
    if (token === "--critical-missing-provenance-links") {
      const value = args.shift();
      if (typeof value !== "string") {
        throw new Error(`${token} requires a value.`);
      }
      criticalMissingProvenanceLinks = parsePositiveInteger(value, token);
      continue;
    }
    if (token === "--critical-lineage-breaks") {
      const value = args.shift();
      if (typeof value !== "string") {
        throw new Error(`${token} requires a value.`);
      }
      criticalLineageBreaks = parsePositiveInteger(value, token);
      continue;
    }
    if (token === "--critical-normalization-rejects") {
      const value = args.shift();
      if (typeof value !== "string") {
        throw new Error(`${token} requires a value.`);
      }
      criticalNormalizationRejects = parsePositiveInteger(value, token);
      continue;
    }

    throw new Error(`Unknown argument: ${token}`);
  }

  return {
    dbPath,
    asJson,
    help,
    criticalMissingProvenanceLinks,
    criticalLineageBreaks,
    criticalNormalizationRejects,
  };
};

const printUsage = (): void => {
  process.stdout.write(
    [
      "Usage:",
      "  bun scripts/validate-provenance-health.ts --db <sqlite-file> [--json]",
      "",
      "Options:",
      "  --critical-missing-provenance-links <N>   Critical threshold override.",
      "  --critical-lineage-breaks <N>             Critical threshold override.",
      "  --critical-normalization-rejects <N>      Critical threshold override.",
      "  --json                                    Emit JSON output.",
      "  --help, -h                                Show this help text.",
    ].join("\n") + "\n"
  );
};

const run = (): number => {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    printUsage();
    return 1;
  }

  if (parsed.help) {
    printUsage();
    return 0;
  }
  if (parsed.dbPath === null) {
    printUsage();
    return 1;
  }

  const database = new DatabaseSync(parsed.dbPath);
  try {
    makeSqliteStorageRepository(database, {
      applyMigrations: true,
    });
    const criticalThresholds = {
      ...(parsed.criticalMissingProvenanceLinks !== undefined
        ? {
            missingProvenanceLinks: parsed.criticalMissingProvenanceLinks,
          }
        : {}),
      ...(parsed.criticalLineageBreaks !== undefined
        ? {
            lineageBreaks: parsed.criticalLineageBreaks,
          }
        : {}),
      ...(parsed.criticalNormalizationRejects !== undefined
        ? {
            normalizationRejects: parsed.criticalNormalizationRejects,
          }
        : {}),
    } satisfies Partial<SqliteProvenanceHealthCriticalThresholds>;
    const report = evaluateSqliteProvenanceHealth(database, {
      criticalThresholds,
    });
    const hasCritical = report.alerts.some(
      (alert) => alert.severity === "critical"
    );
    const result = {
      schemaVersion: RESULT_SCHEMA_VERSION,
      dbPath: parsed.dbPath,
      counters: report.counters,
      alerts: report.alerts,
      ok: !hasCritical,
    };

    if (parsed.asJson) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(
        [
          `Schema version: ${result.schemaVersion}`,
          `DB path: ${result.dbPath}`,
          `Scanned memory rows: ${result.counters.scannedMemoryRows}`,
          `Missing provenance links: ${result.counters.missingProvenanceLinks}`,
          `Lineage breaks: ${result.counters.lineageBreaks}`,
          `Normalization rejects: ${result.counters.normalizationRejects}`,
          `Alerts: ${result.alerts.length}`,
          ...result.alerts.map(
            (alert) =>
              `  - [${alert.severity}] ${alert.code} count=${alert.count} threshold=${alert.threshold}`
          ),
          `Result: ${result.ok ? "ok" : "failed"}`,
        ].join("\n") + "\n"
      );
    }

    return result.ok ? 0 : 2;
  } finally {
    database.close();
  }
};

process.exitCode = run();
