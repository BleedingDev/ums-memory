import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { Effect, Schema } from "effect";

import { executeRuntimeOperation } from "../../api/src/runtime-service.ts";
import {
  type DaemonConfig,
  type DaemonConfigRouteSource,
  explainDaemonRouteResolution,
  readDaemonConfig,
  resolveDaemonConfigFilePath,
} from "./daemon-config.ts";

const MAX_EVENT_CONTENT_LENGTH = 3_000;
const DEFAULT_INGEST_CHUNK_SIZE = 100;
const DEFAULT_DAEMON_POLL_DELAY_MS = 250;
const TEXT_KEY_HINT =
  /(content|text|message|prompt|response|summary|note|query|analysis|output|title|body)/i;
const SECRET_ASSIGNMENT_PATTERN =
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|password|passphrase|authorization)\b\s*[:=]\s*["']?[^\s"',]{6,}/gi;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/-]{10,}/gi;
const JWT_PATTERN =
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const COMMON_SECRET_TOKEN_PATTERN =
  /\b(?:sk-[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/g;

type SupportedSourceName = "codex" | "claude" | "plan";

const NullableStringSchema = Schema.NullOr(Schema.String);
const UnknownRecordSchema = Schema.Record(Schema.String, Schema.Unknown);
const ContentItemSchema = Schema.Struct({
  text: Schema.String,
});
const ContentItemArraySchema = Schema.Array(ContentItemSchema);
const ErrnoCauseSchema = Schema.Struct({
  code: Schema.String,
  message: Schema.optional(Schema.String),
});
type SyncDecodingSchema<S extends Schema.Top> = S & {
  readonly DecodingServices: never;
};

const NonNegativeIntSchema = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0)
);
const PositiveIntSchema = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThan(0)
);

const SourceCursorSchema = Schema.Struct({
  cursor: NonNegativeIntSchema,
  digest: NullableStringSchema,
  updatedAt: Schema.String,
});

const DeliveryCheckpointSchema = Schema.Struct({
  lastDeliveredSequence: NonNegativeIntSchema,
  deliveredEvents: NonNegativeIntSchema,
  accepted: NonNegativeIntSchema,
  duplicates: NonNegativeIntSchema,
  updatedAt: Schema.String,
  lastError: NullableStringSchema,
});

const SyncRuntimeStateSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  updatedAt: Schema.String,
  daemonPid: Schema.NullOr(PositiveIntSchema),
  daemonStartedAt: NullableStringSchema,
  lastRunAt: NullableStringSchema,
  lastSuccessAt: NullableStringSchema,
  lastError: NullableStringSchema,
  nextSequence: PositiveIntSchema,
  sourceCursors: Schema.Record(Schema.String, SourceCursorSchema),
  deliveries: Schema.Record(Schema.String, DeliveryCheckpointSchema),
});

const IngestEventSchema = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal("note"),
  source: Schema.String,
  content: Schema.String,
});

const JournalEntrySchema = Schema.Struct({
  sequence: PositiveIntSchema,
  collectedAt: Schema.String,
  source: Schema.Literals(["codex", "claude", "plan"]),
  sourceFile: Schema.String,
  sourceLine: PositiveIntSchema,
  path: NullableStringSchema,
  repoRoot: NullableStringSchema,
  workspaceRoot: NullableStringSchema,
  routeStatus: Schema.Literals(["matched", "default", "review", "drop"]),
  memory: NullableStringSchema,
  routeIndex: Schema.NullOr(NonNegativeIntSchema),
  event: IngestEventSchema,
});

const CodexSessionMetaSchema = Schema.Struct({
  type: Schema.Literal("session_meta"),
  payload: Schema.Struct({
    id: Schema.optional(Schema.String),
    cwd: Schema.optional(Schema.String),
  }),
});

const CodexHistoryLineSchema = Schema.Struct({
  session_id: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
});

const CodexUserMessageSchema = Schema.Struct({
  type: Schema.Literal("response_item"),
  payload: Schema.Struct({
    type: Schema.Literal("message"),
    role: Schema.Literal("user"),
    content: Schema.Unknown,
  }),
});

const ClaudeUserLineSchema = Schema.Struct({
  type: Schema.Literal("user"),
  content: Schema.String,
});

type SourceCursorRecord = Schema.Schema.Type<typeof SourceCursorSchema>;
type DeliveryCheckpointRecord = Schema.Schema.Type<
  typeof DeliveryCheckpointSchema
>;
type SyncRuntimeState = Schema.Schema.Type<typeof SyncRuntimeStateSchema>;
type IngestEvent = Schema.Schema.Type<typeof IngestEventSchema>;
type JournalEntry = Schema.Schema.Type<typeof JournalEntrySchema>;

interface CollectedEvent {
  readonly source: SupportedSourceName;
  readonly sourceFile: string;
  readonly sourceLine: number;
  readonly path: string | null;
  readonly repoRoot: string | null;
  readonly workspaceRoot: string | null;
  readonly event: IngestEvent;
}

interface SourceCollectionStat {
  readonly source: SupportedSourceName;
  readonly filesScanned: number;
  readonly linesScanned: number;
  readonly eventsPrepared: number;
}

interface PlanCollectionResult {
  readonly events: readonly CollectedEvent[];
  readonly cursorUpdate: SourceCursorRecord | null;
  readonly scannedLines: number;
}

interface DaemonStatusDeliveryView {
  readonly memory: string;
  readonly account: string;
  readonly accountType: "local" | "http";
  readonly lastDeliveredSequence: number;
  readonly deliveredEvents: number;
  readonly accepted: number;
  readonly duplicates: number;
  readonly pendingEvents: number;
  readonly lastError: string | null;
}

export interface DaemonSyncSummary {
  readonly operation: "sync";
  readonly configFile: string;
  readonly stateRoot: string;
  readonly runtimeStateFile: string;
  readonly journalFile: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
  readonly preparedEvents: number;
  readonly journaledEvents: number;
  readonly reviewQueueEvents: number;
  readonly droppedEvents: number;
  readonly deliveredEvents: number;
  readonly accepted: number;
  readonly duplicates: number;
  readonly blockedMemories: readonly string[];
  readonly sourceStats: readonly SourceCollectionStat[];
  readonly deliveries: ReadonlyArray<{
    readonly memory: string;
    readonly account: string;
    readonly accountType: "local" | "http";
    readonly queuedEvents: number;
    readonly deliveredEvents: number;
    readonly accepted: number;
    readonly duplicates: number;
    readonly lastDeliveredSequence: number;
    readonly lastError: string | null;
  }>;
}

