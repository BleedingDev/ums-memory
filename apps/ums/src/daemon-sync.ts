import { createHash } from "node:crypto";
import {
  appendFile,
  type FileHandle,
  access,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, dirname, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { Duration, Effect, Predicate, Result, Schema } from "effect";

import { normalizeAdapterSourceAlias } from "../../../libs/shared/src/effect/contracts/services.ts";
import { validateUnknownSync } from "../../../libs/shared/src/effect/contracts/validators.ts";
import { executeRuntimeOperation } from "../../api/src/runtime-service.ts";
import {
  type DaemonConfig,
  type DaemonConfigRouteSource,
  type DaemonSourceBinding,
  type DaemonSourceBindingHealth,
  type DaemonSourceBindingStatus,
  buildDaemonSourceBindingId,
  explainDaemonRouteResolution,
  getDaemonSourceBindings,
  readDaemonConfig,
  resolveDaemonConfigFilePath,
} from "./daemon-config.ts";
import { loadManagedAccountCredential } from "./daemon-credentials.ts";
import {
  extractSanitizedSourceContent,
  sanitizeSourceContent,
} from "./source-redaction.ts";

const DEFAULT_INGEST_CHUNK_SIZE = 100;
const DEFAULT_DAEMON_POLL_DELAY_MS = 250;
const REMOTE_REQUEST_TIMEOUT_MS = 10_000;
const SYNC_LOCK_TIMEOUT_MS = 5_000;
const SYNC_LOCK_RETRY_MS = 100;
const SYNC_LOCK_STALE_MS = 60_000;
const GENERIC_SOURCE_RECORD_ARRAY_KEYS = new Set([
  "chats",
  "conversations",
  "entries",
  "events",
  "history",
  "items",
  "messages",
  "prompts",
  "requests",
  "sessions",
  "threads",
  "turns",
]);

type SupportedSourceName =
  | "codex"
  | "claude"
  | "cursor"
  | "opencode"
  | "codex-native"
  | "plan"
  | "vscode";
type DiscoverableSourceName = DaemonConfigRouteSource;
const DISCOVERABLE_SOURCE_NAMES = [
  "claude",
  "cursor",
  "codex",
  "codex-native",
  "opencode",
  "plan",
  "vscode",
] as const satisfies readonly DiscoverableSourceName[];
const JSONL_FILE_EXTENSIONS = [".jsonl"] as const;
const JSON_SOURCE_FILE_EXTENSIONS = [".json", ".jsonl"] as const;
const GUIDANCE_FILE_SPECS = [
  {
    relativePath: "PLAN.md",
    label: "Project plan",
  },
  {
    relativePath: "AGENTS.md",
    label: "Agent instructions",
  },
  {
    relativePath: "CLAUDE.md",
    label: "Claude instructions",
  },
  {
    relativePath: ".github/copilot-instructions.md",
    label: "Copilot instructions",
  },
] as const;

const NullableStringSchema = Schema.NullOr(Schema.String);
const UnknownRecordSchema = Schema.Record(Schema.String, Schema.Unknown);
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
const RemoteOperationEnvelopeSchema = Schema.Struct({
  ok: Schema.Literal(true),
  data: UnknownRecordSchema,
});
const RemoteIngestionSummarySchema = Schema.Struct({
  accepted: Schema.optional(NonNegativeIntSchema),
  duplicates: Schema.optional(NonNegativeIntSchema),
});

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
const SourceCheckpointFileSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  kind: Schema.Literal("source"),
  sourceFile: Schema.String,
  cursor: NonNegativeIntSchema,
  digest: NullableStringSchema,
  updatedAt: Schema.String,
});
const DeliveryCheckpointFileSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  kind: Schema.Literal("delivery"),
  memory: Schema.String,
  account: Schema.String,
  storeId: Schema.String,
  profile: Schema.String,
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
  source: Schema.Literals([
    "codex",
    "claude",
    "cursor",
    "codex-native",
    "opencode",
    "plan",
    "vscode",
  ]),
  sourceFile: Schema.String,
  sourceLine: PositiveIntSchema,
  sourceCursor: Schema.optional(SourceCursorSchema),
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
type SourceCheckpointFileRecord = Schema.Schema.Type<
  typeof SourceCheckpointFileSchema
>;
type DeliveryCheckpointFileRecord = Schema.Schema.Type<
  typeof DeliveryCheckpointFileSchema
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

interface SourceFileCollectionResult {
  readonly events: readonly CollectedEvent[];
  readonly nextCursor: number;
  readonly digest: string | null;
  readonly scannedLines: number;
}

export interface DaemonSourceDiscoveryCandidate {
  readonly id: string;
  readonly source: DiscoverableSourceName;
  readonly kind: DaemonSourceBinding["kind"];
  readonly path: string;
  readonly label: string;
  readonly existing: boolean;
  readonly currentStatus: DaemonSourceBindingStatus | null;
  readonly proposedStatus: DaemonSourceBindingStatus;
  readonly supportedForSync: boolean;
  readonly health: DaemonSourceBindingHealth;
  readonly evidenceCount: number;
  readonly recommended: boolean;
  readonly detectedAt: string;
}

export interface DaemonSourceView {
  readonly id: string;
  readonly source: DiscoverableSourceName;
  readonly kind: DaemonSourceBinding["kind"];
  readonly path: string;
  readonly label: string | null;
  readonly status: DaemonSourceBindingStatus;
  readonly supportedForSync: boolean;
  readonly activeForSync: boolean;
  readonly health: DaemonSourceBindingHealth;
  readonly persistedHealth: DaemonSourceBindingHealth | null;
  readonly lastSeenAt: string | null;
  readonly checkpointCount: number;
  readonly latestCheckpointAt: string | null;
  readonly checkpoints: ReadonlyArray<{
    readonly path: string;
    readonly cursor: number;
    readonly digest: string | null;
    readonly updatedAt: string;
  }>;
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
  readonly signal?: AbortSignal;
  readonly onCycle?: (
    result: DaemonSyncSummary | null,
    error: Error | null
  ) => void;
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

export class DaemonSyncLockError extends Schema.TaggedErrorClass<DaemonSyncLockError>()(
  "DaemonSyncLockError",
  {
    operation: Schema.String,
    path: Schema.String,
    message: Schema.String,
    details: Schema.String,
  }
) {}

const resolveManagedAccountSecretEffect = (input: {
  readonly accountAlias: string;
  readonly account: Extract<
    DaemonConfig["accounts"][string],
    { readonly type: "http" }
  >;
}) =>
  input.account.auth.mode === "token-env"
    ? (() => {
        const token = process.env[input.account.auth.env] ?? "";
        return token.trim()
          ? Effect.succeed(token)
          : Effect.fail(
              new DaemonSyncDeliveryError({
                memory: input.accountAlias,
                account: input.accountAlias,
                message: `Managed account '${input.accountAlias}' is missing env token '${input.account.auth.env}'.`,
                details:
                  "Export the configured env var or switch to secure credentialRef auth.",
              })
            );
      })()
    : loadManagedAccountCredential(input.account.auth.credentialRef).pipe(
        Effect.flatMap((credential) =>
          credential && credential.secret.trim()
            ? Effect.succeed(credential.secret)
            : Effect.fail(
                new DaemonSyncDeliveryError({
                  memory: input.accountAlias,
                  account: input.accountAlias,
                  message: `Managed account '${input.accountAlias}' has no secure credential stored.`,
                  details: `Run \`ums account login --name ${input.accountAlias} --secret-stdin\` before syncing.`,
                })
              )
        ),
        Effect.catchTags({
          DaemonCredentialExpiredError: (error) =>
            Effect.fail(
              new DaemonSyncDeliveryError({
                memory: input.accountAlias,
                account: input.accountAlias,
                message: `Managed account '${input.accountAlias}' secure credential expired at ${error.expiresAt}.`,
                details: `Run \`ums account login --name ${input.accountAlias} --secret-stdin --expires-at <timestamp>\` to refresh it.`,
              })
            ),
          DaemonCredentialRefError: (error) =>
            Effect.fail(
              new DaemonSyncDeliveryError({
                memory: input.accountAlias,
                account: input.accountAlias,
                message: `Managed account '${input.accountAlias}' has an invalid credentialRef.`,
                details: error.message,
              })
            ),
          DaemonCredentialStoreError: (error) =>
            Effect.fail(
              new DaemonSyncDeliveryError({
                memory: input.accountAlias,
                account: input.accountAlias,
                message: `Managed account '${input.accountAlias}' secure credential lookup failed.`,
                details: error.message,
              })
            ),
          DaemonCredentialRecordError: (error) =>
            Effect.fail(
              new DaemonSyncDeliveryError({
                memory: input.accountAlias,
                account: input.accountAlias,
                message: `Managed account '${input.accountAlias}' stored credential is invalid.`,
                details: error.message,
              })
            ),
        })
      );

const withRemoteRequestAbortEffect = <Success, Error>(
  execute: (signal: AbortSignal) => Effect.Effect<Success, Error, never>
): Effect.Effect<Success, Error, never> =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const abortController = new AbortController();
      const timeout = setTimeout(() => {
        abortController.abort();
      }, REMOTE_REQUEST_TIMEOUT_MS);
      return { abortController, timeout };
    }),
    ({ abortController }) => execute(abortController.signal),
    ({ timeout }) =>
      Effect.sync(() => {
        clearTimeout(timeout);
      })
  );

const readRemoteResponseTextEffect = (input: {
  readonly response: Response;
  readonly accountAlias: string;
  readonly memoryAlias: string;
  readonly operation: string;
}) =>
  Effect.tryPromise({
    try: () => input.response.text(),
    catch: (cause) =>
      new DaemonSyncDeliveryError({
        memory: input.memoryAlias,
        account: input.accountAlias,
        message: `Remote ${input.operation} failed for memory '${input.memoryAlias}'.`,
        details: toCauseDetails(cause),
      }),
  });

