import { main as runCliMain } from "../../cli/src/index.mjs";
import { startApiServer } from "../../api/src/server.mjs";
import { DEFAULT_SHARED_STATE_FILE } from "../../api/src/persistence.mjs";

const DEFAULT_API_HOST = process.env.UMS_API_HOST ?? "127.0.0.1";
const DEFAULT_API_PORT = Number.parseInt(process.env.UMS_API_PORT ?? "8787", 10);

function printUsage() {
  process.stderr.write(
    [
      "Usage:",
      "  ums <operation> [--input '<json>'] [--file path] [--state-file path] [--store-id id] [--pretty]",
      "  ums serve [--host host] [--port port] [--state-file path]",
      "",
      "Examples:",
      "  ums ingest --store-id coding-agent --input '{\"profile\":\"demo\",\"events\":[{\"type\":\"note\",\"content\":\"Use deterministic IDs\"}]}'",
      "  ums serve --host 127.0.0.1 --port 8787",
      "",
      "Notes:",
      "  - CLI and API default to the same state file: ./.ums-state.json",
      "  - Use `serve` to run the HTTP API server."
    ].join("\n") + "\n"
  );
}

function parseServeArgs(argv) {
  const args = [...argv];
  const parsed = {
    host: DEFAULT_API_HOST,
    port: DEFAULT_API_PORT,
    stateFile: DEFAULT_SHARED_STATE_FILE,
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
      if (!Number.isFinite(parsedPort) || parsedPort < 0 || parsedPort > 65535) {
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

let activeServerHandle = null;

async function runServe(argv) {
  const config = parseServeArgs(argv);
  const { server, host, port } = await startApiServer(config);
  activeServerHandle = server;
  process.stdout.write(`UMS API listening on http://${host}:${port}\n`);
  return 0;
}

async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;

  if (!command || command === "--help" || command === "-h" || command === "help") {
    printUsage();
    return command ? 0 : 1;
  }

  if (command === "serve" || command === "api") {
    return runServe(rest);
  }

  return runCliMain(argv);
}

const isMainModule =
  (typeof import.meta.main === "boolean" && import.meta.main) ||
  import.meta.url === `file://${process.argv[1]}`;

if (isMainModule) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
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
          2,
        )}\n`,
      );
      process.exitCode = 1;
    },
  );
}

export { main };
