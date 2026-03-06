import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { startSupervisedApiService } from "../../api/src/service-runtime.ts";
import { startSupervisedWorkerService } from "../../api/src/worker-runtime.ts";
import { main as runCliMain } from "../../cli/src/program.ts";
import {
  clearStaleDaemonPid,
  type DaemonSyncSummary,
  getDaemonStatus,
  runConfiguredSyncCycle,
  runConfiguredSyncDaemon,
  updateDaemonStatus,
} from "./daemon-sync.ts";
import {
  type DaemonConfig,
  type DaemonConfigIssue,
  type DaemonConfigRouteSource,
  DaemonConfigError,
  canonicalizeDaemonConfig,
  explainDaemonRouteResolution,
  formatDaemonConfigError,
  parseJsonc,
  readDaemonConfig,
  resolveDaemonConfigFilePath,
  serializeDaemonConfig,
  writeDaemonConfig,
} from "./daemon-config.ts";

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
const DEFAULT_RUNTIME_STATE_FILE = ".ums-state.json";
function resolveDefaultStateFile(): string {
  if (
    typeof process.env["UMS_STATE_FILE"] === "string" &&
    process.env["UMS_STATE_FILE"].trim()
  ) {
    return process.env["UMS_STATE_FILE"].trim();
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
      "  ums sync [--config-file path]",
      "  ums sync-daemon [--config-file path] [--interval-ms ms] [--max-cycles n] [--quiet]",
      "  ums status [--config-file path]",
      "  ums account add|list|remove ...",
      "  ums memory add|list|remove ...",
      "  ums route add|list|remove|explain ...",
      "  ums route set-default ...",
      "  ums config init [--config-file path] [--force]",
      "  ums config validate [--config-file path]",
      "  ums config doctor [--config-file path] [--fix]",
      "",
      "Examples:",
      '  ums ingest --store-id coding-agent --input \'{"events":[{"type":"note","content":"Use deterministic IDs"}]}\'',
      "  ums sync --config-file ~/.ums/config.jsonc",
      "  ums sync-daemon --config-file ~/.ums/config.jsonc --interval-ms 60000",
      "  ums status --config-file ~/.ums/config.jsonc",
      "  ums account add --name company --type http --api-url https://ums.company.internal --auth-mode session-ref --credential-ref keychain://ums/company",
      "  ums memory add --name company-new-engine --account company --store-id coding-agent --profile developer-main --project new-engine",
      "  ums route add --path-prefix ~/Developer/new-engine --memory company-new-engine",
      "  ums route set-default --memory personal --on-ambiguous default",
      "  ums route explain --path ~/Developer/new-engine/src/server.ts",
      "  ums config init",
      "  ums config validate",
      "  ums config doctor --fix",
      "  ums serve --host 127.0.0.1 --port 8787",
      "  ums worker --interval-ms 30000 --restart-limit 2 --restart-delay-ms 500",
      "",
      "Notes:",
      "  - CLI and API default to the same state file: ./.ums-state.json",
      "  - Use `serve` to run the HTTP API server.",
      "  - Use `worker` to run background review/replay/maintenance cycles.",
      "  - `sync`, `sync-daemon`, and `status` now use config.jsonc only.",
      "  - `login` and `connect` are removed from the daemon-first runtime path.",
      "  - `config` manages ~/.ums/config.jsonc and uses canonical JSONC validation/rewrites.",
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
      "  ums account remove --name <alias> [--config-file path]",
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
    ].join("\n")}\n`
  );
}

function printRouteUsage(): void {
  process.stderr.write(
    `${[
      "Usage:",
      "  ums route add --memory <alias> [--priority <n>] [--path-prefix <path>] [--repo-root <path>] [--workspace-root <path>] [--source <codex|claude|vscode|codex-native|plan>] [--project <key>] [--workspace <key>] [--notes <text>]",
      "  ums route list [--config-file path]",
      "  ums route remove --index <n> [--config-file path]",
      "  ums route set-default --memory <alias> [--on-ambiguous <review|default|drop>] [--config-file path]",
      "  ums route show-default [--config-file path]",
      "  ums route explain [--path <path>] [--repo-root <path>] [--workspace-root <path>] [--source <source>] [--config-file path]",
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
    typeof parsed.stateFile === "string" &&
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
    normalized !== "vscode" &&
    normalized !== "codex-native" &&
    normalized !== "plan"
  ) {
    throw new Error(
      `${flagName} must be one of codex, claude, vscode, codex-native, plan.`
    );
  }
  return normalized;
}

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

