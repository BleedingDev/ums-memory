import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterAll, beforeEach, test } from "@effect-native/bun-test";
import { Layer, Schema } from "effect";

import { executeOperation, listOperations, resetStore } from "../src/core.ts";
import {
  RuntimeServiceTag,
  DEFAULT_RUNTIME_STATE_FILE,
  clearRuntimeServiceCache,
  executeRuntimeOperation,
  loadRuntimeStoreSnapshot,
  listRuntimeOperations,
} from "../src/runtime-service.ts";
import { startApiServer } from "../src/server.ts";

const CLI_PATH = resolve(process.cwd(), "apps/cli/src/index.ts");
const RUNTIME_SERVICE_FIXTURE = resolve(
  process.cwd(),
  "apps/api/test/fixtures/runtime-service-override.ts"
);
const POLICY_PACK_PLUGIN_FIXTURE = resolve(
  process.cwd(),
  "apps/api/test/fixtures/policy-pack-plugin-override.ts"
);
const ORIGINAL_RUNTIME_SERVICE_MODULE =
  process.env["UMS_RUNTIME_SERVICE_MODULE"];
const ORIGINAL_RUNTIME_SERVICE_EXPORT =
  process.env["UMS_RUNTIME_SERVICE_EXPORT"];
const ORIGINAL_POLICY_PACK_PLUGIN_MODULE =
  process.env["UMS_POLICY_PACK_PLUGIN_MODULE"];
const ORIGINAL_POLICY_PACK_PLUGIN_EXPORT =
  process.env["UMS_POLICY_PACK_PLUGIN_EXPORT"];
const isUnknownRecord = Schema.is(Schema.Record(Schema.String, Schema.Unknown));
const isString = Schema.is(Schema.String);

