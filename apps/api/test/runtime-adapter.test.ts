import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

import { executeOperation, listOperations, resetStore } from "../src/core.ts";
import { executeOperationWithSharedState } from "../src/persistence.ts";
import {
  clearRuntimeAdapterCache,
  executeRuntimeOperation,
  listRuntimeOperations,
} from "../src/runtime-adapter.ts";
import { startApiServer } from "../src/server.ts";

const CLI_PATH = resolve(process.cwd(), "apps/cli/src/index.ts");
const RUNTIME_ADAPTER_FIXTURE = resolve(
  process.cwd(),
  "apps/api/test/fixtures/runtime-adapter-override.ts"
);
const POLICY_PACK_PLUGIN_FIXTURE = resolve(
  process.cwd(),
  "apps/api/test/fixtures/policy-pack-plugin-override.ts"
);
const ORIGINAL_RUNTIME_ADAPTER_MODULE =
  process.env["UMS_RUNTIME_ADAPTER_MODULE"];
const ORIGINAL_RUNTIME_ADAPTER_EXPORT =
  process.env["UMS_RUNTIME_ADAPTER_EXPORT"];
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

function useDefaultRuntimeAdapter() {
  delete process.env["UMS_RUNTIME_ADAPTER_MODULE"];
  delete process.env["UMS_RUNTIME_ADAPTER_EXPORT"];
  delete process.env["UMS_POLICY_PACK_PLUGIN_MODULE"];
  delete process.env["UMS_POLICY_PACK_PLUGIN_EXPORT"];
  clearRuntimeAdapterCache();
}

function useFixtureRuntimeAdapter() {
  process.env["UMS_RUNTIME_ADAPTER_MODULE"] = RUNTIME_ADAPTER_FIXTURE;
  process.env["UMS_RUNTIME_ADAPTER_EXPORT"] =
    "createDeterministicRuntimeAdapter";
  clearRuntimeAdapterCache();
}

test.beforeEach(() => {
  resetStore();
  useDefaultRuntimeAdapter();
});

test.after(() => {
  if (ORIGINAL_RUNTIME_ADAPTER_MODULE) {
    process.env["UMS_RUNTIME_ADAPTER_MODULE"] = ORIGINAL_RUNTIME_ADAPTER_MODULE;
  } else {
    delete process.env["UMS_RUNTIME_ADAPTER_MODULE"];
  }
  if (ORIGINAL_RUNTIME_ADAPTER_EXPORT) {
    process.env["UMS_RUNTIME_ADAPTER_EXPORT"] = ORIGINAL_RUNTIME_ADAPTER_EXPORT;
  } else {
    delete process.env["UMS_RUNTIME_ADAPTER_EXPORT"];
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
  clearRuntimeAdapterCache();
  resetStore();
});

test("runtime adapter default path stays compatible with effect core + persistence wiring", async () => {
  const requestBody = {
    profile: "runtime-adapter-default",
    events: [{ type: "note", source: "test", content: "effect compatibility" }],
  };

  const expectedOperations = listOperations();
  const adapterOperations = await listRuntimeOperations();
  assert.deepEqual(adapterOperations, expectedOperations);

  resetStore();
  const adapterResult = await executeRuntimeOperation({
    operation: "ingest",
    requestBody: structuredClone(requestBody),
    stateFile: null,
  });

  resetStore();
  const legacyResult = await executeOperationWithSharedState({
    operation: "ingest",
    stateFile: null,
    executor: () => executeOperation("ingest", structuredClone(requestBody)),
  });

  assert.deepEqual(adapterResult, legacyResult);
});

test("runtime adapter module override resolves deterministic contract behavior", async () => {
  useFixtureRuntimeAdapter();

  const operations = await listRuntimeOperations();
  assert.deepEqual(operations, ["context", "ingest"]);

  const requestBody = {
    profile: "runtime-adapter-override",
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

  assert.equal((first as any).adapterId, "deterministic-runtime-adapter");
  assert.deepEqual(first, second);
});

test("default runtime adapter can load policy pack plugins from env module", async () => {
  useDefaultRuntimeAdapter();
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

test("api server routes through runtime adapter override for list + operation execution", async () => {
  useFixtureRuntimeAdapter();
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
        profile: "runtime-adapter-http",
        query: "deterministic",
      }),
    });
    assert.equal(first.status, 200);
    const firstBody = await first.json();
    assert.equal(firstBody.ok, true);
    assert.equal(firstBody.data.adapterId, "deterministic-runtime-adapter");
    assert.equal(firstBody.data.request.storeId, "runtime-tenant");

    const second = await fetch(`${base}/v1/context`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-ums-store": "runtime-tenant",
      },
      body: JSON.stringify({
        profile: "runtime-adapter-http",
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

test("cli routes through runtime adapter override deterministically", async () => {
  const env = {
    ...process.env,
    UMS_RUNTIME_ADAPTER_MODULE: RUNTIME_ADAPTER_FIXTURE,
    UMS_RUNTIME_ADAPTER_EXPORT: "createDeterministicRuntimeAdapter",
  };
  const args = [
    "context",
    "--input",
    JSON.stringify({
      profile: "runtime-adapter-cli",
      query: "deterministic",
    }),
  ];

  const first = await runCli(args, "", { env });
  assert.equal((first as any).code, 0, (first as any).stderr);
  const firstBody = JSON.parse((first as any).stdout);
  assert.equal(firstBody.ok, true);
  assert.equal(firstBody.data.adapterId, "deterministic-runtime-adapter");

  const second = await runCli(args, "", { env });
  assert.equal((second as any).code, 0, (second as any).stderr);
  const secondBody = JSON.parse((second as any).stdout);
  assert.equal(secondBody.ok, true);
  assert.equal(secondBody.data.requestDigest, firstBody.data.requestDigest);
});
