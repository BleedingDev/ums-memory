import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { Cause, Effect, Exit, Schema } from "effect";

import {
  DEFAULT_RUNTIME_STATE_FILE,
  executeRuntimeOperation,
} from "../../api/src/runtime-service.ts";
import { startSupervisedApiService } from "../../api/src/service-runtime.ts";
import { startSupervisedWorkerService } from "../../api/src/worker-runtime.ts";
import { main as runCliMain } from "../../cli/src/program.ts";
import {
  isMainImportMetaFlag,
  readCanonicalSkillEffect,
  runAgentBootstrapEffect,
} from "./agent-guidance.ts";
import {
  type DaemonAccountConfig,
  type DaemonConfig,
  type DaemonSourceBindingStatus,
  type DaemonConfigIssue,
  type DaemonConfigRouteSource,
  type DaemonMemoryConfig,
  canonicalizeDaemonConfig,
  explainDaemonRouteResolution,
  formatDaemonConfigError,
  parseJsonc,
  readDaemonConfig,
  resolveDaemonConfigFilePath,
  serializeDaemonConfig,
  writeDaemonConfig,
} from "./daemon-config.ts";
import {
  type DaemonCredentialExpiredError,
  type DaemonCredentialRecordError,
  type DaemonCredentialRefError,
  type DaemonCredentialStoreError,
  defaultCredentialRefForAccount,
  deleteManagedAccountCredential,
  getManagedAccountCredentialState,
  storeManagedAccountCredential,
} from "./daemon-credentials.ts";
import {
  doctorDaemonEffect,
  formatDaemonLifecycleCommandError,
  installDaemonEffect,
  logsDaemonEffect,
  restartDaemonEffect,
  startDaemonEffect,
  statusDaemonEffect,
  stopDaemonEffect,
  uninstallDaemonEffect,
} from "./daemon-lifecycle.ts";
import {
  clearStaleDaemonPid,
  discoverDaemonSources,
  type DaemonSyncSummary,
  executeRemoteAccountOperationEffect,
  getDaemonStatus,
  getDaemonSourceViews,
  runConfiguredSyncCycle,
  runConfiguredSyncDaemon,
  updateDaemonStatus,
} from "./daemon-sync.ts";

const ERRNO_CAUSE_SCHEMA = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
});
const ERROR_WITH_MESSAGE_SCHEMA = Schema.Struct({
  message: Schema.String,
});
const DAEMON_CONFIG_ISSUE_SCHEMA = Schema.Struct({
  path: Schema.String,
  message: Schema.String,
});
const UNKNOWN_RECORD_SCHEMA = Schema.Record(Schema.String, Schema.Unknown);
const DAEMON_CONFIG_ERROR_SCHEMA = Schema.Struct({
  code: Schema.String,
  issues: Schema.Array(DAEMON_CONFIG_ISSUE_SCHEMA),
});
const CLI_CODED_ERROR_SCHEMA = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
});
const TAGGED_ERROR_WITH_MESSAGE_SCHEMA = Schema.Struct({
  _tag: Schema.String,
  message: Schema.String,
});
const isString = Schema.is(Schema.String);
const isUnknownRecord = Schema.is(UNKNOWN_RECORD_SCHEMA);
const isErrnoCause = Schema.is(ERRNO_CAUSE_SCHEMA);
const isErrorWithMessage = Schema.is(ERROR_WITH_MESSAGE_SCHEMA);
const isDaemonConfigErrorLike = Schema.is(DAEMON_CONFIG_ERROR_SCHEMA);
const isCliCodedError = Schema.is(CLI_CODED_ERROR_SCHEMA);
const isTaggedErrorWithMessage = Schema.is(TAGGED_ERROR_WITH_MESSAGE_SCHEMA);

const toCauseMessage = (cause: unknown): string =>
  isErrnoCause(cause) || isErrorWithMessage(cause)
    ? cause.message
    : String(cause);