export interface DaemonStatusView {
  readonly operation: "status";
  readonly configFile: string;
  readonly stateRoot: string;
  readonly runtimeStateFile: string;
  readonly journalFile: string;
  readonly daemon: {
    readonly pid: number | null;
    readonly startedAt: string | null;
    readonly alive: boolean;
  };
  readonly sync: {
    readonly lastRunAt: string | null;
    readonly lastSuccessAt: string | null;
    readonly lastError: string | null;
    readonly nextSequence: number;
  };
  readonly journal: {
    readonly entries: number;
    readonly pendingReview: number;
    readonly pendingDrop: number;
  };
  readonly deliveries: ReadonlyArray<DaemonStatusDeliveryView>;
}

export interface RunConfiguredSyncDaemonOptions {
  readonly configFile?: string | null;
  readonly intervalMs?: number | null;
  readonly maxCycles?: number | null;
  readonly onCycle?: (result: DaemonSyncSummary | null, error: Error | null) => void;
}

export class DaemonSyncIoError extends Schema.TaggedErrorClass<DaemonSyncIoError>()(
  "DaemonSyncIoError",
  {
    operation: Schema.String,
    path: Schema.String,
    code: Schema.String,
    message: Schema.String,
    details: Schema.String,
  }
) {}

export class DaemonSyncParseError extends Schema.TaggedErrorClass<DaemonSyncParseError>()(
  "DaemonSyncParseError",
  {
    scope: Schema.String,
    path: Schema.String,
    message: Schema.String,
    details: Schema.String,
  }
) {}

export class DaemonSyncDeliveryError extends Schema.TaggedErrorClass<DaemonSyncDeliveryError>()(
  "DaemonSyncDeliveryError",
  {
    memory: Schema.String,
    account: Schema.String,
    message: Schema.String,
    details: Schema.String,
  }
) {}

const isErrnoCause = Schema.is(ErrnoCauseSchema);
const isString = Schema.is(Schema.String);
const isUnknownRecord = Schema.is(UnknownRecordSchema);
const isContentItemArray = Schema.is(ContentItemArraySchema);
const isCodexSessionMeta = Schema.is(CodexSessionMetaSchema);
const isCodexHistoryLine = Schema.is(CodexHistoryLineSchema);
const isCodexUserMessage = Schema.is(CodexUserMessageSchema);
const isClaudeUserLine = Schema.is(ClaudeUserLineSchema);

const decodeSyncRuntimeStateSync = Schema.decodeUnknownSync(
  SyncRuntimeStateSchema as SyncDecodingSchema<typeof SyncRuntimeStateSchema>
);
const decodeJournalEntrySync = Schema.decodeUnknownSync(
  JournalEntrySchema as SyncDecodingSchema<typeof JournalEntrySchema>
);

const parseJsonLine = (line: string): unknown =>
  Effect.runSync(
    Effect.try({
      try: () => JSON.parse(line),
      catch: (cause) =>
        new DaemonSyncParseError({
          scope: "Agent source line",
          path: "<jsonl>",
          message: "Source line is not valid JSON.",
          details: toCauseDetails(cause),
        }),
    }).pipe(Effect.orElseSucceed(() => line))
  );

const toIsoNow = (): string => new Date().toISOString();

const toCauseDetails = (cause: unknown): string =>
  isErrnoCause(cause) && isString(cause.message)
    ? cause.message
    : String(cause);

const toErrnoCode = (cause: unknown): string =>
  isErrnoCause(cause) ? cause.code : "UNKNOWN";

const normalizeMaybePath = (value: string | null | undefined): string | null =>
  value ? resolve(value) : null;

const resolveSyncStateFile = (config: DaemonConfig): string =>
  resolve(config.state.rootDir, "sync-state.json");

const resolveRuntimeStateFile = (config: DaemonConfig): string =>
  resolve(config.state.rootDir, "runtime-state.json");

const resolveJournalFile = (config: DaemonConfig): string =>
  resolve(config.state.journalDir, "events.ndjson");

const loadDaemonConfigEffect = (configFile: string | null | undefined) =>
  Effect.tryPromise({
    try: () => readDaemonConfig(configFile),
    catch: (cause) =>
      new DaemonSyncParseError({
        scope: "Daemon config",
        path: resolveDaemonConfigFilePath(configFile),
        message: "Failed to load daemon config.",
        details: toCauseDetails(cause),
      }),
  });

const createEmptySyncState = (): SyncRuntimeState => ({
  schemaVersion: 1,
  updatedAt: toIsoNow(),
  daemonPid: null,
  daemonStartedAt: null,
  lastRunAt: null,
  lastSuccessAt: null,
  lastError: null,
  nextSequence: 1,
  sourceCursors: {},
  deliveries: {},
});

const createEmptyDeliveryCheckpoint = (): DeliveryCheckpointRecord => ({
  lastDeliveredSequence: 0,
  deliveredEvents: 0,
  accepted: 0,
  duplicates: 0,
  updatedAt: toIsoNow(),
  lastError: null,
});

const hashValue = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const stripControlChars = (value: string): string =>
  [...value]
    .map((char) => {
      const code = char.charCodeAt(0);
      return code <= 31 || code === 127 ? " " : char;
    })
    .join("");

const sanitizeKnowledgeContent = (value: string): string => {
  const collapsed = stripControlChars(value)
    .replace(SECRET_ASSIGNMENT_PATTERN, "[REDACTED_SECRET]")
    .replace(BEARER_PATTERN, "Bearer [REDACTED_SECRET]")
    .replace(JWT_PATTERN, "[REDACTED_JWT]")
    .replace(COMMON_SECRET_TOKEN_PATTERN, "[REDACTED_SECRET]")
    .replace(/\s+/g, " ")
    .trim();
  return collapsed.length > MAX_EVENT_CONTENT_LENGTH
    ? collapsed.slice(0, MAX_EVENT_CONTENT_LENGTH)
    : collapsed;
};

const collectInterestingText = (
  value: unknown,
  depth = 0,
  keyHint = ""
): readonly string[] => {
  if (depth > 5) {
    return [];
  }
  if (isString(value)) {
    const normalized = value.trim();
    if (!normalized) {
      return [];
    }
    if (keyHint && !TEXT_KEY_HINT.test(keyHint) && depth > 1) {
      return [];
    }
    return [normalized];
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, 20)
      .flatMap((entry) => collectInterestingText(entry, depth + 1, keyHint))
      .slice(0, 8);
  }
  if (!isUnknownRecord(value)) {
    return [];
  }
  return Object.keys(value)
    .sort((left, right) => left.localeCompare(right))
    .flatMap((key) => collectInterestingText(value[key], depth + 1, key))
    .slice(0, 8);
};

const contentTextFromUnknown = (value: unknown): string =>
  isString(value)
    ? value
    : isContentItemArray(value)
      ? value.map((entry) => entry.text).join(" | ")
      : collectInterestingText(value).join(" | ");

const readUtf8 = (path: string, operation: string) =>
  Effect.tryPromise({
    try: () => readFile(path, "utf8"),
    catch: (cause) =>
      new DaemonSyncIoError({
        operation,
        path,
        code: toErrnoCode(cause),
        message: `${operation} failed for ${path}.`,
        details: toCauseDetails(cause),
      }),
  });

