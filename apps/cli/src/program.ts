import { readFile } from "node:fs/promises";

import {
  DEFAULT_RUNTIME_STATE_FILE,
  executeRuntimeOperation,
  listRuntimeOperations,
} from "../../api/src/runtime-service.ts";

interface ParsedArgs {
  operation: string | null | undefined;
  pretty: boolean;
  input: string | null;
  file: string | null;
  stateFile: string;
  storeId: string | null;
  help: boolean;
}

async function printUsage(): Promise<void> {
  let ops = "unknown";
  try {
    const operations = await listRuntimeOperations();
    ops = operations.join(", ");
  } catch {
    ops = "unavailable (runtime service failed to load)";
  }
  process.stderr.write(
    `${[
      "Usage:",
      "  node --import tsx apps/cli/src/index.ts <operation> [--input '<json>'] [--file path] [--state-file path] [--store-id id] [--pretty]",
      "",
      `Operations: ${ops}`,
      "",
      "Examples:",
      '  node --import tsx apps/cli/src/index.ts ingest --store-id coding-agent --input \'{"events":[{"type":"note","content":"Use deterministic IDs"}]}\'',
      '  echo \'{"query":"deterministic"}\' | node --import tsx apps/cli/src/index.ts context',
    ].join("\n")}\n`
  );
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const args = [...argv];
  const cliStateFileEnv =
    typeof process.env["UMS_CLI_STATE_FILE"] === "string" &&
    process.env["UMS_CLI_STATE_FILE"].trim()
      ? process.env["UMS_CLI_STATE_FILE"].trim()
      : null;
  const operation = args.shift();
  const flags = {
    pretty: false,
    input: null as string | null,
    file: null as string | null,
    stateFile: cliStateFileEnv ?? DEFAULT_RUNTIME_STATE_FILE,
    storeId: null as string | null,
    help: false,
  };

  if (operation === "--help" || operation === "-h" || operation === "help") {
    flags.help = true;
  }

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
    operation: flags.help ? null : operation,
    ...flags,
  };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function readInput({
  input,
  file,
}: {
  input: string | null;
  file: string | null;
}): Promise<string> {
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

function safeJsonParse(raw: string): unknown {
  if (!raw || !raw.trim()) {
    return {};
  }
  return JSON.parse(raw);
}

async function main(
  argv: readonly string[] = process.argv.slice(2)
): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed.help || !parsed.operation) {
    await printUsage();
    return parsed.help ? 0 : 1;
  }

  const requestRaw = await readInput(parsed);
  const requestBody = safeJsonParse(requestRaw);
  const requestBodyObject =
    typeof requestBody === "object" &&
    requestBody &&
    !Array.isArray(requestBody)
      ? (requestBody as { storeId?: unknown })
      : null;
  if (parsed.storeId && requestBodyObject && !requestBodyObject.storeId) {
    requestBodyObject.storeId = parsed.storeId;
  }
  const data = await executeRuntimeOperation({
    operation: parsed.operation,
    requestBody,
    stateFile: parsed.stateFile,
  });
  const payload = {
    ok: true,
    data,
  };
  const spacer = parsed.pretty ? 2 : 0;
  process.stdout.write(`${JSON.stringify(payload, null, spacer)}\n`);
  return 0;
}

export { main };
