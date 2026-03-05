import assert from "node:assert/strict";
import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
const ROOT = process.cwd();
const BUN_AVAILABLE =
  spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0;

let buildDir: string | null = null;
let cliBinaryPath: string | null = null;

interface BinaryCommandResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runBinary(
  binaryPath: string,
  args: readonly string[],
  { stdin = "", cwd = ROOT } = {}
): Promise<BinaryCommandResult> {
  return new Promise<BinaryCommandResult>((resolvePromise) => {
    const proc = spawn(binaryPath, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    proc.on("close", (code) => {
      resolvePromise({ code, stdout, stderr });
    });
    if (stdin) {
      proc.stdin.write(stdin);
    }
    proc.stdin.end();
  });
}

test.before(async () => {
  if (!BUN_AVAILABLE) {
    return;
  }
  buildDir = await mkdtemp(resolve(tmpdir(), "ums-cli-sfe-"));
  cliBinaryPath = resolve(buildDir, "ums-cli");
  const build = spawnSync(
    "bun",
    [
      "build",
      "--compile",
      "--format",
      "esm",
      "--minify",
      "--sourcemap",
      "--bytecode",
      "apps/cli/src/index.ts",
      "--outfile",
      cliBinaryPath,
    ],
    { cwd: ROOT, encoding: "utf8" }
  );
  assert.equal(
    build.status,
    0,
    `Failed to build compiled CLI executable.\nstdout:\n${build.stdout}\nstderr:\n${build.stderr}`
  );
  await access(cliBinaryPath, fsConstants.X_OK);
});

test.after(async () => {
  if (buildDir) {
    await rm(buildDir, { recursive: true, force: true });
  }
});

test(
  "compiled CLI supports --input + --state-file + --store-id with replayed context recall",
  { skip: !BUN_AVAILABLE },
  async () => {
    const tempDir = await mkdtemp(resolve(tmpdir(), "ums-cli-sfe-state-"));
    const stateFile = resolve(tempDir, "state.json");
    try {
      assert.ok(cliBinaryPath);
      const binaryPath = cliBinaryPath;
      const ingest = await runBinary(binaryPath, [
        "ingest",
        "--state-file",
        stateFile,
        "--store-id",
        "coding-agent",
        "--input",
        JSON.stringify({
          profile: "sfe-cli",
          events: [
            {
              type: "note",
              source: "sfe",
              content: "compiled binary ingest path",
            },
          ],
        }),
      ]);
      assert.equal((ingest as any).code, 0);
      const ingestBody = JSON.parse((ingest as any).stdout);
      assert.equal(ingestBody.ok, true);
      assert.equal(ingestBody.data.operation, "ingest");
      assert.equal(ingestBody.data.storeId, "coding-agent");

      const context = await runBinary(binaryPath, [
        "context",
        "--state-file",
        stateFile,
        "--store-id",
        "coding-agent",
        "--input",
        JSON.stringify({
          profile: "sfe-cli",
          query: "compiled binary ingest path",
        }),
      ]);
      assert.equal((context as any).code, 0);
      const contextBody = JSON.parse((context as any).stdout);
      assert.equal(contextBody.ok, true);
      assert.equal(contextBody.data.operation, "context");
      assert.equal(contextBody.data.matches.length, 1);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
);

test(
  "compiled CLI supports --file input and --pretty formatting",
  { skip: !BUN_AVAILABLE },
  async () => {
    const tempDir = await mkdtemp(resolve(tmpdir(), "ums-cli-sfe-file-"));
    const stateFile = resolve(tempDir, "state.json");
    const inputFile = resolve(tempDir, "ingest.json");
    try {
      await writeFile(
        inputFile,
        `${JSON.stringify({
          profile: "sfe-cli-file",
          events: [
            { type: "note", source: "fixture", content: "file payload" },
          ],
        })}\n`,
        "utf8"
      );
      assert.ok(cliBinaryPath);
      const binaryPath = cliBinaryPath;
      const ingest = await runBinary(binaryPath, [
        "ingest",
        "--state-file",
        stateFile,
        "--file",
        inputFile,
        "--pretty",
      ]);
      assert.equal((ingest as any).code, 0);
      assert.match((ingest as any).stdout, /\n {2}"ok": true,/);
      const ingestBody = JSON.parse((ingest as any).stdout);
      assert.equal(ingestBody.ok, true);
      assert.equal(ingestBody.data.accepted, 1);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
);

test(
  "compiled CLI supports stdin JSON input",
  { skip: !BUN_AVAILABLE },
  async () => {
    const tempDir = await mkdtemp(resolve(tmpdir(), "ums-cli-sfe-stdin-"));
    const stateFile = resolve(tempDir, "state.json");
    try {
      assert.ok(cliBinaryPath);
      const binaryPath = cliBinaryPath;
      const ingest = await runBinary(
        binaryPath,
        ["ingest", "--state-file", stateFile, "--store-id", "coding-agent"],
        {
          stdin: JSON.stringify({
            profile: "sfe-cli-stdin",
            events: [
              { type: "task", source: "stdin", content: "stdin payload path" },
            ],
          }),
        }
      );
      assert.equal((ingest as any).code, 0);
      const body = JSON.parse((ingest as any).stdout);
      assert.equal(body.ok, true);
      assert.equal(body.data.profile, "sfe-cli-stdin");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
);

test(
  "compiled CLI reports argument and operation errors deterministically",
  { skip: !BUN_AVAILABLE },
  async () => {
    const tempDir = await mkdtemp(resolve(tmpdir(), "ums-cli-sfe-errors-"));
    const stateFile = resolve(tempDir, "state.json");
    try {
      assert.ok(cliBinaryPath);
      const binaryPath = cliBinaryPath;
      const noOperation = await runBinary(binaryPath, []);
      assert.equal((noOperation as any).code, 1);
      assert.match((noOperation as any).stderr, /Usage:/);

      const unknownArgument = await runBinary(binaryPath, [
        "ingest",
        "--state-file",
        stateFile,
        "--wat",
        "{}",
      ]);
      assert.equal((unknownArgument as any).code, 1);
      const unknownArgumentBody = JSON.parse((unknownArgument as any).stderr);
      assert.equal(unknownArgumentBody.ok, false);
      assert.equal(unknownArgumentBody.error.code, "CLI_ERROR");
      assert.match(unknownArgumentBody.error.message, /Unknown argument/i);

      const unsupportedOperation = await runBinary(binaryPath, [
        "not_a_real_operation",
        "--state-file",
        stateFile,
        "--input",
        "{}",
      ]);
      assert.equal((unsupportedOperation as any).code, 1);
      const unsupportedBody = JSON.parse((unsupportedOperation as any).stderr);
      assert.equal(unsupportedBody.ok, false);
      assert.equal(unsupportedBody.error.code, "CLI_ERROR");
      assert.match(unsupportedBody.error.message, /Unsupported operation/i);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
);

test(
  "compiled CLI state file is created and reusable across invocations",
  { skip: !BUN_AVAILABLE },
  async () => {
    const tempDir = await mkdtemp(resolve(tmpdir(), "ums-cli-sfe-stateful-"));
    const stateFile = resolve(tempDir, "state.json");
    try {
      assert.ok(cliBinaryPath);
      const binaryPath = cliBinaryPath;
      const first = await runBinary(binaryPath, [
        "ingest",
        "--state-file",
        stateFile,
        "--input",
        JSON.stringify({
          profile: "sfe-cli-stateful",
          events: [{ type: "note", source: "sfe", content: "persist me" }],
        }),
      ]);
      assert.equal((first as any).code, 0);
      const persisted = JSON.parse(await readFile(stateFile, "utf8"));
      assert.ok(persisted.stores);

      const second = await runBinary(binaryPath, [
        "context",
        "--state-file",
        stateFile,
        "--input",
        JSON.stringify({
          profile: "sfe-cli-stateful",
          query: "persist me",
        }),
      ]);
      assert.equal((second as any).code, 0);
      const secondBody = JSON.parse((second as any).stdout);
      assert.equal(secondBody.data.matches.length, 1);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
);