const taggedErrorCode = (tag: string): string =>
  tag.replaceAll(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();

const formatCliCommandFailure = (
  cause: unknown
): {
  readonly code: string;
  readonly message: string;
} | null => {
  if (isCliCodedError(cause)) {
    return {
      code: cause.code,
      message: cause.message,
    };
  }
  if (isTaggedErrorWithMessage(cause)) {
    return {
      code: taggedErrorCode(cause._tag),
      message: cause.message,
    };
  }
  return null;
};

interface ServeArgs {
  host: string;
  port: number;
  stateFile: string;
}

interface WorkerArgs {
  intervalMs: number;
  stateFile: string;
  restartLimit: number;
  restartDelayMs: number;
}

interface SyncArgs {
  configFile: string | null;
}

interface SyncDaemonArgs {
  configFile: string | null;
  intervalMs: number | null;
  maxCycles: number | null;
  quiet: boolean;
}

interface StatusArgs {
  configFile: string | null;
}

interface InstallArgs extends ConfigCommonArgs {}

interface StartArgs extends ConfigCommonArgs {
  intervalMs: number | null;
  readyTimeoutMs: number;
}

interface StopArgs extends ConfigCommonArgs {
  timeoutMs: number;
}

interface RestartArgs extends ConfigCommonArgs {
  intervalMs: number | null;
  readyTimeoutMs: number;
  timeoutMs: number;
}

interface LogsArgs extends ConfigCommonArgs {
  lines: number;
}

interface DoctorArgs extends ConfigCommonArgs {}

interface UninstallArgs extends ConfigCommonArgs {
  timeoutMs: number;
}

interface ConfigCommonArgs {
  configFile: string | null;
}

interface ConfigInitArgs extends ConfigCommonArgs {
  force: boolean;
}

interface ConfigValidateArgs extends ConfigCommonArgs {}

interface ConfigDoctorArgs extends ConfigCommonArgs {
  fix: boolean;
}

interface AccountAddArgs extends ConfigCommonArgs {
  name: string | null;
  type: string | null;
  apiUrl: string | null;
  authMode: string | null;
  credentialRef: string | null;
  authEnv: string | null;
  force: boolean;
}

interface AccountListArgs extends ConfigCommonArgs {}

interface AccountLoginArgs extends ConfigCommonArgs {
  name: string | null;
  secretEnv: string | null;
  secretFile: string | null;
  secretStdin: boolean;
  expiresAt: string | null;
}

interface AccountLogoutArgs extends ConfigCommonArgs {
  name: string | null;
}

interface AccountRemoveArgs extends ConfigCommonArgs {
  name: string | null;
}

interface MemoryAddArgs extends ConfigCommonArgs {
  name: string | null;
  account: string | null;
  storeId: string | null;
  profile: string | null;
  project: string | null;
  workspace: string | null;
  tags: readonly string[];
  readOnly: boolean;
  force: boolean;
}

interface MemoryListArgs extends ConfigCommonArgs {}

interface MemoryRemoveArgs extends ConfigCommonArgs {
  name: string | null;
}

type MemoryOutputFormat = "json" | "text";

interface MemoryCommandCommonArgs extends ConfigCommonArgs {
  memory: string | null;
  format: MemoryOutputFormat | null;
  input: string | null;
  file: string | null;
}

interface MemorySearchArgs extends MemoryCommandCommonArgs {
  query: string | null;
  limit: number | null;
  types: readonly string[];
}

interface MemoryTimelineArgs extends MemoryCommandCommonArgs {
  limit: number | null;
  since: string | null;
  until: string | null;
  types: readonly string[];
}

interface MemoryProvenanceArgs extends MemoryCommandCommonArgs {
  limit: number | null;
  entityRefs: readonly {
    readonly entityType: string;
    readonly entityId: string;
  }[];
}

interface MemoryPolicyAuditArgs extends MemoryCommandCommonArgs {
  limit: number | null;
  since: string | null;
  until: string | null;
  operations: readonly string[];
  outcomes: readonly string[];
  reasonCodes: readonly string[];
  policyKey: string | null;
}

interface MemoryAnomaliesArgs extends MemoryCommandCommonArgs {
  since: string | null;
  until: string | null;
  windowHours: number | null;
}

interface MemoryFeedbackArgs extends MemoryCommandCommonArgs {
  signal: "helpful" | "harmful";
  actor: string | null;
  note: string | null;
  feedbackId: string | null;
  targetRuleId: string | null;
  targetCandidateId: string | null;
}

interface MemoryOverrideArgs extends MemoryCommandCommonArgs {
  actor: string | null;
  reason: string | null;
  reasonCodes: readonly string[];
  targetRuleIds: readonly string[];
  targetCandidateIds: readonly string[];
  evidenceEventIds: readonly string[];
  sourceEventIds: readonly string[];
  confirm: boolean;
}

interface RouteAddArgs extends ConfigCommonArgs {
  memory: string | null;
  priority: number;
  pathPrefix: string | null;
  repoRoot: string | null;
  workspaceRoot: string | null;
  source: DaemonConfigRouteSource | null;
  project: string | null;
  workspace: string | null;
  notes: string | null;
}

interface RouteListArgs extends ConfigCommonArgs {}

interface RouteRemoveArgs extends ConfigCommonArgs {
  index: number | null;
}

interface RouteExplainArgs extends ConfigCommonArgs {
  path: string | null;
  repoRoot: string | null;
  workspaceRoot: string | null;
  source: DaemonConfigRouteSource | null;
}

interface RouteSetDefaultArgs extends ConfigCommonArgs {
  memory: string | null;
  onAmbiguous: "review" | "default" | "drop" | null;
}

interface RouteShowDefaultArgs extends ConfigCommonArgs {}

interface SourceDiscoverArgs extends ConfigCommonArgs {
  readonly workspaceRoots: readonly string[];
  readonly sources: readonly DaemonConfigRouteSource[];
}

interface SourceListArgs extends ConfigCommonArgs {
  readonly source: DaemonConfigRouteSource | null;
}

interface SourceInspectArgs extends ConfigCommonArgs {
  readonly id: string | null;
}

const DEFAULT_API_HOST = process.env["UMS_API_HOST"] ?? "127.0.0.1";
const DEFAULT_API_PORT = Number.parseInt(
  process.env["UMS_API_PORT"] ?? "8787",
  10
);
const DEFAULT_WORKER_INTERVAL_MS = Number.parseInt(
  process.env["UMS_WORKER_INTERVAL_MS"] ?? "30000",
  10
);
const DEFAULT_WORKER_RESTART_LIMIT = Number.parseInt(
  process.env["UMS_WORKER_RESTART_LIMIT"] ?? "3",
  10
);
const DEFAULT_WORKER_RESTART_DELAY_MS = Number.parseInt(
  process.env["UMS_WORKER_RESTART_DELAY_MS"] ?? "250",
  10
);
const DEFAULT_DAEMON_READY_TIMEOUT_MS = 5_000;
const DEFAULT_DAEMON_STOP_TIMEOUT_MS = 5_000;
const DEFAULT_DAEMON_LOG_LINES = 25;

function resolveDefaultStateFile(): string {
  const configuredRuntimeStateFile = process.env["UMS_RUNTIME_STATE_FILE"];
  if (
    isString(configuredRuntimeStateFile) &&
    configuredRuntimeStateFile.trim()
  ) {
    return configuredRuntimeStateFile.trim();
  }
  const configuredSharedStateFile = process.env["UMS_STATE_FILE"];
  if (isString(configuredSharedStateFile) && configuredSharedStateFile.trim()) {
    return configuredSharedStateFile.trim();
  }
  return DEFAULT_RUNTIME_STATE_FILE;
}

function printUsage(): void {
  process.stderr.write(
    `${[
      "Usage:",
      "  ums <operation> [--input '<json>'] [--file path] [--state-file path] [--store-id id] [--pretty]",
      "  ums serve [--host host] [--port port] [--state-file path]",
      "  ums worker [--interval-ms ms] [--state-file path] [--restart-limit n] [--restart-delay-ms ms]",
      "  ums login",
      "  ums connect",
      "  ums install [--config-file path]",
      "  ums start [--config-file path] [--interval-ms ms] [--ready-timeout-ms ms]",
      "  ums stop [--config-file path] [--timeout-ms ms]",
      "  ums restart [--config-file path] [--interval-ms ms] [--timeout-ms ms] [--ready-timeout-ms ms]",
      "  ums sync [--config-file path]",
      "  ums sync-daemon [--config-file path] [--interval-ms ms] [--max-cycles n] [--quiet]",
      "  ums status [--config-file path]",
      "  ums logs [--config-file path] [--lines n]",
      "  ums doctor [--config-file path]",
      "  ums uninstall [--config-file path] [--timeout-ms ms]",
      "  ums account add|list|remove ...",
      "  ums memory add|list|remove ...",
      "  ums source discover|onboard|list|inspect|approve|disable|ignore ...",
      "  ums route add|list|remove|explain ...",
      "  ums agent skill|bootstrap ...",
      "  ums route set-default ...",
      "  ums config init [--config-file path] [--force]",
      "  ums config validate [--config-file path]",
      "  ums config doctor [--config-file path] [--fix]",
      "",
      "Examples:",
      '  ums ingest --store-id coding-agent --input \'{"events":[{"type":"note","content":"Use deterministic IDs"}]}\'',
      "  ums install --config-file ~/.ums/config.jsonc",
      "  ums start --config-file ~/.ums/config.jsonc",
      "  ums restart --config-file ~/.ums/config.jsonc --interval-ms 30000",
      "  ums sync --config-file ~/.ums/config.jsonc",
      "  ums status --config-file ~/.ums/config.jsonc",
      "  ums logs --config-file ~/.ums/config.jsonc --lines 10",
      "  ums doctor --config-file ~/.ums/config.jsonc",
      "  ums uninstall --config-file ~/.ums/config.jsonc",
      "  ums account add --name company --type http --api-url https://ums.company.internal --auth-mode session-ref --credential-ref keychain://ums/company",
      "  ums memory add --name company-new-engine --account company --store-id coding-agent --profile developer-main --project new-engine",
      "  ums source discover --workspace-root ~/Developer/new-engine",
      "  ums source onboard --workspace-root ~/Developer/new-engine",
      "  ums source list",
      "  ums source disable --id src_1234567890abcdef",
      "  ums route add --path-prefix ~/Developer/new-engine --memory company-new-engine",
      "  ums route set-default --memory personal --on-ambiguous default",
      "  ums route explain --path ~/Developer/new-engine/src/server.ts",
      "  ums agent skill",
      "  ums agent bootstrap --config-file ~/.ums/config.jsonc --repo-root ~/Developer/new-engine --format all",
      "  ums config init",
      "  ums config validate",
      "  ums config doctor --fix",
      "  ums serve --host 127.0.0.1 --port 8787",
      "  ums worker --interval-ms 30000 --restart-limit 2 --restart-delay-ms 500",
      "",
      "Notes:",
      "  - API/worker default to runtime state base: ./.ums-runtime-state (+ .sqlite ledger, + .json snapshot)",
      "  - Legacy shared JSON compatibility remains opt-in via UMS_STATE_FILE or explicit --state-file",
      "  - Use `serve` to run the HTTP API server.",
      "  - Use `worker` to run background review/replay/maintenance cycles.",
      "  - Use `install` before `start`, `restart`, `logs`, `doctor`, or `uninstall`.",
      "  - `start` manages the background daemon; `sync-daemon` remains the low-level loop.",
      "  - `sync`, `sync-daemon`, and `status` now use config.jsonc only.",
      "  - `login` and `connect` are removed from the daemon-first runtime path.",
      "  - `config` manages ~/.ums/config.jsonc and uses canonical JSONC validation/rewrites.",
      "  - `source` autodiscovers local histories/guidance and persists consented bindings.",
    ].join("\n")}\n`
  );
}

function printConfigUsage(): void {
  process.stderr.write(
    `${[
      "Usage:",
      "  ums config init [--config-file path] [--force]",
      "  ums config validate [--config-file path]",
      "  ums config doctor [--config-file path] [--fix]",
      "",
      "Notes:",
      "  - `init` writes a canonical starter config for a local personal memory.",
      "  - `validate` fails when schema or cross-reference checks fail.",
      "  - `doctor` reports missing/invalid/canonicalization status and can rewrite into canonical form.",
    ].join("\n")}\n`
  );
}

function printAccountUsage(): void {
  process.stderr.write(
    `${[
      "Usage:",
      "  ums account add --name <alias> --type local",
      "  ums account add --name <alias> --type http --api-url <url> --auth-mode <oauth-device|oidc-pkce|session-ref|token-env> [--credential-ref <ref> | --auth-env <ENV>] [--force]",
      "  ums account list [--config-file path]",
      "  ums account login --name <alias> [--secret-stdin | --secret-file <path> | --secret-env <ENV>] [--expires-at <timestamp>] [--config-file path]",
      "  ums account logout --name <alias> [--config-file path]",
      "  ums account remove --name <alias> [--config-file path]",
      "",
      "Notes:",
      "  - Secure auth modes default credentialRef to the platform-native secure store namespace when omitted.",
      "  - `account login` stores managed session material in secure storage; it never writes plaintext secrets into config.",
      "  - `--expires-at` records explicit session expiry; expired secure credentials fail closed until refreshed.",
      "  - `token-env` remains an explicit dev/CI fallback and does not support secure login storage.",
    ].join("\n")}\n`
  );
}

function printMemoryUsage(): void {
  process.stderr.write(
    `${[
      "Usage:",
      "  ums memory add --name <alias> --account <alias> --store-id <id> --profile <profile> [--project <key>] [--workspace <key>] [--tag <tag>] [--read-only] [--force]",
      "  ums memory list [--config-file path]",
      "  ums memory remove --name <alias> [--config-file path]",
      "  ums memory search --memory <alias> --query <text> [--type <entity-type>] [--limit <n>] [--format json|text]",
      "  ums memory timeline --memory <alias> [--type <entity-type>] [--since <iso>] [--until <iso>] [--limit <n>] [--format json|text]",
      "  ums memory provenance --memory <alias> --entity-ref <entityType:entityId> [--entity-ref <entityType:entityId>] [--limit <n>] [--format json|text]",
      "  ums memory policy-audit --memory <alias> [--operation <name>] [--outcome <allow|review|deny|recorded>] [--reason-code <code>] [--policy-key <key>] [--since <iso>] [--until <iso>] [--limit <n>] [--format json|text]",
      "  ums memory anomalies --memory <alias> [--window-hours <n>] [--since <iso>] [--until <iso>] [--format json|text]",
      "  ums memory feedback --memory <alias> --signal <helpful|harmful> --actor <id> (--target-rule-id <id> | --target-candidate-id <id>) [--note <text>] [--feedback-id <id>] [--format json|text]",
      "  ums memory quarantine --memory <alias> --actor <id> --reason <text> (--target-rule-id <id> | --target-candidate-id <id>) [--reason-code <code>] [--evidence-event-id <id>] [--source-event-id <id>] --confirm [--format json|text]",
      "  ums memory forget --memory <alias> --actor <id> --reason <text> (--target-rule-id <id> | --target-candidate-id <id>) [--reason-code <code>] [--evidence-event-id <id>] [--source-event-id <id>] --confirm [--format json|text]",
      "  ums memory pin --memory <alias> --actor <id> --reason <text> (--target-rule-id <id> | --target-candidate-id <id>) [--reason-code <code>] [--evidence-event-id <id>] [--source-event-id <id>] --confirm [--format json|text]",
      "",
      "Notes:",
      "  - Search/timeline/provenance/policy-audit/anomalies default to text on a TTY and JSON in pipelines.",
      "  - Feedback and override controls run against the local runtime snapshot selected by the named memory alias.",
      "  - `quarantine`, `forget`, and `pin` require `--confirm` and preserve audit trail via manual override controls.",
    ].join("\n")}\n`
  );
}

function printSourceUsage(): void {
  process.stderr.write(
    `${[
      "Usage:",
      "  ums source discover [--config-file path] [--workspace-root path] [--source <codex|claude|cursor|opencode|vscode|codex-native|plan>]",
      "  ums source onboard [--config-file path] [--workspace-root path] [--source <codex|claude|cursor|opencode|vscode|codex-native|plan>]",
      "  ums source list [--config-file path] [--source <codex|claude|cursor|opencode|vscode|codex-native|plan>]",
      "  ums source inspect --id <binding-id> [--config-file path]",
      "  ums source approve --id <binding-id> [--config-file path]",
      "  ums source disable --id <binding-id> [--config-file path]",
      "  ums source ignore --id <binding-id> [--config-file path]",
      "",
      "Notes:",
      "  - `discover` previews local source candidates and proposed consent defaults.",
      "  - `onboard` persists detected bindings; sync-supported sources are approved by default.",
      "  - `list` and `inspect` show persisted bindings, health, and checkpoint summaries.",
      "  - `approve`, `disable`, and `ignore` update binding status without editing paths by hand.",
    ].join("\n")}\n`
  );
}

function printRouteUsage(): void {
  process.stderr.write(
    `${[
      "Usage:",
      "  ums route add --memory <alias> [--priority <n>] [--path-prefix <path>] [--repo-root <path>] [--workspace-root <path>] [--source <codex|claude|cursor|opencode|vscode|codex-native|plan>] [--project <key>] [--workspace <key>] [--notes <text>]",
      "  ums route list [--config-file path]",
      "  ums route remove --index <n> [--config-file path]",
      "  ums route set-default --memory <alias> [--on-ambiguous <review|default|drop>] [--config-file path]",
      "  ums route show-default [--config-file path]",
      "  ums route explain [--path <path>] [--repo-root <path>] [--workspace-root <path>] [--source <source>] [--config-file path]",
    ].join("\n")}\n`
  );
}

function printAgentUsage(): void {
  process.stderr.write(
    `${[
      "Usage:",
      "  ums agent skill [--format json|markdown]",
      "  ums agent bootstrap [--config-file path] [--repo-root path] [--format agents|claude|copilot|all] [--output path] [--check] [--force]",
      "",
      "Notes:",
      "  - `skill` returns canonical UMS skill metadata and markdown content.",
      "  - `bootstrap` writes thin repo-local snippets with managed replace markers.",
      "  - Without `--force`, bootstrap refuses to overwrite files that are not already UMS-managed.",
      "  - `--check` performs drift detection and exits non-zero when managed snippets are missing or stale.",
    ].join("\n")}\n`
  );
}

function parsePositiveIntegerFlag(
  raw: string | null,
  flagName: string
): number {
  if (!raw) {
    throw new Error(`Missing value for ${flagName}.`);
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flagName} must be a positive integer.`);
  }
  return parsed;
}

function parseServeArgs(argv: readonly string[]): ServeArgs {
  const args = [...argv];
  const parsed: ServeArgs = {
    host: DEFAULT_API_HOST,
    port: DEFAULT_API_PORT,
    stateFile: resolveDefaultStateFile(),
  };

  while (args.length > 0) {
    const token = args.shift();
    if (!token) {
      continue;
    }
    if (token === "--host") {
      parsed.host = args.shift() ?? "";
      continue;
    }
    if (token === "--port") {
      const portValue = args.shift() ?? "";
      const parsedPort = Number.parseInt(portValue, 10);
      if (
        !Number.isFinite(parsedPort) ||
        parsedPort < 0 ||
        parsedPort > 65535
      ) {
        throw new Error(`Invalid --port value: ${portValue}`);
      }
      parsed.port = parsedPort;
      continue;
    }
    if (token === "--state-file") {
      parsed.stateFile = args.shift() ?? "";
      continue;
    }
    throw new Error(`Unknown serve argument: ${token}`);
  }

  if (!parsed.host.trim()) {
    throw new Error("Host must be a non-empty string.");
  }

  return parsed;
}

function parseWorkerArgs(argv: readonly string[]): WorkerArgs {
  const args = [...argv];
  const parsed: WorkerArgs = {
    intervalMs: DEFAULT_WORKER_INTERVAL_MS,
    stateFile: resolveDefaultStateFile(),
    restartLimit: DEFAULT_WORKER_RESTART_LIMIT,
    restartDelayMs: DEFAULT_WORKER_RESTART_DELAY_MS,
  };

  while (args.length > 0) {
    const token = args.shift();
    if (!token) {
      continue;
    }
    if (token === "--interval-ms") {
      const value = args.shift() ?? "";
      const parsedValue = Number.parseInt(value, 10);
      if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
        throw new Error(`Invalid --interval-ms value: ${value}`);
      }
      parsed.intervalMs = parsedValue;
      continue;
    }
    if (token === "--state-file") {
      parsed.stateFile = args.shift() ?? "";
      continue;
    }
    if (token === "--restart-limit") {
      const value = args.shift() ?? "";
      const parsedValue = Number.parseInt(value, 10);
      if (!Number.isFinite(parsedValue) || parsedValue < 0) {
        throw new Error(`Invalid --restart-limit value: ${value}`);
      }
      parsed.restartLimit = parsedValue;
      continue;
    }
    if (token === "--restart-delay-ms") {
      const value = args.shift() ?? "";
      const parsedValue = Number.parseInt(value, 10);
      if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
        throw new Error(`Invalid --restart-delay-ms value: ${value}`);
      }
      parsed.restartDelayMs = parsedValue;
      continue;
    }
    throw new Error(`Unknown worker argument: ${token}`);
  }

  if (
    isString(parsed.stateFile) &&
    parsed.stateFile.length > 0 &&
    parsed.stateFile.trim().length === 0
  ) {
    throw new Error("State file must be a non-empty string when provided.");
  }

  return parsed;
}

function parseSyncArgs(argv: readonly string[]): SyncArgs {
  const parsed = parseConfigCommonArgs(argv);
  if (parsed.rest.length > 0) {
    throw new Error(`Unknown sync argument: ${parsed.rest[0]}`);
  }
  return {
    configFile: parsed.configFile,
  };
}

function parseSyncDaemonArgs(argv: readonly string[]): SyncDaemonArgs {
  const parsedConfig = parseConfigCommonArgs(argv);
  const args = [...parsedConfig.rest];
  const parsed: SyncDaemonArgs = {
    configFile: parsedConfig.configFile,
    intervalMs: null,
    maxCycles: null,
    quiet: false,
  };

  while (args.length > 0) {
    const token = args.shift();
    if (!token) {
      continue;
    }
    if (token === "--interval-ms") {
      parsed.intervalMs = parsePositiveIntegerFlag(
        args.shift() ?? "",
        "--interval-ms"
      );
      continue;
    }
    if (token === "--max-cycles") {
      parsed.maxCycles = parsePositiveIntegerFlag(
        args.shift() ?? "",
        "--max-cycles"
      );
      continue;
    }
    if (token === "--quiet") {
      parsed.quiet = true;
      continue;
    }
    throw new Error(`Unknown sync-daemon argument: ${token}`);
  }

  return parsed;
}

function parseStatusArgs(argv: readonly string[]): StatusArgs {
  const parsed = parseConfigCommonArgs(argv);
  if (parsed.rest.length > 0) {
    throw new Error(`Unknown status argument: ${parsed.rest[0]}`);
  }
  return {
    configFile: parsed.configFile,
  };
}

function parseInstallArgs(argv: readonly string[]): InstallArgs {
  const parsed = parseConfigCommonArgs(argv);
  if (parsed.rest.length > 0) {
    throw new Error(`Unknown install argument: ${parsed.rest[0]}`);
  }
  return {
    configFile: parsed.configFile,
  };
}

function parseStartArgs(argv: readonly string[]): StartArgs {
  const parsedConfig = parseConfigCommonArgs(argv);
  const args = [...parsedConfig.rest];
  const parsed: StartArgs = {
    configFile: parsedConfig.configFile,
    intervalMs: null,
    readyTimeoutMs: DEFAULT_DAEMON_READY_TIMEOUT_MS,
  };

  while (args.length > 0) {
    const token = args.shift();
    if (!token) {
      continue;
    }
    if (token === "--interval-ms") {
      parsed.intervalMs = parsePositiveIntegerFlag(
        args.shift() ?? "",
        "--interval-ms"
      );
      continue;
    }
    if (token === "--ready-timeout-ms") {
      parsed.readyTimeoutMs = parsePositiveIntegerFlag(
        args.shift() ?? "",
        "--ready-timeout-ms"
      );
      continue;
    }
    throw new Error(`Unknown start argument: ${token}`);
  }

  return parsed;
}

function parseStopArgs(argv: readonly string[]): StopArgs {
  const parsedConfig = parseConfigCommonArgs(argv);
  const args = [...parsedConfig.rest];
  const parsed: StopArgs = {
    configFile: parsedConfig.configFile,
    timeoutMs: DEFAULT_DAEMON_STOP_TIMEOUT_MS,
  };

  while (args.length > 0) {
    const token = args.shift();
    if (!token) {
      continue;
    }
    if (token === "--timeout-ms") {
      parsed.timeoutMs = parsePositiveIntegerFlag(
        args.shift() ?? "",
        "--timeout-ms"
      );
      continue;
    }
    throw new Error(`Unknown stop argument: ${token}`);
  }

  return parsed;
}

function parseRestartArgs(argv: readonly string[]): RestartArgs {
  const parsedConfig = parseConfigCommonArgs(argv);
  const args = [...parsedConfig.rest];
  const parsed: RestartArgs = {
    configFile: parsedConfig.configFile,
    intervalMs: null,
    readyTimeoutMs: DEFAULT_DAEMON_READY_TIMEOUT_MS,
    timeoutMs: DEFAULT_DAEMON_STOP_TIMEOUT_MS,
  };

  while (args.length > 0) {
    const token = args.shift();
    if (!token) {
      continue;
    }
    if (token === "--interval-ms") {
      parsed.intervalMs = parsePositiveIntegerFlag(
        args.shift() ?? "",
        "--interval-ms"
      );
      continue;
    }
    if (token === "--ready-timeout-ms") {
      parsed.readyTimeoutMs = parsePositiveIntegerFlag(
        args.shift() ?? "",
        "--ready-timeout-ms"
      );
      continue;
    }
    if (token === "--timeout-ms") {
      parsed.timeoutMs = parsePositiveIntegerFlag(
        args.shift() ?? "",
        "--timeout-ms"
      );
      continue;
    }
    throw new Error(`Unknown restart argument: ${token}`);
  }

  return parsed;
}

function parseLogsArgs(argv: readonly string[]): LogsArgs {
  const parsedConfig = parseConfigCommonArgs(argv);
  const args = [...parsedConfig.rest];
  const parsed: LogsArgs = {
    configFile: parsedConfig.configFile,
    lines: DEFAULT_DAEMON_LOG_LINES,
  };

  while (args.length > 0) {
    const token = args.shift();
    if (!token) {
      continue;
    }
    if (token === "--lines") {
      parsed.lines = parsePositiveIntegerFlag(args.shift() ?? "", "--lines");
      continue;
    }
    throw new Error(`Unknown logs argument: ${token}`);
  }

  return parsed;
}

function parseDoctorArgs(argv: readonly string[]): DoctorArgs {
  const parsed = parseConfigCommonArgs(argv);
  if (parsed.rest.length > 0) {
    throw new Error(`Unknown doctor argument: ${parsed.rest[0]}`);
  }
  return {
    configFile: parsed.configFile,
  };
}

function parseUninstallArgs(argv: readonly string[]): UninstallArgs {
  const parsedConfig = parseConfigCommonArgs(argv);
  const args = [...parsedConfig.rest];
  const parsed: UninstallArgs = {
    configFile: parsedConfig.configFile,
    timeoutMs: DEFAULT_DAEMON_STOP_TIMEOUT_MS,
  };

  while (args.length > 0) {
    const token = args.shift();
    if (!token) {
      continue;
    }
    if (token === "--timeout-ms") {
      parsed.timeoutMs = parsePositiveIntegerFlag(
        args.shift() ?? "",
        "--timeout-ms"
      );
      continue;
    }
    throw new Error(`Unknown uninstall argument: ${token}`);
  }

  return parsed;
}

function parseConfigCommonArgs(argv: readonly string[]): {
  readonly rest: string[];
  readonly configFile: string | null;
} {
  const args = [...argv];
  let configFile: string | null = null;
  const rest: string[] = [];

  while (args.length > 0) {
    const token = args.shift();
    if (!token) {
      continue;
    }
    if (token === "--config-file") {
      configFile = args.shift() ?? "";
      continue;
    }
    rest.push(token);
  }

  return {
    rest,
    configFile,
  };
}

function parseConfigInitArgs(argv: readonly string[]): ConfigInitArgs {
  const parsed = parseConfigCommonArgs(argv);
  let force = false;

  for (const token of parsed.rest) {
    if (token === "--force") {
      force = true;
      continue;
    }
    throw new Error(`Unknown config init argument: ${token}`);
  }

  return {
    configFile: parsed.configFile,
    force,
  };
}

function parseConfigValidateArgs(argv: readonly string[]): ConfigValidateArgs {
  const parsed = parseConfigCommonArgs(argv);
  if (parsed.rest.length > 0) {
    throw new Error(`Unknown config validate argument: ${parsed.rest[0]}`);
  }
  return {
    configFile: parsed.configFile,
  };
}

function parseConfigDoctorArgs(argv: readonly string[]): ConfigDoctorArgs {
  const parsed = parseConfigCommonArgs(argv);
  let fix = false;

  for (const token of parsed.rest) {
    if (token === "--fix") {
      fix = true;
      continue;
    }
    throw new Error(`Unknown config doctor argument: ${token}`);
  }

  return {
    configFile: parsed.configFile,
    fix,
  };
}

function parseRouteSourceFlag(
  value: string | null,
  flagName: string
): DaemonConfigRouteSource | null {
  const normalized = toMaybeString(value);
  if (!normalized) {
    throw new Error(`${flagName} requires a value.`);
  }
  if (
    normalized !== "codex" &&
    normalized !== "claude" &&
    normalized !== "cursor" &&
    normalized !== "opencode" &&
    normalized !== "vscode" &&
    normalized !== "codex-native" &&
    normalized !== "plan"
  ) {
    throw new Error(
      `${flagName} must be one of codex, claude, cursor, opencode, vscode, codex-native, plan.`
    );
  }
  return normalized;
}

const sortUniqueSources = (
  sources: readonly DaemonConfigRouteSource[]
): readonly DaemonConfigRouteSource[] =>
  [...new Set(sources)].sort((left, right) => left.localeCompare(right));

function parseIntegerValue(raw: string | null, flagName: string): number {
  if (!raw) {
    throw new Error(`${flagName} requires a value.`);
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${flagName} must be an integer.`);
  }
  return parsed;
}

