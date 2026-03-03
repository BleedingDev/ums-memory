import { startSupervisedApiService } from "../../api/src/service-runtime.ts";
import { startSupervisedWorkerService } from "../../api/src/worker-runtime.ts";
import { main as runCliMain } from "../../cli/src/program.ts";

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
      "",
      "Examples:",
      '  ums ingest --store-id coding-agent --input \'{"events":[{"type":"note","content":"Use deterministic IDs"}]}\'',
      "  ums serve --host 127.0.0.1 --port 8787",
      "  ums worker --interval-ms 30000 --restart-limit 2 --restart-delay-ms 500",
      "",
      "Notes:",
      "  - CLI and API default to the same state file: ./.ums-state.json",
      "  - Use `serve` to run the HTTP API server.",
      "  - Use `worker` to run background review/replay/maintenance cycles.",
    ].join("\n")}\n`
  );
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
