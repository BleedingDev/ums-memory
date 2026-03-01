import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const ROOT = process.cwd();
const BUN_AVAILABLE = spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0;

let buildDir = null;
let umsBinaryPath = null;

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

function startBinaryServer(binaryPath, args, { cwd = ROOT } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const proc = spawn(binaryPath, args, {
      cwd,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let resolved = false;
    const timeout = setTimeout(() => {
      if (resolved) {
        return;
      }
      proc.kill("SIGTERM");
      rejectPromise(new Error(`Timed out waiting for single binary API startup.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 8000);

    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      const match = stdout.match(/UMS API listening on http:\/\/([^\s:]+):(\d+)/);
      if (!match || resolved) {
        return;
      }
      resolved = true;
      clearTimeout(timeout);
      resolvePromise({
        proc,
        host: match[1],
        port: Number.parseInt(match[2], 10),
      });
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    proc.on("error", (error) => {
      if (!resolved) {
        clearTimeout(timeout);
        rejectPromise(error);
      }
    });
    proc.on("exit", (code) => {
      if (!resolved) {
        clearTimeout(timeout);
        rejectPromise(new Error(`Single binary exited before startup (code=${code}).\nstdout:\n${stdout}\nstderr:\n${stderr}`));
      }
    });
  });
}

async function stopBinaryServer(proc) {
  await new Promise((resolvePromise) => {
    proc.once("exit", () => resolvePromise());
    proc.kill("SIGTERM");
  });
}

test.before(async () => {
  if (!BUN_AVAILABLE) {
    return;
  }
  buildDir = await mkdtemp(resolve(tmpdir(), "ums-single-sfe-"));
  umsBinaryPath = resolve(buildDir, "ums");
  const build = spawnSync(
    "bun",
    [
      "build",
      "--compile",
      "--minify",
      "--sourcemap",
      "--bytecode",
      "apps/ums/src/index.mjs",
      "--outfile",
      umsBinaryPath,
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.equal(
    build.status,
    0,
    `Failed to build compiled single executable.\nstdout:\n${build.stdout}\nstderr:\n${build.stderr}`,
  );
  await access(umsBinaryPath, fsConstants.X_OK);
});

test.after(async () => {
  if (buildDir) {
    await rm(buildDir, { recursive: true, force: true });
  }
});

test(
  "compiled single executable runs CLI operations",
  { skip: !BUN_AVAILABLE },
  async () => {
    const tempDir = await mkdtemp(resolve(tmpdir(), "ums-single-cli-"));
    const stateFile = resolve(tempDir, "state.json");
    try {
      const ingest = await runBinary(umsBinaryPath, [
        "ingest",
        "--state-file",
        stateFile,
        "--store-id",
        "coding-agent",
        "--input",
        JSON.stringify({
          profile: "single-cli",
          events: [{ type: "note", source: "single", content: "single-binary-cli" }],
        }),
      ]);
      assert.equal(ingest.code, 0);
      const ingestBody = JSON.parse(ingest.stdout);
      assert.equal(ingestBody.ok, true);
      assert.equal(ingestBody.data.accepted, 1);

      const context = await runBinary(umsBinaryPath, [
        "context",
        "--state-file",
        stateFile,
        "--store-id",
        "coding-agent",
        "--input",
        JSON.stringify({ profile: "single-cli", query: "single-binary-cli" }),
      ]);
      assert.equal(context.code, 0);
      const contextBody = JSON.parse(context.stdout);
      assert.equal(contextBody.ok, true);
      assert.equal(contextBody.data.matches.length, 1);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  },
);

test(
  "compiled single executable runs API server mode via serve command",
  { skip: !BUN_AVAILABLE },
  async () => {
    const tempDir = await mkdtemp(resolve(tmpdir(), "ums-single-serve-"));
    const stateFile = resolve(tempDir, "state.json");
    const server = await startBinaryServer(umsBinaryPath, [
      "serve",
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--state-file",
      stateFile,
    ]);
    const base = `http://${server.host}:${server.port}`;
    try {
      const rootRes = await fetch(`${base}/`);
      assert.equal(rootRes.status, 200);
      const rootBody = await rootRes.json();
      assert.equal(rootBody.ok, true);

      const ingestRes = await fetch(`${base}/v1/ingest`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-ums-store": "coding-agent" },
        body: JSON.stringify({
          profile: "single-api",
          events: [{ type: "note", source: "single", content: "single-binary-api" }],
        }),
      });
      assert.equal(ingestRes.status, 200);
      const ingestBody = await ingestRes.json();
      assert.equal(ingestBody.ok, true);
      assert.equal(ingestBody.data.accepted, 1);
    } finally {
      await stopBinaryServer(server.proc);
      await rm(tempDir, { recursive: true, force: true });
    }
  },
);

test(
  "compiled single executable shares default .ums-state.json between CLI and serve",
  { skip: !BUN_AVAILABLE },
  async () => {
    const tempDir = await mkdtemp(resolve(tmpdir(), "ums-single-default-shared-"));
    const server = await startBinaryServer(umsBinaryPath, ["serve", "--host", "127.0.0.1", "--port", "0"], {
      cwd: tempDir,
    });
    const base = `http://${server.host}:${server.port}`;
    try {
      const cliIngest = await runBinary(
        umsBinaryPath,
        [
          "ingest",
          "--store-id",
          "coding-agent",
          "--input",
          JSON.stringify({
            profile: "single-default",
            events: [{ type: "note", source: "cli", content: "single-default-cli-event" }],
          }),
        ],
        { cwd: tempDir },
      );
      assert.equal(cliIngest.code, 0);

      const contextRes = await fetch(`${base}/v1/context`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-ums-store": "coding-agent" },
        body: JSON.stringify({
          profile: "single-default",
          query: "single-default-cli-event",
        }),
      });
      assert.equal(contextRes.status, 200);
      const contextBody = await contextRes.json();
      assert.equal(contextBody.ok, true);
      assert.equal(contextBody.data.matches.length, 1);
    } finally {
      await stopBinaryServer(server.proc);
      await rm(tempDir, { recursive: true, force: true });
    }
  },
);
