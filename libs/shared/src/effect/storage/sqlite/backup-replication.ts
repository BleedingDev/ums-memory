import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { ContractValidationError } from "../../errors.js";
import type { DatabaseSync } from "./database.ts";

const backupOptionContractPrefix =
  "SqliteStorageRepositoryOptions.backupReplication";
const defaultSnapshotFilePrefix = "sqlite-backup";

export type SqliteBackupReplicationTrigger = "manual" | "interval";

export interface SqliteBackupReplicationMetadata {
  readonly sequence: number;
  readonly trigger: SqliteBackupReplicationTrigger;
  readonly createdAtMillis: number;
  readonly snapshotFilename: string;
  readonly snapshotPath: string;
  readonly retainedSnapshotCount: number;
  readonly deletedSnapshotFilenames: readonly string[];
}

export interface SqliteBackupReplicationErrorContext {
  readonly trigger: SqliteBackupReplicationTrigger;
}

export interface SqliteBackupReplicationController {
  readonly start: () => void;
  readonly stop: () => void;
  readonly isRunning: () => boolean;
  readonly replicateNow: (
    trigger?: SqliteBackupReplicationTrigger
  ) => SqliteBackupReplicationMetadata;
}

export interface SqliteBackupReplicationScheduler {
  readonly setInterval: (task: () => void, intervalMillis: number) => unknown;
  readonly clearInterval: (handle: unknown) => void;
}

export interface SqliteBackupReplicationOptions {
  readonly directoryPath: string;
  readonly filePrefix?: string;
  readonly intervalMillis?: number;
  readonly retentionMaxSnapshots?: number;
  readonly autoStart?: boolean;
  readonly clock?: () => number;
  readonly scheduler?: SqliteBackupReplicationScheduler;
  readonly onReplicated?: (metadata: SqliteBackupReplicationMetadata) => void;
  readonly onReplicationError?: (
    error: ContractValidationError,
    context: SqliteBackupReplicationErrorContext
  ) => void;
  readonly onControllerReady?: (
    controller: SqliteBackupReplicationController
  ) => void;
}

interface BackupSnapshotRecord {
  readonly sequence: number;
  readonly createdAtMillis: number;
  readonly filename: string;
  readonly filePath: string;
}

const defaultBackupReplicationScheduler: SqliteBackupReplicationScheduler = {
  setInterval: (task, intervalMillis) => setInterval(task, intervalMillis),
  clearInterval: (handle) =>
    clearInterval(handle as ReturnType<typeof setInterval>),
};

const toErrorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const normalizeTrimmedString = (
  value: unknown,
  contract: string,
  details: string
): string => {
  if (typeof value !== "string") {
    throw new ContractValidationError({
      contract,
      message: "SQLite backup replication option must be a non-empty string.",
      details,
    });
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new ContractValidationError({
      contract,
      message: "SQLite backup replication option must be a non-empty string.",
      details,
    });
  }

  return trimmed;
};

const normalizeSnapshotFilePrefix = (
  value: string,
  contract: string
): string => {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new ContractValidationError({
      contract,
      message:
        "SQLite backup replication filePrefix must contain only [A-Za-z0-9_-].",
      details:
        "filePrefix must not contain path separators, dots, or whitespace to prevent path traversal.",
    });
  }

  return value;
};

const normalizeOptionalPositiveSafeInteger = (
  value: unknown,
  contract: string,
  details: string
): number | null => {
  if (value === undefined) {
    return null;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new ContractValidationError({
      contract,
      message:
        "SQLite backup replication option must be a positive safe integer.",
      details,
    });
  }

  return value;
};

const toSqliteStringLiteral = (value: string): string =>
  `'${value.replace(/'/g, "''")}'`;

const formatSnapshotSequence = (sequence: number): string =>
  sequence.toString().padStart(6, "0");

const formatSnapshotTimestamp = (createdAtMillis: number): string =>
  createdAtMillis.toString().padStart(13, "0");

