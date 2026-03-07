import assert from "node:assert/strict";

import { test } from "@effect-native/bun-test";

import { resetStore } from "../../apps/api/src/core.ts";
import { startApiServer } from "../../apps/api/src/server.ts";
import { createInMemoryApiTelemetry } from "../../apps/api/src/telemetry.ts";

test("ums-memory-onf.5: storage dual-run route stays read-only and emits traceable telemetry", async () => {
  resetStore();
  const events: any[] = [];
  const telemetry = createInMemoryApiTelemetry({
    logger(event) {
      events.push(event);
    },
  });
  const { server, host, port } = await startApiServer({
    host: "127.0.0.1",
    port: 0,
    stateFile: null,
    telemetry,
    enableStorageDualRun: true,
  });
  const base = `http://${host}:${port}`;

  try {
    const response = await fetch(`${base}/v1/storage_dualrun`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-ums-store": "tenant-storage-parity",
      },
      body: JSON.stringify({
        suiteId: "integration-storage-dualrun",
        operations: [
          {
            kind: "upsert",
            label: "seed",
            request: {
              spaceId: "tenant-storage-parity",
              memoryId: "memory-a",
              layer: "working",
              payload: {
                title: "Working memory seed",
                updatedAtMillis: 1700000000100,
              },
              idempotencyKey: "upsert-a",
            },
          },
          {
            kind: "delete",
            label: "missing delete",
            request: {
              spaceId: "tenant-storage-parity",
              memoryId: "memory-missing",
              idempotencyKey: "delete-missing",
            },
          },
          {
            kind: "snapshot_roundtrip",
            label: "roundtrip",
          },
        ],
      }),
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.data.operation, "storage_dualrun");
    assert.equal(body.data.storeId, "tenant-storage-parity");
    assert.equal(body.data.ok, true);
    assert.equal(body.data.mismatchCount, 0);
    assert.equal(body.data.operationCount, 3);
    assert.equal(
      body.data.observability.tracePayload.requestDigest,
      body.data.requestDigest
    );
    assert.equal(
      body.data.observability.tracePayload.storeId,
      "tenant-storage-parity"
    );

    const telemetryEvent = events.find(
      (event) => event.operation === "storage_dualrun"
    );
    assert.ok(telemetryEvent);
    assert.equal(telemetryEvent.status, "success");
    assert.equal(telemetryEvent.statusCode, 200);
    assert.equal(telemetryEvent.storeId, "tenant-storage-parity");
    assert.equal(
      telemetryEvent.tracePayload.requestDigest,
      body.data.requestDigest
    );
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