const decodeRemoteOperationPayloadEffect = (input: {
  readonly response: Response;
  readonly bodyText: string;
  readonly accountAlias: string;
  readonly memoryAlias: string;
  readonly operation: string;
}) =>
  input.response.ok
    ? Effect.try({
        try: () => {
          if (input.bodyText.trim().length === 0) {
            throw new Error("Remote operation response body is empty.");
          }
          const parsedBody = JSON.parse(input.bodyText);
          return decodeRemoteOperationEnvelopeSync(parsedBody).data;
        },
        catch: (cause) =>
          new DaemonSyncDeliveryError({
            memory: input.memoryAlias,
            account: input.accountAlias,
            message: `Remote ${input.operation} returned invalid payload for memory '${input.memoryAlias}'.`,
            details:
              input.bodyText.trim().length > 0
                ? input.bodyText.slice(0, 240)
                : toCauseDetails(cause),
          }),
      })
    : Effect.fail(
        new DaemonSyncDeliveryError({
          memory: input.memoryAlias,
          account: input.accountAlias,
          message: `Remote ${input.operation} failed for memory '${input.memoryAlias}'.`,
          details: `${input.response.status} ${input.response.statusText}: ${input.bodyText.slice(0, 240)}`,
        })
      );

export const executeRemoteAccountOperationEffect = (input: {
  readonly accountAlias: string;
  readonly account: Extract<
    DaemonConfig["accounts"][string],
    { readonly type: "http" }
  >;
  readonly memoryAlias: string;
  readonly memory: DaemonConfig["memories"][string];
  readonly operation: string;
  readonly request: Record<string, unknown>;
}) =>
  resolveManagedAccountSecretEffect({
    accountAlias: input.accountAlias,
    account: input.account,
  }).pipe(
    Effect.flatMap((token) =>
      withRemoteRequestAbortEffect((signal) =>
        Effect.tryPromise({
          try: () =>
            fetch(new URL(`/v1/${input.operation}`, input.account.apiBaseUrl), {
              method: "POST",
              headers: {
                "content-type": "application/json",
                authorization: `Bearer ${token}`,
                "x-ums-api-key": token,
                "x-ums-store": input.memory.storeId,
              },
              body: JSON.stringify({
                ...input.request,
                storeId: input.memory.storeId,
                profile: input.memory.profile,
              }),
              signal,
            }),
          catch: (cause) =>
            new DaemonSyncDeliveryError({
              memory: input.memoryAlias,
              account: input.accountAlias,
              message: `Remote ${input.operation} failed for memory '${input.memoryAlias}'.`,
              details: toCauseDetails(cause),
            }),
        }).pipe(
          Effect.flatMap((response) =>
            readRemoteResponseTextEffect({
              response,
              accountAlias: input.accountAlias,
              memoryAlias: input.memoryAlias,
              operation: input.operation,
            }).pipe(
              Effect.flatMap((bodyText) =>
                decodeRemoteOperationPayloadEffect({
                  response,
                  bodyText,
                  accountAlias: input.accountAlias,
                  memoryAlias: input.memoryAlias,
                  operation: input.operation,
                })
              )
            )
          )
        )
      )
    )
  );

const postRemoteIngestionChunkEffect = (input: {
  readonly accountAlias: string;
  readonly account: Extract<
    DaemonConfig["accounts"][string],
    { readonly type: "http" }
  >;
  readonly memoryAlias: string;
  readonly memory: DaemonConfig["memories"][string];
  readonly events: readonly IngestEvent[];
}) =>
  executeRemoteAccountOperationEffect({
    accountAlias: input.accountAlias,
    account: input.account,
    memoryAlias: input.memoryAlias,
    memory: input.memory,
    operation: "ingest",
    request: {
      events: input.events,
    },
  }).pipe(
    Effect.flatMap((response) =>
      Effect.try({
        try: () => decodeRemoteIngestionSummarySync(response),
        catch: (cause) =>
          new DaemonSyncDeliveryError({
            memory: input.memoryAlias,
            account: input.accountAlias,
            message: `Remote ingest returned invalid summary for memory '${input.memoryAlias}'.`,
            details: toCauseDetails(cause),
          }),
      })
    ),
    Effect.map((summary) => ({
      accepted: summary.accepted ?? input.events.length,
      duplicates: summary.duplicates ?? 0,
    }))
  );

const isErrnoCause = Schema.is(ErrnoCauseSchema);
const isString = Schema.is(Schema.String);
const isUnknownRecord = Schema.is(UnknownRecordSchema);
const isCodexSessionMeta = Schema.is(CodexSessionMetaSchema);
const isCodexHistoryLine = Schema.is(CodexHistoryLineSchema);
const isCodexUserMessage = Schema.is(CodexUserMessageSchema);
const isClaudeUserLine = Schema.is(ClaudeUserLineSchema);

const decodeSyncRuntimeStateSync: (input: unknown) => SyncRuntimeState =
  validateUnknownSync(
    SyncRuntimeStateSchema as SyncDecodingSchema<typeof SyncRuntimeStateSchema>
  );
const decodeRemoteOperationEnvelopeSync = validateUnknownSync(
  RemoteOperationEnvelopeSchema as SyncDecodingSchema<
    typeof RemoteOperationEnvelopeSchema
  >
);
const decodeRemoteIngestionSummarySync = validateUnknownSync(
  RemoteIngestionSummarySchema as SyncDecodingSchema<
    typeof RemoteIngestionSummarySchema
  >
);
const decodeSourceCheckpointFileSync = validateUnknownSync(
  SourceCheckpointFileSchema as SyncDecodingSchema<
    typeof SourceCheckpointFileSchema
  >
);
const decodeDeliveryCheckpointFileSync = validateUnknownSync(
  DeliveryCheckpointFileSchema as SyncDecodingSchema<
    typeof DeliveryCheckpointFileSchema
  >
);
const decodeJournalEntrySync: (input: unknown) => JournalEntry =
  validateUnknownSync(
    JournalEntrySchema as SyncDecodingSchema<typeof JournalEntrySchema>
  );

const parseJsonLine = (line: string): unknown => {
  const result = Result.try({
    try: () => JSON.parse(line),
    catch: () =>
      new DaemonSyncParseError({
        scope: "Agent source line",
        path: "<jsonl>",
        message: "Source line is not valid JSON.",
        details: "Falling back to raw line content.",
      }),
  });
  return Result.isSuccess(result) ? result.success : line;
};

const parseStructuredJsonValue = (value: string): unknown | null => {
  const parsed = Result.try({
    try: () => JSON.parse(value),
    catch: () => null,
  });
  return Result.isSuccess(parsed) ? parsed.success : null;
};

const splitJsonlContent = (raw: string): readonly string[] => {
  const lines = raw.split(/\r?\n/);
  const lastLine = lines.at(-1);
  return lastLine === "" ? lines.slice(0, -1) : lines;
};

const parseStructuredSourceDocument = (raw: string): unknown | null =>
  raw.trim().length === 0 ? [] : parseStructuredJsonValue(raw);

const parseStructuredSourceLines = (raw: string): readonly unknown[] | null => {
  const records: unknown[] = [];
  for (const line of splitJsonlContent(raw)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const parsed = parseStructuredJsonValue(trimmed);
    if (parsed === null) {
      return null;
    }
    records.push(parsed);
  }
  return records;
};

const toIsoNow = (): string => new Date().toISOString();

const toCauseDetails = (cause: unknown): string =>
  isErrnoCause(cause) && isString(cause.message)
    ? cause.message
    : String(cause);

const toErrnoCode = (cause: unknown): string =>
  isErrnoCause(cause) ? cause.code : "UNKNOWN";

const parseLockOwnerPid = (raw: string): number | null => {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  const parsedJson = Result.try({
    try: () => JSON.parse(trimmed) as unknown,
    catch: () => null,
  });
  if (Result.isSuccess(parsedJson) && isUnknownRecord(parsedJson.success)) {
    const pid = parsedJson.success["pid"];
    if (Predicate.isNumber(pid) && Number.isInteger(pid) && pid > 0) {
      return pid;
    }
  }

  const firstToken = trimmed.split(/\s+/, 1)[0] ?? "";
  const parsedPid = Number.parseInt(firstToken, 10);
  return Number.isInteger(parsedPid) && parsedPid > 0 ? parsedPid : null;
};

const normalizeMaybePath = (value: string | null | undefined): string | null =>
  value ? resolve(value) : null;

const resolveSyncStateFile = (config: DaemonConfig): string =>
  resolve(config.state.rootDir, "sync-state.json");

const resolveRuntimeStateFile = (config: DaemonConfig): string =>
  resolve(config.state.rootDir, "runtime-state.json");

const resolveJournalFile = (config: DaemonConfig): string =>
  resolve(config.state.journalDir, "events.ndjson");

const resolveSyncLockFile = (config: DaemonConfig): string =>
  resolve(config.state.rootDir, "sync.lock");

const resolveSourceCheckpointDir = (config: DaemonConfig): string =>
  resolve(config.state.checkpointDir, "sources");

const resolveDeliveryCheckpointDir = (config: DaemonConfig): string =>
  resolve(config.state.checkpointDir, "deliveries");

const sourceCheckpointFileNameFor = (sourceFile: string): string =>
  `src_${hashValue(resolve(sourceFile)).slice(0, 24)}.json`;

const deliveryCheckpointFileNameFor = (memoryAlias: string): string =>
  `target_${hashValue(memoryAlias).slice(0, 24)}.json`;

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

const sourceAutoApproveByDefault = (source: DiscoverableSourceName): boolean =>
  source === "codex" || source === "claude" || source === "plan";

const looksLikePathString = (value: string): boolean =>
  value.startsWith("~/") ||
  value.startsWith("./") ||
  value.startsWith("../") ||
  value.startsWith("/") ||
  value.startsWith("file://") ||
  /^[A-Za-z]:[\\/]/.test(value);

const normalizePathHint = (value: unknown, baseDir: string): string | null => {
  if (!isString(value)) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed || !looksLikePathString(trimmed)) {
    return null;
  }
  if (trimmed === "~") {
    return homedir();
  }
  if (trimmed.startsWith("~/")) {
    return resolve(homedir(), trimmed.slice(2));
  }
  if (trimmed.startsWith("file://")) {
    const uri = Result.try({
      try: () => new URL(trimmed),
      catch: () => null,
    });
    if (Result.isSuccess(uri) && uri.success) {
      return resolve(decodeURIComponent(uri.success.pathname));
    }
    return null;
  }
  return resolve(baseDir, trimmed);
};