const writeUtf8Atomic = (path: string, content: string) => {
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  return Effect.gen(function* () {
    yield* Effect.tryPromise({
      try: () => mkdir(dirname(path), { recursive: true }),
      catch: (cause) =>
        new DaemonSyncIoError({
          operation: "mkdir",
          path: dirname(path),
          code: toErrnoCode(cause),
          message: `mkdir failed for ${dirname(path)}.`,
          details: toCauseDetails(cause),
        }),
    });
    yield* Effect.tryPromise({
      try: () => writeFile(tempPath, content, "utf8"),
      catch: (cause) =>
        new DaemonSyncIoError({
          operation: "writeFile",
          path: tempPath,
          code: toErrnoCode(cause),
          message: `writeFile failed for ${tempPath}.`,
          details: toCauseDetails(cause),
        }),
    });
    yield* Effect.tryPromise({
      try: () => rename(tempPath, path),
      catch: (cause) =>
        new DaemonSyncIoError({
          operation: "rename",
          path,
          code: toErrnoCode(cause),
          message: `rename failed for ${path}.`,
          details: toCauseDetails(cause),
        }),
    });
    yield* Effect.orElseSucceed(
      Effect.tryPromise({
        try: () => rm(tempPath, { force: true }),
        catch: (cause) =>
          new DaemonSyncIoError({
            operation: "rm",
            path: tempPath,
            code: toErrnoCode(cause),
            message: `rm failed for ${tempPath}.`,
            details: toCauseDetails(cause),
          }),
      }),
      () => undefined
    );
  });
};

const fileExists = (path: string) =>
  Effect.tryPromise({
    try: () => access(path).then(() => true),
    catch: (cause) =>
      new DaemonSyncIoError({
        operation: "access",
        path,
        code: toErrnoCode(cause),
        message: `access failed for ${path}.`,
        details: toCauseDetails(cause),
      }),
  }).pipe(
    Effect.match({
      onSuccess: () => Effect.succeed(true),
      onFailure: (error) =>
        error.code === "ENOENT" ? Effect.succeed(false) : Effect.fail(error),
    }),
    Effect.flatten
  );

const readJsonFile = <A>(
  path: string,
  scope: string,
  decode: (input: unknown) => A
) =>
  readUtf8(path, "readFile").pipe(
    Effect.flatMap((raw) =>
      Effect.try({
        try: () => JSON.parse(raw),
        catch: (cause) =>
          new DaemonSyncParseError({
            scope,
            path,
            message: `${scope} contains invalid JSON.`,
            details: toCauseDetails(cause),
          }),
      })
    ),
    Effect.flatMap((parsed) =>
      Effect.try({
        try: () => decode(parsed),
        catch: (cause) =>
          new DaemonSyncParseError({
            scope,
            path,
            message: `${scope} failed schema validation.`,
            details: toCauseDetails(cause),
          }),
      })
    )
  );

const readSyncStateEffect = (config: DaemonConfig) =>
  readJsonFile(
    resolveSyncStateFile(config),
    "Daemon sync state",
    decodeSyncRuntimeStateSync
  ).pipe(
    Effect.catchTag("DaemonSyncIoError", (error) =>
      error.code === "ENOENT"
        ? Effect.succeed(createEmptySyncState())
        : Effect.fail(error)
    )
  );

const writeSyncStateEffect = (config: DaemonConfig, state: SyncRuntimeState) =>
  writeUtf8Atomic(
    resolveSyncStateFile(config),
    `${JSON.stringify(
      {
        ...state,
        updatedAt: toIsoNow(),
      },
      null,
      2
    )}\n`
  );

const ensureStateDirsEffect = (config: DaemonConfig) =>
  Effect.all([
    Effect.tryPromise({
      try: () => mkdir(config.state.rootDir, { recursive: true }),
      catch: (cause) =>
        new DaemonSyncIoError({
          operation: "mkdir",
          path: config.state.rootDir,
          code: toErrnoCode(cause),
          message: `mkdir failed for ${config.state.rootDir}.`,
          details: toCauseDetails(cause),
        }),
    }),
    Effect.tryPromise({
      try: () => mkdir(config.state.journalDir, { recursive: true }),
      catch: (cause) =>
        new DaemonSyncIoError({
          operation: "mkdir",
          path: config.state.journalDir,
          code: toErrnoCode(cause),
          message: `mkdir failed for ${config.state.journalDir}.`,
          details: toCauseDetails(cause),
        }),
    }),
    Effect.tryPromise({
      try: () => mkdir(config.state.checkpointDir, { recursive: true }),
      catch: (cause) =>
        new DaemonSyncIoError({
          operation: "mkdir",
          path: config.state.checkpointDir,
          code: toErrnoCode(cause),
          message: `mkdir failed for ${config.state.checkpointDir}.`,
          details: toCauseDetails(cause),
        }),
    }),
  ]).pipe(Effect.asVoid);

const readJournalEntriesEffect = (config: DaemonConfig) =>
  readUtf8(resolveJournalFile(config), "readFile").pipe(
    Effect.catchTag("DaemonSyncIoError", (error) =>
      error.code === "ENOENT" ? Effect.succeed("") : Effect.fail(error)
    ),
    Effect.flatMap((raw) =>
      Effect.forEach(
        raw
          .split(/\r?\n/)
          .filter((line) => line.trim().length > 0)
          .map((line, index) => ({ index, line })),
        ({ index, line }) =>
          Effect.try({
            try: () => JSON.parse(line),
            catch: (cause) =>
              new DaemonSyncParseError({
                scope: "Daemon journal",
                path: `${resolveJournalFile(config)}:${index + 1}`,
                message: "Daemon journal contains invalid JSON.",
                details: toCauseDetails(cause),
              }),
          }).pipe(
            Effect.flatMap((parsed) =>
              Effect.try({
                try: () => decodeJournalEntrySync(parsed),
                catch: (cause) =>
                  new DaemonSyncParseError({
                    scope: "Daemon journal",
                    path: `${resolveJournalFile(config)}:${index + 1}`,
                    message: "Daemon journal entry failed schema validation.",
                    details: toCauseDetails(cause),
                  }),
              })
            )
          ),
        { concurrency: 1 }
      )
    )
  );

const appendJournalEntriesEffect = (
  config: DaemonConfig,
  entries: readonly JournalEntry[]
) =>
  entries.length === 0
    ? Effect.void
    : readUtf8(resolveJournalFile(config), "readFile").pipe(
        Effect.catchTag("DaemonSyncIoError", (error) =>
          error.code === "ENOENT" ? Effect.succeed("") : Effect.fail(error)
        ),
        Effect.flatMap((existing) =>
          writeUtf8Atomic(
            resolveJournalFile(config),
            `${existing}${existing && !existing.endsWith("\n") ? "\n" : ""}${entries
              .map((entry) => JSON.stringify(entry))
              .join("\n")}\n`
          )
        )
      );

