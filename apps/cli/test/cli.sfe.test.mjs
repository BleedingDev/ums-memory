import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const ROOT = process.cwd();
const BUN_AVAILABLE = spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0;

let buildDir = null;
let cliBinaryPath = null;

function runBinary(binaryPath, args, { stdin = "", cwd = ROOT } = {}) {
  return new Promise((resolvePromise) => {
    const proc = spawn(binaryPath, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    proc.stderr.on("data", (chunk) => {
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
      "--minify",
      "--sourcemap",
      "--bytecode",
      "apps/cli/src/index.mjs",
      "--outfile",
      cliBinaryPath,
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.equal(
    build.status,
    0,
    `Failed to build compiled CLI executable.\nstdout:\n${build.stdout}\nstderr:\n${build.stderr}`,
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
      const ingest = await runBinary(cliBinaryPath, [
        "ingest",
        "--state-file",
        stateFile,
        "--store-id",
        "coding-agent",
        "--input",
        JSON.stringify({
          profile: "sfe-cli",
          events: [{ type: "note", source: "sfe", content: "compiled binary ingest path" }],
        }),
      ]);
      assert.equal(ingest.code, 0);
      const ingestBody = JSON.parse(ingest.stdout);
      assert.equal(ingestBody.ok, true);
      assert.equal(ingestBody.data.operation, "ingest");
      assert.equal(ingestBody.data.storeId, "coding-agent");

      const context = await runBinary(cliBinaryPath, [
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
      assert.equal(context.code, 0);
      const contextBody = JSON.parse(context.stdout);
      assert.equal(contextBody.ok, true);
      assert.equal(contextBody.data.operation, "context");
      assert.equal(contextBody.data.matches.length, 1);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  },
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
          events: [{ type: "note", source: "fixture", content: "file payload" }],
        })}\n`,
        "utf8",
      );
      const ingest = await runBinary(cliBinaryPath, [
        "ingest",
        "--state-file",
        stateFile,
        "--file",
        inputFile,
        "--pretty",
      ]);
      assert.equal(ingest.code, 0);
      assert.match(ingest.stdout, /\n  "ok": true,/);
      const ingestBody = JSON.parse(ingest.stdout);
      assert.equal(ingestBody.ok, true);
      assert.equal(ingestBody.data.accepted, 1);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  },
);

test(
  "compiled CLI supports stdin JSON input",
  { skip: !BUN_AVAILABLE },
  async () => {
    const tempDir = await mkdtemp(resolve(tmpdir(), "ums-cli-sfe-stdin-"));
    const stateFile = resolve(tempDir, "state.json");
    try {
      const ingest = await runBinary(
        cliBinaryPath,
        ["ingest", "--state-file", stateFile, "--store-id", "coding-agent"],
        {
          stdin: JSON.stringify({
            profile: "sfe-cli-stdin",
            events: [{ type: "task", source: "stdin", content: "stdin payload path" }],
          }),
        },
      );
      assert.equal(ingest.code, 0);
      const body = JSON.parse(ingest.stdout);
      assert.equal(body.ok, true);
      assert.equal(body.data.profile, "sfe-cli-stdin");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  },
);

test(
  "compiled CLI reports argument and operation errors deterministically",
  { skip: !BUN_AVAILABLE },
  async () => {
    const tempDir = await mkdtemp(resolve(tmpdir(), "ums-cli-sfe-errors-"));
    const stateFile = resolve(tempDir, "state.json");
    try {
      const noOperation = await runBinary(cliBinaryPath, []);
      assert.equal(noOperation.code, 1);
      assert.match(noOperation.stderr, /Usage:/);

      const unknownArgument = await runBinary(cliBinaryPath, [
        "ingest",
        "--state-file",
        stateFile,
        "--wat",
        "{}",
      ]);
      assert.equal(unknownArgument.code, 1);
      const unknownArgumentBody = JSON.parse(unknownArgument.stderr);
      assert.equal(unknownArgumentBody.ok, false);
      assert.equal(unknownArgumentBody.error.code, "CLI_ERROR");
      assert.match(unknownArgumentBody.error.message, /Unknown argument/i);

      const unsupportedOperation = await runBinary(cliBinaryPath, [
        "not_a_real_operation",
        "--state-file",
        stateFile,
        "--input",
        "{}",
      ]);
      assert.equal(unsupportedOperation.code, 1);
      const unsupportedBody = JSON.parse(unsupportedOperation.stderr);
      assert.equal(unsupportedBody.ok, false);
      assert.equal(unsupportedBody.error.code, "CLI_ERROR");
      assert.match(unsupportedBody.error.message, /Unsupported operation/i);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  },
);

test(
  "compiled CLI state file is created and reusable across invocations",
  { skip: !BUN_AVAILABLE },
  async () => {
    const tempDir = await mkdtemp(resolve(tmpdir(), "ums-cli-sfe-stateful-"));
    const stateFile = resolve(tempDir, "state.json");
    try {
      const first = await runBinary(cliBinaryPath, [
        "ingest",
        "--state-file",
        stateFile,
        "--input",
        JSON.stringify({
          profile: "sfe-cli-stateful",
          events: [{ type: "note", source: "sfe", content: "persist me" }],
        }),
      ]);
      assert.equal(first.code, 0);
      const persisted = JSON.parse(await readFile(stateFile, "utf8"));
      assert.ok(persisted.stores);

      const second = await runBinary(cliBinaryPath, [
        "context",
        "--state-file",
        stateFile,
        "--input",
        JSON.stringify({
          profile: "sfe-cli-stateful",
          query: "persist me",
        }),
      ]);
      assert.equal(second.code, 0);
      const secondBody = JSON.parse(second.stdout);
      assert.equal(secondBody.data.matches.length, 1);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  },
);