const extractPathHintsFromUnknown = (
  value: unknown,
  baseDir: string,
  depth = 0,
  current: {
    readonly path: string | null;
    readonly repoRoot: string | null;
    readonly workspaceRoot: string | null;
  } = {
    path: null,
    repoRoot: null,
    workspaceRoot: null,
  }
): {
  readonly path: string | null;
  readonly repoRoot: string | null;
  readonly workspaceRoot: string | null;
} => {
  if (depth > 5) {
    return current;
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, 12)
      .reduce(
        (accumulator, entry) =>
          extractPathHintsFromUnknown(entry, baseDir, depth + 1, accumulator),
        current
      );
  }
  if (!isUnknownRecord(value)) {
    return current;
  }
  let nextHints = current;
  for (const key of Object.keys(value).sort((left, right) =>
    left.localeCompare(right)
  )) {
    const normalizedKey = key.toLowerCase();
    const hintedPath = normalizePathHint(value[key], baseDir);
    if (hintedPath) {
      if (
        nextHints.path === null &&
        (normalizedKey === "path" ||
          normalizedKey === "cwd" ||
          normalizedKey === "filepath" ||
          normalizedKey === "fspath" ||
          normalizedKey === "uri")
      ) {
        nextHints = {
          ...nextHints,
          path: hintedPath,
        };
      }
      if (
        nextHints.repoRoot === null &&
        (normalizedKey === "reporoot" ||
          normalizedKey === "repo" ||
          normalizedKey === "root")
      ) {
        nextHints = {
          ...nextHints,
          repoRoot: hintedPath,
        };
      }
      if (
        nextHints.workspaceRoot === null &&
        (normalizedKey === "workspaceroot" ||
          normalizedKey === "workspacefolder" ||
          normalizedKey === "workspace" ||
          normalizedKey === "folder")
      ) {
        nextHints = {
          ...nextHints,
          workspaceRoot: hintedPath,
        };
      }
      if (normalizedKey === "cwd") {
        nextHints = {
          path: nextHints.path ?? hintedPath,
          repoRoot: nextHints.repoRoot ?? hintedPath,
          workspaceRoot: nextHints.workspaceRoot ?? hintedPath,
        };
      }
    }
    nextHints = extractPathHintsFromUnknown(
      value[key],
      baseDir,
      depth + 1,
      nextHints
    );
  }
  return nextHints;
};

const contentTextFromGenericSourceRecord = (value: unknown): string =>
  extractSanitizedSourceContent(value);

const extractGenericSourceRecords = (
  value: unknown,
  depth = 0
): readonly unknown[] => {
  if (depth > 4) {
    return [value];
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, 500)
      .flatMap((entry) => extractGenericSourceRecords(entry, depth + 1))
      .slice(0, 500);
  }
  if (!isUnknownRecord(value)) {
    return [value];
  }
  const nestedRecords = Object.keys(value)
    .sort((left, right) => left.localeCompare(right))
    .flatMap((key) => {
      if (!GENERIC_SOURCE_RECORD_ARRAY_KEYS.has(key.toLowerCase())) {
        return [];
      }
      const nested = value[key];
      return Array.isArray(nested)
        ? extractGenericSourceRecords(nested, depth + 1)
        : [];
    })
    .slice(0, 500);
  return nestedRecords.length > 0 ? nestedRecords : [value];
};

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

const statFileEffect = (path: string, operation: string) =>
  Effect.tryPromise({
    try: () => stat(path),
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
      () => null
    );
  });
};

const appendUtf8Effect = (path: string, content: string) =>
  Effect.gen(function* () {
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
      try: () => appendFile(path, content, "utf8"),
      catch: (cause) =>
        new DaemonSyncIoError({
          operation: "appendFile",
          path,
          code: toErrnoCode(cause),
          message: `appendFile failed for ${path}.`,
          details: toCauseDetails(cause),
        }),
    });
  });

