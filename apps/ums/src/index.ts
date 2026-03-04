import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

import { startSupervisedApiService } from "../../api/src/service-runtime.ts";
import { startSupervisedWorkerService } from "../../api/src/worker-runtime.ts";
import { main as runCliMain } from "../../cli/src/program.ts";
import {
  clearStaleDaemonPid,
  connectAccount,
  getAccountSessionPublicView,
  loginAccount,
  parseSyncSources,
  runSyncCycle,
  updateDaemonStatus,
} from "./account-sync.ts";

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

interface LoginArgs {
  apiUrl: string | null;
  token: string | null;
  tokenFromStdin: boolean;
  accountFile: string | null;
  accountId: string | null;
  userId: string | null;
  verify: boolean;
  verifyStoreId: string | null;
}

interface ConnectArgs {
  accountFile: string | null;
  storeId: string | null;
  profile: string | null;
  sources: string | null;
  intervalMs: number | null;
  maxEventsPerCycle: number | null;
  autoStartDaemon: boolean;
}

interface SyncArgs {
  accountFile: string | null;
}

interface SyncDaemonArgs {
  accountFile: string | null;
  intervalMs: number | null;
  maxCycles: number | null;
  quiet: boolean;
}

interface StatusArgs {
  accountFile: string | null;
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
const DEFAULT_RUNTIME_STATE_FILE = ".ums-state.json";
const DEFAULT_SYNC_DAEMON_POLL_DELAY_MS = 250;

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
      "  ums login --api-url <url> [--token <token> | --token-stdin] [--account-file path] [--account-id id] [--user-id id] [--skip-verify]",
      "  ums connect --store-id <id> [--profile id] [--sources codex,claude,plan] [--interval-ms ms] [--max-events n] [--account-file path] [--no-auto-start]",
      "  ums sync [--account-file path]",
      "  ums sync-daemon [--account-file path] [--interval-ms ms] [--max-cycles n] [--quiet]",
      "  ums status [--account-file path]",
      "",
      "Examples:",
      '  ums ingest --store-id coding-agent --input \'{"events":[{"type":"note","content":"Use deterministic IDs"}]}\'',
      "  ums login --api-url http://127.0.0.1:8787 --token $UMS_API_AUTH_TOKENS",
      "  ums connect --store-id coding-agent --sources codex,claude,plan",
      "  ums sync",
      "  ums sync-daemon --interval-ms 60000",
      "  ums serve --host 127.0.0.1 --port 8787",
      "  ums worker --interval-ms 30000 --restart-limit 2 --restart-delay-ms 500",
      "",
      "Notes:",
      "  - CLI and API default to the same state file: ./.ums-state.json",
      "  - Use `serve` to run the HTTP API server.",
      "  - Use `worker` to run background review/replay/maintenance cycles.",
      "  - `login` + `connect` configure account-linked ingestion into your deployed API.",
      "  - `connect` starts `sync-daemon` automatically unless --no-auto-start is provided.",
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

function parseLoginArgs(argv: readonly string[]): LoginArgs {
  const args = [...argv];
  const parsed: LoginArgs = {
    apiUrl: null,
    token: null,
    tokenFromStdin: false,
    accountFile: null,
    accountId: null,
    userId: null,
    verify: true,
    verifyStoreId: null,
  };

  while (args.length > 0) {
    const token = args.shift();
    if (!token) {
      continue;
    }
    if (token === "--api-url") {
      parsed.apiUrl = args.shift() ?? "";
      continue;
    }
    if (token === "--token") {
      parsed.token = args.shift() ?? "";
      continue;
    }
    if (token === "--token-stdin") {
      parsed.tokenFromStdin = true;
      continue;
    }
    if (token === "--account-file") {
      parsed.accountFile = args.shift() ?? "";
      continue;
    }
    if (token === "--account-id") {
      parsed.accountId = args.shift() ?? "";
      continue;
    }
    if (token === "--user-id") {
      parsed.userId = args.shift() ?? "";
      continue;
    }
    if (token === "--skip-verify") {
      parsed.verify = false;
      continue;
    }
    if (token === "--verify-store-id") {
      parsed.verifyStoreId = args.shift() ?? "";
      continue;
    }
    throw new Error(`Unknown login argument: ${token}`);
  }

  if (!parsed.apiUrl || !parsed.apiUrl.trim()) {
    throw new Error("login requires --api-url.");
  }

  if (!parsed.tokenFromStdin && (!parsed.token || !parsed.token.trim())) {
    throw new Error("login requires --token <token> or --token-stdin.");
  }

  if (parsed.tokenFromStdin && parsed.token && parsed.token.trim()) {
    throw new Error("Use either --token or --token-stdin, not both.");
  }

  return parsed;
}

function parseConnectArgs(argv: readonly string[]): ConnectArgs {
  const args = [...argv];
  const parsed: ConnectArgs = {
    accountFile: null,
    storeId: null,
    profile: null,
    sources: null,
    intervalMs: null,
    maxEventsPerCycle: null,
    autoStartDaemon: true,
  };

  while (args.length > 0) {
    const token = args.shift();
    if (!token) {
      continue;
    }
    if (token === "--account-file") {
      parsed.accountFile = args.shift() ?? "";
      continue;
    }
    if (token === "--store-id") {
      parsed.storeId = args.shift() ?? "";
      continue;
    }
    if (token === "--profile") {
      parsed.profile = args.shift() ?? "";
      continue;
    }
    if (token === "--sources") {
      parsed.sources = args.shift() ?? "";
      continue;
    }
    if (token === "--interval-ms") {
      parsed.intervalMs = parsePositiveIntegerFlag(
        args.shift() ?? "",
        "--interval-ms"
      );
      continue;
    }
    if (token === "--max-events") {
      parsed.maxEventsPerCycle = parsePositiveIntegerFlag(
        args.shift() ?? "",
        "--max-events"
      );
      continue;
    }
    if (token === "--no-auto-start") {
      parsed.autoStartDaemon = false;
      continue;
    }
    if (token === "--auto-start") {
      parsed.autoStartDaemon = true;
      continue;
    }
    throw new Error(`Unknown connect argument: ${token}`);
  }

  if (!parsed.storeId || !parsed.storeId.trim()) {
    throw new Error("connect requires --store-id.");
  }
  return parsed;
}

function parseSyncArgs(argv: readonly string[]): SyncArgs {
  const args = [...argv];
  const parsed: SyncArgs = {
    accountFile: null,
  };

  while (args.length > 0) {
    const token = args.shift();
    if (!token) {
      continue;
    }
    if (token === "--account-file") {
      parsed.accountFile = args.shift() ?? "";
      continue;
    }
    throw new Error(`Unknown sync argument: ${token}`);
  }

  return parsed;
}

function parseSyncDaemonArgs(argv: readonly string[]): SyncDaemonArgs {
  const args = [...argv];
  const parsed: SyncDaemonArgs = {
    accountFile: null,
    intervalMs: null,
    maxCycles: null,
    quiet: false,
  };

  while (args.length > 0) {
    const token = args.shift();
    if (!token) {
      continue;
    }
    if (token === "--account-file") {
      parsed.accountFile = args.shift() ?? "";
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
  const args = [...argv];
  const parsed: StatusArgs = {
    accountFile: null,
  };

  while (args.length > 0) {
    const token = args.shift();
    if (!token) {
      continue;
    }
    if (token === "--account-file") {
      parsed.accountFile = args.shift() ?? "";
      continue;
    }
    throw new Error(`Unknown status argument: ${token}`);
  }

  return parsed;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8").trim();
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

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function daemonLaunchSpec({
  accountFile,
  intervalMs,
}: {
  accountFile: string | null;
  intervalMs: number | null;
}): { command: string; args: string[] } {
  const baseArgs = ["sync-daemon", "--quiet"];
  if (accountFile) {
    baseArgs.push("--account-file", accountFile);
  }
  if (typeof intervalMs === "number" && Number.isFinite(intervalMs)) {
    baseArgs.push("--interval-ms", String(intervalMs));
  }

  const entrypoint = process.argv[1];
  if (entrypoint && entrypoint.endsWith(".ts")) {
    return {
      command: process.execPath,
      args: ["--import", "tsx", entrypoint, ...baseArgs],
    };
  }

  return {
    command: process.execPath,
    args: baseArgs,
  };
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
  const parsed = parseLoginArgs(argv);
  const apiBaseUrl = parsed.apiUrl;
  if (!apiBaseUrl) {
    throw new Error("login requires --api-url.");
  }
  const stdinToken = parsed.tokenFromStdin ? await readStdin() : "";
  const token = toMaybeString(
    parsed.tokenFromStdin ? stdinToken : parsed.token
  );
  if (!token) {
    throw new Error(
      "Token is empty. Provide --token or pipe token via --token-stdin."
    );
  }

  const session = await loginAccount({
    accountFile: toMaybeString(parsed.accountFile),
    apiBaseUrl,
    token,
    accountId: toMaybeString(parsed.accountId),
    userId: toMaybeString(parsed.userId),
    verify: parsed.verify,
    verifyStoreId: toMaybeString(parsed.verifyStoreId),
  });

  writeSuccess({
    operation: "login",
    session,
  });
  return 0;
}

async function runConnect(argv: readonly string[]): Promise<number> {
  const parsed = parseConnectArgs(argv);
  const sources = parsed.sources ? parseSyncSources(parsed.sources) : null;
  const connectInput = {
    accountFile: toMaybeString(parsed.accountFile),
    storeId: parsed.storeId ?? "",
    profile: toMaybeString(parsed.profile),
    intervalMs: parsed.intervalMs,
    maxEventsPerCycle: parsed.maxEventsPerCycle,
    autoStartDaemon: parsed.autoStartDaemon,
    ...(sources === null ? {} : { enabledSources: sources }),
  };
  let session = await connectAccount(connectInput);

  let daemon = {
    action: "disabled" as "disabled" | "already_running" | "started",
    pid: null as number | null,
  };
  if (parsed.autoStartDaemon) {
    const refreshed = await clearStaleDaemonPid(
      toMaybeString(parsed.accountFile)
    );
    const existingPid = refreshed.sync.daemonPid;
    if (existingPid && isProcessAlive(existingPid)) {
      daemon = {
        action: "already_running",
        pid: existingPid,
      };
      session = refreshed;
    } else {
      const launch = daemonLaunchSpec({
        accountFile: toMaybeString(parsed.accountFile),
        intervalMs: parsed.intervalMs,
      });
      const child = spawn(launch.command, launch.args, {
        detached: true,
        stdio: "ignore",
        env: {
          ...process.env,
          UMS_SYNC_DAEMON_CHILD: "1",
        },
      });
      child.unref();
      const pid =
        typeof child.pid === "number" && child.pid > 0 ? child.pid : null;
      daemon = {
        action: "started",
        pid,
      };
      if (pid !== null) {
        session = await updateDaemonStatus({
          accountFile: toMaybeString(parsed.accountFile),
          daemonPid: pid,
          daemonStartedAt: new Date().toISOString(),
        });
      }
    }
  }

  writeSuccess({
    operation: "connect",
    session,
    daemon,
  });
  return 0;
}

async function runSync(argv: readonly string[]): Promise<number> {
  const parsed = parseSyncArgs(argv);
  const summary = await runSyncCycle(toMaybeString(parsed.accountFile));
  writeSuccess(summary);
  return 0;
}

async function runStatus(argv: readonly string[]): Promise<number> {
  const parsed = parseStatusArgs(argv);
  const session = await clearStaleDaemonPid(toMaybeString(parsed.accountFile));
  writeSuccess({
    operation: "status",
    session,
  });
  return 0;
}

async function runSyncDaemon(argv: readonly string[]): Promise<number> {
  const parsed = parseSyncDaemonArgs(argv);
  const accountFile = toMaybeString(parsed.accountFile);
  const staleCleared = await clearStaleDaemonPid(accountFile);
  if (
    staleCleared.sync.daemonPid &&
    staleCleared.sync.daemonPid !== process.pid &&
    isProcessAlive(staleCleared.sync.daemonPid)
  ) {
    writeSuccess({
      operation: "sync-daemon",
      status: "already_running",
      pid: staleCleared.sync.daemonPid,
      session: staleCleared,
    });
    return 0;
  }

  await updateDaemonStatus({
    accountFile,
    daemonPid: process.pid,
    daemonStartedAt: new Date().toISOString(),
  });

  let cycles = 0;
  let stopRequested = false;
  const maxCycles =
    typeof parsed.maxCycles === "number" && parsed.maxCycles > 0
      ? parsed.maxCycles
      : null;
  const intervalMs =
    typeof parsed.intervalMs === "number" && parsed.intervalMs > 0
      ? parsed.intervalMs
      : staleCleared.sync.intervalMs;
  const stop = () => {
    stopRequested = true;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    while (true) {
      if (stopRequested) {
        break;
      }
      if (maxCycles !== null && cycles >= maxCycles) {
        break;
      }
      try {
        const summary = await runSyncCycle(accountFile);
        cycles += 1;
        if (!parsed.quiet) {
          writeSuccess(summary);
        }
      } catch (error) {
        cycles += 1;
        if (!parsed.quiet) {
          process.stderr.write(
            `${JSON.stringify(
              {
                ok: false,
                error: {
                  code:
                    error instanceof Error &&
                    "code" in error &&
                    typeof (error as { code?: unknown }).code === "string"
                      ? String((error as { code: string }).code)
                      : "SYNC_DAEMON_CYCLE_ERROR",
                  message:
                    error instanceof Error ? error.message : String(error),
                },
              },
              null,
              2
            )}\n`
          );
        }
      }
      if (stopRequested || (maxCycles !== null && cycles >= maxCycles)) {
        break;
      }
      const delayMs = Math.max(intervalMs, DEFAULT_SYNC_DAEMON_POLL_DELAY_MS);
      await delay(delayMs);
    }
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await updateDaemonStatus({
      accountFile,
      daemonPid: null,
    });
  }

  if (!parsed.quiet) {
    const session = await getAccountSessionPublicView(accountFile);
    writeSuccess({
      operation: "sync-daemon",
      status: "stopped",
      cycles,
      session,
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
  if (command === "sync") {
    return runSync(rest);
  }
  if (command === "sync-daemon") {
    return runSyncDaemon(rest);
  }
  if (command === "status") {
    return runStatus(rest);
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