function parseRouteSetDefaultArgs(argv: readonly string[]): RouteSetDefaultArgs {
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
        throw new Error(
          "--on-ambiguous must be one of review, default, drop."
        );
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

function parseRouteShowDefaultArgs(argv: readonly string[]): RouteShowDefaultArgs {
  const parsed = parseConfigCommonArgs(argv);
  if (parsed.rest.length > 0) {
    throw new Error(`Unknown route show-default argument: ${parsed.rest[0]}`);
  }
  return {
    configFile: parsed.configFile,
  };
}

function toMaybeString(value: string | null): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function writeSuccess(data: unknown): void {
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        data,
      },
      null,
      2
    )}\n`
  );
}

function writeError(code: string, message: string): void {
  process.stderr.write(
    `${JSON.stringify(
      {
        ok: false,
        error: {
          code,
          message,
        },
      },
      null,
      2
    )}\n`
  );
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
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
  readonly defaultMemory: string;
  readonly managedMemories: readonly string[];
} {
  const managedMemories = Object.keys(config.memories).filter((alias) =>
    config.policy.managedMemoryPrefixes.some((prefix) => alias.startsWith(prefix))
  );
  return {
    accounts: Object.keys(config.accounts).length,
    memories: Object.keys(config.memories).length,
    routes: config.routes.length,
    defaultMemory: config.defaults.memory,
    managedMemories,
  };
}

function buildDoctorWarnings(config: DaemonConfig): string[] {
  const warnings = new Set<string>();
  for (const [alias, account] of Object.entries(config.accounts)) {
    if (account.type === "http" && account.auth.mode === "token-env") {
      warnings.add(
        `Account '${alias}' uses token-env fallback. Prefer keychain-backed auth for user devices.`
      );
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
  try {
    const loaded = await readDaemonConfig(parsed.configFile);
    writeSuccess({
      operation: "config.validate",
      configFile: loaded.configFile,
      summary: summarizeDaemonConfig(loaded.config),
      warnings: buildDoctorWarnings(loaded.config),
    });
    return 0;
  } catch (error) {
    writeError(
      error instanceof DaemonConfigError
        ? error.code
        : "DAEMON_CONFIG_VALIDATE_ERROR",
      formatDaemonConfigError(error)
    );
    return 1;
  }
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

  let raw = "";
  try {
    raw = await readFile(configFile, "utf8");
  } catch (error) {
    throw new Error(
      `Unable to read daemon config file '${configFile}': ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  try {
    const parsedRaw = parseJsonc(raw);
    const config = canonicalizeDaemonConfig(parsedRaw, { configFile });
    const canonicalText = serializeDaemonConfig(config);
    const canonical = raw === canonicalText;
    const rewritten = parsed.fix && !canonical;
    if (rewritten) {
      await writeDaemonConfig(configFile, config);
    }
    const warnings = buildDoctorWarnings(config);
    const suggestions = [
      ...(!canonical && !parsed.fix
        ? ["Run `ums config doctor --fix` to rewrite the file into canonical JSON."]
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
      status: rewritten
        ? "rewritten"
        : canonical
          ? "healthy"
          : "needs_rewrite",
      healthy: true,
      canonical,
      rewritten,
      summary: summarizeDaemonConfig(config),
      warnings,
      issues: [],
      suggestions,
    });
    return 0;
  } catch (error) {
    const issues =
      error instanceof DaemonConfigError ? formatConfigIssues(error.issues) : [];
    writeSuccess({
      operation: "config.doctor",
      configFile,
      status: "invalid",
      healthy: false,
      warnings: [],
      issues,
      suggestions: [
        "Fix the reported config errors and re-run `ums config validate`.",
      ],
      message: formatDaemonConfigError(error),
    });
    return 0;
  }
}