const listJsonlFilesEffect = (rootPath: string) =>
  Effect.gen(function* () {
    const exists = yield* fileExists(rootPath);
    if (!exists) {
      return [] as string[];
    }
    let discovered: string[] = [];
    let stack = [rootPath];
    while (stack.length > 0 && discovered.length < 2_000) {
      const current = stack.pop();
      if (!current) {
        continue;
      }
      const entriesAttempt = yield* Effect.tryPromise({
        try: () => readdir(current, { withFileTypes: true }),
        catch: (cause) =>
          new DaemonSyncIoError({
            operation: "readdir",
            path: current,
            code: toErrnoCode(cause),
            message: `readdir failed for ${current}.`,
            details: toCauseDetails(cause),
          }),
      }).pipe(
        Effect.match({
          onSuccess: (entries) => ({
            status: "success" as const,
            entries,
          }),
          onFailure: (error) => ({
            status: "failure" as const,
            error,
          }),
        })
      );
      if (entriesAttempt.status === "failure") {
        if (
          entriesAttempt.error.code === "ENOTDIR" &&
          current.toLowerCase().endsWith(".jsonl")
        ) {
          discovered = [...discovered, current];
          continue;
        }
        return yield* Effect.fail(entriesAttempt.error);
      }
      const entries = entriesAttempt.entries;
      if (entries.length === 0 && current.toLowerCase().endsWith(".jsonl")) {
        discovered = [...discovered, current];
        continue;
      }
      for (const entry of [...entries].sort((left, right) =>
        left.name.localeCompare(right.name)
      )) {
        const absolutePath = resolve(current, entry.name);
        if (entry.isDirectory()) {
          stack = [...stack, absolutePath];
          continue;
        }
        if (entry.isFile() && entry.name.toLowerCase().endsWith(".jsonl")) {
          discovered = [...discovered, absolutePath];
        }
      }
    }
    return [...new Set(discovered)].sort((left, right) => left.localeCompare(right));
  });

const defaultSourceRoots = (source: SupportedSourceName): readonly string[] =>
  source === "codex"
    ? [
        resolve(homedir(), ".codex", "archived_sessions"),
        resolve(homedir(), ".codex", "sessions"),
      ]
    : source === "claude"
      ? [
          resolve(homedir(), ".claude", "transcripts"),
          resolve(homedir(), ".claude", "projects"),
        ]
      : [process.cwd()];

const sourceRootsFor = (
  config: DaemonConfig,
  source: SupportedSourceName
): readonly string[] => {
  const adapter =
    source === "codex"
      ? config.sources.codex
      : source === "claude"
        ? config.sources.claude
        : config.sources.plan;
  return adapter?.enabled === false
    ? []
    : adapter?.roots?.length
      ? adapter.roots
      : defaultSourceRoots(source);
};

const chunkItems = <T>(items: readonly T[], chunkSize = DEFAULT_INGEST_CHUNK_SIZE) =>
  items.reduce<readonly T[][]>(
    (chunks, item, index) =>
      index % chunkSize === 0
        ? [...chunks, [item]]
        : [
            ...chunks.slice(0, -1),
            [...(chunks[chunks.length - 1] ?? []), item],
          ],
    []
  );

const buildIngestEvent = (input: {
  readonly source: SupportedSourceName;
  readonly sourceFile: string;
  readonly sourceLine: number;
  readonly content: string;
}): IngestEvent => ({
  id: `evt_${hashValue(
    `${input.source}|${input.sourceFile}|${input.sourceLine}|${input.content}`
  ).slice(0, 24)}`,
  type: "note",
  source:
    input.source === "codex"
      ? "codex-cli"
      : input.source === "claude"
        ? "claude-code"
        : "plan",
  content: input.content,
});

const buildCollectedEvent = (input: {
  readonly source: SupportedSourceName;
  readonly sourceFile: string;
  readonly sourceLine: number;
  readonly content: string;
  readonly path?: string | null;
  readonly repoRoot?: string | null;
  readonly workspaceRoot?: string | null;
}): CollectedEvent => ({
  source: input.source,
  sourceFile: input.sourceFile,
  sourceLine: input.sourceLine,
  path: normalizeMaybePath(input.path ?? null),
  repoRoot: normalizeMaybePath(input.repoRoot ?? input.path ?? null),
  workspaceRoot: normalizeMaybePath(
    input.workspaceRoot ?? input.repoRoot ?? input.path ?? null
  ),
  event: buildIngestEvent({
    source: input.source,
    sourceFile: input.sourceFile,
    sourceLine: input.sourceLine,
    content: input.content,
  }),
});

const collectPlanEventsEffect = (input: {
  readonly planPath: string;
  readonly cursor: SourceCursorRecord | undefined;
}): Effect.Effect<PlanCollectionResult, DaemonSyncIoError> =>
  fileExists(input.planPath).pipe(
    Effect.flatMap((exists) => {
      if (!exists) {
        return Effect.succeed<PlanCollectionResult>({
          events: [],
          cursorUpdate: null,
          scannedLines: 0,
        });
      }
      return readUtf8(input.planPath, "readFile").pipe(
        Effect.map(
          (raw): PlanCollectionResult => {
            const sanitized = sanitizeKnowledgeContent(raw);
            const digest = hashValue(sanitized);
            const scannedLines = raw.split(/\r?\n/).length;
            if (input.cursor?.digest === digest) {
              return {
                events: [],
                cursorUpdate: {
                  cursor: 0,
                  digest,
                  updatedAt: input.cursor.updatedAt,
                },
                scannedLines,
              };
            }
            return {
              events: sanitized
                ? [
                    buildCollectedEvent({
                      source: "plan",
                      sourceFile: input.planPath,
                      sourceLine: 1,
                      content: sanitizeKnowledgeContent(
                        `PLAN.md snapshot ${sanitized}`
                      ),
                      path: input.planPath,
                      repoRoot: dirname(input.planPath),
                      workspaceRoot: dirname(input.planPath),
                    }),
                  ]
                : [],
              cursorUpdate: {
                cursor: 0,
                digest,
                updatedAt: toIsoNow(),
              },
              scannedLines,
            };
          }
        )
      );
    })
  );

const indexCodexSessionHintsEffect = (roots: readonly string[]) =>
  Effect.gen(function* () {
    const hints = new Map<string, string>();
    for (const root of roots) {
      const files = yield* listJsonlFilesEffect(root);
      for (const filePath of files) {
        const raw = yield* readUtf8(filePath, "readFile").pipe(
          Effect.catchTag("DaemonSyncIoError", (error) =>
            error.code === "ENOENT" ? Effect.succeed("") : Effect.fail(error)
          )
        );
        const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
        for (const line of lines) {
          const parsed = parseJsonLine(line);
          if (isCodexSessionMeta(parsed)) {
            const sessionId = parsed.payload.id ?? "";
            const cwd = parsed.payload.cwd ?? "";
            if (sessionId && cwd) {
              hints.set(sessionId, resolve(cwd));
              break;
            }
          }
        }
      }
    }
    return hints;
  });