function runCli(args: any, stdin = "", { env = process.env } = {}) {
  return new Promise((resolvePromise) => {
    const proc = spawn(process.execPath, [CLI_PATH, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
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

function useDefaultRuntimeService() {
  delete process.env["UMS_RUNTIME_SERVICE_MODULE"];
  delete process.env["UMS_RUNTIME_SERVICE_EXPORT"];
  delete process.env["UMS_POLICY_PACK_PLUGIN_MODULE"];
  delete process.env["UMS_POLICY_PACK_PLUGIN_EXPORT"];
  clearRuntimeServiceCache();
}

function useFixtureRuntimeService() {
  process.env["UMS_RUNTIME_SERVICE_MODULE"] = RUNTIME_SERVICE_FIXTURE;
  process.env["UMS_RUNTIME_SERVICE_EXPORT"] =
    "createDeterministicRuntimeService";
  clearRuntimeServiceCache();
}

beforeEach(() => {
  resetStore();
  useDefaultRuntimeService();
});

afterAll(() => {
  if (ORIGINAL_RUNTIME_SERVICE_MODULE) {
    process.env["UMS_RUNTIME_SERVICE_MODULE"] = ORIGINAL_RUNTIME_SERVICE_MODULE;
  } else {
    delete process.env["UMS_RUNTIME_SERVICE_MODULE"];
  }
  if (ORIGINAL_RUNTIME_SERVICE_EXPORT) {
    process.env["UMS_RUNTIME_SERVICE_EXPORT"] = ORIGINAL_RUNTIME_SERVICE_EXPORT;
  } else {
    delete process.env["UMS_RUNTIME_SERVICE_EXPORT"];
  }
  if (ORIGINAL_POLICY_PACK_PLUGIN_MODULE) {
    process.env["UMS_POLICY_PACK_PLUGIN_MODULE"] =
      ORIGINAL_POLICY_PACK_PLUGIN_MODULE;
  } else {
    delete process.env["UMS_POLICY_PACK_PLUGIN_MODULE"];
  }
  if (ORIGINAL_POLICY_PACK_PLUGIN_EXPORT) {
    process.env["UMS_POLICY_PACK_PLUGIN_EXPORT"] =
      ORIGINAL_POLICY_PACK_PLUGIN_EXPORT;
  } else {
    delete process.env["UMS_POLICY_PACK_PLUGIN_EXPORT"];
  }
  clearRuntimeServiceCache();
  resetStore();
});

test("runtime service default path stays compatible with effect core + persistence wiring", async () => {
  const requestBody = {
    profile: "runtime-service-default",
    events: [{ type: "note", source: "test", content: "effect compatibility" }],
  };

  const expectedOperations = listOperations();
  const serviceOperations = await listRuntimeOperations();
  assert.deepEqual(serviceOperations, expectedOperations);

  resetStore();
  const serviceResult = await executeRuntimeOperation({
    operation: "ingest",
    requestBody: structuredClone(requestBody),
    stateFile: null,
  });

  resetStore();
  const directResult = executeOperation("ingest", structuredClone(requestBody));

  assert.deepEqual(serviceResult, directResult);
});

test("default runtime service uses dedicated runtime state files instead of the legacy shared JSON path", async () => {
  const tempDir = await mkdtemp(
    resolve(tmpdir(), "ums-runtime-service-persistence-")
  );
  const stateFile = resolve(tempDir, "runtime-state");

  try {
    const ingest = await executeRuntimeOperation({
      operation: "ingest",
      requestBody: {
        profile: "runtime-service-sidecar",
        events: [
          {
            type: "note",
            source: "runtime-service",
            content: "sqlite sidecar event",
          },
        ],
      },
      stateFile,
    });
    assert.equal((ingest as { accepted?: unknown }).accepted, 1);

    await writeFile(
      resolve(tempDir, ".ums-state.json"),
      "{not-valid-json",
      "utf8"
    );

    const context = await executeRuntimeOperation({
      operation: "context",
      requestBody: {
        profile: "runtime-service-sidecar",
        query: "sqlite sidecar event",
      },
      stateFile,
    });

    assert.equal((context as { matches?: unknown[] }).matches?.length, 1);
    const snapshot = await loadRuntimeStoreSnapshot({ stateFile });
    assert.match(JSON.stringify(snapshot), /sqlite sidecar event/);
    await assert.rejects(access(`${stateFile}.json`));
    assert.equal(
      (await readFile(`${stateFile}.sqlite`)).subarray(0, 15).toString("utf8"),
      "SQLite format 3"
    );
  } finally {
    clearRuntimeServiceCache();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("default runtime state path no longer falls back to legacy shared JSON without explicit env override", () => {
  assert.equal(DEFAULT_RUNTIME_STATE_FILE, ".ums-runtime-state");
});

test("explicit legacy .ums-state.json paths stay on shared-state compatibility mode", async () => {
  const tempDir = await mkdtemp(
    resolve(tmpdir(), "ums-runtime-service-json-compat-")
  );
  const stateFile = resolve(tempDir, ".ums-state.json");

  try {
    const ingest = await executeRuntimeOperation({
      operation: "ingest",
      requestBody: {
        profile: "runtime-service-json-compat",
        events: [
          {
            type: "note",
            source: "runtime-service",
            content: "explicit json compatibility event",
          },
        ],
      },
      stateFile,
    });
    assert.equal((ingest as { accepted?: unknown }).accepted, 1);

    const context = await executeRuntimeOperation({
      operation: "context",
      requestBody: {
        profile: "runtime-service-json-compat",
        query: "explicit json compatibility event",
      },
      stateFile,
    });

    assert.equal((context as { matches?: unknown[] }).matches?.length, 1);
    const snapshot = await loadRuntimeStoreSnapshot({ stateFile });
    assert.match(JSON.stringify(snapshot), /explicit json compatibility event/);
    await assert.rejects(access(`${stateFile}.sqlite`));
  } finally {
    clearRuntimeServiceCache();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("arbitrary json runtime state paths still use sqlite-backed persistence", async () => {
  const tempDir = await mkdtemp(
    resolve(tmpdir(), "ums-runtime-service-arbitrary-json-")
  );
  const stateFile = resolve(tempDir, "worker-state.json");

  try {
    const ingest = await executeRuntimeOperation({
      operation: "ingest",
      requestBody: {
        profile: "runtime-service-arbitrary-json",
        events: [
          {
            type: "note",
            source: "runtime-service",
            content: "arbitrary json sqlite event",
          },
        ],
      },
      stateFile,
    });
    assert.equal((ingest as { accepted?: unknown }).accepted, 1);

    await writeFile(stateFile, "{not-valid-json", "utf8");

    const context = await executeRuntimeOperation({
      operation: "context",
      requestBody: {
        profile: "runtime-service-arbitrary-json",
        query: "arbitrary json sqlite event",
      },
      stateFile,
    });

    assert.equal((context as { matches?: unknown[] }).matches?.length, 1);
    await access(`${stateFile}.sqlite`);
    assert.equal(
      (await readFile(`${stateFile}.sqlite`)).subarray(0, 15).toString("utf8"),
      "SQLite format 3"
    );
  } finally {
    clearRuntimeServiceCache();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("runtime service module override resolves deterministic contract behavior", async () => {
  useFixtureRuntimeService();

  const operations = await listRuntimeOperations();
  assert.deepEqual(operations, ["context", "ingest"]);

  const requestBody = {
    profile: "runtime-service-override",
    query: "deterministic",
  };

  const first = await executeRuntimeOperation({
    operation: "context",
    requestBody: structuredClone(requestBody),
    stateFile: "/tmp/custom-state.json",
  });
  const second = await executeRuntimeOperation({
    operation: "context",
    requestBody: structuredClone(requestBody),
    stateFile: "/tmp/custom-state.json",
  });

  assert.equal(
    (first as any).runtimeServiceId,
    "deterministic-runtime-service"
  );
  assert.deepEqual(first, second);
});

test("runtime service supports direct Layer override without env module loading", async () => {
  const runtimeLayer = Layer.succeed(RuntimeServiceTag, {
    source: "runtime-layer-override",
    listOperations: () => ["context"],
    executeOperation: async ({
      operation,
      requestBody,
      stateFile,
    }: {
      operation: string;
      requestBody?: unknown;
      stateFile?: string | null;
    }) => ({
      operation,
      requestBody: isUnknownRecord(requestBody) ? requestBody : {},
      stateFile: isString(stateFile) ? stateFile : null,
      runtimeServiceId: "runtime-layer-override",
    }),
  });

  const operations = await listRuntimeOperations({ runtimeLayer });
  assert.deepEqual(operations, ["context"]);

  const result = await executeRuntimeOperation({
    operation: "context",
    requestBody: { query: "layer-override" },
    stateFile: null,
    runtimeLayer,
  });
  assert.equal(
    (result as { runtimeServiceId?: unknown }).runtimeServiceId,
    "runtime-layer-override"
  );
});

test("default runtime service can load policy pack plugins from env module", async () => {
  useDefaultRuntimeService();
  const env = {
    ...process.env,
    UMS_POLICY_PACK_PLUGIN_MODULE: POLICY_PACK_PLUGIN_FIXTURE,
    UMS_POLICY_PACK_PLUGIN_EXPORT: "createPolicyPackPlugin",
  };
  const requestBody = {
    storeId: "tenant-runtime-policy-pack",
    profile: "learner-runtime-policy-pack",
    decisionId: "pol-runtime-policy-pack-1",
    policyKey: "plugin-fixture-deny",
    outcome: "review",
    reasonCodes: ["insufficient-evidence"],
    provenanceEventIds: ["evt-runtime-policy-pack-1"],
    timestamp: "2026-03-02T21:00:00.000Z",
  };

  const first = await executeRuntimeOperation({
    operation: "policy_decision_update",
    requestBody: structuredClone(requestBody),
    stateFile: null,
    env,
    reload: true,
  });
  const replay = await executeRuntimeOperation({
    operation: "policy_decision_update",
    requestBody: structuredClone(requestBody),
    stateFile: null,
    env,
  });

  assert.equal((first as any).action, "created");
  assert.equal((first as any).decision.outcome, "deny");
  assert.equal(
    (first as any).decision.reasonCodes.includes("fixture-plugin-deny"),
    true
  );
  assert.equal(
    (first as any).decision.metadata.policyPackPlugin.pluginName,
    "fixture-policy-pack-plugin"
  );
  assert.equal(
    (first as any).decision.metadata.policyPackPlugin.status,
    "executed"
  );
  assert.equal((replay as any).action, "noop");
  assert.equal((replay as any).decisionDigest, (first as any).decisionDigest);
});

test("api server routes through runtime service override for list + operation execution", async () => {
  useFixtureRuntimeService();
  const { server, host } = await startApiServer({
    host: "127.0.0.1",
    port: 0,
    stateFile: null,
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://${host}:${address.port}`;

  try {
    const root = await fetch(`${base}/`);
    assert.equal(root.status, 200);
    const rootBody = await root.json();
    assert.deepEqual(rootBody.operations, ["/v1/context", "/v1/ingest"]);

    const first = await fetch(`${base}/v1/context`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-ums-store": "runtime-tenant",
      },
      body: JSON.stringify({
        profile: "runtime-service-http",
        query: "deterministic",
      }),
    });
    assert.equal(first.status, 200);
    const firstBody = await first.json();
    assert.equal(firstBody.ok, true);
    assert.equal(
      firstBody.data.runtimeServiceId,
      "deterministic-runtime-service"
    );
    assert.equal(firstBody.data.request.storeId, "runtime-tenant");

    const second = await fetch(`${base}/v1/context`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-ums-store": "runtime-tenant",
      },
      body: JSON.stringify({
        profile: "runtime-service-http",
        query: "deterministic",
      }),
    });
    const secondBody = await second.json();
    assert.equal(secondBody.ok, true);
    assert.equal(secondBody.data.requestDigest, firstBody.data.requestDigest);
  } finally {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      server.close((error) =>
        error ? rejectPromise(error) : resolvePromise()
      );
    });
  }
});

test("cli routes through runtime-service overrides while explicit legacy shared-state compat remains opt-in", async () => {
  const env = {
    ...process.env,
    UMS_RUNTIME_SERVICE_MODULE: RUNTIME_SERVICE_FIXTURE,
    UMS_RUNTIME_SERVICE_EXPORT: "createDeterministicRuntimeService",
  };
  const tempDir = await mkdtemp(resolve(tmpdir(), "ums-runtime-service-cli-"));
  const stateFile = resolve(tempDir, "cli-state.json");
  try {
    const ingest = await runCli(
      [
        "ingest",
        "--state-file",
        stateFile,
        "--input",
        JSON.stringify({
          profile: "runtime-service-cli",
          events: [
            {
              type: "note",
              source: "cli",
              content: "deterministic shared state",
            },
          ],
        }),
      ],
      "",
      { env }
    );
    assert.equal((ingest as any).code, 0, (ingest as any).stderr);

    const args = [
      "context",
      "--state-file",
      stateFile,
      "--input",
      JSON.stringify({
        profile: "runtime-service-cli",
        query: "deterministic",
      }),
    ];

    const first = await runCli(args, "", { env });
    assert.equal((first as any).code, 0, (first as any).stderr);
    const firstBody = JSON.parse((first as any).stdout);
    assert.equal(firstBody.ok, true);
    assert.equal(
      firstBody.data.runtimeServiceId,
      "deterministic-runtime-service"
    );
    assert.equal(firstBody.data.request.stateFile, undefined);
    assert.equal(firstBody.data.request.profile, "runtime-service-cli");

    const second = await runCli(args, "", { env });
    assert.equal((second as any).code, 0, (second as any).stderr);
    const secondBody = JSON.parse((second as any).stdout);
    assert.equal(secondBody.ok, true);
    assert.equal(
      secondBody.data.runtimeServiceId,
      "deterministic-runtime-service"
    );
    assert.equal(secondBody.data.requestDigest, firstBody.data.requestDigest);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
