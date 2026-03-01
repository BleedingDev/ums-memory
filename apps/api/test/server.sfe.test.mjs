import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const ROOT = process.cwd();
const BUN_AVAILABLE = spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0;
const CURL_AVAILABLE = spawnSync("curl", ["--version"], { encoding: "utf8" }).status === 0;

let buildDir = null;
let apiBinaryPath = null;

function startBinaryServer(binaryPath, envOverrides = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const proc = spawn(binaryPath, [], {
      cwd: ROOT,
      env: {
        ...process.env,
        UMS_API_HOST: "127.0.0.1",
        UMS_API_PORT: "0",
        ...envOverrides,
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
      rejectPromise(new Error(`Timed out waiting for compiled API server startup.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 8000);

    const onData = (chunk) => {
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
        getLogs() {
          return { stdout, stderr };
        },
      });
    };
    proc.stdout.on("data", onData);
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
          new Error(`Compiled API server exited before startup (code=${code}).\nstdout:\n${stdout}\nstderr:\n${stderr}`),
        );
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

function requestJson(url, { method = "GET", headers = {}, body = null } = {}) {
  const args = ["-sS", "-X", method];
  for (const [key, value] of Object.entries(headers)) {
    args.push("-H", `${key}: ${value}`);
  }
  if (body !== null && body !== undefined) {
    args.push("--data", body);
  }
  args.push("-w", "\n%{http_code}", url);
  const result = spawnSync("curl", args, { cwd: ROOT, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`curl request failed (status=${result.status}): ${result.stderr || result.stdout}`);
  }
  const output = result.stdout ?? "";
  const newlineIndex = output.lastIndexOf("\n");
  const rawBody = newlineIndex >= 0 ? output.slice(0, newlineIndex) : "";
  const statusCodeRaw = newlineIndex >= 0 ? output.slice(newlineIndex + 1).trim() : "0";
  const status = Number.parseInt(statusCodeRaw, 10);
  return {
    status: Number.isFinite(status) ? status : 0,
    body: rawBody ? JSON.parse(rawBody) : null,
  };
}

test.before(async () => {
  if (!BUN_AVAILABLE) {
    return;
  }
  buildDir = await mkdtemp(resolve(tmpdir(), "ums-api-sfe-"));
  apiBinaryPath = resolve(buildDir, "ums-api");
  const build = spawnSync(
    "bun",
    [
      "build",
      "--compile",
      "--minify",
      "--sourcemap",
      "--bytecode",
      "apps/api/src/server.mjs",
      "--outfile",
      apiBinaryPath,
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.equal(
    build.status,
    0,
    `Failed to build compiled API executable.\nstdout:\n${build.stdout}\nstderr:\n${build.stderr}`,
  );
  await access(apiBinaryPath, fsConstants.X_OK);
});

test.after(async () => {
  if (buildDir) {
    await rm(buildDir, { recursive: true, force: true });
  }
});

test(
  "compiled API executable serves root + ingest/context routes",
  { skip: !BUN_AVAILABLE || !CURL_AVAILABLE },
  async () => {
    const server = await startBinaryServer(apiBinaryPath);
    const base = `http://${server.host}:${server.port}`;
    try {
      const rootRes = await requestJson(`${base}/`);
      assert.equal(rootRes.status, 200);
      const rootBody = rootRes.body;
      assert.equal(rootBody.ok, true);
      assert.equal(rootBody.deterministic, true);
      assert.equal(Array.isArray(rootBody.operations), true);
      assert.equal(rootBody.operations.includes("/v1/ingest"), true);
      assert.equal(rootBody.operations.includes("/v1/context"), true);

      const ingestRes = await requestJson(`${base}/v1/ingest`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-ums-store": "sfe-store" },
        body: JSON.stringify({
          profile: "sfe-api",
          events: [{ type: "note", source: "sfe", content: "compiled api ingest" }],
        }),
      });
      assert.equal(ingestRes.status, 200);
      const ingestBody = ingestRes.body;
      assert.equal(ingestBody.ok, true);
      assert.equal(ingestBody.data.operation, "ingest");
      assert.equal(ingestBody.data.storeId, "sfe-store");
      assert.equal(ingestBody.data.accepted, 1);

      const contextRes = await requestJson(`${base}/v1/context`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-ums-store": "sfe-store" },
        body: JSON.stringify({
          profile: "sfe-api",
          query: "compiled api ingest",
        }),
      });
      assert.equal(contextRes.status, 200);
      const contextBody = contextRes.body;
      assert.equal(contextBody.ok, true);
      assert.equal(contextBody.data.operation, "context");
      assert.equal(contextBody.data.matches.length, 1);
    } finally {
      await stopBinaryServer(server.proc);
    }
  },
);

test(
  "compiled API executable preserves deterministic error envelopes",
  { skip: !BUN_AVAILABLE || !CURL_AVAILABLE },
  async () => {
    const server = await startBinaryServer(apiBinaryPath);
    const base = `http://${server.host}:${server.port}`;
    try {
      const notFound = await requestJson(`${base}/v1/not-real`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(notFound.status, 404);
      const notFoundBody = notFound.body;
      assert.equal(notFoundBody.ok, false);
      assert.equal(notFoundBody.error.code, "UNSUPPORTED_OPERATION");

      const badJson = await requestJson(`${base}/v1/ingest`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{bad",
      });
      assert.equal(badJson.status, 400);
      const badJsonBody = badJson.body;
      assert.equal(badJsonBody.ok, false);
      assert.equal(badJsonBody.error.code, "INVALID_JSON");
    } finally {
      await stopBinaryServer(server.proc);
    }
  },
);