const tailCodexFileEffect = (input: {
  readonly filePath: string;
  readonly startCursor: number;
  readonly maxEvents: number;
  readonly sessionHints: ReadonlyMap<string, string>;
}) =>
  readUtf8(input.filePath, "readFile").pipe(
    Effect.catchTag("DaemonSyncIoError", (error) =>
      error.code === "ENOENT" ? Effect.succeed("") : Effect.fail(error)
    ),
    Effect.map((raw) => {
      const lines = raw.split(/\r?\n/);
      let currentPath: string | null = null;
      let events: CollectedEvent[] = [];
      let scannedLines = 0;
      const safeCursor =
        input.startCursor >= 0 && input.startCursor <= lines.length
          ? input.startCursor
          : 0;

      for (let index = 0; index < lines.length; index += 1) {
        const rawLine = lines[index]?.trim() ?? "";
        if (!rawLine) {
          continue;
        }
        const parsed = parseJsonLine(rawLine);
        if (isCodexSessionMeta(parsed)) {
          currentPath = normalizeMaybePath(parsed.payload.cwd ?? null);
        }
        if (index < safeCursor) {
          continue;
        }
        scannedLines += 1;
        if (events.length >= input.maxEvents) {
          return {
            events,
            nextCursor: index,
            scannedLines,
          };
        }
        if (isCodexSessionMeta(parsed)) {
          continue;
        }
        const historyText =
          isCodexHistoryLine(parsed) && parsed.text ? parsed.text : "";
        const historyPath =
          isCodexHistoryLine(parsed) && parsed.session_id
            ? normalizeMaybePath(input.sessionHints.get(parsed.session_id) ?? null)
            : null;
        const userContent =
          isCodexUserMessage(parsed)
            ? contentTextFromUnknown(parsed.payload.content)
            : "";
        const normalizedPath = historyPath ?? currentPath;
        const content = sanitizeKnowledgeContent(historyText || userContent);
        if (!content) {
          continue;
        }
        events = [
          ...events,
          buildCollectedEvent({
            source: "codex",
            sourceFile: input.filePath,
            sourceLine: index + 1,
            content: sanitizeKnowledgeContent(
              `${basename(input.filePath)}:${index + 1} ${content}`
            ),
            path: normalizedPath,
          }),
        ];
      }
      return {
        events,
        nextCursor: lines.length,
        scannedLines,
      };
    })
  );

const tailClaudeFileEffect = (input: {
  readonly filePath: string;
  readonly startCursor: number;
  readonly maxEvents: number;
}) =>
  readUtf8(input.filePath, "readFile").pipe(
    Effect.catchTag("DaemonSyncIoError", (error) =>
      error.code === "ENOENT" ? Effect.succeed("") : Effect.fail(error)
    ),
    Effect.map((raw) => {
      const lines = raw.split(/\r?\n/);
      let events: CollectedEvent[] = [];
      let scannedLines = 0;
      const safeCursor =
        input.startCursor >= 0 && input.startCursor <= lines.length
          ? input.startCursor
          : 0;
      for (let index = safeCursor; index < lines.length; index += 1) {
        if (events.length >= input.maxEvents) {
          return {
            events,
            nextCursor: index,
            scannedLines,
          };
        }
        scannedLines += 1;
        const rawLine = lines[index]?.trim() ?? "";
        if (!rawLine) {
          continue;
        }
        const parsed = parseJsonLine(rawLine);
        const content = sanitizeKnowledgeContent(
          isClaudeUserLine(parsed)
            ? parsed.content
            : isString(parsed)
              ? parsed
              : ""
        );
        if (!content) {
          continue;
        }
        events = [
          ...events,
          buildCollectedEvent({
            source: "claude",
            sourceFile: input.filePath,
            sourceLine: index + 1,
            content: sanitizeKnowledgeContent(
              `${basename(input.filePath)}:${index + 1} ${content}`
            ),
          }),
        ];
      }
      return {
        events,
        nextCursor: lines.length,
        scannedLines,
      };
    })
  );

const collectSourceEventsEffect = (input: {
  readonly config: DaemonConfig;
  readonly state: SyncRuntimeState;
}) =>
  Effect.gen(function* () {
    let events: CollectedEvent[] = [];
    let cursorUpdates: Record<string, SourceCursorRecord> = {};
    let sourceStats: SourceCollectionStat[] = [];
    const now = toIsoNow();
    const maxEventsPerCycle = input.config.sources.defaults.maxEventsPerCycle;

    for (const source of ["codex", "claude", "plan"] as const) {
      if (events.length >= maxEventsPerCycle) {
        break;
      }
      const roots = sourceRootsFor(input.config, source);
      if (roots.length === 0) {
        continue;
      }
      if (source === "plan") {
        for (const root of roots) {
          const planPath = root.endsWith("PLAN.md") ? root : resolve(root, "PLAN.md");
          const collected = yield* collectPlanEventsEffect({
            planPath,
            cursor: input.state.sourceCursors[planPath],
          });
          sourceStats = [
            ...sourceStats.filter((entry) => entry.source !== source),
            {
              source,
              filesScanned:
                (sourceStats.find((entry) => entry.source === source)?.filesScanned ??
                  0) + 1,
              linesScanned:
                (sourceStats.find((entry) => entry.source === source)?.linesScanned ??
                  0) + collected.scannedLines,
              eventsPrepared:
                (sourceStats.find((entry) => entry.source === source)
                  ?.eventsPrepared ?? 0) + collected.events.length,
            },
          ];
          if (collected.cursorUpdate) {
            cursorUpdates = {
              ...cursorUpdates,
              [planPath]: {
                ...collected.cursorUpdate,
                updatedAt: now,
              },
            };
          }
          events = [...events, ...collected.events].slice(0, maxEventsPerCycle);
        }
        continue;
      }

      const sessionHints =
        source === "codex" ? yield* indexCodexSessionHintsEffect(roots) : new Map<string, string>();
      const discoveredFiles = (
        yield* Effect.forEach(roots, (root) => listJsonlFilesEffect(root), {
          concurrency: 1,
        })
      )
        .flat()
        .sort((left, right) => left.localeCompare(right));

      for (const filePath of discoveredFiles) {
        if (events.length >= maxEventsPerCycle) {
          break;
        }
        const remaining = Math.max(0, maxEventsPerCycle - events.length);
        const collected =
          source === "codex"
            ? yield* tailCodexFileEffect({
                filePath,
                startCursor: input.state.sourceCursors[filePath]?.cursor ?? 0,
                maxEvents: remaining,
                sessionHints,
              })
            : yield* tailClaudeFileEffect({
                filePath,
                startCursor: input.state.sourceCursors[filePath]?.cursor ?? 0,
                maxEvents: remaining,
              });
        const existingStat = sourceStats.find((entry) => entry.source === source);
        sourceStats = [
          ...sourceStats.filter((entry) => entry.source !== source),
          {
            source,
            filesScanned: (existingStat?.filesScanned ?? 0) + 1,
            linesScanned: (existingStat?.linesScanned ?? 0) + collected.scannedLines,
            eventsPrepared:
              (existingStat?.eventsPrepared ?? 0) + collected.events.length,
          },
        ];
        cursorUpdates = {
          ...cursorUpdates,
          [filePath]: {
            cursor: collected.nextCursor,
            digest: null,
            updatedAt: now,
          },
        };
        events = [...events, ...collected.events].slice(0, maxEventsPerCycle);
      }
    }

    return {
      events,
      cursorUpdates,
      sourceStats: sourceStats.sort((left, right) =>
        left.source.localeCompare(right.source)
      ),
    };
  });