const fileExists = (path: string) =>
  Effect.tryPromise({
    try: async () => {
      await access(path);
      return true;
    },
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

const safeFileExists = (path: string) =>
  fileExists(path).pipe(
    Effect.catchTag("DaemonSyncIoError", () => Effect.succeed(false))
  );

const removeFileEffect = (path: string, operation: string) =>
  Effect.tryPromise({
    try: () => rm(path, { force: true }),
    catch: (cause) =>
      new DaemonSyncIoError({
        operation,
        path,
        code: toErrnoCode(cause),
        message: `${operation} failed for ${path}.`,
        details: toCauseDetails(cause),
      }),
  });

const closeLockHandleEffect = (
  handle: FileHandle,
  path: string,
  operation: string
) =>
  Effect.tryPromise({
    try: () => handle.close(),
    catch: (cause) =>
      new DaemonSyncIoError({
        operation,
        path,
        code: toErrnoCode(cause),
        message: `${operation} failed for ${path}.`,
        details: toCauseDetails(cause),
      }),
  });

const canReclaimSyncLockEffect = (lockPath: string) =>
  readUtf8(lockPath, "readFile").pipe(
    Effect.map(parseLockOwnerPid),
    Effect.flatMap((ownerPid) =>
      ownerPid !== null
        ? Effect.succeed(!isProcessAlive(ownerPid))
        : statFileEffect(lockPath, "stat").pipe(
            Effect.map(
              (metadata) => Date.now() - metadata.mtimeMs >= SYNC_LOCK_STALE_MS
            )
          )
    ),
    Effect.catchTag("DaemonSyncIoError", (error) =>
      error.code === "ENOENT" ? Effect.succeed(false) : Effect.fail(error)
    )
  );

const openSyncLockHandleEffect = (lockPath: string) =>
  Effect.gen(function* () {
    const handle = yield* Effect.tryPromise({
      try: () => open(lockPath, "wx"),
      catch: (cause) =>
        new DaemonSyncIoError({
          operation: "open",
          path: lockPath,
          code: toErrnoCode(cause),
          message: `open failed for ${lockPath}.`,
          details: toCauseDetails(cause),
        }),
    });
    yield* Effect.tryPromise({
      try: () =>
        handle.writeFile(
          `${JSON.stringify({
            pid: process.pid,
            acquiredAt: toIsoNow(),
          })}\n`,
          "utf8"
        ),
      catch: (cause) =>
        new DaemonSyncIoError({
          operation: "writeFile",
          path: lockPath,
          code: toErrnoCode(cause),
          message: `writeFile failed for ${lockPath}.`,
          details: toCauseDetails(cause),
        }),
    }).pipe(
      Effect.catchTag("DaemonSyncIoError", (error) =>
        Effect.orElseSucceed(
          closeLockHandleEffect(handle, lockPath, "close"),
          () => null
        ).pipe(
          Effect.flatMap(() =>
            Effect.orElseSucceed(removeFileEffect(lockPath, "rm"), () => null)
          ),
          Effect.flatMap(() => Effect.fail(error))
        )
      )
    );
    return handle;
  });

const acquireSyncLockHandleEffect = (
  lockPath: string,
  timeoutMs = SYNC_LOCK_TIMEOUT_MS,
  retryMs = SYNC_LOCK_RETRY_MS
): Effect.Effect<FileHandle, DaemonSyncIoError | DaemonSyncLockError> => {
  const deadline = Date.now() + timeoutMs;
  const loop = (): Effect.Effect<
    FileHandle,
    DaemonSyncIoError | DaemonSyncLockError
  > =>
    openSyncLockHandleEffect(lockPath).pipe(
      Effect.catchTag("DaemonSyncIoError", (error) =>
        error.code !== "EEXIST"
          ? Effect.fail(error)
          : canReclaimSyncLockEffect(lockPath).pipe(
              Effect.flatMap((reclaimable) =>
                reclaimable
                  ? removeFileEffect(lockPath, "rm").pipe(
                      Effect.flatMap(() => loop())
                    )
                  : Date.now() >= deadline
                    ? Effect.fail(
                        new DaemonSyncLockError({
                          operation: "sync",
                          path: lockPath,
                          message: `Timed out acquiring daemon sync lock '${lockPath}'.`,
                          details:
                            "Another daemon sync process is still holding the collector lock.",
                        })
                      )
                    : Effect.sleep(Duration.millis(retryMs)).pipe(
                        Effect.flatMap(() => loop())
                      )
              )
            )
      )
    );

  return loop();
};

const releaseSyncLockEffect = (handle: FileHandle, lockPath: string) =>
  Effect.gen(function* () {
    yield* Effect.orElseSucceed(
      closeLockHandleEffect(handle, lockPath, "close"),
      () => null
    );
    yield* Effect.orElseSucceed(removeFileEffect(lockPath, "rm"), () => null);
  });

const withSyncLockEffect = <A, E>(
  config: DaemonConfig,
  effect: Effect.Effect<A, E | DaemonSyncIoError | DaemonSyncLockError>
) =>
  Effect.acquireUseRelease(
    acquireSyncLockHandleEffect(resolveSyncLockFile(config)),
    () => effect,
    (handle) => releaseSyncLockEffect(handle, resolveSyncLockFile(config))
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

const readSourceCheckpointFilesEffect = (config: DaemonConfig) =>
  Effect.gen(function* () {
    const checkpointDir = resolveSourceCheckpointDir(config);
    const fileNames = yield* Effect.tryPromise({
      try: () => readdir(checkpointDir),
      catch: (cause) =>
        new DaemonSyncIoError({
          operation: "readdir",
          path: checkpointDir,
          code: toErrnoCode(cause),
          message: `readdir failed for ${checkpointDir}.`,
          details: toCauseDetails(cause),
        }),
    }).pipe(
      Effect.catchTag("DaemonSyncIoError", (error) =>
        error.code === "ENOENT"
          ? Effect.succeed([] as string[])
          : Effect.fail(error)
      )
    );
    const records = yield* Effect.forEach(
      fileNames
        .filter((fileName) => fileName.toLowerCase().endsWith(".json"))
        .sort((left, right) => left.localeCompare(right)),
      (fileName) =>
        readJsonFile(
          resolve(checkpointDir, fileName),
          "Source checkpoint",
          decodeSourceCheckpointFileSync
        ),
      {
        concurrency: 1,
      }
    );
    return records.reduce<Record<string, SourceCursorRecord>>(
      (accumulator, record) => ({
        ...accumulator,
        [resolve(record.sourceFile)]: {
          cursor: record.cursor,
          digest: record.digest,
          updatedAt: record.updatedAt,
        },
      }),
      {}
    );
  });

const readDeliveryCheckpointFilesEffect = (config: DaemonConfig) =>
  Effect.gen(function* () {
    const checkpointDir = resolveDeliveryCheckpointDir(config);
    const fileNames = yield* Effect.tryPromise({
      try: () => readdir(checkpointDir),
      catch: (cause) =>
        new DaemonSyncIoError({
          operation: "readdir",
          path: checkpointDir,
          code: toErrnoCode(cause),
          message: `readdir failed for ${checkpointDir}.`,
          details: toCauseDetails(cause),
        }),
    }).pipe(
      Effect.catchTag("DaemonSyncIoError", (error) =>
        error.code === "ENOENT"
          ? Effect.succeed([] as string[])
          : Effect.fail(error)
      )
    );
    const records = yield* Effect.forEach(
      fileNames
        .filter((fileName) => fileName.toLowerCase().endsWith(".json"))
        .sort((left, right) => left.localeCompare(right)),
      (fileName) =>
        readJsonFile(
          resolve(checkpointDir, fileName),
          "Delivery checkpoint",
          decodeDeliveryCheckpointFileSync
        ),
      {
        concurrency: 1,
      }
    );
    return records.reduce<Record<string, DeliveryCheckpointRecord>>(
      (accumulator, record) => ({
        ...accumulator,
        [record.memory]: {
          lastDeliveredSequence: record.lastDeliveredSequence,
          deliveredEvents: record.deliveredEvents,
          accepted: record.accepted,
          duplicates: record.duplicates,
          updatedAt: record.updatedAt,
          lastError: record.lastError,
        },
      }),
      {}
    );
  });

const writeSourceCheckpointFilesEffect = (
  config: DaemonConfig,
  sourceCursors: SyncRuntimeState["sourceCursors"]
) =>
  Effect.gen(function* () {
    const checkpointDir = resolveSourceCheckpointDir(config);
    yield* Effect.tryPromise({
      try: () => mkdir(checkpointDir, { recursive: true }),
      catch: (cause) =>
        new DaemonSyncIoError({
          operation: "mkdir",
          path: checkpointDir,
          code: toErrnoCode(cause),
          message: `mkdir failed for ${checkpointDir}.`,
          details: toCauseDetails(cause),
        }),
    });
    yield* Effect.forEach(
      Object.entries(sourceCursors).sort(([left], [right]) =>
        left.localeCompare(right)
      ),
      ([sourceFile, cursor]) =>
        writeUtf8Atomic(
          resolve(checkpointDir, sourceCheckpointFileNameFor(sourceFile)),
          `${JSON.stringify(
            {
              schemaVersion: 1,
              kind: "source",
              sourceFile,
              cursor: cursor.cursor,
              digest: cursor.digest,
              updatedAt: cursor.updatedAt,
            } satisfies SourceCheckpointFileRecord,
            null,
            2
          )}\n`
        ),
      {
        concurrency: 1,
      }
    );
  });

const writeDeliveryCheckpointFilesEffect = (
  config: DaemonConfig,
  deliveries: SyncRuntimeState["deliveries"],
  memories: DaemonConfig["memories"]
) =>
  Effect.gen(function* () {
    const checkpointDir = resolveDeliveryCheckpointDir(config);
    yield* Effect.tryPromise({
      try: () => mkdir(checkpointDir, { recursive: true }),
      catch: (cause) =>
        new DaemonSyncIoError({
          operation: "mkdir",
          path: checkpointDir,
          code: toErrnoCode(cause),
          message: `mkdir failed for ${checkpointDir}.`,
          details: toCauseDetails(cause),
        }),
    });
    yield* Effect.forEach(
      Object.entries(deliveries).sort(([left], [right]) =>
        left.localeCompare(right)
      ),
      ([memoryAlias, checkpoint]) => {
        const memory = memories[memoryAlias];
        return memory
          ? writeUtf8Atomic(
              resolve(
                checkpointDir,
                deliveryCheckpointFileNameFor(memoryAlias)
              ),
              `${JSON.stringify(
                {
                  schemaVersion: 1,
                  kind: "delivery",
                  memory: memoryAlias,
                  account: memory.account,
                  storeId: memory.storeId,
                  profile: memory.profile,
                  lastDeliveredSequence: checkpoint.lastDeliveredSequence,
                  deliveredEvents: checkpoint.deliveredEvents,
                  accepted: checkpoint.accepted,
                  duplicates: checkpoint.duplicates,
                  updatedAt: checkpoint.updatedAt,
                  lastError: checkpoint.lastError,
                } satisfies DeliveryCheckpointFileRecord,
                null,
                2
              )}\n`
            )
          : Effect.void;
      },
      {
        concurrency: 1,
      }
    );
  });

const readSyncStateEffect = (config: DaemonConfig) =>
  Effect.gen(function* () {
    const state = yield* readJsonFile(
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
    const sourceCursors = yield* readSourceCheckpointFilesEffect(config);
    const deliveries = yield* readDeliveryCheckpointFilesEffect(config);
    return {
      ...state,
      sourceCursors: mergeSourceCursorMaps(state.sourceCursors, sourceCursors),
      deliveries: mergeDeliveryCheckpointMaps(state.deliveries, deliveries),
    } satisfies SyncRuntimeState;
  });

const writeSyncStateEffect = (config: DaemonConfig, state: SyncRuntimeState) =>
  Effect.gen(function* () {
    const nextState: SyncRuntimeState = {
      ...state,
      updatedAt: toIsoNow(),
    };
    yield* writeUtf8Atomic(
      resolveSyncStateFile(config),
      `${JSON.stringify(nextState, null, 2)}\n`
    );
    yield* writeSourceCheckpointFilesEffect(config, nextState.sourceCursors);
    yield* writeDeliveryCheckpointFilesEffect(
      config,
      nextState.deliveries,
      config.memories
    );
  });

const compareJournalEntries = (
  left: JournalEntry,
  right: JournalEntry
): number =>
  left.sequence - right.sequence ||
  left.sourceFile.localeCompare(right.sourceFile) ||
  left.sourceLine - right.sourceLine ||
  left.event.id.localeCompare(right.event.id);

const normalizeJournalEntries = (
  entries: readonly JournalEntry[]
): readonly JournalEntry[] => {
  const normalizedEntries = [...entries].sort(compareJournalEntries);
  const deduplicatedEntries = new Map<number, JournalEntry>();
  for (const entry of normalizedEntries) {
    if (!deduplicatedEntries.has(entry.sequence)) {
      deduplicatedEntries.set(entry.sequence, entry);
    }
  }
  return [...deduplicatedEntries.values()];
};

const serializeJournalEntries = (entries: readonly JournalEntry[]): string =>
  entries.length === 0
    ? ""
    : `${normalizeJournalEntries(entries)
        .map((entry) => JSON.stringify(entry))
        .join("\n")}\n`;

const mergeSourceCursorRecord = (
  current: SourceCursorRecord | undefined,
  next: SourceCursorRecord
): SourceCursorRecord => {
  if (!current) {
    return next;
  }
  if (next.cursor !== current.cursor) {
    return next.cursor > current.cursor ? next : current;
  }
  if (next.updatedAt !== current.updatedAt) {
    return next.updatedAt.localeCompare(current.updatedAt) > 0 ? next : current;
  }
  if (next.digest !== current.digest && next.digest !== null) {
    return next;
  }
  return current;
};

const mergeSourceCursorMaps = (
  current: SyncRuntimeState["sourceCursors"],
  next: SyncRuntimeState["sourceCursors"]
): SyncRuntimeState["sourceCursors"] => {
  const merged: Record<string, SourceCursorRecord> = {
    ...current,
  };
  for (const [sourceFile, cursor] of Object.entries(next).sort(
    ([left], [right]) => left.localeCompare(right)
  )) {
    merged[sourceFile] = mergeSourceCursorRecord(merged[sourceFile], cursor);
  }
  return merged;
};

const mergeDeliveryCheckpointRecord = (
  current: DeliveryCheckpointRecord | undefined,
  next: DeliveryCheckpointRecord
): DeliveryCheckpointRecord => {
  if (!current) {
    return next;
  }
  if (next.lastDeliveredSequence !== current.lastDeliveredSequence) {
    return next.lastDeliveredSequence > current.lastDeliveredSequence
      ? next
      : current;
  }
  if (next.updatedAt !== current.updatedAt) {
    return next.updatedAt.localeCompare(current.updatedAt) > 0 ? next : current;
  }
  if (next.accepted !== current.accepted) {
    return next.accepted > current.accepted ? next : current;
  }
  if (next.deliveredEvents !== current.deliveredEvents) {
    return next.deliveredEvents > current.deliveredEvents ? next : current;
  }
  if (next.duplicates !== current.duplicates) {
    return next.duplicates > current.duplicates ? next : current;
  }
  if (next.lastError !== current.lastError && next.lastError !== null) {
    return next;
  }
  return current;
};

const mergeDeliveryCheckpointMaps = (
  current: SyncRuntimeState["deliveries"],
  next: SyncRuntimeState["deliveries"]
): SyncRuntimeState["deliveries"] => {
  const merged: Record<string, DeliveryCheckpointRecord> = {
    ...current,
  };
  for (const [memoryAlias, checkpoint] of Object.entries(next).sort(
    ([left], [right]) => left.localeCompare(right)
  )) {
    merged[memoryAlias] = mergeDeliveryCheckpointRecord(
      merged[memoryAlias],
      checkpoint
    );
  }
  return merged;
};

const reconcileSyncStateWithJournalEntries = (
  state: SyncRuntimeState,
  journalEntries: readonly JournalEntry[]
): SyncRuntimeState => {
  const normalizedJournalEntries = normalizeJournalEntries(journalEntries);
  let changed = false;
  let nextSequence = state.nextSequence;
  const sourceCursors: Record<string, SourceCursorRecord> = {
    ...state.sourceCursors,
  };

  const highestSequence = normalizedJournalEntries.at(-1)?.sequence;
  if (
    highestSequence !== undefined &&
    highestSequence + 1 > state.nextSequence
  ) {
    nextSequence = highestSequence + 1;
    changed = true;
  }

  for (const entry of normalizedJournalEntries) {
    if (!entry.sourceCursor) {
      continue;
    }
    const currentCursor = sourceCursors[entry.sourceFile];
    const mergedCursor = mergeSourceCursorRecord(
      currentCursor,
      entry.sourceCursor
    );
    if (currentCursor === mergedCursor) {
      continue;
    }
    sourceCursors[entry.sourceFile] = mergedCursor;
    changed = true;
  }

  return changed
    ? {
        ...state,
        nextSequence,
        sourceCursors,
      }
    : state;
};

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
        splitJsonlContent(raw)
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
    ),
    Effect.map(normalizeJournalEntries)
  );

const appendJournalEntriesEffect = (
  config: DaemonConfig,
  entries: readonly JournalEntry[]
) =>
  entries.length === 0
    ? Effect.void
    : appendUtf8Effect(
        resolveJournalFile(config),
        serializeJournalEntries(entries)
      );

const listJsonlFilesEffect = (rootPath: string) =>
  listSourceFilesEffect(rootPath, JSONL_FILE_EXTENSIONS);

const listSourceFilesEffect = (
  rootPath: string,
  extensions: readonly string[]
) =>
  Effect.gen(function* () {
    const exists = yield* fileExists(rootPath);
    if (!exists) {
      return [] as string[];
    }
    const discovered: string[] = [];
    const stack = [rootPath];
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
          extensions.some((extension) =>
            current.toLowerCase().endsWith(extension)
          )
        ) {
          discovered.push(current);
          continue;
        }
        return yield* Effect.fail(entriesAttempt.error);
      }
      const entries = entriesAttempt.entries;
      if (
        entries.length === 0 &&
        extensions.some((extension) =>
          current.toLowerCase().endsWith(extension)
        )
      ) {
        discovered.push(current);
        continue;
      }
      for (const entry of [...entries].sort((left, right) =>
        left.name.localeCompare(right.name)
      )) {
        const absolutePath = resolve(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(absolutePath);
          continue;
        }
        if (
          entry.isFile() &&
          extensions.some((extension) =>
            entry.name.toLowerCase().endsWith(extension)
          )
        ) {
          discovered.push(absolutePath);
        }
      }
    }
    return [...new Set(discovered)].sort((left, right) =>
      left.localeCompare(right)
    );
  });

