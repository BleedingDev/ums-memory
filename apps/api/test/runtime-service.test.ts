import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

import { Layer } from "effect";

import { executeOperation, listOperations, resetStore } from "../src/core.ts";
import { executeOperationWithSharedState } from "../src/persistence.ts";
import {
  RuntimeServiceTag,
  clearRuntimeServiceCache,
  executeRuntimeOperation,
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

function runCli(args: any, stdin = "", { env = process.env } = {}) {
  return new Promise((resolvePromise) => {
    const proc = spawn(
      process.execPath,
      ["--import", "tsx", CLI_PATH, ...args],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env,
      }
    );
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

test.beforeEach(() => {
  resetStore();
  useDefaultRuntimeService();
});

test.after(() => {
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
  const directResult = await executeOperationWithSharedState({
    operation: "ingest",
    stateFile: null,
    executor: () => executeOperation("ingest", structuredClone(requestBody)),
  });

  assert.deepEqual(serviceResult, directResult);
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
      requestBody:
        requestBody &&
        typeof requestBody === "object" &&
        !Array.isArray(requestBody)
          ? requestBody
          : {},
      stateFile: typeof stateFile === "string" ? stateFile : null,
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
        error ? rejectPromise(error) : resolvePromise(undefined)
      );
    });
  }
});

test("cli routes through runtime service override deterministically", async () => {
  const env = {
    ...process.env,
    UMS_RUNTIME_SERVICE_MODULE: RUNTIME_SERVICE_FIXTURE,
    UMS_RUNTIME_SERVICE_EXPORT: "createDeterministicRuntimeService",
  };
  const args = [
    "context",
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

  const second = await runCli(args, "", { env });
  assert.equal((second as any).code, 0, (second as any).stderr);
  const secondBody = JSON.parse((second as any).stdout);
  assert.equal(secondBody.ok, true);
  assert.equal(secondBody.data.requestDigest, firstBody.data.requestDigest);
});
