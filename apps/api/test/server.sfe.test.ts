import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterAll, beforeAll, test } from "@effect-native/bun-test";
const ROOT = process.cwd();
const BUN_AVAILABLE =
  spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0;
const testIfBunAvailable = BUN_AVAILABLE ? test : test.skip;

let buildDir: string | null = null;
let apiBinaryPath: string | null = null;

interface BinaryServerHandle {
  readonly proc: ChildProcess;
  readonly host: string;
  readonly port: number;
  readonly getLogs: () => { readonly stdout: string; readonly stderr: string };
}

interface JsonRequestOptions {
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string | null;
}

function startBinaryServer(
  binaryPath: string,
  envOverrides: NodeJS.ProcessEnv = {}
): Promise<BinaryServerHandle> {
  return new Promise<BinaryServerHandle>((resolvePromise, rejectPromise) => {
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
      rejectPromise(
        new Error(
          `Timed out waiting for compiled API server startup.\nstdout:\n${stdout}\nstderr:\n${stderr}`
        )
      );
    }, 8000);

    const onData = (chunk: any) => {
      stdout += chunk.toString("utf8");
      const match = stdout.match(
        /UMS API listening on http:\/\/([^\s:]+):(\d+)/
      );
      if (!match || resolved) {
        return;
      }
      const host = match[1];
      const portRaw = match[2];
      if (host === undefined || portRaw === undefined) {
        return;
      }
      resolved = true;
      clearTimeout(timeout);
      resolvePromise({
        proc,
        host,
        port: Number.parseInt(portRaw, 10),
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
          new Error(
            `Compiled API server exited before startup (code=${code}).\nstdout:\n${stdout}\nstderr:\n${stderr}`
          )
        );
      }
    });
  });
}

async function stopBinaryServer(proc: ChildProcess | undefined): Promise<void> {
  if (!proc) {
    return;
  }
  await new Promise<void>((resolvePromise) => {
    proc.once("exit", () => resolvePromise());
    proc.kill("SIGTERM");
  });
}

async function requestJson(
  url: string,
  { method = "GET", headers = {}, body = null }: JsonRequestOptions = {}
) {
  const requestInit: RequestInit = {
    method,
    headers,
  };
  if (body !== null && body !== undefined) {
    requestInit.body = body;
  }
  const response = await fetch(url, requestInit);
  const rawBody = await response.text();
  return {
    status: response.status,
    body: rawBody ? JSON.parse(rawBody) : null,
  };
}

beforeAll(async () => {
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
      "--format",
      "esm",
      "--minify",
      "--sourcemap",
      "--bytecode",
      "apps/api/src/server.ts",
      "--outfile",
      apiBinaryPath,
    ],
    { cwd: ROOT, encoding: "utf8" }
  );
  assert.equal(
    build.status,
    0,
    `Failed to build compiled API executable.\nstdout:\n${build.stdout}\nstderr:\n${build.stderr}`
  );
  await access(apiBinaryPath, fsConstants.X_OK);
});

afterAll(async () => {
  if (buildDir) {
    await rm(buildDir, { recursive: true, force: true });
  }
});

testIfBunAvailable(
  "compiled API executable serves root + ingest/context routes",
  async () => {
    const tempDir = await mkdtemp(resolve(tmpdir(), "ums-api-sfe-state-"));
    const stateFile = resolve(tempDir, "state.json");
    assert.ok(apiBinaryPath);
    const binaryPath = apiBinaryPath;
    const server = await startBinaryServer(binaryPath, {
      UMS_STATE_FILE: stateFile,
    });
    const base = `http://${(server as any).host}:${(server as any).port}`;
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
        headers: {
          "content-type": "application/json",
          "x-ums-store": "sfe-store",
        },
        body: JSON.stringify({
          profile: "sfe-api",
          events: [
            { type: "note", source: "sfe", content: "compiled api ingest" },
          ],
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
        headers: {
          "content-type": "application/json",
          "x-ums-store": "sfe-store",
        },
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
      await stopBinaryServer((server as any).proc);
      await rm(tempDir, { recursive: true, force: true });
    }
  }
);

testIfBunAvailable(
  "compiled API executable preserves deterministic error envelopes",
  async () => {
    const tempDir = await mkdtemp(resolve(tmpdir(), "ums-api-sfe-state-"));
    const stateFile = resolve(tempDir, "state.json");
    assert.ok(apiBinaryPath);
    const binaryPath = apiBinaryPath;
    const server = await startBinaryServer(binaryPath, {
      UMS_STATE_FILE: stateFile,
    });
    const base = `http://${(server as any).host}:${(server as any).port}`;
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
      await stopBinaryServer((server as any).proc);
      await rm(tempDir, { recursive: true, force: true });
    }
  }
);