const discoveryRootsFromEnv = (envKey: string): readonly string[] => {
  const configured = process.env[envKey];
  if (!isString(configured) || configured.trim().length === 0) {
    return [];
  }
  return [
    ...new Set(
      configured
        .split(delimiter)
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
        .map((value) => resolve(value))
    ),
  ].sort((left, right) => left.localeCompare(right));
};

const defaultDiscoverableSourceRoots = (
  source: Exclude<DiscoverableSourceName, "plan">
): readonly string[] =>
  source === "codex"
    ? [
        resolve(homedir(), ".codex", "archived_sessions"),
        resolve(homedir(), ".codex", "sessions"),
      ]
    : source === "claude"
      ? [
          resolve(homedir(), ".claude", "projects"),
          resolve(homedir(), ".claude", "transcripts"),
        ]
      : source === "cursor"
        ? [
            resolve(
              homedir(),
              "Library",
              "Application Support",
              "Cursor",
              "User",
              "globalStorage"
            ),
            resolve(
              homedir(),
              "Library",
              "Application Support",
              "Cursor",
              "User",
              "workspaceStorage"
            ),
            resolve(homedir(), ".config", "Cursor", "User", "workspaceStorage"),
          ]
        : source === "codex-native"
          ? [
              resolve(homedir(), ".codex-native", "history"),
              resolve(homedir(), ".codex-native", "projects"),
              resolve(homedir(), ".codex-native", "sessions"),
            ]
          : source === "opencode"
            ? [
                resolve(homedir(), ".opencode", "history"),
                resolve(homedir(), ".opencode", "projects"),
                resolve(homedir(), ".opencode", "sessions"),
              ]
            : [
                resolve(
                  homedir(),
                  "Library",
                  "Application Support",
                  "Code",
                  "User",
                  "globalStorage",
                  "github.copilot-chat"
                ),
                resolve(
                  homedir(),
                  "Library",
                  "Application Support",
                  "Code",
                  "User",
                  "workspaceStorage"
                ),
                resolve(
                  homedir(),
                  ".config",
                  "Code",
                  "User",
                  "workspaceStorage"
                ),
              ];

const discoverableSourceRootsFor = (
  source: Exclude<DiscoverableSourceName, "plan">
): readonly string[] => {
  const envKey =
    source === "codex"
      ? "UMS_DISCOVERY_CODEX_ROOTS"
      : source === "claude"
        ? "UMS_DISCOVERY_CLAUDE_ROOTS"
        : source === "cursor"
          ? "UMS_DISCOVERY_CURSOR_ROOTS"
          : source === "codex-native"
            ? "UMS_DISCOVERY_CODEX_NATIVE_ROOTS"
            : source === "opencode"
              ? "UMS_DISCOVERY_OPENCODE_ROOTS"
              : "UMS_DISCOVERY_VSCODE_ROOTS";
  const configured = discoveryRootsFromEnv(envKey);
  return configured.length > 0
    ? configured
    : defaultDiscoverableSourceRoots(source);
};

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
      : source === "cursor" ||
          source === "codex-native" ||
          source === "opencode" ||
          source === "vscode"
        ? discoverableSourceRootsFor(source)
        : [process.cwd()];

const isSyncSupportedSource = (
  source: DiscoverableSourceName
): source is SupportedSourceName =>
  source === "codex" ||
  source === "claude" ||
  source === "cursor" ||
  source === "codex-native" ||
  source === "opencode" ||
  source === "plan" ||
  source === "vscode";

const adapterEnabledForSource = (
  config: DaemonConfig,
  source: DiscoverableSourceName
): boolean => {
  const adapter =
    source === "codex"
      ? config.sources.codex
      : source === "claude"
        ? config.sources.claude
        : source === "cursor"
          ? config.sources.cursor
          : source === "opencode"
            ? config.sources.opencode
            : source === "vscode"
              ? config.sources.vscode
              : source === "codex-native"
                ? config.sources.codexNative
                : config.sources.plan;
  return adapter?.enabled !== false;
};

const activeBindingsForSource = (
  config: DaemonConfig,
  source: DiscoverableSourceName
): readonly DaemonSourceBinding[] =>
  getDaemonSourceBindings(config, source).filter(
    (binding) => binding.status === "approved"
  );

const sourceHasManagedBindings = (
  config: DaemonConfig,
  source: DiscoverableSourceName
): boolean => getDaemonSourceBindings(config, source).length > 0;

const uniqueSortedPaths = (paths: readonly string[]): readonly string[] =>
  [...new Set(paths.map((path) => resolve(path)))].sort((left, right) =>
    left.localeCompare(right)
  );

const resolveWorkspaceRoots = (
  workspaceRoots: readonly string[]
): readonly string[] =>
  uniqueSortedPaths(
    workspaceRoots.length > 0 ? workspaceRoots : [process.cwd()]
  );

const guidanceCandidatePathsFor = (
  workspaceRoots: readonly string[]
): ReadonlyArray<{
  readonly path: string;
  readonly label: string;
}> =>
  resolveWorkspaceRoots(workspaceRoots).flatMap((workspaceRoot) =>
    GUIDANCE_FILE_SPECS.map((spec) => ({
      path: resolve(workspaceRoot, spec.relativePath),
      label: `${spec.label} (${basename(workspaceRoot)})`,
    }))
  );

const planPathsFor = (config: DaemonConfig): readonly string[] => {
  if (!adapterEnabledForSource(config, "plan")) {
    return [];
  }
  const approvedBindingPaths = activeBindingsForSource(config, "plan").map(
    (binding) => binding.path
  );
  const configuredRoots = config.sources.plan?.roots ?? [];
  const explicitPaths = uniqueSortedPaths([
    ...approvedBindingPaths,
    ...configuredRoots,
  ]);
  if (explicitPaths.length > 0) {
    return explicitPaths;
  }
  return sourceHasManagedBindings(config, "plan")
    ? []
    : defaultSourceRoots("plan");
};

const sourceRootsFor = (
  config: DaemonConfig,
  source: SupportedSourceName
): readonly string[] => {
  const adapter =
    source === "codex"
      ? config.sources.codex
      : source === "claude"
        ? config.sources.claude
        : source === "cursor"
          ? config.sources.cursor
          : source === "opencode"
            ? config.sources.opencode
            : source === "vscode"
              ? config.sources.vscode
              : source === "codex-native"
                ? config.sources.codexNative
                : config.sources.plan;
  if (adapter?.enabled === false) {
    return [];
  }
  const approvedBindingPaths = activeBindingsForSource(config, source).map(
    (binding) => binding.path
  );
  const explicitPaths = uniqueSortedPaths([
    ...approvedBindingPaths,
    ...(adapter?.roots ?? []),
  ]);
  if (explicitPaths.length > 0) {
    return explicitPaths;
  }
  if (sourceHasManagedBindings(config, source)) {
    return [];
  }
  return source === "codex-native" ||
    source === "cursor" ||
    source === "opencode" ||
    source === "vscode"
    ? []
    : defaultSourceRoots(source);
};

const chunkItems = <T>(
  items: readonly T[],
  chunkSize = DEFAULT_INGEST_CHUNK_SIZE
) => {
  const chunks: T[][] = [];
  for (const [index, item] of items.entries()) {
    if (index % chunkSize === 0) {
      chunks.push([item]);
      continue;
    }
    const lastChunk = chunks.at(-1);
    if (lastChunk) {
      lastChunk.push(item);
    }
  }
  return chunks;
};

const appendWithLimit = <T>(
  target: T[],
  items: readonly T[],
  limit: number
): void => {
  for (const item of items) {
    if (target.length >= limit) {
      break;
    }
    target.push(item);
  }
};

const upsertSourceStatEntry = (
  sourceStats: SourceCollectionStat[],
  nextStat: SourceCollectionStat
): void => {
  const existingIndex = sourceStats.findIndex(
    (entry) => entry.source === nextStat.source
  );
  if (existingIndex === -1) {
    sourceStats.push(nextStat);
    return;
  }
  sourceStats[existingIndex] = nextStat;
};