function parseNonNegativeIntegerValue(
  raw: string | null,
  flagName: string
): number {
  const parsed = parseIntegerValue(raw, flagName);
  if (parsed < 0) {
    throw new Error(`${flagName} must be a non-negative integer.`);
  }
  return parsed;
}

function parseAccountAddArgs(argv: readonly string[]): AccountAddArgs {
  const parsed = parseConfigCommonArgs(argv);
  let name: string | null = null;
  let type: string | null = null;
  let apiUrl: string | null = null;
  let authMode: string | null = null;
  let credentialRef: string | null = null;
  let authEnv: string | null = null;
  let force = false;

  const args = [...parsed.rest];
  while (args.length > 0) {
    const token = args.shift();
    if (!token) {
      continue;
    }
    if (token === "--name") {
      name = args.shift() ?? "";
      continue;
    }
    if (token === "--type") {
      type = args.shift() ?? "";
      continue;
    }
    if (token === "--api-url") {
      apiUrl = args.shift() ?? "";
      continue;
    }
    if (token === "--auth-mode") {
      authMode = args.shift() ?? "";
      continue;
    }
    if (token === "--credential-ref") {
      credentialRef = args.shift() ?? "";
      continue;
    }
    if (token === "--auth-env") {
      authEnv = args.shift() ?? "";
      continue;
    }
    if (token === "--force") {
      force = true;
      continue;
    }
    throw new Error(`Unknown account add argument: ${token}`);
  }

  return {
    configFile: parsed.configFile,
    name: toMaybeString(name),
    type: toMaybeString(type),
    apiUrl: toMaybeString(apiUrl),
    authMode: toMaybeString(authMode),
    credentialRef: toMaybeString(credentialRef),
    authEnv: toMaybeString(authEnv),
    force,
  };
}

function parseAccountListArgs(argv: readonly string[]): AccountListArgs {
  const parsed = parseConfigCommonArgs(argv);
  if (parsed.rest.length > 0) {
    throw new Error(`Unknown account list argument: ${parsed.rest[0]}`);
  }
  return {
    configFile: parsed.configFile,
  };
}

function parseAccountLoginArgs(argv: readonly string[]): AccountLoginArgs {
  const parsed = parseConfigCommonArgs(argv);
  let name: string | null = null;
  let secretEnv: string | null = null;
  let secretFile: string | null = null;
  let secretStdin = false;
  let expiresAt: string | null = null;

  const args = [...parsed.rest];
  while (args.length > 0) {
    const token = args.shift();
    if (!token) {
      continue;
    }
    if (token === "--name") {
      name = args.shift() ?? "";
      continue;
    }
    if (token === "--secret-env") {
      secretEnv = args.shift() ?? "";
      continue;
    }
    if (token === "--secret-file") {
      secretFile = args.shift() ?? "";
      continue;
    }
    if (token === "--secret-stdin") {
      secretStdin = true;
      continue;
    }
    if (token === "--expires-at") {
      expiresAt = args.shift() ?? "";
      continue;
    }
    throw new Error(`Unknown account login argument: ${token}`);
  }

  return {
    configFile: parsed.configFile,
    name: toMaybeString(name),
    secretEnv: toMaybeString(secretEnv),
    secretFile: toMaybeString(secretFile),
    secretStdin,
    expiresAt: toMaybeString(expiresAt),
  };
}

function parseAccountLogoutArgs(argv: readonly string[]): AccountLogoutArgs {
  const parsed = parseConfigCommonArgs(argv);
  let name: string | null = null;
  const args = [...parsed.rest];
  while (args.length > 0) {
    const token = args.shift();
    if (!token) {
      continue;
    }
    if (token === "--name") {
      name = args.shift() ?? "";
      continue;
    }
    throw new Error(`Unknown account logout argument: ${token}`);
  }
  return {
    configFile: parsed.configFile,
    name: toMaybeString(name),
  };
}

function parseAccountRemoveArgs(argv: readonly string[]): AccountRemoveArgs {
  const parsed = parseConfigCommonArgs(argv);
  let name: string | null = null;
  const args = [...parsed.rest];
  while (args.length > 0) {
    const token = args.shift();
    if (!token) {
      continue;
    }
    if (token === "--name") {
      name = args.shift() ?? "";
      continue;
    }
    throw new Error(`Unknown account remove argument: ${token}`);
  }
  return {
    configFile: parsed.configFile,
    name: toMaybeString(name),
  };
}

function parseTags(values: readonly string[]): readonly string[] {
  return [...new Set(values.flatMap((value) => value.split(",")))]
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .sort((left, right) => left.localeCompare(right));
}

function parseMemoryAddArgs(argv: readonly string[]): MemoryAddArgs {
  const parsed = parseConfigCommonArgs(argv);
  let name: string | null = null;
  let account: string | null = null;
  let storeId: string | null = null;
  let profile: string | null = null;
  let project: string | null = null;
  let workspace: string | null = null;
  let readOnly = false;
  let force = false;
  const rawTags: string[] = [];

  const args = [...parsed.rest];
  while (args.length > 0) {
    const token = args.shift();
    if (!token) {
      continue;
    }
    if (token === "--name") {
      name = args.shift() ?? "";
      continue;
    }
    if (token === "--account") {
      account = args.shift() ?? "";
      continue;
    }
    if (token === "--store-id") {
      storeId = args.shift() ?? "";
      continue;
    }
    if (token === "--profile") {
      profile = args.shift() ?? "";
      continue;
    }
    if (token === "--project") {
      project = args.shift() ?? "";
      continue;
    }
    if (token === "--workspace") {
      workspace = args.shift() ?? "";
      continue;
    }
    if (token === "--tag" || token === "--tags") {
      rawTags.push(args.shift() ?? "");
      continue;
    }
    if (token === "--read-only") {
      readOnly = true;
      continue;
    }
    if (token === "--force") {
      force = true;
      continue;
    }
    throw new Error(`Unknown memory add argument: ${token}`);
  }

  return {
    configFile: parsed.configFile,
    name: toMaybeString(name),
    account: toMaybeString(account),
    storeId: toMaybeString(storeId),
    profile: toMaybeString(profile),
    project: toMaybeString(project),
    workspace: toMaybeString(workspace),
    tags: parseTags(rawTags),
    readOnly,
    force,
  };
}

function parseMemoryListArgs(argv: readonly string[]): MemoryListArgs {
  const parsed = parseConfigCommonArgs(argv);
  if (parsed.rest.length > 0) {
    throw new Error(`Unknown memory list argument: ${parsed.rest[0]}`);
  }
  return {
    configFile: parsed.configFile,
  };
}

function parseMemoryRemoveArgs(argv: readonly string[]): MemoryRemoveArgs {
  const parsed = parseConfigCommonArgs(argv);
  let name: string | null = null;
  const args = [...parsed.rest];
  while (args.length > 0) {
    const token = args.shift();
    if (!token) {
      continue;
    }
    if (token === "--name") {
      name = args.shift() ?? "";
      continue;
    }
    throw new Error(`Unknown memory remove argument: ${token}`);
  }
  return {
    configFile: parsed.configFile,
    name: toMaybeString(name),
  };
}

function parseMemoryCommandCommonArgs(argv: readonly string[]): {
  readonly configFile: string | null;
  readonly memory: string | null;
  readonly format: MemoryOutputFormat | null;
  readonly input: string | null;
  readonly file: string | null;
  readonly rest: readonly string[];
} {
  const parsed = parseConfigCommonArgs(argv);
  let memory: string | null = null;
  let format: MemoryOutputFormat | null = null;
  let input: string | null = null;
  let file: string | null = null;
  const rest: string[] = [];

  const args = [...parsed.rest];
  while (args.length > 0) {
    const token = args.shift();
    if (!token) {
      continue;
    }
    if (token === "--memory") {
      memory = args.shift() ?? "";
      continue;
    }
    if (token === "--format") {
      const value = toMaybeString(args.shift() ?? "");
      if (value !== "json" && value !== "text") {
        throw new Error("--format must be one of json or text.");
      }
      format = value;
      continue;
    }
    if (token === "--json") {
      format = "json";
      continue;
    }
    if (token === "--input") {
      input = args.shift() ?? "";
      continue;
    }
    if (token === "--file") {
      file = args.shift() ?? "";
      continue;
    }
    rest.push(token);
  }

  return {
    configFile: parsed.configFile,
    memory: toMaybeString(memory),
    format,
    input: toMaybeString(input),
    file: toMaybeString(file),
    rest,
  };
}

function parseEntityRefFlag(raw: string | null): {
  readonly entityType: string;
  readonly entityId: string;
} {
  const value = toMaybeString(raw);
  if (!value) {
    throw new Error("--entity-ref requires a value.");
  }
  const separatorIndex = value.indexOf(":");
  if (separatorIndex <= 0 || separatorIndex >= value.length - 1) {
    throw new Error("--entity-ref must use entityType:entityId format.");
  }
  return {
    entityType: value.slice(0, separatorIndex).trim(),
    entityId: value.slice(separatorIndex + 1).trim(),
  };
}

const sortUniqueStrings = (values: readonly string[]): readonly string[] =>
  [
    ...new Set(
      values.map((value) => value.trim()).filter((value) => value.length > 0)
    ),
  ].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

function parseMemorySearchArgs(argv: readonly string[]): MemorySearchArgs {
  const common = parseMemoryCommandCommonArgs(argv);
  let query: string | null = null;
  let limit: number | null = null;
  const types: string[] = [];

  const args = [...common.rest];
  while (args.length > 0) {
    const token = args.shift();
    if (!token) {
      continue;
    }
    if (token === "--query") {
      query = args.shift() ?? "";
      continue;
    }
    if (token === "--type") {
      const value = toMaybeString(args.shift() ?? "");
      if (!value) {
        throw new Error("--type requires a value.");
      }
      types.push(value);
      continue;
    }
    if (token === "--limit") {
      limit = parsePositiveIntegerFlag(args.shift() ?? "", "--limit");
      continue;
    }
    throw new Error(`Unknown memory search argument: ${token}`);
  }

  return {
    configFile: common.configFile,
    memory: common.memory,
    format: common.format,
    input: common.input,
    file: common.file,
    query: toMaybeString(query),
    limit,
    types: sortUniqueStrings(types),
  };
}

function parseMemoryTimelineArgs(argv: readonly string[]): MemoryTimelineArgs {
  const common = parseMemoryCommandCommonArgs(argv);
  let since: string | null = null;
  let until: string | null = null;
  let limit: number | null = null;
  const types: string[] = [];

  const args = [...common.rest];
  while (args.length > 0) {
    const token = args.shift();
    if (!token) {
      continue;
    }
    if (token === "--type") {
      const value = toMaybeString(args.shift() ?? "");
      if (!value) {
        throw new Error("--type requires a value.");
      }
      types.push(value);
      continue;
    }
    if (token === "--since") {
      since = args.shift() ?? "";
      continue;
    }
    if (token === "--until") {
      until = args.shift() ?? "";
      continue;
    }
    if (token === "--limit") {
      limit = parsePositiveIntegerFlag(args.shift() ?? "", "--limit");
      continue;
    }
    throw new Error(`Unknown memory timeline argument: ${token}`);
  }

  return {
    configFile: common.configFile,
    memory: common.memory,
    format: common.format,
    input: common.input,
    file: common.file,
    limit,
    since: toMaybeString(since),
    until: toMaybeString(until),
    types: sortUniqueStrings(types),
  };
}

function parseMemoryProvenanceArgs(
  argv: readonly string[]
): MemoryProvenanceArgs {
  const common = parseMemoryCommandCommonArgs(argv);
  let limit: number | null = null;
  const entityRefs: { entityType: string; entityId: string }[] = [];

  const args = [...common.rest];
  while (args.length > 0) {
    const token = args.shift();
    if (!token) {
      continue;
    }
    if (token === "--entity-ref") {
      entityRefs.push(parseEntityRefFlag(args.shift() ?? ""));
      continue;
    }
    if (token === "--limit") {
      limit = parsePositiveIntegerFlag(args.shift() ?? "", "--limit");
      continue;
    }
    throw new Error(`Unknown memory provenance argument: ${token}`);
  }

  return {
    configFile: common.configFile,
    memory: common.memory,
    format: common.format,
    input: common.input,
    file: common.file,
    limit,
    entityRefs: entityRefs.sort((left, right) =>
      `${left.entityType}:${left.entityId}`.localeCompare(
        `${right.entityType}:${right.entityId}`
      )
    ),
  };
}

function parseMemoryPolicyAuditArgs(
  argv: readonly string[]
): MemoryPolicyAuditArgs {
  const common = parseMemoryCommandCommonArgs(argv);
  let limit: number | null = null;
  let since: string | null = null;
  let until: string | null = null;
  let policyKey: string | null = null;
  const operations: string[] = [];
  const outcomes: string[] = [];
  const reasonCodes: string[] = [];

  const args = [...common.rest];
  while (args.length > 0) {
    const token = args.shift();
    if (!token) {
      continue;
    }
    if (token === "--operation") {
      const value = toMaybeString(args.shift() ?? "");
      if (!value) {
        throw new Error("--operation requires a value.");
      }
      operations.push(value);
      continue;
    }
    if (token === "--outcome") {
      const value = toMaybeString(args.shift() ?? "");
      if (!value) {
        throw new Error("--outcome requires a value.");
      }
      outcomes.push(value);
      continue;
    }
    if (token === "--reason-code") {
      const value = toMaybeString(args.shift() ?? "");
      if (!value) {
        throw new Error("--reason-code requires a value.");
      }
      reasonCodes.push(value);
      continue;
    }
    if (token === "--policy-key") {
      policyKey = args.shift() ?? "";
      continue;
    }
    if (token === "--since") {
      since = args.shift() ?? "";
      continue;
    }
    if (token === "--until") {
      until = args.shift() ?? "";
      continue;
    }
    if (token === "--limit") {
      limit = parsePositiveIntegerFlag(args.shift() ?? "", "--limit");
      continue;
    }
    throw new Error(`Unknown memory policy-audit argument: ${token}`);
  }

  return {
    configFile: common.configFile,
    memory: common.memory,
    format: common.format,
    input: common.input,
    file: common.file,
    limit,
    since: toMaybeString(since),
    until: toMaybeString(until),
    operations: sortUniqueStrings(operations),
    outcomes: sortUniqueStrings(outcomes),
    reasonCodes: sortUniqueStrings(reasonCodes),
    policyKey: toMaybeString(policyKey),
  };
}

