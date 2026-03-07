import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";

import { afterAll, beforeAll, test } from "@effect-native/bun-test";
import { Schema } from "effect";

const ROOT = process.cwd();
const SFE_TEMP_ROOT =
  process.env["UMS_SFE_TMP_DIR"] ??
  resolve(ROOT, ".tmp", "bun-test", "apps-api-server-sfe");
const BUN_AVAILABLE =
  spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0;
const testIfBunAvailable = BUN_AVAILABLE ? test : test.skip;

let buildDir: string | null = null;
let buildTempDir: string | null = null;
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

const ReadyFileSchema = Schema.Struct({
  host: Schema.optional(Schema.String),
  port: Schema.Number,
});

const RootResponseSchema = Schema.Struct({
  ok: Schema.Boolean,
  deterministic: Schema.Boolean,
  operations: Schema.Array(Schema.String),
});

const OperationResponseSchema = Schema.Struct({
  ok: Schema.Boolean,
  data: Schema.Struct({
    operation: Schema.String,
    storeId: Schema.optional(Schema.String),
    accepted: Schema.optional(Schema.Number),
    matches: Schema.optional(Schema.Array(Schema.Unknown)),
  }),
});

const ErrorResponseSchema = Schema.Struct({
  ok: Schema.Boolean,
  error: Schema.Struct({
    code: Schema.String,
  }),
});

const isReadyFile = Schema.is(ReadyFileSchema);
const isRootResponse = Schema.is(RootResponseSchema);
const isOperationResponse = Schema.is(OperationResponseSchema);
const isErrorResponse = Schema.is(ErrorResponseSchema);

function startBinaryServer(
  binaryPath: string,
  envOverrides: NodeJS.ProcessEnv = {}
): Promise<BinaryServerHandle> {
  return new Promise<BinaryServerHandle>((resolvePromise, rejectPromise) => {
    const host = "127.0.0.1";
    const readyFilePath = envOverrides["UMS_API_READY_FILE"];
    if (!readyFilePath || readyFilePath.length === 0) {
      rejectPromise(
        new Error("UMS_API_READY_FILE is required for SFE startup.")
      );
      return;
    }
    const proc = spawn(binaryPath, [], {
      cwd: ROOT,
      env: {
        ...process.env,
        UMS_API_HOST: host,
        UMS_API_PORT: envOverrides["UMS_API_PORT"] ?? "0",
        TMPDIR: SFE_TEMP_ROOT,
        TMP: SFE_TEMP_ROOT,
        TEMP: SFE_TEMP_ROOT,
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
      resolved = true;
      void stopBinaryServer(proc);
      rejectPromise(
        new Error(
          `Timed out waiting for compiled API server startup.\nstdout:\n${stdout}\nstderr:\n${stderr}`
        )
      );
    }, 8000);
    const onStdoutData = (chunk: any) => {
      stdout += chunk.toString("utf8");
    };
    proc.stdout.on("data", onStdoutData);
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
    void (async () => {
      while (!resolved) {
        if (proc.exitCode !== null) {
          return;
        }
        try {
          const readiness = JSON.parse(await readFile(readyFilePath, "utf8"));
          if (!isReadyFile(readiness) || !Number.isInteger(readiness.port)) {
            throw new Error("Ready file port is invalid.");
          }
          const readyHost =
            readiness.host && readiness.host.length > 0 ? readiness.host : host;
          const readyPort = readiness.port;
          const response = await fetch(`http://${readyHost}:${readyPort}/`);
          if (!resolved && response.ok) {
            resolved = true;
            clearTimeout(timeout);
            resolvePromise({
              proc,
              host: readyHost,
              port: readyPort,
              getLogs() {
                return { stdout, stderr };
              },
            });
            return;
          }
        } catch {}
        await Bun.sleep(50);
      }
    })();
  });
}

async function stopBinaryServer(proc: ChildProcess | undefined): Promise<void> {
  if (!proc) {
    return;
  }
  if (proc.exitCode !== null || proc.killed) {
    return;
  }
  await new Promise<void>((resolvePromise) => {
    const forceKillTimer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {}
    }, 1000);
    proc.once("exit", () => {
      clearTimeout(forceKillTimer);
      resolvePromise();
    });
    try {
      proc.kill("SIGTERM");
    } catch {
      clearTimeout(forceKillTimer);
      resolvePromise();
    }
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
  let parsedBody: unknown = null;
  if (rawBody) {
    try {
      parsedBody = JSON.parse(rawBody);
    } catch {
      parsedBody = rawBody;
    }
  }
  return {
    status: response.status,
    body: parsedBody,
    rawBody,
  };
}

beforeAll(async () => {
  if (!BUN_AVAILABLE) {
    return;
  }
  await mkdir(SFE_TEMP_ROOT, { recursive: true });
  buildTempDir = await mkdtemp(resolve(SFE_TEMP_ROOT, "ums-api-bun-build-"));
  buildDir = await mkdtemp(resolve(SFE_TEMP_ROOT, "ums-api-sfe-"));
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
    {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        TMPDIR: buildTempDir,
        TMP: buildTempDir,
        TEMP: buildTempDir,
      },
    }
  );
  assert.equal(
    build.status,
    0,
    `Failed to build compiled API executable.\nstdout:\n${build.stdout}\nstderr:\n${build.stderr}`
  );
  await access(apiBinaryPath, fsConstants.X_OK);
});