const buildIngestEvent = (input: {
  readonly source: SupportedSourceName;
  readonly sourceFile: string;
  readonly sourceLine: number;
  readonly content: string;
}): IngestEvent => {
  const canonicalSource =
    normalizeAdapterSourceAlias(input.source) ?? input.source;
  return {
    id: `evt_${hashValue(
      `${input.source}|${input.sourceFile}|${input.sourceLine}|${input.content}`
    ).slice(0, 24)}`,
    type: "note",
    source: canonicalSource,
    content: input.content,
  };
};

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

const mergeExtractedPathHints = (
  primary: {
    readonly path: string | null;
    readonly repoRoot: string | null;
    readonly workspaceRoot: string | null;
  },
  fallback: {
    readonly path: string | null;
    readonly repoRoot: string | null;
    readonly workspaceRoot: string | null;
  }
): {
  readonly path: string | null;
  readonly repoRoot: string | null;
  readonly workspaceRoot: string | null;
} => ({
  path:
    primary.path ??
    fallback.path ??
    primary.workspaceRoot ??
    fallback.workspaceRoot ??
    primary.repoRoot ??
    fallback.repoRoot,
  repoRoot: primary.repoRoot ?? fallback.repoRoot,
  workspaceRoot: primary.workspaceRoot ?? fallback.workspaceRoot,
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
        Effect.map((raw): PlanCollectionResult => {
          const sanitized = sanitizeSourceContent(raw);
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
                    content: sanitizeSourceContent(
                      `${basename(input.planPath)} snapshot ${sanitized}`
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
        })
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
        const lines = splitJsonlContent(raw).filter(
          (line) => line.trim().length > 0
        );
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
}): Effect.Effect<SourceFileCollectionResult, DaemonSyncIoError> =>
  readUtf8(input.filePath, "readFile").pipe(
    Effect.catchTag("DaemonSyncIoError", (error) =>
      error.code === "ENOENT" ? Effect.succeed("") : Effect.fail(error)
    ),
    Effect.map((raw) => {
      const lines = splitJsonlContent(raw);
      let currentPath: string | null = null;
      const events: CollectedEvent[] = [];
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
            digest: null,
          };
        }
        if (isCodexSessionMeta(parsed)) {
          continue;
        }
        const historyText =
          isCodexHistoryLine(parsed) && parsed.text ? parsed.text : "";
        const historyPath =
          isCodexHistoryLine(parsed) && parsed.session_id
            ? normalizeMaybePath(
                input.sessionHints.get(parsed.session_id) ?? null
              )
            : null;
        const userContent = isCodexUserMessage(parsed)
          ? extractSanitizedSourceContent(parsed.payload.content)
          : "";
        const normalizedPath = historyPath ?? currentPath;
        const content = sanitizeSourceContent(historyText || userContent);
        if (!content) {
          continue;
        }
        events.push(
          buildCollectedEvent({
            source: "codex",
            sourceFile: input.filePath,
            sourceLine: index + 1,
            content: sanitizeSourceContent(
              `${basename(input.filePath)}:${index + 1} ${content}`
            ),
            path: normalizedPath,
          })
        );
      }
      return {
        events,
        nextCursor: lines.length,
        scannedLines,
        digest: null,
      };
    })
  );

const tailClaudeFileEffect = (input: {
  readonly filePath: string;
  readonly startCursor: number;
  readonly maxEvents: number;
}): Effect.Effect<SourceFileCollectionResult, DaemonSyncIoError> =>
  readUtf8(input.filePath, "readFile").pipe(
    Effect.catchTag("DaemonSyncIoError", (error) =>
      error.code === "ENOENT" ? Effect.succeed("") : Effect.fail(error)
    ),
    Effect.map((raw) => {
      const lines = splitJsonlContent(raw);
      const events: CollectedEvent[] = [];
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
            digest: null,
          };
        }
        scannedLines += 1;
        const rawLine = lines[index]?.trim() ?? "";
        if (!rawLine) {
          continue;
        }
        const parsed = parseJsonLine(rawLine);
        const content = sanitizeSourceContent(
          isClaudeUserLine(parsed)
            ? parsed.content
            : isString(parsed)
              ? parsed
              : ""
        );
        if (!content) {
          continue;
        }
        events.push(
          buildCollectedEvent({
            source: "claude",
            sourceFile: input.filePath,
            sourceLine: index + 1,
            content: sanitizeSourceContent(
              `${basename(input.filePath)}:${index + 1} ${content}`
            ),
          })
        );
      }
      return {
        events,
        nextCursor: lines.length,
        scannedLines,
        digest: null,
      };
    })
  );

const collectGenericSourceFileEffect = (input: {
  readonly source: Extract<
    SupportedSourceName,
    "codex-native" | "cursor" | "opencode" | "vscode"
  >;
  readonly filePath: string;
  readonly cursor: SourceCursorRecord | undefined;
  readonly maxEvents: number;
}): Effect.Effect<SourceFileCollectionResult, DaemonSyncIoError> =>
  readUtf8(input.filePath, "readFile").pipe(
    Effect.catchTag("DaemonSyncIoError", (error) =>
      error.code === "ENOENT" ? Effect.succeed("") : Effect.fail(error)
    ),
    Effect.map((raw) => {
      const isJsonlSource = input.filePath.toLowerCase().endsWith(".jsonl");
      const parsedStructuredSource = isJsonlSource
        ? (() => {
            const parsedLines = parseStructuredSourceLines(raw);
            return parsedLines === null
              ? null
              : {
                  parsedRoot: parsedLines,
                  records: parsedLines,
                };
          })()
        : (() => {
            const parsedDocument = parseStructuredSourceDocument(raw);
            return parsedDocument === null
              ? null
              : {
                  parsedRoot: parsedDocument,
                  records: extractGenericSourceRecords(parsedDocument),
                };
          })();
      const digest = hashValue(raw.trim());
      if (parsedStructuredSource === null) {
        return {
          events: [],
          nextCursor: isJsonlSource ? splitJsonlContent(raw).length : 0,
          scannedLines: isJsonlSource ? splitJsonlContent(raw).length : 1,
          digest,
        } satisfies SourceFileCollectionResult;
      }
      const { parsedRoot, records } = parsedStructuredSource;
      let safeCursor =
        input.cursor &&
        input.cursor.cursor >= 0 &&
        input.cursor.cursor <= records.length
          ? input.cursor.cursor
          : 0;
      if (input.cursor?.digest === digest && safeCursor >= records.length) {
        return {
          events: [],
          nextCursor: records.length,
          scannedLines: 0,
          digest,
        } satisfies SourceFileCollectionResult;
      }
      if (
        input.cursor?.digest &&
        input.cursor.digest !== digest &&
        safeCursor >= records.length
      ) {
        safeCursor = 0;
      }

      const fileHints = extractPathHintsFromUnknown(
        parsedRoot,
        dirname(input.filePath)
      );
      const events: CollectedEvent[] = [];
      let scannedLines = 0;

      for (let index = safeCursor; index < records.length; index += 1) {
        if (events.length >= input.maxEvents) {
          return {
            events,
            nextCursor: index,
            scannedLines,
            digest,
          } satisfies SourceFileCollectionResult;
        }
        scannedLines += 1;
        const record = records[index];
        const content = contentTextFromGenericSourceRecord(record);
        if (!content) {
          continue;
        }
        const pathHints = mergeExtractedPathHints(
          extractPathHintsFromUnknown(record, dirname(input.filePath)),
          fileHints
        );
        events.push(
          buildCollectedEvent({
            source: input.source,
            sourceFile: input.filePath,
            sourceLine: index + 1,
            content: sanitizeSourceContent(
              `${basename(input.filePath)}:${index + 1} ${content}`
            ),
            path: pathHints.path,
            repoRoot: pathHints.repoRoot,
            workspaceRoot: pathHints.workspaceRoot,
          })
        );
      }
      return {
        events,
        nextCursor: records.length,
        scannedLines,
        digest,
      } satisfies SourceFileCollectionResult;
    })
  );