const pendingEventsByMemory = (
  journalEntries: readonly JournalEntry[],
  deliveries: SyncRuntimeState["deliveries"]
) =>
  journalEntries.reduce<Map<string, number>>((acc, entry) => {
    if (!entry.memory) {
      return acc;
    }
    const checkpoint = deliveries[entry.memory];
    if (!checkpoint || entry.sequence > checkpoint.lastDeliveredSequence) {
      acc.set(entry.memory, (acc.get(entry.memory) ?? 0) + 1);
    }
    return acc;
  }, new Map<string, number>());

const isProcessAlive = (pid: number): boolean => {
  return Effect.runSync(
    Effect.try({
      try: () => {
        process.kill(pid, 0);
        return true;
      },
      catch: () => false,
    }).pipe(Effect.orElseSucceed(() => false))
  );
};

const buildDaemonStatusViewEffect = (
  configFile: string,
  config: DaemonConfig,
  state: SyncRuntimeState
) =>
  readJournalEntriesEffect(config).pipe(
    Effect.flatMap((journalEntries) =>
      Effect.gen(function* () {
        const deliveries: DaemonStatusDeliveryView[] = [];
        const pendingByMemory = pendingEventsByMemory(journalEntries, state.deliveries);
        for (const [memoryAlias, memory] of Object.entries(config.memories).sort(
          ([left], [right]) => left.localeCompare(right)
        )) {
          const checkpoint =
            state.deliveries[memoryAlias] ?? createEmptyDeliveryCheckpoint();
          const account = config.accounts[memory.account];
          if (!account) {
            return yield* Effect.fail(
              new DaemonSyncParseError({
                scope: "Daemon config",
                path: configFile,
                message: `Memory '${memoryAlias}' references unknown account '${memory.account}'.`,
                details: "Re-run config validation and repair account references.",
              })
            );
          }
          deliveries.push({
            memory: memoryAlias,
            account: memory.account,
            accountType: account.type,
            lastDeliveredSequence: checkpoint.lastDeliveredSequence,
            deliveredEvents: checkpoint.deliveredEvents,
            accepted: checkpoint.accepted,
            duplicates: checkpoint.duplicates,
            pendingEvents: pendingByMemory.get(memoryAlias) ?? 0,
            lastError: checkpoint.lastError,
          });
        }
        return {
          operation: "status" as const,
          configFile,
          stateRoot: config.state.rootDir,
          runtimeStateFile: resolveRuntimeStateFile(config),
          journalFile: resolveJournalFile(config),
          daemon: {
            pid: state.daemonPid,
            startedAt: state.daemonStartedAt,
            alive: state.daemonPid ? isProcessAlive(state.daemonPid) : false,
          },
          sync: {
            lastRunAt: state.lastRunAt,
            lastSuccessAt: state.lastSuccessAt,
            lastError: state.lastError,
            nextSequence: state.nextSequence,
          },
          journal: {
            entries: journalEntries.length,
            pendingReview: journalEntries.filter(
              (entry) => entry.routeStatus === "review"
            ).length,
            pendingDrop: journalEntries.filter(
              (entry) => entry.routeStatus === "drop"
            ).length,
          },
          deliveries,
        } satisfies DaemonStatusView;
      })
    )
  );

const getDaemonStatusEffect = (configFile: string | null | undefined) =>
  Effect.gen(function* () {
    const loaded = yield* loadDaemonConfigEffect(configFile);
    yield* ensureStateDirsEffect(loaded.config);
    const state = yield* readSyncStateEffect(loaded.config);
    return yield* buildDaemonStatusViewEffect(
      loaded.configFile,
      loaded.config,
      state
    );
  });

const clearStaleDaemonPidEffect = (configFile: string | null | undefined) =>
  Effect.gen(function* () {
    const loaded = yield* loadDaemonConfigEffect(configFile);
    yield* ensureStateDirsEffect(loaded.config);
    const state = yield* readSyncStateEffect(loaded.config);
    const nextState =
      state.daemonPid && !isProcessAlive(state.daemonPid)
        ? {
            ...state,
            daemonPid: null,
            daemonStartedAt: null,
          }
        : state;
    if (nextState !== state) {
      yield* writeSyncStateEffect(loaded.config, nextState);
    }
    return yield* buildDaemonStatusViewEffect(
      loaded.configFile,
      loaded.config,
      nextState
    );
  });

const updateDaemonStatusEffect = (input: {
  readonly configFile?: string | null;
  readonly daemonPid: number | null;
  readonly daemonStartedAt?: string | null;
}) =>
  Effect.gen(function* () {
    const loaded = yield* loadDaemonConfigEffect(input.configFile);
    yield* ensureStateDirsEffect(loaded.config);
    const state = yield* readSyncStateEffect(loaded.config);
    const nextState: SyncRuntimeState = {
      ...state,
      daemonPid: input.daemonPid,
      daemonStartedAt:
        input.daemonPid === null
          ? null
          : input.daemonStartedAt ?? state.daemonStartedAt ?? toIsoNow(),
    };
    yield* writeSyncStateEffect(loaded.config, nextState);
    return yield* buildDaemonStatusViewEffect(
      loaded.configFile,
      loaded.config,
      nextState
    );
  });