function parseMemoryAnomaliesArgs(
  argv: readonly string[]
): MemoryAnomaliesArgs {
  const common = parseMemoryCommandCommonArgs(argv);
  let since: string | null = null;
  let until: string | null = null;
  let windowHours: number | null = null;

  const args = [...common.rest];
  while (args.length > 0) {
    const token = args.shift();
    if (!token) {
      continue;
    }
    if (token === "--since") {
      since = args.shift() ?? "";
      continue;
    }
    if (token === "--until") {
      until = args.shift() ?? "";
      continue;
    }
    if (token === "--window-hours") {
      windowHours = parsePositiveIntegerFlag(
        args.shift() ?? "",
        "--window-hours"
      );
      continue;
    }
    throw new Error(`Unknown memory anomalies argument: ${token}`);
  }

  return {
    configFile: common.configFile,
    memory: common.memory,
    format: common.format,
    input: common.input,
    file: common.file,
    since: toMaybeString(since),
    until: toMaybeString(until),
    windowHours,
  };
}

function parseMemoryFeedbackArgs(argv: readonly string[]): MemoryFeedbackArgs {
  const common = parseMemoryCommandCommonArgs(argv);
  let signal: "helpful" | "harmful" = "helpful";
  let actor: string | null = null;
  let note: string | null = null;
  let feedbackId: string | null = null;
  let targetRuleId: string | null = null;
  let targetCandidateId: string | null = null;

  const args = [...common.rest];
  while (args.length > 0) {
    const token = args.shift();
    if (!token) {
      continue;
    }
    if (token === "--signal") {
      const value = toMaybeString(args.shift() ?? "");
      if (value !== "helpful" && value !== "harmful") {
        throw new Error("--signal must be helpful or harmful.");
      }
      signal = value;
      continue;
    }
    if (token === "--actor") {
      actor = args.shift() ?? "";
      continue;
    }
    if (token === "--note") {
      note = args.shift() ?? "";
      continue;
    }
    if (token === "--feedback-id") {
      feedbackId = args.shift() ?? "";
      continue;
    }
    if (token === "--target-rule-id") {
      targetRuleId = args.shift() ?? "";
      continue;
    }
    if (token === "--target-candidate-id") {
      targetCandidateId = args.shift() ?? "";
      continue;
    }
    throw new Error(`Unknown memory feedback argument: ${token}`);
  }

  return {
    configFile: common.configFile,
    memory: common.memory,
    format: common.format,
    input: common.input,
    file: common.file,
    signal,
    actor: toMaybeString(actor),
    note: toMaybeString(note),
    feedbackId: toMaybeString(feedbackId),
    targetRuleId: toMaybeString(targetRuleId),
    targetCandidateId: toMaybeString(targetCandidateId),
  };
}

function parseMemoryOverrideArgs(argv: readonly string[]): MemoryOverrideArgs {
  const common = parseMemoryCommandCommonArgs(argv);
  let actor: string | null = null;
  let reason: string | null = null;
  let confirm = false;
  const reasonCodes: string[] = [];
  const targetRuleIds: string[] = [];
  const targetCandidateIds: string[] = [];
  const evidenceEventIds: string[] = [];
  const sourceEventIds: string[] = [];

  const args = [...common.rest];
  while (args.length > 0) {
    const token = args.shift();
    if (!token) {
      continue;
    }
    if (token === "--actor") {
      actor = args.shift() ?? "";
      continue;
    }
    if (token === "--reason") {
      reason = args.shift() ?? "";
      continue;
    }
    if (token === "--reason-code") {
      const value = toMaybeString(args.shift() ?? "");
      if (!value) {
        throw new Error("--reason-code requires a value.");
      }
      reasonCodes.push(value);
      continue;
    }
    if (token === "--target-rule-id") {
      const value = toMaybeString(args.shift() ?? "");
      if (!value) {
        throw new Error("--target-rule-id requires a value.");
      }
      targetRuleIds.push(value);
      continue;
    }
    if (token === "--target-candidate-id") {
      const value = toMaybeString(args.shift() ?? "");
      if (!value) {
        throw new Error("--target-candidate-id requires a value.");
      }
      targetCandidateIds.push(value);
      continue;
    }
    if (token === "--evidence-event-id") {
      const value = toMaybeString(args.shift() ?? "");
      if (!value) {
        throw new Error("--evidence-event-id requires a value.");
      }
      evidenceEventIds.push(value);
      continue;
    }
    if (token === "--source-event-id") {
      const value = toMaybeString(args.shift() ?? "");
      if (!value) {
        throw new Error("--source-event-id requires a value.");
      }
      sourceEventIds.push(value);
      continue;
    }
    if (token === "--confirm") {
      confirm = true;
      continue;
    }
    throw new Error(`Unknown memory override argument: ${token}`);
  }

  return {
    configFile: common.configFile,
    memory: common.memory,
    format: common.format,
    input: common.input,
    file: common.file,
    actor: toMaybeString(actor),
    reason: toMaybeString(reason),
    reasonCodes: sortUniqueStrings(reasonCodes),
    targetRuleIds: sortUniqueStrings(targetRuleIds),
    targetCandidateIds: sortUniqueStrings(targetCandidateIds),
    evidenceEventIds: sortUniqueStrings(evidenceEventIds),
    sourceEventIds: sortUniqueStrings(sourceEventIds),
    confirm,
  };
}

function parseRouteAddArgs(argv: readonly string[]): RouteAddArgs {
  const parsed = parseConfigCommonArgs(argv);
  let memory: string | null = null;
  let priority = 0;
  let pathPrefix: string | null = null;
  let repoRoot: string | null = null;
  let workspaceRoot: string | null = null;
  let source: DaemonConfigRouteSource | null = null;
  let project: string | null = null;
  let workspace: string | null = null;
  let notes: string | null = null;

  const args = [...parsed.rest];
  while (args.length > 0) {
    const token = args.shift();
    if (!token) {
      continue;
    }
    if (token === "--memory") {
      memory = args.shift() ?? "";
      continue;
    }
    if (token === "--priority") {
      priority = parseIntegerValue(args.shift() ?? "", "--priority");
      continue;
    }
    if (token === "--path-prefix") {
      pathPrefix = args.shift() ?? "";
      continue;
    }
    if (token === "--repo-root") {
      repoRoot = args.shift() ?? "";
      continue;
    }
    if (token === "--workspace-root") {
      workspaceRoot = args.shift() ?? "";
      continue;
    }
    if (token === "--source") {
      source = parseRouteSourceFlag(args.shift() ?? "", "--source");
      continue;
    }
    if (token === "--project") {
      project = args.shift() ?? "";
      continue;
    }
    if (token === "--workspace") {
      workspace = args.shift() ?? "";
      continue;
    }
    if (token === "--notes") {
      notes = args.shift() ?? "";
      continue;
    }
    throw new Error(`Unknown route add argument: ${token}`);
  }

  return {
    configFile: parsed.configFile,
    memory: toMaybeString(memory),
    priority,
    pathPrefix: toMaybeString(pathPrefix),
    repoRoot: toMaybeString(repoRoot),
    workspaceRoot: toMaybeString(workspaceRoot),
    source,
    project: toMaybeString(project),
    workspace: toMaybeString(workspace),
    notes: toMaybeString(notes),
  };
}

function parseRouteListArgs(argv: readonly string[]): RouteListArgs {
  const parsed = parseConfigCommonArgs(argv);
  if (parsed.rest.length > 0) {
    throw new Error(`Unknown route list argument: ${parsed.rest[0]}`);
  }
  return {
    configFile: parsed.configFile,
  };
}

function parseRouteRemoveArgs(argv: readonly string[]): RouteRemoveArgs {
  const parsed = parseConfigCommonArgs(argv);
  let index: number | null = null;
  const args = [...parsed.rest];
  while (args.length > 0) {
    const token = args.shift();
    if (!token) {
      continue;
    }
    if (token === "--index") {
      index = parseNonNegativeIntegerValue(args.shift() ?? "", "--index");
      continue;
    }
    throw new Error(`Unknown route remove argument: ${token}`);
  }
  return {
    configFile: parsed.configFile,
    index,
  };
}

function parseRouteExplainArgs(argv: readonly string[]): RouteExplainArgs {
  const parsed = parseConfigCommonArgs(argv);
  let path: string | null = null;
  let repoRoot: string | null = null;
  let workspaceRoot: string | null = null;
  let source: DaemonConfigRouteSource | null = null;
  const args = [...parsed.rest];
  while (args.length > 0) {
    const token = args.shift();
    if (!token) {
      continue;
    }
    if (token === "--path") {
      path = args.shift() ?? "";
      continue;
    }
    if (token === "--repo-root") {
      repoRoot = args.shift() ?? "";
      continue;
    }
    if (token === "--workspace-root") {
      workspaceRoot = args.shift() ?? "";
      continue;
    }
    if (token === "--source") {
      source = parseRouteSourceFlag(args.shift() ?? "", "--source");
      continue;
    }
    throw new Error(`Unknown route explain argument: ${token}`);
  }
  return {
    configFile: parsed.configFile,
    path: toMaybeString(path),
    repoRoot: toMaybeString(repoRoot),
    workspaceRoot: toMaybeString(workspaceRoot),
    source,
  };
}

function parseRouteSetDefaultArgs(
  argv: readonly string[]
): RouteSetDefaultArgs {
  const parsed = parseConfigCommonArgs(argv);
  let memory: string | null = null;
  let onAmbiguous: "review" | "default" | "drop" | null = null;
  const args = [...parsed.rest];
  while (args.length > 0) {
    const token = args.shift();
    if (!token) {
      continue;
    }
    if (token === "--memory") {
      memory = args.shift() ?? "";
      continue;
    }
    if (token === "--on-ambiguous") {
      const raw = toMaybeString(args.shift() ?? "");
      if (raw !== "review" && raw !== "default" && raw !== "drop") {
        throw new Error("--on-ambiguous must be one of review, default, drop.");
      }
      onAmbiguous = raw;
      continue;
    }
    throw new Error(`Unknown route set-default argument: ${token}`);
  }
  return {
    configFile: parsed.configFile,
    memory: toMaybeString(memory),
    onAmbiguous,
  };
}

function parseRouteShowDefaultArgs(
  argv: readonly string[]
): RouteShowDefaultArgs {
  const parsed = parseConfigCommonArgs(argv);
  if (parsed.rest.length > 0) {
    throw new Error(`Unknown route show-default argument: ${parsed.rest[0]}`);
  }
  return {
    configFile: parsed.configFile,
  };
}

function parseSourceDiscoverArgs(argv: readonly string[]): SourceDiscoverArgs {
  const parsed = parseConfigCommonArgs(argv);
  const args = [...parsed.rest];
  const workspaceRoots: string[] = [];
  const sources: DaemonConfigRouteSource[] = [];

  while (args.length > 0) {
    const token = args.shift();
    if (!token) {
      continue;
    }
    if (token === "--workspace-root") {
      const workspaceRoot = toMaybeString(args.shift() ?? "");
      if (!workspaceRoot) {
        throw new Error("--workspace-root requires a value.");
      }
      workspaceRoots.push(resolve(workspaceRoot));
      continue;
    }
    if (token === "--source") {
      const source = parseRouteSourceFlag(args.shift() ?? "", "--source");
      if (source) {
        sources.push(source);
      }
      continue;
    }
    throw new Error(`Unknown source discover argument: ${token}`);
  }

  return {
    configFile: parsed.configFile,
    workspaceRoots: [...new Set(workspaceRoots)].sort((left, right) =>
      left.localeCompare(right)
    ),
    sources: sortUniqueSources(sources),
  };
}

function parseSourceListArgs(argv: readonly string[]): SourceListArgs {
  const parsed = parseConfigCommonArgs(argv);
  const args = [...parsed.rest];
  let source: DaemonConfigRouteSource | null = null;

  while (args.length > 0) {
    const token = args.shift();
    if (!token) {
      continue;
    }
    if (token === "--source") {
      source = parseRouteSourceFlag(args.shift() ?? "", "--source");
      continue;
    }
    throw new Error(`Unknown source list argument: ${token}`);
  }

  return {
    configFile: parsed.configFile,
    source,
  };
}

function parseSourceInspectArgs(argv: readonly string[]): SourceInspectArgs {
  const parsed = parseConfigCommonArgs(argv);
  const args = [...parsed.rest];
  let id: string | null = null;

  while (args.length > 0) {
    const token = args.shift();
    if (!token) {
      continue;
    }
    if (token === "--id") {
      id = toMaybeString(args.shift() ?? "");
      continue;
    }
    throw new Error(`Unknown source inspect argument: ${token}`);
  }

  return {
    configFile: parsed.configFile,
    id,
  };
}