async function runConfig(argv: readonly string[]): Promise<number> {
  const [subcommand, ...rest] = argv;
  if (
    !subcommand ||
    subcommand === "--help" ||
    subcommand === "-h" ||
    subcommand === "help"
  ) {
    printConfigUsage();
    return subcommand ? 0 : 1;
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
  try {
    return await readDaemonConfig(configFile);
  } catch (error) {
    throw new Error(formatDaemonConfigError(error));
  }
}

async function saveDaemonConfigForCommand(
  configFile: string | null,
  config: DaemonConfig
): Promise<{ configFile: string; config: DaemonConfig }> {
  try {
    return await writeDaemonConfig(configFile, config);
  } catch (error) {
    throw new Error(formatDaemonConfigError(error));
  }
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
      if (!parsed.credentialRef) {
        throw new Error(
          "account add secure auth modes require --credential-ref."
        );
      }
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
          credentialRef: parsed.credentialRef,
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
  writeSuccess({
    operation: "account.list",
    configFile: loaded.configFile,
    accounts: Object.entries(loaded.config.accounts).map(([name, account]) => ({
      name,
      ...account,
    })),
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
  const nextAccounts = { ...loaded.config.accounts };
  delete nextAccounts[parsed.name];
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

async function runAccount(argv: readonly string[]): Promise<number> {
  const [subcommand, ...rest] = argv;
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    printAccountUsage();
    return subcommand ? 0 : 1;
  }
  if (subcommand === "add") {
    return runAccountAdd(rest);
  }
  if (subcommand === "list") {
    return runAccountList(rest);
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
  const nextMemories = { ...loaded.config.memories };
  delete nextMemories[parsed.name];
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

async function runMemory(argv: readonly string[]): Promise<number> {
  const [subcommand, ...rest] = argv;
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    printMemoryUsage();
    return subcommand ? 0 : 1;
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
  throw new Error(`Unknown memory subcommand: ${subcommand}`);
}

async function runRouteAdd(argv: readonly string[]): Promise<number> {
  const parsed = parseRouteAddArgs(argv);
  if (!parsed.memory) {
    throw new Error("route add requires --memory.");
  }
  if (!parsed.pathPrefix && !parsed.repoRoot && !parsed.workspaceRoot && !parsed.source) {
    throw new Error(
      "route add requires at least one of --path-prefix, --repo-root, --workspace-root, or --source."
    );
  }
  const loaded = await loadDaemonConfigForCommand(parsed.configFile);
  const written = await saveDaemonConfigForCommand(loaded.configFile, {
    ...loaded.config,
    routes: [
      ...loaded.config.routes,
      {
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
      },
    ],
  });
  const index = written.config.routes.findIndex(
    (route) =>
      route.memory === parsed.memory &&
      route.priority === parsed.priority &&
      route.notes === parsed.notes
  );
  writeSuccess({
    operation: "route.add",
    configFile: written.configFile,
    routeIndex: index,
    route: written.config.routes[index] ?? null,
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
  if (
    parsed.index < 0 ||
    parsed.index >= loaded.config.routes.length
  ) {
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
      ...(parsed.onAmbiguous
        ? { onAmbiguous: parsed.onAmbiguous }
        : {}),
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

async function runRoute(argv: readonly string[]): Promise<number> {
  const [subcommand, ...rest] = argv;
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    printRouteUsage();
    return subcommand ? 0 : 1;
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
  if (typeof supervisionWatcher.unref === "function") {
    supervisionWatcher.unref();
  }
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

async function runLogin(argv: readonly string[]): Promise<number> {
  void argv;
  throw new Error(
    "login is removed from the config-backed daemon runtime. Use `ums account add` and wait for secure keychain-backed login."
  );
}

async function runConnect(argv: readonly string[]): Promise<number> {
  void argv;
  throw new Error(
    "connect is removed from the config-backed daemon runtime. Define accounts, memories, and routes in config.jsonc."
  );
}

async function runSync(argv: readonly string[]): Promise<number> {
  const parsed = parseSyncArgs(argv);
  const summary = await runConfiguredSyncCycle(parsed.configFile);
  writeSuccess(summary);
  return 0;
}

async function runStatus(argv: readonly string[]): Promise<number> {
  const parsed = parseStatusArgs(argv);
  const status = await clearStaleDaemonPid(parsed.configFile);
  writeSuccess(status);
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

  try {
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
    });
    await updateDaemonStatus({
      configFile: parsed.configFile,
      daemonPid: null,
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
  } finally {
    await updateDaemonStatus({
      configFile: parsed.configFile,
      daemonPid: null,
    });
  }
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
  if (command === "sync") {
    return runSync(rest);
  }
  if (command === "sync-daemon") {
    return runSyncDaemon(rest);
  }
  if (command === "status") {
    return runStatus(rest);
  }
  if (command === "account") {
    return runAccount(rest);
  }
  if (command === "memory") {
    return runMemory(rest);
  }
  if (command === "route") {
    return runRoute(rest);
  }
  if (command === "config") {
    return runConfig(rest);
  }

  return await runCliMain([...argv]);
}

const isMainModule =
  (typeof (import.meta as ImportMeta & { main?: boolean }).main === "boolean" &&
    (import.meta as ImportMeta & { main?: boolean }).main) ||
  import.meta.url === `file://${process.argv[1]}`;

if (isMainModule) {
  void (async () => {
    try {
      const code = await main();
      process.exitCode = code;
    } catch (error) {
      process.stderr.write(
        `${JSON.stringify(
          {
            ok: false,
            error: {
              code: "UMS_RUNTIME_ERROR",
              message: error instanceof Error ? error.message : String(error),
            },
          },
          null,
          2
        )}\n`
      );
      process.exitCode = 1;
    }
  })();
}

export { main };