const collectSourceEventsEffect = (input: {
  readonly config: DaemonConfig;
  readonly state: SyncRuntimeState;
}) =>
  Effect.gen(function* () {
    const events: CollectedEvent[] = [];
    const cursorUpdates: Record<string, SourceCursorRecord> = {};
    const sourceStats: SourceCollectionStat[] = [];
    const now = toIsoNow();
    const maxEventsPerCycle = input.config.sources.defaults.maxEventsPerCycle;

    for (const source of [
      "codex",
      "claude",
      "cursor",
      "codex-native",
      "opencode",
      "plan",
      "vscode",
    ] as const) {
      if (events.length >= maxEventsPerCycle) {
        break;
      }
      const roots = sourceRootsFor(input.config, source);
      if (roots.length === 0) {
        continue;
      }
      if (source === "plan") {
        for (const planPath of planPathsFor(input.config)) {
          const collected = yield* collectPlanEventsEffect({
            planPath,
            cursor: input.state.sourceCursors[planPath],
          });
          const existingStat = sourceStats.find(
            (entry) => entry.source === source
          );
          upsertSourceStatEntry(sourceStats, {
            source,
            filesScanned: (existingStat?.filesScanned ?? 0) + 1,
            linesScanned:
              (existingStat?.linesScanned ?? 0) + collected.scannedLines,
            eventsPrepared:
              (existingStat?.eventsPrepared ?? 0) + collected.events.length,
          });
          if (collected.cursorUpdate) {
            cursorUpdates[planPath] = {
              ...collected.cursorUpdate,
              updatedAt: now,
            };
          }
          appendWithLimit(events, collected.events, maxEventsPerCycle);
        }
        continue;
      }

      const sessionHints =
        source === "codex"
          ? yield* indexCodexSessionHintsEffect(roots)
          : new Map<string, string>();
      const discoveredFiles = (yield* Effect.forEach(
        roots,
        (root) =>
          source === "codex-native" ||
          source === "cursor" ||
          source === "opencode" ||
          source === "vscode"
            ? listSourceFilesEffect(root, JSON_SOURCE_FILE_EXTENSIONS)
            : listJsonlFilesEffect(root),
        {
          concurrency: 1,
        }
      ))
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
            : source === "claude"
              ? yield* tailClaudeFileEffect({
                  filePath,
                  startCursor: input.state.sourceCursors[filePath]?.cursor ?? 0,
                  maxEvents: remaining,
                })
              : yield* collectGenericSourceFileEffect({
                  source,
                  filePath,
                  cursor: input.state.sourceCursors[filePath],
                  maxEvents: remaining,
                });
        const existingStat = sourceStats.find(
          (entry) => entry.source === source
        );
        upsertSourceStatEntry(sourceStats, {
          source,
          filesScanned: (existingStat?.filesScanned ?? 0) + 1,
          linesScanned:
            (existingStat?.linesScanned ?? 0) + collected.scannedLines,
          eventsPrepared:
            (existingStat?.eventsPrepared ?? 0) + collected.events.length,
        });
        cursorUpdates[filePath] = {
          cursor: collected.nextCursor,
          digest: collected.digest,
          updatedAt: now,
        };
        appendWithLimit(events, collected.events, maxEventsPerCycle);
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
  const result = Result.try({
    try: () => {
      process.kill(pid, 0);
      return true;
    },
    catch: () => false,
  });
  return Result.isSuccess(result) ? result.success : false;
};

const bindingMatchesCursorPath = (
  binding: DaemonSourceBinding,
  cursorPath: string
): boolean => {
  const normalizedCursorPath = resolve(cursorPath);
  if (binding.kind === "file") {
    return normalizedCursorPath === binding.path;
  }
  return (
    normalizedCursorPath === binding.path ||
    normalizedCursorPath.startsWith(`${binding.path}${sep}`)
  );
};

const sourceBindingHealthFor = (
  source: DiscoverableSourceName,
  exists: boolean
): DaemonSourceBindingHealth =>
  exists
    ? isSyncSupportedSource(source)
      ? "ready"
      : "unsupported"
    : "missing";

const directoryEntryCountEffect = (path: string) =>
  Effect.tryPromise({
    try: () => readdir(path, { withFileTypes: true }),
    catch: (cause) =>
      new DaemonSyncIoError({
        operation: "readdir",
        path,
        code: toErrnoCode(cause),
        message: `readdir failed for ${path}.`,
        details: toCauseDetails(cause),
      }),
  }).pipe(
    Effect.map((entries) => entries.length),
    Effect.catchTag("DaemonSyncIoError", () => Effect.succeed(0))
  );

const buildDiscoveryLabel = (
  source: DiscoverableSourceName,
  path: string,
  fallbackLabel: string | null = null
): string =>
  fallbackLabel ??
  (source === "codex"
    ? `Codex history (${basename(path)})`
    : source === "claude"
      ? `Claude history (${basename(path)})`
      : source === "cursor"
        ? `Cursor storage (${basename(path)})`
        : source === "codex-native"
          ? `Codex Native storage (${basename(path)})`
          : source === "opencode"
            ? `OpenCode storage (${basename(path)})`
            : source === "vscode"
              ? `VSCode/Copilot storage (${basename(path)})`
              : `Guidance file (${basename(path)})`);

const buildDiscoveryCandidate = (input: {
  readonly config?: DaemonConfig;
  readonly source: DiscoverableSourceName;
  readonly kind: DaemonSourceBinding["kind"];
  readonly path: string;
  readonly label: string;
  readonly evidenceCount: number;
  readonly detectedAt: string;
}): DaemonSourceDiscoveryCandidate => {
  const bindingPath = resolve(input.path);
  const id = buildDaemonSourceBindingId(input.source, input.kind, bindingPath);
  const existingBinding =
    input.config?.sources.bindings.find((binding) => binding.id === id) ?? null;
  const supportedForSync = isSyncSupportedSource(input.source);
  const autoApprove = sourceAutoApproveByDefault(input.source);
  return {
    id,
    source: input.source,
    kind: input.kind,
    path: bindingPath,
    label: input.label,
    existing: existingBinding !== null,
    currentStatus: existingBinding?.status ?? null,
    proposedStatus:
      existingBinding?.status ?? (autoApprove ? "approved" : "pending"),
    supportedForSync,
    health: sourceBindingHealthFor(input.source, true),
    evidenceCount: input.evidenceCount,
    recommended: autoApprove,
    detectedAt: input.detectedAt,
  };
};

const discoverDaemonSourcesEffect = (input: {
  readonly config?: DaemonConfig;
  readonly workspaceRoots?: readonly string[];
  readonly sourceFilter?: readonly DiscoverableSourceName[];
}) =>
  Effect.gen(function* () {
    const filteredSources =
      input.sourceFilter && input.sourceFilter.length > 0
        ? [...new Set(input.sourceFilter)].sort((left, right) =>
            left.localeCompare(right)
          )
        : [...DISCOVERABLE_SOURCE_NAMES];
    const detectedAt = toIsoNow();
    const candidates = new Map<string, DaemonSourceDiscoveryCandidate>();

    for (const source of filteredSources) {
      if (source === "plan") {
        for (const candidate of guidanceCandidatePathsFor(
          input.workspaceRoots ?? []
        )) {
          const exists = yield* safeFileExists(candidate.path);
          if (!exists) {
            continue;
          }
          const nextCandidate = buildDiscoveryCandidate({
            ...(input.config ? { config: input.config } : {}),
            source,
            kind: "file",
            path: candidate.path,
            label: candidate.label,
            evidenceCount: 1,
            detectedAt,
          });
          candidates.set(nextCandidate.id, nextCandidate);
        }
        continue;
      }

      for (const root of discoverableSourceRootsFor(source)) {
        const exists = yield* safeFileExists(root);
        if (!exists) {
          continue;
        }
        const evidenceCount =
          source === "codex" || source === "claude"
            ? (yield* listJsonlFilesEffect(root).pipe(
                Effect.catchTag("DaemonSyncIoError", () =>
                  Effect.succeed([] as string[])
                )
              )).length
            : source === "codex-native" || source === "vscode"
              ? (yield* listSourceFilesEffect(
                  root,
                  JSON_SOURCE_FILE_EXTENSIONS
                ).pipe(
                  Effect.catchTag("DaemonSyncIoError", () =>
                    Effect.succeed([] as string[])
                  )
                )).length
              : yield* directoryEntryCountEffect(root);
        const nextCandidate = buildDiscoveryCandidate({
          ...(input.config ? { config: input.config } : {}),
          source,
          kind: "directory",
          path: root,
          label: buildDiscoveryLabel(source, root),
          evidenceCount,
          detectedAt,
        });
        candidates.set(nextCandidate.id, nextCandidate);
      }
    }

    return [...candidates.values()].sort((left, right) =>
      `${left.source}|${left.path}`.localeCompare(
        `${right.source}|${right.path}`
      )
    );
  });

const getDaemonSourceViewsEffect = (configFile: string | null | undefined) =>
  Effect.gen(function* () {
    const loaded = yield* loadDaemonConfigEffect(configFile);
    yield* ensureStateDirsEffect(loaded.config);
    const state = yield* readSyncStateEffect(loaded.config);
    const bindings = yield* Effect.forEach(
      getDaemonSourceBindings(loaded.config),
      (binding) =>
        Effect.gen(function* () {
          const exists = yield* safeFileExists(binding.path);
          const checkpoints = Object.entries(state.sourceCursors)
            .filter(([path]) => bindingMatchesCursorPath(binding, path))
            .map(([path, cursor]) => ({
              path,
              cursor: cursor.cursor,
              digest: cursor.digest,
              updatedAt: cursor.updatedAt,
            }))
            .sort((left, right) =>
              right.updatedAt.localeCompare(left.updatedAt)
            );
          const supportedForSync = isSyncSupportedSource(binding.source);
          return {
            id: binding.id,
            source: binding.source,
            kind: binding.kind,
            path: binding.path,
            label: binding.label ?? null,
            status: binding.status,
            supportedForSync,
            activeForSync:
              binding.status === "approved" &&
              supportedForSync &&
              adapterEnabledForSource(loaded.config, binding.source),
            health: sourceBindingHealthFor(binding.source, exists),
            persistedHealth: binding.health ?? null,
            lastSeenAt: binding.lastSeenAt ?? null,
            checkpointCount: checkpoints.length,
            latestCheckpointAt: checkpoints[0]?.updatedAt ?? null,
            checkpoints,
          } satisfies DaemonSourceView;
        }),
      { concurrency: 1 }
    );
    return {
      configFile: loaded.configFile,
      bindings: bindings.sort((left, right) =>
        `${left.source}|${left.path}`.localeCompare(
          `${right.source}|${right.path}`
        )
      ),
    };
  });

const buildDaemonStatusViewEffect = (
  configFile: string,
  config: DaemonConfig,
  state: SyncRuntimeState
) =>
  readJournalEntriesEffect(config).pipe(
    Effect.flatMap((journalEntries) =>
      Effect.gen(function* () {
        const deliveries: DaemonStatusDeliveryView[] = [];
        const pendingByMemory = pendingEventsByMemory(
          journalEntries,
          state.deliveries
        );
        for (const [memoryAlias, memory] of Object.entries(
          config.memories
        ).sort(([left], [right]) => left.localeCompare(right))) {
          const checkpoint =
            state.deliveries[memoryAlias] ?? createEmptyDeliveryCheckpoint();
          const account = config.accounts[memory.account];
          if (!account) {
            return yield* Effect.fail(
              new DaemonSyncParseError({
                scope: "Daemon config",
                path: configFile,
                message: `Memory '${memoryAlias}' references unknown account '${memory.account}'.`,
                details:
                  "Re-run config validation and repair account references.",
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
          : (input.daemonStartedAt ?? state.daemonStartedAt ?? toIsoNow()),
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
    return yield* withSyncLockEffect(
      loaded.config,
      Effect.gen(function* () {
        const state = yield* readSyncStateEffect(loaded.config);
        const journalEntriesAtStart = yield* readJournalEntriesEffect(
          loaded.config
        );
        const recoveredState = reconcileSyncStateWithJournalEntries(
          state,
          journalEntriesAtStart
        );
        if (recoveredState !== state) {
          yield* writeSyncStateEffect(loaded.config, recoveredState);
        }
        const runtimeStateFile = resolveRuntimeStateFile(loaded.config);
        const journalFile = resolveJournalFile(loaded.config);
        const collected = yield* collectSourceEventsEffect({
          config: loaded.config,
          state: recoveredState,
        });
        const collectedAt = toIsoNow();
        const numberedJournalEntries = collected.events.map<JournalEntry>(
          (event, index) => {
            const resolution = explainDaemonRouteResolution(loaded.config, {
              path: event.path,
              repoRoot: event.repoRoot,
              workspaceRoot: event.workspaceRoot,
              source: event.source as DaemonConfigRouteSource,
            });
            const sourceCursor = collected.cursorUpdates[event.sourceFile];
            return {
              sequence: recoveredState.nextSequence + index,
              collectedAt,
              source: event.source,
              sourceFile: event.sourceFile,
              sourceLine: event.sourceLine,
              ...(sourceCursor ? { sourceCursor } : {}),
              path: event.path,
              repoRoot: event.repoRoot,
              workspaceRoot: event.workspaceRoot,
              routeStatus: resolution.status,
              memory:
                resolution.status === "matched" ||
                resolution.status === "default"
                  ? resolution.memory
                  : null,
              routeIndex: resolution.routeIndex,
              event: event.event,
            };
          }
        );
        const nextStateAfterJournal: SyncRuntimeState = {
          ...recoveredState,
          nextSequence:
            recoveredState.nextSequence + numberedJournalEntries.length,
          sourceCursors: {
            ...recoveredState.sourceCursors,
            ...collected.cursorUpdates,
          },
          lastRunAt: startedAt,
        };
        yield* appendJournalEntriesEffect(
          loaded.config,
          numberedJournalEntries
        );
        const journalEntriesFull = yield* readJournalEntriesEffect(
          loaded.config
        );
        const stateBeforeDelivery = reconcileSyncStateWithJournalEntries(
          nextStateAfterJournal,
          journalEntriesFull
        );
        yield* writeSyncStateEffect(loaded.config, stateBeforeDelivery);

        type DeliverySummaryRecord = DaemonSyncSummary["deliveries"][number];
        const deliveries: DeliverySummaryRecord[] = [];
        const deliveryErrors = [] as string[];
        const blockedMemories = [] as string[];
        const nextDeliveries: Record<string, DeliveryCheckpointRecord> = {
          ...stateBeforeDelivery.deliveries,
        };
        let deliveredEvents = 0;
        let accepted = 0;
        let duplicates = 0;

        for (const [memoryAlias, memory] of Object.entries(
          loaded.config.memories
        ).sort(([left], [right]) => left.localeCompare(right))) {
          const checkpoint =
            nextDeliveries[memoryAlias] ?? createEmptyDeliveryCheckpoint();
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
                details:
                  "Re-run config validation and repair account references.",
              })
            );
          }
          if (pendingEntries.length === 0) {
            deliveries.push({
              memory: memoryAlias,
              account: memory.account,
              accountType: account.type,
              queuedEvents: 0,
              deliveredEvents: checkpoint.deliveredEvents,
              accepted: checkpoint.accepted,
              duplicates: checkpoint.duplicates,
              lastDeliveredSequence: checkpoint.lastDeliveredSequence,
              lastError: checkpoint.lastError,
            });
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
            nextDeliveries[memoryAlias] = updatedCheckpoint;
            deliveryErrors.push(error.message);
            deliveries.push({
              memory: memoryAlias,
              account: memory.account,
              accountType: account.type,
              queuedEvents: pendingEntries.length,
              deliveredEvents: updatedCheckpoint.deliveredEvents,
              accepted: updatedCheckpoint.accepted,
              duplicates: updatedCheckpoint.duplicates,
              lastDeliveredSequence: updatedCheckpoint.lastDeliveredSequence,
              lastError: updatedCheckpoint.lastError,
            });
            continue;
          }

          let cycleAccepted = 0;
          let cycleDuplicates = 0;
          const deliveryAttempt = yield* Effect.forEach(
            chunkItems(pendingEntries.map((entry) => entry.event)),
            (chunk) =>
              (account.type === "local"
                ? Effect.tryPromise({
                    try: () =>
                      executeRuntimeOperation({
                        operation: "ingest",
                        stateFile: runtimeStateFile,
                        requestBody: {
                          storeId: memory.storeId,
                          profile: memory.profile,
                          events: chunk,
                        },
                      }),
                    catch: (cause) =>
                      new DaemonSyncDeliveryError({
                        memory: memoryAlias,
                        account: memory.account,
                        message: `Local ingest failed for memory '${memoryAlias}'.`,
                        details: toCauseDetails(cause),
                      }),
                  })
                : postRemoteIngestionChunkEffect({
                    accountAlias: memory.account,
                    account,
                    memoryAlias,
                    memory,
                    events: chunk,
                  })
              ).pipe(
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
                  return result;
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
            nextDeliveries[memoryAlias] = updatedCheckpoint;
            deliveryErrors.push(deliveryAttempt.error.message);
            if (account.type === "http") {
              blockedMemories.push(memoryAlias);
            }
            deliveries.push({
              memory: memoryAlias,
              account: memory.account,
              accountType: account.type,
              queuedEvents: pendingEntries.length,
              deliveredEvents: updatedCheckpoint.deliveredEvents,
              accepted: updatedCheckpoint.accepted,
              duplicates: updatedCheckpoint.duplicates,
              lastDeliveredSequence: updatedCheckpoint.lastDeliveredSequence,
              lastError: updatedCheckpoint.lastError,
            });
            continue;
          }

          const updatedCheckpoint: DeliveryCheckpointRecord = {
            ...checkpoint,
            lastDeliveredSequence:
              pendingEntries.at(-1)?.sequence ??
              checkpoint.lastDeliveredSequence,
            deliveredEvents: checkpoint.deliveredEvents + pendingEntries.length,
            accepted: checkpoint.accepted + cycleAccepted,
            duplicates: checkpoint.duplicates + cycleDuplicates,
            updatedAt: toIsoNow(),
            lastError: null,
          };
          nextDeliveries[memoryAlias] = updatedCheckpoint;
          deliveredEvents += pendingEntries.length;
          accepted += cycleAccepted;
          duplicates += cycleDuplicates;
          deliveries.push({
            memory: memoryAlias,
            account: memory.account,
            accountType: account.type,
            queuedEvents: pendingEntries.length,
            deliveredEvents: updatedCheckpoint.deliveredEvents,
            accepted: updatedCheckpoint.accepted,
            duplicates: updatedCheckpoint.duplicates,
            lastDeliveredSequence: updatedCheckpoint.lastDeliveredSequence,
            lastError: updatedCheckpoint.lastError,
          });
        }

        const finalState: SyncRuntimeState = {
          ...stateBeforeDelivery,
          deliveries: nextDeliveries,
          lastSuccessAt:
            deliveryErrors.length === 0
              ? toIsoNow()
              : stateBeforeDelivery.lastSuccessAt,
          lastError:
            deliveryErrors.length === 0 ? null : deliveryErrors.join("; "),
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
          const errorDetails = deliveryErrors.join("; ");
          return yield* Effect.fail(
            new DaemonSyncDeliveryError({
              memory: blockedMemories[0] ?? "multiple",
              account:
                blockedMemories[0] && loaded.config.memories[blockedMemories[0]]
                  ? (loaded.config.memories[blockedMemories[0]]?.account ??
                    "multiple")
                  : "multiple",
              message: `Sync completed with delivery errors: ${errorDetails}`,
              details: errorDetails,
            })
          );
        }

        return summary;
      })
    );
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
): Promise<DaemonStatusView> =>
  Effect.runPromise(getDaemonStatusEffect(configFile));

export const discoverDaemonSources = (
  input: {
    readonly config?: DaemonConfig;
    readonly workspaceRoots?: readonly string[];
    readonly sourceFilter?: readonly DiscoverableSourceName[];
  } = {}
): Promise<readonly DaemonSourceDiscoveryCandidate[]> =>
  Effect.runPromise(discoverDaemonSourcesEffect(input));

export const getDaemonSourceViews = (
  configFile: string | null | undefined
): Promise<{
  readonly configFile: string;
  readonly bindings: readonly DaemonSourceView[];
}> => Effect.runPromise(getDaemonSourceViewsEffect(configFile));

export const runConfiguredSyncCycle = (
  configFile: string | null | undefined
): Promise<DaemonSyncSummary> =>
  Effect.runPromise(runConfiguredSyncCycleEffect(configFile));

export const runConfiguredSyncDaemon = (
  options: RunConfiguredSyncDaemonOptions = {}
): Promise<{ cycles: number; lastSummary: DaemonSyncSummary | null }> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const resolvedConfigFile = resolveDaemonConfigFilePath(
        options.configFile
      );
      const loaded = yield* loadDaemonConfigEffect(resolvedConfigFile);
      const intervalMs =
        options.intervalMs && options.intervalMs > 0
          ? options.intervalMs
          : loaded.config.defaults.sync.intervalMs;
      const maxCycles =
        options.maxCycles && options.maxCycles > 0 ? options.maxCycles : null;
      let cycles = 0;
      let lastSummary: DaemonSyncSummary | null = null;
      for (;;) {
        if (options.signal?.aborted) {
          break;
        }
        if (maxCycles !== null && cycles >= maxCycles) {
          break;
        }
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
        if (options.signal?.aborted) {
          break;
        }
        if (maxCycles !== null && cycles >= maxCycles) {
          break;
        }
        const delayExit = yield* Effect.tryPromise({
          try: () =>
            options.signal
              ? delay(
                  Math.max(intervalMs, DEFAULT_DAEMON_POLL_DELAY_MS),
                  undefined,
                  { signal: options.signal }
                )
              : delay(Math.max(intervalMs, DEFAULT_DAEMON_POLL_DELAY_MS)),
          catch: (cause) => cause,
        }).pipe(
          Effect.match({
            onSuccess: () => ({
              status: "success" as const,
            }),
            onFailure: (cause) => ({
              status: "failure" as const,
              cause,
            }),
          })
        );
        if (delayExit.status === "failure") {
          if (options.signal?.aborted) {
            break;
          }
          return yield* Effect.fail(
            new DaemonSyncIoError({
              operation: "delay",
              path: resolvedConfigFile,
              code: "DELAY_FAILED",
              message: "sync-daemon sleep failed.",
              details: toCauseDetails(delayExit.cause),
            })
          );
        }
      }
      return {
        cycles,
        lastSummary,
      };
    })
  );