function toMaybeString(value: string | null): string | null {
  if (!isString(value)) {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function shouldCompactJsonOutput(): boolean {
  return process.env["UMS_JSON_COMPACT"] === "1";
}

function writeJson(
  stream: NodeJS.WriteStream,
  payload: Record<string, unknown>
): void {
  stream.write(
    `${JSON.stringify(payload, null, shouldCompactJsonOutput() ? 0 : 2)}\n`
  );
}

function writeSuccess(data: unknown): void {
  writeJson(process.stdout, {
    ok: true,
    data,
  });
}

function writeFailure(error: {
  readonly code: string;
  readonly message: string;
  readonly data?: Record<string, unknown>;
}): void {
  writeJson(process.stderr, {
    ok: false,
    error,
  });
}

function writeError(code: string, message: string): void {
  writeFailure({
    code,
    message,
  });
}

function fileExists(path: string): Promise<boolean> {
  return Effect.runPromise(
    Effect.tryPromise({
      try: async () => {
        await access(path);
        return true;
      },
      catch: (cause) => cause,
    }).pipe(
      Effect.match({
        onSuccess: () => Effect.succeed(true),
        onFailure: (cause) =>
          isErrnoCause(cause) && cause.code === "ENOENT"
            ? Effect.succeed(false)
            : Effect.fail(cause),
      }),
      Effect.flatten
    )
  );
}

async function resolveDefaultWorkspacePathPrefix(): Promise<string> {
  for (const candidate of [
    resolve(homedir(), "Developer"),
    resolve(homedir(), "Projects"),
    homedir(),
  ]) {
    if (await fileExists(candidate)) {
      return candidate;
    }
  }
  return homedir();
}

function buildStarterDaemonConfig(pathPrefix: string): DaemonConfig {
  return canonicalizeDaemonConfig({
    version: 1,
    accounts: {
      local: {
        type: "local",
      },
    },
    memories: {
      personal: {
        account: "local",
        storeId: "personal",
        profile: "main",
        tags: ["personal"],
      },
    },
    sources: {
      defaults: {
        scanIntervalMs: 60_000,
        maxEventsPerCycle: 400,
      },
    },
    routes: [
      {
        match: {
          pathPrefix,
        },
        memory: "personal",
        priority: 0,
        notes: "Default personal workspace route created by `ums config init`.",
      },
    ],
    defaults: {
      memory: "personal",
      onAmbiguous: "review",
      sync: {
        intervalMs: 60_000,
        maxEventsPerCycle: 400,
      },
    },
    policy: {
      allowEnvTokenFallback: false,
      allowPlaintextDevAuth: false,
      requireProjectForManagedWrites: false,
      managedMemoryPrefixes: [],
    },
  });
}

function summarizeDaemonConfig(config: DaemonConfig): {
  readonly accounts: number;
  readonly memories: number;
  readonly routes: number;
  readonly sourceBindings: number;
  readonly defaultMemory: string;
  readonly managedMemories: readonly string[];
} {
  const managedMemories = Object.keys(config.memories).filter((alias) =>
    config.policy.managedMemoryPrefixes.some((prefix) =>
      alias.startsWith(prefix)
    )
  );
  return {
    accounts: Object.keys(config.accounts).length,
    memories: Object.keys(config.memories).length,
    routes: config.routes.length,
    sourceBindings: config.sources.bindings.length,
    defaultMemory: config.defaults.memory,
    managedMemories,
  };
}

async function buildDoctorWarnings(config: DaemonConfig): Promise<string[]> {
  const warnings = new Set<string>();
  for (const [alias, account] of Object.entries(config.accounts)) {
    if (account.type === "http" && account.auth.mode === "token-env") {
      warnings.add(
        `Account '${alias}' uses token-env fallback. Prefer keychain-backed auth for user devices.`
      );
      continue;
    }
    if (account.type === "http" && account.auth.mode !== "token-env") {
      const credentialState = await runCredentialEffect(
        getManagedAccountCredentialState(account.auth.credentialRef)
      ).catch((error) => ({
        status: "error" as const,
        storedAt: null,
        expiresAt: null,
        message: toCauseMessage(error),
      }));
      if (credentialState.status === "missing") {
        warnings.add(
          `Account '${alias}' has no secure credential stored yet. Run \`ums account login --name ${alias} --secret-stdin\`.`
        );
      }
      if (credentialState.status === "expired") {
        warnings.add(
          `Account '${alias}' secure credential expired at ${credentialState.expiresAt}. Run \`ums account login --name ${alias} --secret-stdin --expires-at <timestamp>\` to refresh it.`
        );
      }
      if (credentialState.status === "error") {
        warnings.add(
          `Account '${alias}' secure credential health could not be verified: ${credentialState.message}`
        );
      }
    }
  }
  if (config.defaults.onAmbiguous !== "review") {
    warnings.add(
      `defaults.onAmbiguous is '${config.defaults.onAmbiguous}'. Review mode is safer for uncertain routing.`
    );
  }
  if (
    config.policy.requireProjectForManagedWrites &&
    config.policy.managedMemoryPrefixes.length === 0
  ) {
    warnings.add(
      "Managed-write protection is enabled without managedMemoryPrefixes; no memory is currently treated as managed."
    );
  }
  return [...warnings].sort((left, right) => left.localeCompare(right));
}

function formatConfigIssues(issues: readonly DaemonConfigIssue[]): string[] {
  return issues.map((issue) => `${issue.path}: ${issue.message}`);
}

async function runConfigInit(argv: readonly string[]): Promise<number> {
  const parsed = parseConfigInitArgs(argv);
  const configFile = resolveDaemonConfigFilePath(parsed.configFile);
  const existed = await fileExists(configFile);
  if (existed && !parsed.force) {
    throw new Error(
      `Daemon config already exists: ${configFile}. Re-run with --force to overwrite it.`
    );
  }
  const starter = buildStarterDaemonConfig(
    await resolveDefaultWorkspacePathPrefix()
  );
  const written = await writeDaemonConfig(configFile, starter);
  writeSuccess({
    operation: "config.init",
    configFile: written.configFile,
    created: !existed,
    overwritten: existed,
    summary: summarizeDaemonConfig(written.config),
  });
  return 0;
}

async function runConfigValidate(argv: readonly string[]): Promise<number> {
  const parsed = parseConfigValidateArgs(argv);
  const exit = await Effect.runPromiseExit(
    Effect.tryPromise({
      try: () => readDaemonConfig(parsed.configFile),
      catch: (cause) => cause,
    })
  );
  if (Exit.isSuccess(exit)) {
    writeSuccess({
      operation: "config.validate",
      configFile: exit.value.configFile,
      summary: summarizeDaemonConfig(exit.value.config),
      warnings: await buildDoctorWarnings(exit.value.config),
    });
    return 0;
  }
  const error = Cause.squash(exit.cause);
  writeError(
    isDaemonConfigErrorLike(error)
      ? error.code
      : "DAEMON_CONFIG_VALIDATE_ERROR",
    formatDaemonConfigError(error)
  );
  return 1;
}

async function runConfigDoctor(argv: readonly string[]): Promise<number> {
  const parsed = parseConfigDoctorArgs(argv);
  const configFile = resolveDaemonConfigFilePath(parsed.configFile);
  if (!(await fileExists(configFile))) {
    writeSuccess({
      operation: "config.doctor",
      configFile,
      status: "missing",
      healthy: false,
      issues: [],
      warnings: [],
      suggestions: [`Run \`ums config init --config-file ${configFile}\`.`],
    });
    return 0;
  }

  const rawExit = await Effect.runPromiseExit(
    Effect.tryPromise({
      try: () => readFile(configFile, "utf8"),
      catch: (cause) => cause,
    })
  );
  if (Exit.isFailure(rawExit)) {
    const error = Cause.squash(rawExit.cause);
    writeSuccess({
      operation: "config.doctor",
      configFile,
      status: "invalid",
      healthy: false,
      warnings: [],
      issues: [],
      suggestions: [
        "Fix the reported config errors and re-run `ums config validate`.",
      ],
      message: `Unable to read daemon config file '${configFile}': ${toCauseMessage(error)}`,
    });
    return 1;
  }
  const raw = rawExit.value;

  const analyzed = await Effect.runPromiseExit(
    Effect.try({
      try: () => {
        const parsedRaw = parseJsonc(raw);
        const config = canonicalizeDaemonConfig(parsedRaw, { configFile });
        return {
          config,
          canonicalText: serializeDaemonConfig(config),
        };
      },
      catch: (cause) => cause,
    })
  );

  if (Exit.isSuccess(analyzed)) {
    const { config, canonicalText } = analyzed.value;
    const canonical = raw === canonicalText;
    const rewritten = parsed.fix && !canonical;
    if (rewritten) {
      const rewriteExit = await Effect.runPromiseExit(
        Effect.tryPromise({
          try: () => writeDaemonConfig(configFile, config),
          catch: (cause) => cause,
        })
      );
      if (Exit.isFailure(rewriteExit)) {
        const error = Cause.squash(rewriteExit.cause);
        writeSuccess({
          operation: "config.doctor",
          configFile,
          status: "invalid",
          healthy: false,
          canonical: false,
          rewritten: false,
          summary: summarizeDaemonConfig(config),
          warnings: await buildDoctorWarnings(config),
          issues: [],
          suggestions: [
            "Check filesystem permissions and re-run `ums config doctor --fix`.",
          ],
          message: `Unable to rewrite daemon config file '${configFile}': ${toCauseMessage(error)}`,
        });
        return 1;
      }
    }
    const warnings = await buildDoctorWarnings(config);
    const suggestions = [
      ...(!canonical && !parsed.fix
        ? [
            "Run `ums config doctor --fix` to rewrite the file into canonical JSON.",
          ]
        : []),
      ...warnings
        .filter((warning) => warning.includes("token-env"))
        .map(
          () =>
            "Replace token-env auth with a secure credentialRef before enabling managed accounts."
        ),
    ];
    writeSuccess({
      operation: "config.doctor",
      configFile,
      status: rewritten ? "rewritten" : canonical ? "healthy" : "needs_rewrite",
      healthy: canonical || rewritten,
      canonical,
      rewritten,
      summary: summarizeDaemonConfig(config),
      warnings,
      issues: [],
      suggestions,
    });
    return canonical || rewritten ? 0 : 1;
  }
  const error = Cause.squash(analyzed.cause);
  writeSuccess({
    operation: "config.doctor",
    configFile,
    status: "invalid",
    healthy: false,
    warnings: [],
    issues: isDaemonConfigErrorLike(error)
      ? formatConfigIssues(error.issues)
      : [],
    suggestions: [
      "Fix the reported config errors and re-run `ums config validate`.",
    ],
    message: formatDaemonConfigError(error),
  });
  return 1;
}

function runConfig(argv: readonly string[]): Promise<number> {
  const [subcommand, ...rest] = argv;
  if (
    !subcommand ||
    subcommand === "--help" ||
    subcommand === "-h" ||
    subcommand === "help"
  ) {
    printConfigUsage();
    return Promise.resolve(subcommand ? 0 : 1);
  }
  if (subcommand === "init") {
    return runConfigInit(rest);
  }
  if (subcommand === "validate") {
    return runConfigValidate(rest);
  }
  if (subcommand === "doctor") {
    return runConfigDoctor(rest);
  }
  throw new Error(`Unknown config subcommand: ${subcommand}`);
}

async function loadDaemonConfigForCommand(
  configFile: string | null
): Promise<{ configFile: string; config: DaemonConfig }> {
  const exit = await Effect.runPromiseExit(
    Effect.tryPromise({
      try: () => readDaemonConfig(configFile),
      catch: (cause) => cause,
    })
  );
  if (Exit.isSuccess(exit)) {
    return exit.value;
  }
  throw new Error(formatDaemonConfigError(Cause.squash(exit.cause)));
}

async function saveDaemonConfigForCommand(
  configFile: string | null,
  config: DaemonConfig
): Promise<{ configFile: string; config: DaemonConfig }> {
  const exit = await Effect.runPromiseExit(
    Effect.tryPromise({
      try: () => writeDaemonConfig(configFile, config),
      catch: (cause) => cause,
    })
  );
  if (Exit.isSuccess(exit)) {
    return exit.value;
  }
  throw new Error(formatDaemonConfigError(Cause.squash(exit.cause)));
}

async function runCredentialEffect<A>(
  effect: Effect.Effect<
    A,
    | DaemonCredentialExpiredError
    | DaemonCredentialRefError
    | DaemonCredentialStoreError
    | DaemonCredentialRecordError
  >
): Promise<A> {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) {
    return exit.value;
  }
  throw Cause.squash(exit.cause);
}

async function readManagedSecretInput(args: {
  readonly secretEnv: string | null;
  readonly secretFile: string | null;
  readonly secretStdin: boolean;
}): Promise<string> {
  const configuredSources = [
    args.secretEnv !== null,
    args.secretFile !== null,
    args.secretStdin,
  ].filter(Boolean).length;
  if (configuredSources !== 1) {
    throw new Error(
      "account login requires exactly one of --secret-stdin, --secret-file, or --secret-env."
    );
  }
  const raw =
    args.secretEnv !== null
      ? (process.env[args.secretEnv] ?? "")
      : args.secretFile !== null
        ? await readFile(args.secretFile, "utf8")
        : await readUtf8Stdin();
  const secret = raw.replace(/\r?\n$/, "");
  if (!secret.trim()) {
    throw new Error("Managed account secret must not be empty.");
  }
  return secret;
}

function normalizeOptionalTimestamp(
  value: string | null,
  flag: string
): string | null {
  if (value === null) {
    return null;
  }
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${flag} must not be empty.`);
  }
  const millis = Date.parse(normalized);
  if (!Number.isFinite(millis)) {
    throw new Error(`${flag} must be a valid ISO-8601 timestamp.`);
  }
  return new Date(millis).toISOString();
}

async function loadOptionalDaemonConfigForCommand(
  configFile: string | null
): Promise<{ configFile: string; config: DaemonConfig } | null> {
  const resolvedConfigFile = resolveDaemonConfigFilePath(configFile);
  if (!(await fileExists(resolvedConfigFile))) {
    return null;
  }
  return loadDaemonConfigForCommand(configFile);
}

function summarizeSourceBindingStatuses(
  bindings: ReadonlyArray<{
    readonly status: DaemonSourceBindingStatus;
    readonly activeForSync?: boolean;
  }>
): {
  readonly total: number;
  readonly approved: number;
  readonly pending: number;
  readonly disabled: number;
  readonly ignored: number;
  readonly activeForSync: number;
} {
  return {
    total: bindings.length,
    approved: bindings.filter((binding) => binding.status === "approved")
      .length,
    pending: bindings.filter((binding) => binding.status === "pending").length,
    disabled: bindings.filter((binding) => binding.status === "disabled")
      .length,
    ignored: bindings.filter((binding) => binding.status === "ignored").length,
    activeForSync: bindings.filter((binding) => binding.activeForSync === true)
      .length,
  };
}

async function runAccountAdd(argv: readonly string[]): Promise<number> {
  const parsed = parseAccountAddArgs(argv);
  if (!parsed.name) {
    throw new Error("account add requires --name.");
  }
  if (!parsed.type) {
    throw new Error("account add requires --type.");
  }
  const loaded = await loadDaemonConfigForCommand(parsed.configFile);
  const existing = loaded.config.accounts[parsed.name];
  if (existing && !parsed.force) {
    throw new Error(
      `Account '${parsed.name}' already exists. Re-run with --force to overwrite it.`
    );
  }

  let account: DaemonConfig["accounts"][string];
  if (parsed.type === "local") {
    account = { type: "local" };
  } else if (parsed.type === "http") {
    if (!parsed.apiUrl) {
      throw new Error("account add --type http requires --api-url.");
    }
    if (!parsed.authMode) {
      throw new Error("account add --type http requires --auth-mode.");
    }
    if (parsed.authMode === "token-env") {
      if (!parsed.authEnv) {
        throw new Error(
          "account add --auth-mode token-env requires --auth-env."
        );
      }
      account = {
        type: "http",
        apiBaseUrl: parsed.apiUrl,
        auth: {
          mode: "token-env",
          env: parsed.authEnv,
        },
      };
    } else {
      if (
        parsed.authMode !== "oauth-device" &&
        parsed.authMode !== "oidc-pkce" &&
        parsed.authMode !== "session-ref"
      ) {
        throw new Error(
          "--auth-mode must be one of oauth-device, oidc-pkce, session-ref, token-env."
        );
      }
      account = {
        type: "http",
        apiBaseUrl: parsed.apiUrl,
        auth: {
          mode: parsed.authMode,
          credentialRef:
            parsed.credentialRef ?? defaultCredentialRefForAccount(parsed.name),
        },
      };
    }
  } else {
    throw new Error("account add --type must be local or http.");
  }

  const written = await saveDaemonConfigForCommand(loaded.configFile, {
    ...loaded.config,
    accounts: {
      ...loaded.config.accounts,
      [parsed.name]: account,
    },
  });
  writeSuccess({
    operation: "account.add",
    configFile: written.configFile,
    account: {
      name: parsed.name,
      ...written.config.accounts[parsed.name],
    },
  });
  return 0;
}

async function runAccountList(argv: readonly string[]): Promise<number> {
  const parsed = parseAccountListArgs(argv);
  const loaded = await loadDaemonConfigForCommand(parsed.configFile);
  const accounts = await Promise.all(
    Object.entries(loaded.config.accounts).map(async ([name, account]) => {
      if (account.type !== "http" || account.auth.mode === "token-env") {
        return {
          name,
          ...account,
          credentialState: null,
        };
      }
      const credentialState = await runCredentialEffect(
        getManagedAccountCredentialState(account.auth.credentialRef)
      ).catch((error) => ({
        status: "error" as const,
        storedAt: null,
        expiresAt: null,
        message: toCauseMessage(error),
      }));
      return {
        name,
        ...account,
        credentialState,
      };
    })
  );
  writeSuccess({
    operation: "account.list",
    configFile: loaded.configFile,
    accounts,
  });
  return 0;
}

async function runAccountLogin(argv: readonly string[]): Promise<number> {
  const parsed = parseAccountLoginArgs(argv);
  if (!parsed.name) {
    throw new Error("account login requires --name.");
  }
  const loaded = await loadDaemonConfigForCommand(parsed.configFile);
  const account = loaded.config.accounts[parsed.name];
  if (!account) {
    throw new Error(`Account '${parsed.name}' does not exist.`);
  }
  if (account.type !== "http") {
    throw new Error(
      `Account '${parsed.name}' is local and does not support managed login.`
    );
  }
  if (account.auth.mode === "token-env") {
    throw new Error(
      `Account '${parsed.name}' uses token-env fallback. Secure login storage is unavailable for env-backed auth.`
    );
  }
  const secret = await readManagedSecretInput(parsed);
  const storedAt = new Date().toISOString();
  const expiresAt = normalizeOptionalTimestamp(
    parsed.expiresAt,
    "account login --expires-at"
  );
  await runCredentialEffect(
    storeManagedAccountCredential({
      credentialRef: account.auth.credentialRef,
      secret,
      storedAt,
      expiresAt,
    })
  );
  writeSuccess({
    operation: "account.login",
    configFile: loaded.configFile,
    account: parsed.name,
    authMode: account.auth.mode,
    credentialRef: account.auth.credentialRef,
    storedAt,
    expiresAt,
  });
  return 0;
}

async function runAccountLogout(argv: readonly string[]): Promise<number> {
  const parsed = parseAccountLogoutArgs(argv);
  if (!parsed.name) {
    throw new Error("account logout requires --name.");
  }
  const loaded = await loadDaemonConfigForCommand(parsed.configFile);
  const account = loaded.config.accounts[parsed.name];
  if (!account) {
    throw new Error(`Account '${parsed.name}' does not exist.`);
  }
  if (account.type !== "http" || account.auth.mode === "token-env") {
    writeSuccess({
      operation: "account.logout",
      configFile: loaded.configFile,
      account: parsed.name,
      cleared: false,
    });
    return 0;
  }
  const cleared = await runCredentialEffect(
    deleteManagedAccountCredential(account.auth.credentialRef)
  );
  writeSuccess({
    operation: "account.logout",
    configFile: loaded.configFile,
    account: parsed.name,
    cleared,
  });
  return 0;
}

async function runAccountRemove(argv: readonly string[]): Promise<number> {
  const parsed = parseAccountRemoveArgs(argv);
  if (!parsed.name) {
    throw new Error("account remove requires --name.");
  }
  const loaded = await loadDaemonConfigForCommand(parsed.configFile);
  if (!loaded.config.accounts[parsed.name]) {
    throw new Error(`Account '${parsed.name}' does not exist.`);
  }
  const dependentMemories = Object.entries(loaded.config.memories)
    .filter(([, memory]) => memory.account === parsed.name)
    .map(([alias]) => alias);
  if (dependentMemories.length > 0) {
    throw new Error(
      `Cannot remove account '${parsed.name}' while memories still reference it: ${dependentMemories.join(", ")}`
    );
  }
  const account = loaded.config.accounts[parsed.name];
  if (!account) {
    throw new Error(`Account '${parsed.name}' does not exist.`);
  }
  if (account.type === "http" && account.auth.mode !== "token-env") {
    await runCredentialEffect(
      deleteManagedAccountCredential(account.auth.credentialRef)
    );
  }
  const { [parsed.name]: _removedAccount, ...nextAccounts } =
    loaded.config.accounts;
  const written = await saveDaemonConfigForCommand(loaded.configFile, {
    ...loaded.config,
    accounts: nextAccounts,
  });
  writeSuccess({
    operation: "account.remove",
    configFile: written.configFile,
    removed: parsed.name,
  });
  return 0;
}

function runAccount(argv: readonly string[]): Promise<number> {
  const [subcommand, ...rest] = argv;
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    printAccountUsage();
    return Promise.resolve(subcommand ? 0 : 1);
  }
  if (subcommand === "add") {
    return runAccountAdd(rest);
  }
  if (subcommand === "list") {
    return runAccountList(rest);
  }
  if (subcommand === "login") {
    return runAccountLogin(rest);
  }
  if (subcommand === "logout") {
    return runAccountLogout(rest);
  }
  if (subcommand === "remove") {
    return runAccountRemove(rest);
  }
  throw new Error(`Unknown account subcommand: ${subcommand}`);
}

async function runMemoryAdd(argv: readonly string[]): Promise<number> {
  const parsed = parseMemoryAddArgs(argv);
  if (!parsed.name || !parsed.account || !parsed.storeId || !parsed.profile) {
    throw new Error(
      "memory add requires --name, --account, --store-id, and --profile."
    );
  }
  const loaded = await loadDaemonConfigForCommand(parsed.configFile);
  if (loaded.config.memories[parsed.name] && !parsed.force) {
    throw new Error(
      `Memory '${parsed.name}' already exists. Re-run with --force to overwrite it.`
    );
  }
  const written = await saveDaemonConfigForCommand(loaded.configFile, {
    ...loaded.config,
    memories: {
      ...loaded.config.memories,
      [parsed.name]: {
        account: parsed.account,
        storeId: parsed.storeId,
        profile: parsed.profile,
        ...(parsed.project ? { project: parsed.project } : {}),
        ...(parsed.workspace ? { workspace: parsed.workspace } : {}),
        readOnly: parsed.readOnly,
        tags: parsed.tags,
      },
    },
  });
  writeSuccess({
    operation: "memory.add",
    configFile: written.configFile,
    memory: {
      name: parsed.name,
      ...written.config.memories[parsed.name],
    },
  });
  return 0;
}

async function runMemoryList(argv: readonly string[]): Promise<number> {
  const parsed = parseMemoryListArgs(argv);
  const loaded = await loadDaemonConfigForCommand(parsed.configFile);
  writeSuccess({
    operation: "memory.list",
    configFile: loaded.configFile,
    memories: Object.entries(loaded.config.memories).map(([name, memory]) => ({
      name,
      ...memory,
    })),
  });
  return 0;
}

async function runMemoryRemove(argv: readonly string[]): Promise<number> {
  const parsed = parseMemoryRemoveArgs(argv);
  if (!parsed.name) {
    throw new Error("memory remove requires --name.");
  }
  const loaded = await loadDaemonConfigForCommand(parsed.configFile);
  if (!loaded.config.memories[parsed.name]) {
    throw new Error(`Memory '${parsed.name}' does not exist.`);
  }
  if (loaded.config.defaults.memory === parsed.name) {
    throw new Error(
      `Cannot remove memory '${parsed.name}' while it is defaults.memory.`
    );
  }
  const dependentRoutes = loaded.config.routes
    .map((route, index) => ({ route, index }))
    .filter(({ route }) => route.memory === parsed.name)
    .map(({ index }) => index);
  if (dependentRoutes.length > 0) {
    throw new Error(
      `Cannot remove memory '${parsed.name}' while routes still reference it: ${dependentRoutes.join(", ")}`
    );
  }
  const { [parsed.name]: _removedMemory, ...nextMemories } =
    loaded.config.memories;
  const written = await saveDaemonConfigForCommand(loaded.configFile, {
    ...loaded.config,
    memories: nextMemories,
  });
  writeSuccess({
    operation: "memory.remove",
    configFile: written.configFile,
    removed: parsed.name,
  });
  return 0;
}

async function readUtf8Stdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function readJsonObjectInput(args: {
  readonly input: string | null;
  readonly file: string | null;
}): Promise<Record<string, unknown>> {
  const fileInput = args.file ? await readFile(args.file, "utf8") : null;
  const raw =
    args.input ??
    (fileInput
      ? fileInput.trim()
      : !process.stdin.isTTY
        ? await readUtf8Stdin()
        : "");
  if (!raw.trim()) {
    return {};
  }
  const decoded = await Effect.runPromiseExit(
    Effect.try({
      try: () => JSON.parse(raw),
      catch: (cause) => cause,
    })
  );
  if (Exit.isFailure(decoded)) {
    throw new Error(`Invalid JSON input: ${Cause.pretty(decoded.cause)}`);
  }
  if (!isUnknownRecord(decoded.value)) {
    throw new Error("Memory command input must decode to a JSON object.");
  }
  return { ...decoded.value };
}

function resolveMemoryOutputFormat(
  format: MemoryOutputFormat | null
): MemoryOutputFormat {
  if (format) {
    return format;
  }
  return process.stdout.isTTY ? "text" : "json";
}

function resolveDaemonRuntimeStateFile(config: DaemonConfig): string {
  return resolve(config.state.rootDir, "runtime-state.json");
}

async function resolveMemoryCommandTarget(args: {
  readonly configFile: string | null;
  readonly memory: string | null;
}): Promise<{
  readonly configFile: string;
  readonly config: DaemonConfig;
  readonly memoryAlias: string;
  readonly memoryConfig: DaemonMemoryConfig;
  readonly accountConfig: DaemonAccountConfig;
  readonly runtimeStateFile: string;
}> {
  if (!args.memory) {
    throw new Error("memory command requires --memory.");
  }
  const loaded = await loadDaemonConfigForCommand(args.configFile);
  const memoryConfig = loaded.config.memories[args.memory];
  if (!memoryConfig) {
    throw new Error(`Memory '${args.memory}' does not exist.`);
  }
  const accountConfig = loaded.config.accounts[memoryConfig.account];
  if (!accountConfig) {
    throw new Error(
      `Memory '${args.memory}' references unknown account '${memoryConfig.account}'.`
    );
  }
  return {
    configFile: loaded.configFile,
    config: loaded.config,
    memoryAlias: args.memory,
    memoryConfig,
    accountConfig,
    runtimeStateFile: resolveDaemonRuntimeStateFile(loaded.config),
  };
}

function assertMemoryCommandAvailability(
  target: {
    readonly config: DaemonConfig;
    readonly memoryAlias: string;
    readonly memoryConfig: DaemonMemoryConfig;
    readonly accountConfig: DaemonAccountConfig;
  },
  options: {
    readonly write: boolean;
  }
): void {
  if (options.write && target.memoryConfig.readOnly) {
    throw new Error(
      `Memory '${target.memoryAlias}' is read-only. Corrective controls are disabled for this memory.`
    );
  }
  if (
    options.write &&
    target.accountConfig.type === "http" &&
    target.config.policy.requireProjectForManagedWrites &&
    target.config.policy.managedMemoryPrefixes.some((prefix) =>
      target.memoryAlias.startsWith(prefix)
    ) &&
    !target.memoryConfig.project
  ) {
    throw new Error(
      `Memory '${target.memoryAlias}' requires a project binding before managed corrective controls are allowed.`
    );
  }
}

async function executeMemoryCommand(
  target: {
    readonly runtimeStateFile: string;
    readonly accountConfig: DaemonAccountConfig;
    readonly memoryConfig: DaemonMemoryConfig;
  } & {
    readonly memoryAlias: string;
    readonly configFile: string;
  },
  input: {
    readonly operation: string;
    readonly request: Record<string, unknown>;
  }
): Promise<Record<string, unknown>> {
  const exit = await Effect.runPromiseExit(
    target.accountConfig.type === "local"
      ? Effect.tryPromise({
          try: () =>
            executeRuntimeOperation({
              operation: input.operation,
              stateFile: target.runtimeStateFile,
              requestBody: {
                ...input.request,
                storeId: target.memoryConfig.storeId,
                profile: target.memoryConfig.profile,
              },
            }),
          catch: (cause) => cause,
        })
      : executeRemoteAccountOperationEffect({
          accountAlias: target.memoryConfig.account,
          account: target.accountConfig,
          memoryAlias: target.memoryAlias,
          memory: target.memoryConfig,
          operation: input.operation,
          request: input.request,
        })
  );
  if (Exit.isFailure(exit)) {
    throw Cause.squash(exit.cause);
  }
  if (!isUnknownRecord(exit.value)) {
    throw new Error(
      `Memory command '${input.operation}' returned an invalid response payload.`
    );
  }
  return exit.value;
}

function readRecordField(
  record: Record<string, unknown>,
  key: string
): Record<string, unknown> | null {
  const value = record[key];
  return isUnknownRecord(value) ? value : null;
}

function readArrayField(
  record: Record<string, unknown>,
  key: string
): readonly Record<string, unknown>[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is Record<string, unknown> =>
    isUnknownRecord(entry)
  );
}

function readStringField(
  record: Record<string, unknown>,
  key: string
): string | null {
  const value = record[key];
  return isString(value) ? value : null;
}

function readNumberField(
  record: Record<string, unknown>,
  key: string
): number | null {
  const value = record[key];
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function renderTextList(items: readonly string[]): string {
  return items.length > 0 ? items.join(", ") : "none";
}

function renderMemorySearchText(
  memoryAlias: string,
  response: Record<string, unknown>
): string {
  const results = readArrayField(response, "results");
  const totalMatches =
    readNumberField(response, "totalMatches") ?? results.length;
  const query = readStringField(response, "query") ?? "<none>";
  return [
    `Memory search for '${memoryAlias}'`,
    `Query: ${query}`,
    `Matches: ${totalMatches}`,
    ...results.map((row, index) => {
      const entityType = readStringField(row, "entityType") ?? "unknown";
      const entityId = readStringField(row, "entityId") ?? "unknown";
      const timestamp = readStringField(row, "timestamp") ?? "unknown";
      const summary = readStringField(row, "summary") ?? "";
      return `${index + 1}. [${entityType}] ${entityId} @ ${timestamp} — ${summary}`;
    }),
  ].join("\n");
}

function renderMemoryTimelineText(
  memoryAlias: string,
  response: Record<string, unknown>
): string {
  const events = readArrayField(response, "events");
  const totalEvents = readNumberField(response, "totalEvents") ?? events.length;
  return [
    `Memory timeline for '${memoryAlias}'`,
    `Events: ${totalEvents}`,
    ...events.map((event, index) => {
      const entityType =
        readStringField(event, "entityType") ??
        readStringField(event, "eventType") ??
        "unknown";
      const entityId = readStringField(event, "entityId") ?? "unknown";
      const timestamp = readStringField(event, "timestamp") ?? "unknown";
      const summary = readStringField(event, "summary") ?? "";
      return `${index + 1}. [${entityType}] ${entityId} @ ${timestamp} — ${summary}`;
    }),
  ].join("\n");
}

function renderMemoryProvenanceText(
  memoryAlias: string,
  response: Record<string, unknown>
): string {
  const resolution = readRecordField(response, "resolution") ?? {};
  const entities = readArrayField(response, "entities");
  return [
    `Memory provenance for '${memoryAlias}'`,
    `Resolved: ${readNumberField(resolution, "resolved") ?? 0}/${readNumberField(resolution, "requested") ?? entities.length}`,
    ...entities.map((entity, index) => {
      const entityType = readStringField(entity, "entityType") ?? "unknown";
      const entityId = readStringField(entity, "entityId") ?? "unknown";
      const found = entity["found"] === true ? "found" : "missing";
      const linkedSourceIds = Array.isArray(entity["linkedSourceIds"])
        ? renderTextList(
            entity["linkedSourceIds"].filter((value): value is string =>
              isString(value)
            )
          )
        : "none";
      return `${index + 1}. [${entityType}] ${entityId} — ${found}; sources: ${linkedSourceIds}`;
    }),
  ].join("\n");
}

function renderMemoryPolicyAuditText(
  memoryAlias: string,
  response: Record<string, unknown>
): string {
  const decisionRows = readArrayField(response, "policyDecisions");
  const auditRows = readArrayField(response, "auditTrail");
  return [
    `Memory policy audit for '${memoryAlias}'`,
    `Decisions: ${readNumberField(response, "totalPolicyDecisions") ?? decisionRows.length}`,
    `Audit events: ${readNumberField(response, "totalAuditTrailEvents") ?? auditRows.length}`,
    ...decisionRows.map((decision, index) => {
      const decisionId = readStringField(decision, "decisionId") ?? "unknown";
      const policyKey = readStringField(decision, "policyKey") ?? "unknown";
      const outcome = readStringField(decision, "outcome") ?? "review";
      return `${index + 1}. decision ${decisionId} — ${policyKey} => ${outcome}`;
    }),
    ...auditRows.map((entry, index) => {
      const operation = readStringField(entry, "operation") ?? "unknown";
      const outcome = readStringField(entry, "outcome") ?? "recorded";
      const summaryText = readStringField(entry, "summary") ?? "";
      return `${index + 1}. audit ${operation} => ${outcome}${summaryText ? ` — ${summaryText}` : ""}`;
    }),
  ].join("\n");
}

function renderMemoryAnomaliesText(
  memoryAlias: string,
  response: Record<string, unknown>
): string {
  const summary = readRecordField(response, "summary") ?? {};
  const alerts = readArrayField(response, "alerts");
  return [
    `Memory anomalies for '${memoryAlias}'`,
    `Alerts: ${readNumberField(summary, "totalAlerts") ?? alerts.length} (critical=${readNumberField(summary, "criticalAlerts") ?? 0}, warning=${readNumberField(summary, "warningAlerts") ?? 0})`,
    ...alerts.map((alert, index) => {
      const type = readStringField(alert, "type") ?? "unknown";
      const severity = readStringField(alert, "severity") ?? "none";
      const summaryText = readStringField(alert, "summary") ?? "";
      return `${index + 1}. [${severity}] ${type} — ${summaryText}`;
    }),
  ].join("\n");
}

function renderMemoryFeedbackText(
  memoryAlias: string,
  response: Record<string, unknown>
): string {
  const feedbackId = readStringField(response, "feedbackId") ?? "unknown";
  const signal = readStringField(response, "signal") ?? "helpful";
  const action = readStringField(response, "action") ?? "created";
  const targetRuleId = readStringField(response, "targetRuleId");
  const targetCandidateId = readStringField(response, "targetCandidateId");
  return [
    `Memory feedback for '${memoryAlias}'`,
    `Action: ${action}`,
    `Signal: ${signal}`,
    `Feedback ID: ${feedbackId}`,
    `Target: ${targetRuleId ?? targetCandidateId ?? "none"}`,
  ].join("\n");
}

function renderMemoryOverrideText(
  memoryAlias: string,
  response: Record<string, unknown>
): string {
  const override = readRecordField(response, "override") ?? {};
  const action = readStringField(response, "action") ?? "created";
  const overrideAction = readStringField(override, "action") ?? "suppress";
  const changed = override["changed"] === true ? "yes" : "no";
  return [
    `Memory override for '${memoryAlias}'`,
    `Action: ${action}`,
    `Override: ${overrideAction}`,
    `Changed: ${changed}`,
    `Candidates: ${renderTextList(
      Array.isArray(override["targetCandidateIds"])
        ? override["targetCandidateIds"].filter((value): value is string =>
            isString(value)
          )
        : []
    )}`,
    `Rules: ${renderTextList(
      Array.isArray(override["targetRuleIds"])
        ? override["targetRuleIds"].filter((value): value is string =>
            isString(value)
          )
        : []
    )}`,
  ].join("\n");
}

function writeMemoryCommandResult(args: {
  readonly operation: string;
  readonly configFile: string;
  readonly memoryAlias: string;
  readonly memoryConfig: DaemonMemoryConfig;
  readonly format: MemoryOutputFormat | null;
  readonly response: Record<string, unknown>;
  readonly renderText: (
    memoryAlias: string,
    response: Record<string, unknown>
  ) => string;
}): void {
  const resolvedFormat = resolveMemoryOutputFormat(args.format);
  if (resolvedFormat === "json") {
    writeSuccess({
      operation: args.operation,
      configFile: args.configFile,
      memory: args.memoryAlias,
      storeId: args.memoryConfig.storeId,
      profile: args.memoryConfig.profile,
      response: args.response,
    });
    return;
  }
  process.stdout.write(`${args.renderText(args.memoryAlias, args.response)}\n`);
}

async function runMemorySearch(argv: readonly string[]): Promise<number> {
  const parsed = parseMemorySearchArgs(argv);
  if (!parsed.query) {
    throw new Error("memory search requires --query.");
  }
  const target = await resolveMemoryCommandTarget(parsed);
  assertMemoryCommandAvailability(target, { write: false });
  const requestInput = await readJsonObjectInput(parsed);
  const response = await executeMemoryCommand(target, {
    operation: "memory_console_search",
    request: {
      ...requestInput,
      ...(parsed.query ? { query: parsed.query } : {}),
      ...(parsed.limit ? { limit: parsed.limit } : {}),
      ...(parsed.types.length > 0 ? { types: parsed.types } : {}),
    },
  });
  writeMemoryCommandResult({
    operation: "memory.search",
    configFile: target.configFile,
    memoryAlias: target.memoryAlias,
    memoryConfig: target.memoryConfig,
    format: parsed.format,
    response,
    renderText: renderMemorySearchText,
  });
  return 0;
}

async function runMemoryTimeline(argv: readonly string[]): Promise<number> {
  const parsed = parseMemoryTimelineArgs(argv);
  const target = await resolveMemoryCommandTarget(parsed);
  assertMemoryCommandAvailability(target, { write: false });
  const requestInput = await readJsonObjectInput(parsed);
  const response = await executeMemoryCommand(target, {
    operation: "memory_console_timeline",
    request: {
      ...requestInput,
      ...(parsed.limit ? { limit: parsed.limit } : {}),
      ...(parsed.since ? { since: parsed.since } : {}),
      ...(parsed.until ? { until: parsed.until } : {}),
      ...(parsed.types.length > 0 ? { types: parsed.types } : {}),
    },
  });
  writeMemoryCommandResult({
    operation: "memory.timeline",
    configFile: target.configFile,
    memoryAlias: target.memoryAlias,
    memoryConfig: target.memoryConfig,
    format: parsed.format,
    response,
    renderText: renderMemoryTimelineText,
  });
  return 0;
}

async function runMemoryProvenance(argv: readonly string[]): Promise<number> {
  const parsed = parseMemoryProvenanceArgs(argv);
  if (parsed.entityRefs.length === 0) {
    throw new Error("memory provenance requires at least one --entity-ref.");
  }
  const target = await resolveMemoryCommandTarget(parsed);
  assertMemoryCommandAvailability(target, { write: false });
  const requestInput = await readJsonObjectInput(parsed);
  const response = await executeMemoryCommand(target, {
    operation: "memory_console_provenance",
    request: {
      ...requestInput,
      entityRefs: parsed.entityRefs,
      ...(parsed.limit ? { limit: parsed.limit } : {}),
    },
  });
  writeMemoryCommandResult({
    operation: "memory.provenance",
    configFile: target.configFile,
    memoryAlias: target.memoryAlias,
    memoryConfig: target.memoryConfig,
    format: parsed.format,
    response,
    renderText: renderMemoryProvenanceText,
  });
  return 0;
}

async function runMemoryPolicyAudit(argv: readonly string[]): Promise<number> {
  const parsed = parseMemoryPolicyAuditArgs(argv);
  const target = await resolveMemoryCommandTarget(parsed);
  assertMemoryCommandAvailability(target, { write: false });
  const requestInput = await readJsonObjectInput(parsed);
  const response = await executeMemoryCommand(target, {
    operation: "memory_console_policy_audit",
    request: {
      ...requestInput,
      ...(parsed.limit ? { limit: parsed.limit } : {}),
      ...(parsed.since ? { since: parsed.since } : {}),
      ...(parsed.until ? { until: parsed.until } : {}),
      ...(parsed.operations.length > 0
        ? { operations: parsed.operations }
        : {}),
      ...(parsed.outcomes.length > 0 ? { outcomes: parsed.outcomes } : {}),
      ...(parsed.reasonCodes.length > 0
        ? { reasonCodes: parsed.reasonCodes }
        : {}),
      ...(parsed.policyKey ? { policyKey: parsed.policyKey } : {}),
    },
  });
  writeMemoryCommandResult({
    operation: "memory.policy-audit",
    configFile: target.configFile,
    memoryAlias: target.memoryAlias,
    memoryConfig: target.memoryConfig,
    format: parsed.format,
    response,
    renderText: renderMemoryPolicyAuditText,
  });
  return 0;
}

async function runMemoryAnomalies(argv: readonly string[]): Promise<number> {
  const parsed = parseMemoryAnomaliesArgs(argv);
  const target = await resolveMemoryCommandTarget(parsed);
  assertMemoryCommandAvailability(target, { write: false });
  const requestInput = await readJsonObjectInput(parsed);
  const response = await executeMemoryCommand(target, {
    operation: "memory_console_anomaly_alerts",
    request: {
      ...requestInput,
      ...(parsed.since ? { since: parsed.since } : {}),
      ...(parsed.until ? { until: parsed.until } : {}),
      ...(parsed.windowHours ? { windowHours: parsed.windowHours } : {}),
    },
  });
  writeMemoryCommandResult({
    operation: "memory.anomalies",
    configFile: target.configFile,
    memoryAlias: target.memoryAlias,
    memoryConfig: target.memoryConfig,
    format: parsed.format,
    response,
    renderText: renderMemoryAnomaliesText,
  });
  return 0;
}

async function runMemoryFeedback(argv: readonly string[]): Promise<number> {
  const parsed = parseMemoryFeedbackArgs(argv);
  if (!parsed.actor) {
    throw new Error("memory feedback requires --actor.");
  }
  if (!parsed.targetRuleId && !parsed.targetCandidateId) {
    throw new Error(
      "memory feedback requires --target-rule-id or --target-candidate-id."
    );
  }
  const target = await resolveMemoryCommandTarget(parsed);
  assertMemoryCommandAvailability(target, { write: true });
  const requestInput = await readJsonObjectInput(parsed);
  const response = await executeMemoryCommand(target, {
    operation: "feedback",
    request: {
      ...requestInput,
      signal: parsed.signal,
      actor: parsed.actor,
      ...(parsed.note ? { note: parsed.note } : {}),
      ...(parsed.feedbackId ? { feedbackId: parsed.feedbackId } : {}),
      ...(parsed.targetRuleId ? { targetRuleId: parsed.targetRuleId } : {}),
      ...(parsed.targetCandidateId
        ? { targetCandidateId: parsed.targetCandidateId }
        : {}),
    },
  });
  writeMemoryCommandResult({
    operation: "memory.feedback",
    configFile: target.configFile,
    memoryAlias: target.memoryAlias,
    memoryConfig: target.memoryConfig,
    format: parsed.format,
    response,
    renderText: renderMemoryFeedbackText,
  });
  return 0;
}

async function runMemoryOverride(
  argv: readonly string[],
  command: {
    readonly command: "quarantine" | "forget" | "pin";
    readonly overrideAction: "suppress" | "promote";
    readonly defaultReasonCode: string;
  }
): Promise<number> {
  const parsed = parseMemoryOverrideArgs(argv);
  if (!parsed.confirm) {
    throw new Error(
      `memory ${command.command} requires --confirm to apply a manual override.`
    );
  }
  if (!parsed.actor) {
    throw new Error(`memory ${command.command} requires --actor.`);
  }
  if (!parsed.reason) {
    throw new Error(`memory ${command.command} requires --reason.`);
  }
  if (
    parsed.targetRuleIds.length === 0 &&
    parsed.targetCandidateIds.length === 0
  ) {
    throw new Error(
      `memory ${command.command} requires at least one --target-rule-id or --target-candidate-id.`
    );
  }
  const target = await resolveMemoryCommandTarget(parsed);
  assertMemoryCommandAvailability(target, { write: true });
  const requestInput = await readJsonObjectInput(parsed);
  const response = await executeMemoryCommand(target, {
    operation: "manual_override_control",
    request: {
      ...requestInput,
      overrideAction: command.overrideAction,
      actor: parsed.actor,
      reason: parsed.reason,
      reasonCodes: sortUniqueStrings([
        command.defaultReasonCode,
        ...parsed.reasonCodes,
      ]),
      targetRuleIds: parsed.targetRuleIds,
      targetCandidateIds: parsed.targetCandidateIds,
      ...(parsed.evidenceEventIds.length > 0
        ? { evidenceEventIds: parsed.evidenceEventIds }
        : {}),
      ...(parsed.sourceEventIds.length > 0
        ? { sourceEventIds: parsed.sourceEventIds }
        : {}),
    },
  });
  writeMemoryCommandResult({
    operation: `memory.${command.command}`,
    configFile: target.configFile,
    memoryAlias: target.memoryAlias,
    memoryConfig: target.memoryConfig,
    format: parsed.format,
    response,
    renderText: renderMemoryOverrideText,
  });
  return 0;
}

function runMemory(argv: readonly string[]): Promise<number> {
  const [subcommand, ...rest] = argv;
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    printMemoryUsage();
    return Promise.resolve(subcommand ? 0 : 1);
  }
  if (subcommand === "add") {
    return runMemoryAdd(rest);
  }
  if (subcommand === "list") {
    return runMemoryList(rest);
  }
  if (subcommand === "remove") {
    return runMemoryRemove(rest);
  }
  if (subcommand === "search") {
    return runMemorySearch(rest);
  }
  if (subcommand === "timeline") {
    return runMemoryTimeline(rest);
  }
  if (subcommand === "provenance") {
    return runMemoryProvenance(rest);
  }
  if (subcommand === "policy-audit") {
    return runMemoryPolicyAudit(rest);
  }
  if (subcommand === "anomalies") {
    return runMemoryAnomalies(rest);
  }
  if (subcommand === "feedback") {
    return runMemoryFeedback(rest);
  }
  if (subcommand === "quarantine") {
    return runMemoryOverride(rest, {
      command: "quarantine",
      overrideAction: "suppress",
      defaultReasonCode: "manual_quarantine_requested",
    });
  }
  if (subcommand === "forget") {
    return runMemoryOverride(rest, {
      command: "forget",
      overrideAction: "suppress",
      defaultReasonCode: "manual_forget_requested",
    });
  }
  if (subcommand === "pin") {
    return runMemoryOverride(rest, {
      command: "pin",
      overrideAction: "promote",
      defaultReasonCode: "manual_pin_requested",
    });
  }
  throw new Error(`Unknown memory subcommand: ${subcommand}`);
}

async function runRouteAdd(argv: readonly string[]): Promise<number> {
  const parsed = parseRouteAddArgs(argv);
  if (!parsed.memory) {
    throw new Error("route add requires --memory.");
  }
  if (
    !parsed.pathPrefix &&
    !parsed.repoRoot &&
    !parsed.workspaceRoot &&
    !parsed.source
  ) {
    throw new Error(
      "route add requires at least one of --path-prefix, --repo-root, --workspace-root, or --source."
    );
  }
  const loaded = await loadDaemonConfigForCommand(parsed.configFile);
  const nextRoute = {
    match: {
      ...(parsed.pathPrefix ? { pathPrefix: parsed.pathPrefix } : {}),
      ...(parsed.repoRoot ? { repoRoot: parsed.repoRoot } : {}),
      ...(parsed.workspaceRoot ? { workspaceRoot: parsed.workspaceRoot } : {}),
      ...(parsed.source ? { source: parsed.source } : {}),
    },
    memory: parsed.memory,
    priority: parsed.priority,
    ...(parsed.project ? { project: parsed.project } : {}),
    ...(parsed.workspace ? { workspace: parsed.workspace } : {}),
    ...(parsed.notes ? { notes: parsed.notes } : {}),
  };
  const nextConfig = canonicalizeDaemonConfig(
    {
      ...loaded.config,
      routes: [...loaded.config.routes, nextRoute],
    },
    { configFile: loaded.configFile }
  );
  const existingRouteCounts = loaded.config.routes.reduce<Map<string, number>>(
    (counts, route) => {
      const key = JSON.stringify(route);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      return counts;
    },
    new Map<string, number>()
  );
  const routeIndex = nextConfig.routes.findIndex((route) => {
    const key = JSON.stringify(route);
    const remaining = existingRouteCounts.get(key) ?? 0;
    if (remaining > 0) {
      existingRouteCounts.set(key, remaining - 1);
      return false;
    }
    return true;
  });
  const written = await saveDaemonConfigForCommand(loaded.configFile, {
    ...loaded.config,
    routes: [...loaded.config.routes, nextRoute],
  });
  writeSuccess({
    operation: "route.add",
    configFile: written.configFile,
    routeIndex,
    route: written.config.routes[routeIndex] ?? null,
  });
  return 0;
}

async function runRouteList(argv: readonly string[]): Promise<number> {
  const parsed = parseRouteListArgs(argv);
  const loaded = await loadDaemonConfigForCommand(parsed.configFile);
  writeSuccess({
    operation: "route.list",
    configFile: loaded.configFile,
    routes: loaded.config.routes.map((route, index) => ({
      index,
      ...route,
    })),
  });
  return 0;
}

async function runRouteRemove(argv: readonly string[]): Promise<number> {
  const parsed = parseRouteRemoveArgs(argv);
  if (parsed.index === null) {
    throw new Error("route remove requires --index.");
  }
  const loaded = await loadDaemonConfigForCommand(parsed.configFile);
  if (parsed.index < 0 || parsed.index >= loaded.config.routes.length) {
    throw new Error(
      `Route index ${parsed.index} is out of range for ${loaded.config.routes.length} configured route(s).`
    );
  }
  const removed = loaded.config.routes[parsed.index];
  const written = await saveDaemonConfigForCommand(loaded.configFile, {
    ...loaded.config,
    routes: loaded.config.routes.filter((_, index) => index !== parsed.index),
  });
  writeSuccess({
    operation: "route.remove",
    configFile: written.configFile,
    removedIndex: parsed.index,
    removedRoute: removed,
  });
  return 0;
}

async function runRouteExplain(argv: readonly string[]): Promise<number> {
  const parsed = parseRouteExplainArgs(argv);
  const loaded = await loadDaemonConfigForCommand(parsed.configFile);
  const resolution = explainDaemonRouteResolution(loaded.config, {
    path: parsed.path,
    repoRoot: parsed.repoRoot,
    workspaceRoot: parsed.workspaceRoot,
    source: parsed.source,
  });
  writeSuccess({
    operation: "route.explain",
    configFile: loaded.configFile,
    defaults: loaded.config.defaults,
    ...resolution,
  });
  return 0;
}

async function runRouteSetDefault(argv: readonly string[]): Promise<number> {
  const parsed = parseRouteSetDefaultArgs(argv);
  if (!parsed.memory) {
    throw new Error("route set-default requires --memory.");
  }
  const loaded = await loadDaemonConfigForCommand(parsed.configFile);
  const written = await saveDaemonConfigForCommand(loaded.configFile, {
    ...loaded.config,
    defaults: {
      ...loaded.config.defaults,
      memory: parsed.memory,
      ...(parsed.onAmbiguous ? { onAmbiguous: parsed.onAmbiguous } : {}),
    },
  });
  writeSuccess({
    operation: "route.set-default",
    configFile: written.configFile,
    defaults: written.config.defaults,
  });
  return 0;
}

async function runRouteShowDefault(argv: readonly string[]): Promise<number> {
  const parsed = parseRouteShowDefaultArgs(argv);
  const loaded = await loadDaemonConfigForCommand(parsed.configFile);
  writeSuccess({
    operation: "route.show-default",
    configFile: loaded.configFile,
    defaults: loaded.config.defaults,
  });
  return 0;
}

function runRoute(argv: readonly string[]): Promise<number> {
  const [subcommand, ...rest] = argv;
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    printRouteUsage();
    return Promise.resolve(subcommand ? 0 : 1);
  }
  if (subcommand === "add") {
    return runRouteAdd(rest);
  }
  if (subcommand === "list") {
    return runRouteList(rest);
  }
  if (subcommand === "remove") {
    return runRouteRemove(rest);
  }
  if (subcommand === "set-default") {
    return runRouteSetDefault(rest);
  }
  if (subcommand === "show-default") {
    return runRouteShowDefault(rest);
  }
  if (subcommand === "explain" || subcommand === "test") {
    return runRouteExplain(rest);
  }
  throw new Error(`Unknown route subcommand: ${subcommand}`);
}

async function runSourceDiscover(argv: readonly string[]): Promise<number> {
  const parsed = parseSourceDiscoverArgs(argv);
  const loaded = await loadOptionalDaemonConfigForCommand(parsed.configFile);
  const candidates = await discoverDaemonSources({
    ...(loaded ? { config: loaded.config } : {}),
    ...(parsed.workspaceRoots.length > 0
      ? { workspaceRoots: parsed.workspaceRoots }
      : {}),
    ...(parsed.sources.length > 0 ? { sourceFilter: parsed.sources } : {}),
  });
  writeSuccess({
    operation: "source.discover",
    configFile:
      loaded?.configFile ?? resolveDaemonConfigFilePath(parsed.configFile),
    configured: loaded !== null,
    workspaceRoots:
      parsed.workspaceRoots.length > 0
        ? parsed.workspaceRoots
        : [process.cwd()],
    candidates,
    summary: {
      detected: candidates.length,
      recommended: candidates.filter((candidate) => candidate.recommended)
        .length,
      alreadyConfigured: candidates.filter((candidate) => candidate.existing)
        .length,
      pending: candidates.filter(
        (candidate) => candidate.proposedStatus === "pending"
      ).length,
      approvedByDefault: candidates.filter(
        (candidate) => candidate.proposedStatus === "approved"
      ).length,
    },
  });
  return 0;
}

async function runSourceOnboard(argv: readonly string[]): Promise<number> {
  const parsed = parseSourceDiscoverArgs(argv);
  const loaded = await loadDaemonConfigForCommand(parsed.configFile);
  const candidates = await discoverDaemonSources({
    config: loaded.config,
    ...(parsed.workspaceRoots.length > 0
      ? { workspaceRoots: parsed.workspaceRoots }
      : {}),
    ...(parsed.sources.length > 0 ? { sourceFilter: parsed.sources } : {}),
  });
  const nextBindings = new Map(
    loaded.config.sources.bindings.map((binding) => [binding.id, binding])
  );
  for (const candidate of candidates) {
    const existingBinding = nextBindings.get(candidate.id);
    nextBindings.set(candidate.id, {
      id: candidate.id,
      source: candidate.source,
      kind: candidate.kind,
      path: candidate.path,
      status: existingBinding?.status ?? candidate.proposedStatus,
      label: candidate.label,
      health: candidate.health,
      lastSeenAt: candidate.detectedAt,
    });
  }
  const written = await saveDaemonConfigForCommand(loaded.configFile, {
    ...loaded.config,
    sources: {
      ...loaded.config.sources,
      bindings: [...nextBindings.values()],
    },
  });
  const catalog = await getDaemonSourceViews(written.configFile);
  const onboardedIds = new Set(candidates.map((candidate) => candidate.id));
  const bindings = catalog.bindings.filter((binding) =>
    onboardedIds.has(binding.id)
  );
  writeSuccess({
    operation: "source.onboard",
    configFile: catalog.configFile,
    bindings,
    summary: summarizeSourceBindingStatuses(bindings),
  });
  return 0;
}

async function runSourceList(argv: readonly string[]): Promise<number> {
  const parsed = parseSourceListArgs(argv);
  const catalog = await getDaemonSourceViews(parsed.configFile);
  const bindings =
    parsed.source === null
      ? catalog.bindings
      : catalog.bindings.filter((binding) => binding.source === parsed.source);
  writeSuccess({
    operation: "source.list",
    configFile: catalog.configFile,
    bindings,
    summary: summarizeSourceBindingStatuses(bindings),
  });
  return 0;
}

async function runSourceInspect(argv: readonly string[]): Promise<number> {
  const parsed = parseSourceInspectArgs(argv);
  if (!parsed.id) {
    throw new Error("source inspect requires --id.");
  }
  const catalog = await getDaemonSourceViews(parsed.configFile);
  const binding = catalog.bindings.find((entry) => entry.id === parsed.id);
  if (!binding) {
    throw new Error(`Source binding '${parsed.id}' does not exist.`);
  }
  writeSuccess({
    operation: "source.inspect",
    configFile: catalog.configFile,
    binding,
  });
  return 0;
}

async function runSourceStatusCommand(
  argv: readonly string[],
  status: DaemonSourceBindingStatus,
  operation: "source.approve" | "source.disable" | "source.ignore"
): Promise<number> {
  const parsed = parseSourceInspectArgs(argv);
  if (!parsed.id) {
    throw new Error(`${operation} requires --id.`);
  }
  const loaded = await loadDaemonConfigForCommand(parsed.configFile);
  const existing = loaded.config.sources.bindings.find(
    (binding) => binding.id === parsed.id
  );
  if (!existing) {
    throw new Error(`Source binding '${parsed.id}' does not exist.`);
  }
  const written = await saveDaemonConfigForCommand(loaded.configFile, {
    ...loaded.config,
    sources: {
      ...loaded.config.sources,
      bindings: loaded.config.sources.bindings.map((binding) =>
        binding.id === parsed.id ? { ...binding, status } : binding
      ),
    },
  });
  const catalog = await getDaemonSourceViews(written.configFile);
  writeSuccess({
    operation,
    configFile: catalog.configFile,
    binding:
      catalog.bindings.find((binding) => binding.id === parsed.id) ?? null,
  });
  return 0;
}

function runSource(argv: readonly string[]): Promise<number> {
  const [subcommand, ...rest] = argv;
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    printSourceUsage();
    return Promise.resolve(subcommand ? 0 : 1);
  }
  if (subcommand === "discover") {
    return runSourceDiscover(rest);
  }
  if (subcommand === "onboard") {
    return runSourceOnboard(rest);
  }
  if (subcommand === "list") {
    return runSourceList(rest);
  }
  if (subcommand === "inspect") {
    return runSourceInspect(rest);
  }
  if (subcommand === "approve") {
    return runSourceStatusCommand(rest, "approved", "source.approve");
  }
  if (subcommand === "disable") {
    return runSourceStatusCommand(rest, "disabled", "source.disable");
  }
  if (subcommand === "ignore") {
    return runSourceStatusCommand(rest, "ignored", "source.ignore");
  }
  throw new Error(`Unknown source subcommand: ${subcommand}`);
}

async function runAgentSkill(argv: readonly string[]): Promise<number> {
  writeSuccess(await Effect.runPromise(readCanonicalSkillEffect(argv)));
  return 0;
}

async function runAgentBootstrap(argv: readonly string[]): Promise<number> {
  const payload = await Effect.runPromise(runAgentBootstrapEffect(argv));
  writeSuccess(payload);
  return payload.operation === "agent.bootstrap.check" && !payload.healthy
    ? 1
    : 0;
}

function runAgent(argv: readonly string[]): Promise<number> {
  const [subcommand, ...rest] = argv;
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    printAgentUsage();
    return Promise.resolve(subcommand ? 0 : 1);
  }
  if (subcommand === "skill") {
    return runAgentSkill(rest);
  }
  if (subcommand === "bootstrap") {
    return runAgentBootstrap(rest);
  }
  throw new Error(`Unknown agent subcommand: ${subcommand}`);
}

let _activeServerHandle: unknown = null;
let _activeWorkerHandle: unknown = null;

async function runServe(argv: readonly string[]): Promise<number> {
  const config = parseServeArgs(argv);
  const { service, host, port } = await startSupervisedApiService(config);
  _activeServerHandle = service;
  process.stdout.write(`UMS API listening on http://${host}:${port}\n`);
  const supervisionWatcher = setInterval(() => {
    const snapshot = service.status();
    if (snapshot.phase === "failed") {
      clearInterval(supervisionWatcher);
      process.stderr.write(
        `UMS serve supervision failed: ${snapshot.lastError ?? "unknown failure"}\n`
      );
      process.exit(1);
      return;
    }
    if (snapshot.phase === "stopped") {
      clearInterval(supervisionWatcher);
    }
  }, 250);
  supervisionWatcher.unref?.();
  return 0;
}

async function runWorker(argv: readonly string[]): Promise<number> {
  const config = parseWorkerArgs(argv);
  const { service } = await startSupervisedWorkerService(config);
  _activeWorkerHandle = service;
  const snapshot = service.status();
  process.stdout.write(
    `UMS worker running (intervalMs=${snapshot.intervalMs}, stateFile=${snapshot.stateFile ?? "in-memory"})\n`
  );
  const supervisionWatcher = setInterval(() => {
    const workerSnapshot = service.status();
    if (workerSnapshot.phase === "failed") {
      clearInterval(supervisionWatcher);
      process.stderr.write(
        `UMS worker supervision failed: ${workerSnapshot.lastError ?? "unknown failure"}\n`
      );
      process.exit(1);
      return;
    }
    if (workerSnapshot.phase === "stopped") {
      clearInterval(supervisionWatcher);
    }
  }, 250);
  return 0;
}

function runLogin(argv: readonly string[]): Promise<number> {
  void argv;
  throw new Error(
    "login is removed from the config-backed daemon runtime. Use `ums account add` and wait for secure keychain-backed login."
  );
}

function runConnect(argv: readonly string[]): Promise<number> {
  void argv;
  throw new Error(
    "connect is removed from the config-backed daemon runtime. Define accounts, memories, and routes in config.jsonc."
  );
}

async function runDaemonLifecycleCommand<A>(
  effect: Effect.Effect<A, unknown>
): Promise<number> {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) {
    writeSuccess(exit.value);
    return 0;
  }

  const error = Cause.squash(exit.cause);
  const formatted = formatDaemonLifecycleCommandError(error);
  if (formatted) {
    writeFailure(formatted);
    return 1;
  }

  writeError("UMS_RUNTIME_ERROR", toCauseMessage(error));
  return 1;
}