const runConfiguredSyncCycleEffect = (configFile: string | null | undefined) =>
  Effect.gen(function* () {
    const startedAt = toIsoNow();
    const startedMs = Date.now();
    const loaded = yield* loadDaemonConfigEffect(configFile);
    yield* ensureStateDirsEffect(loaded.config);
    const state = yield* readSyncStateEffect(loaded.config);
    const runtimeStateFile = resolveRuntimeStateFile(loaded.config);
    const journalFile = resolveJournalFile(loaded.config);
    const collected = yield* collectSourceEventsEffect({
      config: loaded.config,
      state,
    });
    const collectedAt = toIsoNow();
    const numberedJournalEntries = collected.events.map<JournalEntry>((event, index) => {
      const resolution = explainDaemonRouteResolution(loaded.config, {
        path: event.path,
        repoRoot: event.repoRoot,
        workspaceRoot: event.workspaceRoot,
        source: event.source as DaemonConfigRouteSource,
      });
      return {
        sequence: state.nextSequence + index,
        collectedAt,
        source: event.source,
        sourceFile: event.sourceFile,
        sourceLine: event.sourceLine,
        path: event.path,
        repoRoot: event.repoRoot,
        workspaceRoot: event.workspaceRoot,
        routeStatus: resolution.status,
        memory:
          resolution.status === "matched" || resolution.status === "default"
            ? resolution.memory
            : null,
        routeIndex: resolution.routeIndex,
        event: event.event,
      };
    });
    const nextStateAfterJournal: SyncRuntimeState = {
      ...state,
      nextSequence: state.nextSequence + numberedJournalEntries.length,
      sourceCursors: {
        ...state.sourceCursors,
        ...collected.cursorUpdates,
      },
      lastRunAt: startedAt,
    };
    yield* appendJournalEntriesEffect(loaded.config, numberedJournalEntries);
    const journalEntriesFull = yield* readJournalEntriesEffect(loaded.config);

    let deliveries = [] as DaemonSyncSummary["deliveries"];
    let deliveryErrors = [] as string[];
    let blockedMemories = [] as string[];
    let deliveredEvents = 0;
    let accepted = 0;
    let duplicates = 0;
    let nextState = nextStateAfterJournal;

    for (const [memoryAlias, memory] of Object.entries(loaded.config.memories).sort(
      ([left], [right]) => left.localeCompare(right)
    )) {
      const checkpoint =
        nextState.deliveries[memoryAlias] ?? createEmptyDeliveryCheckpoint();
      const pendingEntries = journalEntriesFull.filter(
        (entry) =>
          entry.memory === memoryAlias &&
          entry.sequence > checkpoint.lastDeliveredSequence
      );
      const account = loaded.config.accounts[memory.account];
      if (!account) {
        return yield* Effect.fail(
          new DaemonSyncParseError({
            scope: "Daemon config",
            path: loaded.configFile,
            message: `Memory '${memoryAlias}' references unknown account '${memory.account}'.`,
            details: "Re-run config validation and repair account references.",
          })
        );
      }
      if (pendingEntries.length === 0) {
        deliveries = [
          ...deliveries,
          {
            memory: memoryAlias,
            account: memory.account,
            accountType: account.type,
            queuedEvents: 0,
            deliveredEvents: checkpoint.deliveredEvents,
            accepted: checkpoint.accepted,
            duplicates: checkpoint.duplicates,
            lastDeliveredSequence: checkpoint.lastDeliveredSequence,
            lastError: checkpoint.lastError,
          },
        ];
        continue;
      }

      if (memory.readOnly) {
        const error = new DaemonSyncDeliveryError({
          memory: memoryAlias,
          account: memory.account,
          message: `Memory '${memoryAlias}' is read-only.`,
          details: "Remove readOnly or route writes elsewhere.",
        });
        const updatedCheckpoint = {
          ...checkpoint,
          updatedAt: toIsoNow(),
          lastError: error.message,
        };
        nextState = {
          ...nextState,
          deliveries: {
            ...nextState.deliveries,
            [memoryAlias]: updatedCheckpoint,
          },
          lastError: error.message,
        };
        deliveryErrors = [...deliveryErrors, error.message];
        deliveries = [
          ...deliveries,
          {
            memory: memoryAlias,
            account: memory.account,
            accountType: account.type,
            queuedEvents: pendingEntries.length,
            deliveredEvents: updatedCheckpoint.deliveredEvents,
            accepted: updatedCheckpoint.accepted,
            duplicates: updatedCheckpoint.duplicates,
            lastDeliveredSequence: updatedCheckpoint.lastDeliveredSequence,
            lastError: updatedCheckpoint.lastError,
          },
        ];
        continue;
      }

      if (account.type !== "local") {
        const error = new DaemonSyncDeliveryError({
          memory: memoryAlias,
          account: memory.account,
          message: `Remote account '${memory.account}' is not yet supported by config-backed sync.`,
          details: "Wait for secure managed auth and remote delivery support.",
        });
        const updatedCheckpoint = {
          ...checkpoint,
          updatedAt: toIsoNow(),
          lastError: error.message,
        };
        nextState = {
          ...nextState,
          deliveries: {
            ...nextState.deliveries,
            [memoryAlias]: updatedCheckpoint,
          },
          lastError: error.message,
        };
        deliveryErrors = [...deliveryErrors, error.message];
        blockedMemories = [...blockedMemories, memoryAlias];
        deliveries = [
          ...deliveries,
          {
            memory: memoryAlias,
            account: memory.account,
            accountType: account.type,
            queuedEvents: pendingEntries.length,
            deliveredEvents: updatedCheckpoint.deliveredEvents,
            accepted: updatedCheckpoint.accepted,
            duplicates: updatedCheckpoint.duplicates,
            lastDeliveredSequence: updatedCheckpoint.lastDeliveredSequence,
            lastError: updatedCheckpoint.lastError,
          },
        ];
        continue;
      }

      let cycleAccepted = 0;
      let cycleDuplicates = 0;
      const deliveryAttempt = yield* Effect.forEach(
        chunkItems(pendingEntries.map((entry) => entry.event)),
        (chunk) =>
          Effect.tryPromise({
            try: () =>
              executeRuntimeOperation({
                operation: "ingest",
                requestBody: {
                  storeId: memory.storeId,
                  profile: memory.profile,
                  events: chunk,
                },
                stateFile: runtimeStateFile,
              }),
            catch: (cause) =>
              new DaemonSyncDeliveryError({
                memory: memoryAlias,
                account: memory.account,
                message: `Local ingest failed for memory '${memoryAlias}'.`,
                details: toCauseDetails(cause),
              }),
          }).pipe(
            Effect.map((result) => {
              const resultRecord = isUnknownRecord(result) ? result : {};
              const acceptedValue = Number.parseInt(
                String(resultRecord["accepted"] ?? ""),
                10
              );
              const duplicatesValue = Number.parseInt(
                String(resultRecord["duplicates"] ?? ""),
                10
              );
              cycleAccepted +=
                Number.isFinite(acceptedValue) && acceptedValue >= 0
                  ? acceptedValue
                  : chunk.length;
              cycleDuplicates +=
                Number.isFinite(duplicatesValue) && duplicatesValue >= 0
                  ? duplicatesValue
                  : 0;
            })
          ),
        { concurrency: 1 }
      ).pipe(
        Effect.match({
          onSuccess: () => ({
            status: "success" as const,
          }),
          onFailure: (error) => ({
            status: "failure" as const,
            error,
          }),
        })
      );

      if (deliveryAttempt.status === "failure") {
        const updatedCheckpoint = {
          ...checkpoint,
          updatedAt: toIsoNow(),
          lastError: deliveryAttempt.error.message,
        };
        nextState = {
          ...nextState,
          deliveries: {
            ...nextState.deliveries,
            [memoryAlias]: updatedCheckpoint,
          },
          lastError: deliveryAttempt.error.message,
        };
        deliveryErrors = [...deliveryErrors, deliveryAttempt.error.message];
        deliveries = [
          ...deliveries,
          {
            memory: memoryAlias,
            account: memory.account,
            accountType: account.type,
            queuedEvents: pendingEntries.length,
            deliveredEvents: updatedCheckpoint.deliveredEvents,
            accepted: updatedCheckpoint.accepted,
            duplicates: updatedCheckpoint.duplicates,
            lastDeliveredSequence: updatedCheckpoint.lastDeliveredSequence,
            lastError: updatedCheckpoint.lastError,
          },
        ];
        continue;
      }

      const updatedCheckpoint: DeliveryCheckpointRecord = {
        ...checkpoint,
        lastDeliveredSequence:
          pendingEntries[pendingEntries.length - 1]?.sequence ??
          checkpoint.lastDeliveredSequence,
        deliveredEvents: checkpoint.deliveredEvents + pendingEntries.length,
        accepted: checkpoint.accepted + cycleAccepted,
        duplicates: checkpoint.duplicates + cycleDuplicates,
        updatedAt: toIsoNow(),
        lastError: null,
      };
      nextState = {
        ...nextState,
        deliveries: {
          ...nextState.deliveries,
          [memoryAlias]: updatedCheckpoint,
        },
      };
      deliveredEvents += pendingEntries.length;
      accepted += cycleAccepted;
      duplicates += cycleDuplicates;
      deliveries = [
        ...deliveries,
        {
          memory: memoryAlias,
          account: memory.account,
          accountType: account.type,
          queuedEvents: pendingEntries.length,
          deliveredEvents: updatedCheckpoint.deliveredEvents,
          accepted: updatedCheckpoint.accepted,
          duplicates: updatedCheckpoint.duplicates,
          lastDeliveredSequence: updatedCheckpoint.lastDeliveredSequence,
          lastError: updatedCheckpoint.lastError,
        },
      ];
    }

    const finalState: SyncRuntimeState = {
      ...nextState,
      lastSuccessAt: deliveryErrors.length === 0 ? toIsoNow() : nextState.lastSuccessAt,
      lastError: deliveryErrors.length === 0 ? null : deliveryErrors.join("; "),
    };
    yield* writeSyncStateEffect(loaded.config, finalState);

    const summary: DaemonSyncSummary = {
      operation: "sync",
      configFile: loaded.configFile,
      stateRoot: loaded.config.state.rootDir,
      runtimeStateFile,
      journalFile,
      startedAt,
      completedAt: toIsoNow(),
      durationMs: Date.now() - startedMs,
      preparedEvents: collected.events.length,
      journaledEvents: numberedJournalEntries.length,
      reviewQueueEvents: numberedJournalEntries.filter(
        (entry) => entry.routeStatus === "review"
      ).length,
      droppedEvents: numberedJournalEntries.filter(
        (entry) => entry.routeStatus === "drop"
      ).length,
      deliveredEvents,
      accepted,
      duplicates,
      blockedMemories: blockedMemories.sort((left, right) =>
        left.localeCompare(right)
      ),
      sourceStats: collected.sourceStats,
      deliveries,
    };

    if (deliveryErrors.length > 0) {
      return yield* Effect.fail(
        new DaemonSyncDeliveryError({
          memory: blockedMemories[0] ?? "multiple",
          account:
            blockedMemories[0] &&
            loaded.config.memories[blockedMemories[0]]
              ? loaded.config.memories[blockedMemories[0]]?.account ?? "multiple"
              : "multiple",
          message: "Sync completed with delivery errors.",
          details: deliveryErrors.join("; "),
        })
      );
    }

    return summary;
  });