const escapeRegularExpression = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

const parseSnapshotRecord = (
  filename: string,
  directoryPath: string,
  snapshotPattern: RegExp
): BackupSnapshotRecord | null => {
  const match = snapshotPattern.exec(filename);
  if (match === null) {
    return null;
  }

  const createdAtMillis = Number(match[1]);
  const sequence = Number(match[2]);
  if (
    !Number.isSafeInteger(createdAtMillis) ||
    createdAtMillis < 0 ||
    !Number.isSafeInteger(sequence) ||
    sequence <= 0
  ) {
    return null;
  }

  return {
    sequence,
    createdAtMillis,
    filename,
    filePath: join(directoryPath, filename),
  };
};

const sortSnapshotRecords = (
  left: BackupSnapshotRecord,
  right: BackupSnapshotRecord
): number => {
  if (left.createdAtMillis !== right.createdAtMillis) {
    return left.createdAtMillis - right.createdAtMillis;
  }
  if (left.sequence !== right.sequence) {
    return left.sequence - right.sequence;
  }
  return left.filename.localeCompare(right.filename);
};

const normalizeCreatedAtMillis = (createdAtMillis: number): number => {
  if (!Number.isSafeInteger(createdAtMillis) || createdAtMillis < 0) {
    throw new ContractValidationError({
      contract: `${backupOptionContractPrefix}.clock`,
      message:
        "SQLite backup replication clock must return non-negative safe integer millis.",
      details: `Received clock value: ${createdAtMillis}.`,
    });
  }

  return createdAtMillis;
};

const isClosedDatabaseError = (error: ContractValidationError): boolean =>
  /SQLITE_MISUSE|closed|not open/u.test(error.details);

