import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const ROOT = process.cwd();
const CLI_PATH = resolve(ROOT, "apps/cli/src/index.mjs");
const API_PATH = resolve(ROOT, "apps/api/src/server.mjs");

function cleanSharedStateEnv() {
  const env = { ...process.env };
  delete env.UMS_STATE_FILE;
  delete env.UMS_CLI_STATE_FILE;
  return env;
}

function runNode(scriptPath, args, { cwd, env, stdin = "" }) {
  return new Promise((resolvePromise) => {
    const proc = spawn(process.execPath, [scriptPath, ...args], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
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

function startSourceApiServer({ cwd, env }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const proc = spawn(process.execPath, [API_PATH], {
      cwd,
      env: {
        ...env,
        UMS_API_HOST: "127.0.0.1",
        UMS_API_PORT: "0",
      },
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
      rejectPromise(new Error(`Timed out waiting for API startup.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
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
        rejectPromise(
          new Error(`API exited before startup (code=${code}).\nstdout:\n${stdout}\nstderr:\n${stderr}`),
        );
      }
    });
  });
}

async function stopSourceApiServer(proc) {
  await new Promise((resolvePromise) => {
    proc.once("exit", () => resolvePromise());
    proc.kill("SIGTERM");
  });
}

test("cli and api default to the same .ums-state.json file without env overrides", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "ums-default-shared-state-"));
  const env = cleanSharedStateEnv();
  const sharedStatePath = resolve(tempDir, ".ums-state.json");

  try {
    const cliIngest = await runNode(
      CLI_PATH,
      [
        "ingest",
        "--store-id",
        "coding-agent",
        "--input",
        JSON.stringify({
          profile: "default-shared-state",
          events: [{ type: "note", source: "cli", content: "default-shared-event-from-cli" }],
        }),
      ],
      { cwd: tempDir, env },
    );
    assert.equal(cliIngest.code, 0, `cli ingest failed: ${cliIngest.stderr}`);

    const firstSnapshot = JSON.parse(await readFile(sharedStatePath, "utf8"));
    assert.ok(firstSnapshot && typeof firstSnapshot === "object");
    assert.ok(firstSnapshot.stores);

    const server = await startSourceApiServer({ cwd: tempDir, env });
    const base = `http://${server.host}:${server.port}`;

    try {
      const contextResponse = await fetch(`${base}/v1/context`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-ums-store": "coding-agent",
        },
        body: JSON.stringify({
          profile: "default-shared-state",
          query: "default-shared-event-from-cli",
        }),
      });
      assert.equal(contextResponse.status, 200);
      const contextBody = await contextResponse.json();
      assert.equal(contextBody.ok, true);
      assert.equal(contextBody.data.matches.length, 1);

      const apiIngestResponse = await fetch(`${base}/v1/ingest`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-ums-store": "coding-agent",
        },
        body: JSON.stringify({
          profile: "default-shared-state",
          events: [{ type: "note", source: "api", content: "default-shared-event-from-api" }],
        }),
      });
      assert.equal(apiIngestResponse.status, 200);
      const apiIngestBody = await apiIngestResponse.json();
      assert.equal(apiIngestBody.ok, true);
      assert.equal(apiIngestBody.data.accepted, 1);
    } finally {
      await stopSourceApiServer(server.proc);
    }

    const cliContext = await runNode(
      CLI_PATH,
      [
        "context",
        "--store-id",
        "coding-agent",
        "--input",
        JSON.stringify({
          profile: "default-shared-state",
          query: "default-shared-event-from-api",
        }),
      ],
      { cwd: tempDir, env },
    );
    assert.equal(cliContext.code, 0, `cli context failed: ${cliContext.stderr}`);
    const cliContextBody = JSON.parse(cliContext.stdout);
    assert.equal(cliContextBody.ok, true);
    assert.equal(cliContextBody.data.matches.length, 1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