export const clearStaleDaemonPid = (
  configFile: string | null | undefined
): Promise<DaemonStatusView> =>
  Effect.runPromise(clearStaleDaemonPidEffect(configFile));

export const updateDaemonStatus = (input: {
  readonly configFile?: string | null;
  readonly daemonPid: number | null;
  readonly daemonStartedAt?: string | null;
}): Promise<DaemonStatusView> =>
  Effect.runPromise(updateDaemonStatusEffect(input));

export const getDaemonStatus = (
  configFile: string | null | undefined
): Promise<DaemonStatusView> => Effect.runPromise(getDaemonStatusEffect(configFile));

export const runConfiguredSyncCycle = (
  configFile: string | null | undefined
): Promise<DaemonSyncSummary> =>
  Effect.runPromise(runConfiguredSyncCycleEffect(configFile));

export const runConfiguredSyncDaemon = (
  options: RunConfiguredSyncDaemonOptions = {}
): Promise<{ cycles: number; lastSummary: DaemonSyncSummary | null }> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const resolvedConfigFile = resolveDaemonConfigFilePath(options.configFile);
      const loaded = yield* loadDaemonConfigEffect(resolvedConfigFile);
      const intervalMs =
        options.intervalMs && options.intervalMs > 0
          ? options.intervalMs
          : loaded.config.defaults.sync.intervalMs;
      const maxCycles =
        options.maxCycles && options.maxCycles > 0 ? options.maxCycles : null;
      let cycles = 0;
      let lastSummary: DaemonSyncSummary | null = null;
      while (maxCycles === null || cycles < maxCycles) {
        const attempt = yield* runConfiguredSyncCycleEffect(
          resolvedConfigFile
        ).pipe(
          Effect.match({
            onSuccess: (summary) => ({
              status: "success" as const,
              summary,
            }),
            onFailure: (error) => ({
              status: "failure" as const,
              error,
            }),
          })
        );
        if (attempt.status === "success") {
          lastSummary = attempt.summary;
          options.onCycle?.(attempt.summary, null);
        } else {
          options.onCycle?.(null, new Error(attempt.error.message));
        }
        cycles += 1;
        if (maxCycles !== null && cycles >= maxCycles) {
          break;
        }
        yield* Effect.tryPromise({
          try: () => delay(Math.max(intervalMs, DEFAULT_DAEMON_POLL_DELAY_MS)),
          catch: (cause) =>
            new DaemonSyncIoError({
              operation: "delay",
              path: resolvedConfigFile,
              code: "DELAY_FAILED",
              message: "sync-daemon sleep failed.",
              details: toCauseDetails(cause),
            }),
        });
      }
      return {
        cycles,
        lastSummary,
      };
    })
  );