export const createSqliteBackupReplicator = (
  database: DatabaseSync,
  options: SqliteBackupReplicationOptions
): SqliteBackupReplicationController => {
  const directoryPath = normalizeTrimmedString(
    options.directoryPath,
    `${backupOptionContractPrefix}.directoryPath`,
    "directoryPath must be a non-empty filesystem path string."
  );
  const filePrefix =
    options.filePrefix === undefined
      ? defaultSnapshotFilePrefix
      : normalizeTrimmedString(
          options.filePrefix,
          `${backupOptionContractPrefix}.filePrefix`,
          "filePrefix must be a non-empty string when provided."
        );
  const sanitizedFilePrefix = normalizeSnapshotFilePrefix(
    filePrefix,
    `${backupOptionContractPrefix}.filePrefix`
  );
  const intervalMillis = normalizeOptionalPositiveSafeInteger(
    options.intervalMillis,
    `${backupOptionContractPrefix}.intervalMillis`,
    "intervalMillis must be a positive safe integer when provided."
  );
  const retentionMaxSnapshots = normalizeOptionalPositiveSafeInteger(
    options.retentionMaxSnapshots,
    `${backupOptionContractPrefix}.retentionMaxSnapshots`,
    "retentionMaxSnapshots must be a positive safe integer when provided."
  );
  const clock = options.clock ?? Date.now;
  const scheduler = options.scheduler ?? defaultBackupReplicationScheduler;
  const autoStart = options.autoStart ?? true;
  const snapshotPattern = new RegExp(
    `^${escapeRegularExpression(sanitizedFilePrefix)}-(\\d{13})-(\\d+)\\.sqlite$`,
    "u"
  );

  let nextSequence = 0;
  let timerHandle: unknown | null = null;
  const managedSnapshots: BackupSnapshotRecord[] = [];
  const onReplicationError = options.onReplicationError;

  const publishReplicationError = (
    error: ContractValidationError,
    context: SqliteBackupReplicationErrorContext
  ): void => {
    if (onReplicationError === undefined) {
      return;
    }
    try {
      onReplicationError(error, context);
    } catch {
      // Error hooks are optional and must not break storage semantics.
    }
  };

  const applyRetention = (): string[] => {
    if (
      retentionMaxSnapshots === null ||
      managedSnapshots.length <= retentionMaxSnapshots
    ) {
      return [];
    }

    const staleSnapshots = managedSnapshots.splice(
      0,
      managedSnapshots.length - retentionMaxSnapshots
    );
    const deletedSnapshotFilenames: string[] = [];
    for (const staleSnapshot of staleSnapshots) {
      deletedSnapshotFilenames.push(staleSnapshot.filename);
      rmSync(staleSnapshot.filePath, { force: true });
    }

    return deletedSnapshotFilenames;
  };

  mkdirSync(directoryPath, { recursive: true });
  const existingSnapshots = readdirSync(directoryPath)
    .map((filename) =>
      parseSnapshotRecord(filename, directoryPath, snapshotPattern)
    )
    .filter((record): record is BackupSnapshotRecord => record !== null)
    .sort(sortSnapshotRecords);
  if (existingSnapshots.length > 0) {
    managedSnapshots.push(...existingSnapshots);
    nextSequence = existingSnapshots.reduce(
      (maxSequence, snapshot) => Math.max(maxSequence, snapshot.sequence),
      0
    );
    applyRetention();
  }

  const replicateNow = (
    trigger: SqliteBackupReplicationTrigger = "manual"
  ): SqliteBackupReplicationMetadata => {
    const createdAtMillis = normalizeCreatedAtMillis(clock());
    nextSequence += 1;
    const snapshotFilename = `${sanitizedFilePrefix}-${formatSnapshotTimestamp(createdAtMillis)}-${formatSnapshotSequence(nextSequence)}.sqlite`;
    const snapshotPath = join(directoryPath, snapshotFilename);

    if (existsSync(snapshotPath)) {
      rmSync(snapshotPath, { force: true });
    }

    try {
      database.exec(`VACUUM INTO ${toSqliteStringLiteral(snapshotPath)};`);
    } catch (cause) {
      const replicationError = new ContractValidationError({
        contract: `${backupOptionContractPrefix}.snapshot`,
        message: "SQLite backup replication snapshot failed.",
        details: toErrorMessage(cause),
      });
      publishReplicationError(replicationError, { trigger });
      throw replicationError;
    }

    managedSnapshots.push({
      sequence: nextSequence,
      createdAtMillis,
      filename: snapshotFilename,
      filePath: snapshotPath,
    });

    const deletedSnapshotFilenames = applyRetention();

    const metadata: SqliteBackupReplicationMetadata = Object.freeze({
      sequence: nextSequence,
      trigger,
      createdAtMillis,
      snapshotFilename,
      snapshotPath,
      retainedSnapshotCount: managedSnapshots.length,
      deletedSnapshotFilenames: Object.freeze([...deletedSnapshotFilenames]),
    });
    const onReplicated = options.onReplicated;
    if (onReplicated !== undefined) {
      try {
        onReplicated(metadata);
      } catch {
        // Replication hooks are optional and must never break storage semantics.
      }
    }

    return metadata;
  };

  const start = (): void => {
    if (intervalMillis === null || timerHandle !== null) {
      return;
    }
    timerHandle = scheduler.setInterval(() => {
      try {
        replicateNow("interval");
      } catch (cause) {
        if (
          cause instanceof ContractValidationError &&
          isClosedDatabaseError(cause)
        ) {
          stop();
        }
      }
    }, intervalMillis);
  };

  const stop = (): void => {
    if (timerHandle === null) {
      return;
    }
    scheduler.clearInterval(timerHandle);
    timerHandle = null;
  };

  const controller: SqliteBackupReplicationController = Object.freeze({
    start,
    stop,
    isRunning: () => timerHandle !== null,
    replicateNow,
  });
  const onControllerReady = options.onControllerReady;
  if (onControllerReady !== undefined) {
    try {
      onControllerReady(controller);
    } catch {
      // Controller registration hooks are optional and must remain best-effort.
    }
  }
  if (autoStart) {
    start();
  }

  return controller;
};