function runInstall(argv: readonly string[]): Promise<number> {
  const parsed = parseInstallArgs(argv);
  return runDaemonLifecycleCommand(
    installDaemonEffect({ configFile: parsed.configFile })
  );
}

function runStart(argv: readonly string[]): Promise<number> {
  const parsed = parseStartArgs(argv);
  return runDaemonLifecycleCommand(
    startDaemonEffect({
      configFile: parsed.configFile,
      intervalMs: parsed.intervalMs,
      readyTimeoutMs: parsed.readyTimeoutMs,
    })
  );
}

function runStop(argv: readonly string[]): Promise<number> {
  const parsed = parseStopArgs(argv);
  return runDaemonLifecycleCommand(
    stopDaemonEffect({
      configFile: parsed.configFile,
      timeoutMs: parsed.timeoutMs,
    })
  );
}

function runRestart(argv: readonly string[]): Promise<number> {
  const parsed = parseRestartArgs(argv);
  return runDaemonLifecycleCommand(
    restartDaemonEffect({
      configFile: parsed.configFile,
      intervalMs: parsed.intervalMs,
      readyTimeoutMs: parsed.readyTimeoutMs,
      timeoutMs: parsed.timeoutMs,
    })
  );
}

function runLifecycleStatus(argv: readonly string[]): Promise<number> {
  const parsed = parseStatusArgs(argv);
  return runDaemonLifecycleCommand(
    statusDaemonEffect({ configFile: parsed.configFile })
  );
}

