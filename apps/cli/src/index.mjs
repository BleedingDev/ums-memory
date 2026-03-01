import { readFile } from "node:fs/promises";
import {
  executeOperation,
  listOperations
} from "../../api/src/core.mjs";
import { DEFAULT_SHARED_STATE_FILE, executeOperationWithSharedState } from "../../api/src/persistence.mjs";

function printUsage() {
  const ops = listOperations().join(", ");
  process.stderr.write(
    [
      "Usage:",
      "  node apps/cli/src/index.mjs <operation> [--input '<json>'] [--file path] [--state-file path] [--store-id id] [--pretty]",
      "",
      `Operations: ${ops}`,
      "",
      "Examples:",
      "  node apps/cli/src/index.mjs ingest --store-id coding-agent --input '{\"profile\":\"demo\",\"events\":[{\"type\":\"note\",\"content\":\"Use deterministic IDs\"}]}'",
      "  echo '{\"profile\":\"demo\",\"query\":\"deterministic\"}' | node apps/cli/src/index.mjs context"
    ].join("\n") + "\n"
  );
}

function parseArgs(argv) {
  const args = [...argv];
  const cliStateFileEnv =
    typeof process.env.UMS_CLI_STATE_FILE === "string" && process.env.UMS_CLI_STATE_FILE.trim()
      ? process.env.UMS_CLI_STATE_FILE.trim()
      : null;
  const operation = args.shift();
  const flags = {
    pretty: false,
    input: null,
    file: null,
    stateFile: cliStateFileEnv ?? DEFAULT_SHARED_STATE_FILE,
    storeId: null,
    help: false
  };

  while (args.length > 0) {
    const token = args.shift();
    if (!token) {
      continue;
    }
    if (token === "--pretty") {
      flags.pretty = true;
      continue;
    }
    if (token === "--help" || token === "-h") {
      flags.help = true;
      continue;
    }
    if (token === "--input") {
      flags.input = args.shift() ?? "";
      continue;
    }
    if (token === "--file") {
      flags.file = args.shift() ?? "";
      continue;
    }
    if (token === "--state-file") {
      flags.stateFile = args.shift() ?? "";
      continue;
    }
    if (token === "--store-id") {
      flags.storeId = args.shift() ?? "";
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  return {
    operation,
    ...flags
  };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function readInput({ input, file }) {
  if (typeof input === "string" && input.trim()) {
    return input;
  }
  if (typeof file === "string" && file.trim()) {
    const content = await readFile(file, "utf8");
    return content.trim();
  }
  if (!process.stdin.isTTY) {
    return readStdin();
  }
  return "{}";
}

function safeJsonParse(raw) {
  if (!raw || !raw.trim()) {
    return {};
  }
  return JSON.parse(raw);
}

async function main(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  if (parsed.help || !parsed.operation) {
    printUsage();
    return parsed.help ? 0 : 1;
  }

  const requestRaw = await readInput(parsed);
  const requestBody = safeJsonParse(requestRaw);
  if (
    parsed.storeId &&
    typeof requestBody === "object" &&
    requestBody &&
    !Array.isArray(requestBody) &&
    !requestBody.storeId
  ) {
    requestBody.storeId = parsed.storeId;
  }
  const data = await executeOperationWithSharedState({
    operation: parsed.operation,
    stateFile: parsed.stateFile,
    executor: () => executeOperation(parsed.operation, requestBody),
  });
  const payload = {
    ok: true,
    data
  };
  const spacer = parsed.pretty ? 2 : 0;
  process.stdout.write(`${JSON.stringify(payload, null, spacer)}\n`);
  return 0;
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
              code: "CLI_ERROR",
              message: error instanceof Error ? error.message : String(error)
            }
          },
          null,
          2
        )}\n`
      );
      process.exitCode = 1;
    }
  );
}

export { main };