afterAll(async () => {
  await Promise.allSettled(
    [buildDir, buildTempDir, SFE_TEMP_ROOT]
      .filter((path): path is string => typeof path === "string")
      .map((path) => rm(path, { recursive: true, force: true }))
  );
});

testIfBunAvailable(
  "compiled API executable serves root + ingest/context routes",
  async () => {
    const tempDir = await mkdtemp(resolve(SFE_TEMP_ROOT, "ums-api-sfe-state-"));
    const stateFile = resolve(tempDir, "state.json");
    const readyFilePath = resolve(tempDir, "ready.json");
    let server: BinaryServerHandle | undefined;
    try {
      assert.ok(apiBinaryPath);
      const binaryPath = apiBinaryPath;
      server = await startBinaryServer(binaryPath, {
        UMS_STATE_FILE: stateFile,
        UMS_API_READY_FILE: readyFilePath,
        TMPDIR: tempDir,
        TMP: tempDir,
        TEMP: tempDir,
      });
      const base = `http://${server.host}:${server.port}`;
      const rootRes = await requestJson(`${base}/`);
      assert.equal(rootRes.status, 200);
      const rootBody = rootRes.body;
      assert.equal(isRootResponse(rootBody), true);
      if (!isRootResponse(rootBody)) {
        return;
      }
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
      assert.equal(isOperationResponse(ingestBody), true);
      if (!isOperationResponse(ingestBody)) {
        return;
      }
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
      assert.equal(isOperationResponse(contextBody), true);
      if (!isOperationResponse(contextBody)) {
        return;
      }
      assert.equal(contextBody.ok, true);
      assert.equal(contextBody.data.operation, "context");
      assert.equal(contextBody.data.matches?.length, 1);
    } finally {
      await stopBinaryServer(server?.proc);
      await rm(tempDir, { recursive: true, force: true });
    }
  }
);

testIfBunAvailable(
  "compiled API executable preserves deterministic error envelopes",
  async () => {
    const tempDir = await mkdtemp(resolve(SFE_TEMP_ROOT, "ums-api-sfe-state-"));
    const stateFile = resolve(tempDir, "state.json");
    const readyFilePath = resolve(tempDir, "ready.json");
    let server: BinaryServerHandle | undefined;
    try {
      assert.ok(apiBinaryPath);
      const binaryPath = apiBinaryPath;
      server = await startBinaryServer(binaryPath, {
        UMS_STATE_FILE: stateFile,
        UMS_API_READY_FILE: readyFilePath,
        TMPDIR: tempDir,
        TMP: tempDir,
        TEMP: tempDir,
      });
      const base = `http://${server.host}:${server.port}`;
      const notFound = await requestJson(`${base}/v1/not-real`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(notFound.status, 404);
      const notFoundBody = notFound.body;
      assert.equal(isErrorResponse(notFoundBody), true);
      if (!isErrorResponse(notFoundBody)) {
        return;
      }
      assert.equal(notFoundBody.ok, false);
      assert.equal(notFoundBody.error.code, "UNSUPPORTED_OPERATION");

      const badJson = await requestJson(`${base}/v1/ingest`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{bad",
      });
      assert.equal(badJson.status, 400);
      const badJsonBody = badJson.body;
      assert.equal(isErrorResponse(badJsonBody), true);
      if (!isErrorResponse(badJsonBody)) {
        return;
      }
      assert.equal(badJsonBody.ok, false);
      assert.equal(badJsonBody.error.code, "INVALID_JSON");
    } finally {
      await stopBinaryServer(server?.proc);
      await rm(tempDir, { recursive: true, force: true });
    }
  }
);