function runLogs(argv: readonly string[]): Promise<number> {
  const parsed = parseLogsArgs(argv);
  return runDaemonLifecycleCommand(
    logsDaemonEffect({
      configFile: parsed.configFile,
      lines: parsed.lines,
    })
  );
}

function runDoctor(argv: readonly string[]): Promise<number> {
  const parsed = parseDoctorArgs(argv);
  return runDaemonLifecycleCommand(
    doctorDaemonEffect({ configFile: parsed.configFile })
  );
}

function runUninstall(argv: readonly string[]): Promise<number> {
  const parsed = parseUninstallArgs(argv);
  return runDaemonLifecycleCommand(
    uninstallDaemonEffect({
      configFile: parsed.configFile,
      timeoutMs: parsed.timeoutMs,
    })
  );
}

async function runSync(argv: readonly string[]): Promise<number> {
  const parsed = parseSyncArgs(argv);
  const summary = await runConfiguredSyncCycle(parsed.configFile);
  writeSuccess(summary);
  return 0;
}

async function runSyncDaemon(argv: readonly string[]): Promise<number> {
  const parsed = parseSyncDaemonArgs(argv);
  const staleCleared = await clearStaleDaemonPid(parsed.configFile);
  if (
    staleCleared.daemon.pid &&
    staleCleared.daemon.pid !== process.pid &&
    staleCleared.daemon.alive
  ) {
    writeSuccess({
      operation: "sync-daemon",
      status: "already_running",
      pid: staleCleared.daemon.pid,
      daemon: staleCleared.daemon,
    });
    return 0;
  }

  await updateDaemonStatus({
    configFile: parsed.configFile,
    daemonPid: process.pid,
    daemonStartedAt: new Date().toISOString(),
  });

  const result = await runConfiguredSyncDaemon({
    configFile: parsed.configFile,
    intervalMs: parsed.intervalMs,
    maxCycles: parsed.maxCycles,
    ...(parsed.quiet
      ? {}
      : {
          onCycle: (summary: DaemonSyncSummary | null, error: Error | null) => {
            if (summary) {
              writeSuccess(summary);
              return;
            }
            if (error) {
              writeError("SYNC_DAEMON_CYCLE_ERROR", error.message);
            }
          },
        }),
  }).finally(async () => {
    await updateDaemonStatus({
      configFile: parsed.configFile,
      daemonPid: null,
    });
  });
  if (!parsed.quiet) {
    const status = await getDaemonStatus(parsed.configFile);
    writeSuccess({
      operation: "sync-daemon",
      status: "stopped",
      cycles: result.cycles,
      daemon: status.daemon,
      sync: status.sync,
    });
  }
  return 0;
}

async function main(
  argv: readonly string[] = process.argv.slice(2)
): Promise<number> {
  const [command, ...rest] = argv;

  if (
    !command ||
    command === "--help" ||
    command === "-h" ||
    command === "help"
  ) {
    printUsage();
    return command ? 0 : 1;
  }

  if (command === "serve" || command === "api") {
    return runServe(rest);
  }
  if (command === "worker") {
    return runWorker(rest);
  }
  if (command === "login") {
    return runLogin(rest);
  }
  if (command === "connect") {
    return runConnect(rest);
  }
  if (command === "install") {
    return runInstall(rest);
  }
  if (command === "start") {
    return runStart(rest);
  }
  if (command === "stop") {
    return runStop(rest);
  }
  if (command === "restart") {
    return runRestart(rest);
  }
  if (command === "sync") {
    return runSync(rest);
  }
  if (command === "sync-daemon") {
    return runSyncDaemon(rest);
  }
  if (command === "status") {
    return runLifecycleStatus(rest);
  }
  if (command === "logs") {
    return runLogs(rest);
  }
  if (command === "doctor") {
    return runDoctor(rest);
  }
  if (command === "uninstall") {
    return runUninstall(rest);
  }
  if (command === "account") {
    return runAccount(rest);
  }
  if (command === "memory") {
    return runMemory(rest);
  }
  if (command === "source") {
    return runSource(rest);
  }
  if (command === "route") {
    return runRoute(rest);
  }
  if (command === "agent") {
    return runAgent(rest);
  }
  if (command === "config") {
    return runConfig(rest);
  }

  return await runCliMain([...argv]);
}

const isMainModule =
  isMainImportMetaFlag((import.meta as ImportMeta & { main?: boolean }).main) ||
  import.meta.url === `file://${process.argv[1]}`;

if (isMainModule) {
  void (async () => {
    const exit = await Effect.runPromiseExit(Effect.promise(() => main()));
    if (Exit.isSuccess(exit)) {
      process.exitCode = exit.value;
      return;
    }
    const squashed = Cause.squash(exit.cause);
    const formatted = formatCliCommandFailure(squashed);
    if (formatted) {
      writeFailure(formatted);
      process.exitCode = 1;
      return;
    }
    writeError("UMS_RUNTIME_ERROR", Cause.pretty(exit.cause));
    process.exitCode = 1;
  })();
}

export { main };
