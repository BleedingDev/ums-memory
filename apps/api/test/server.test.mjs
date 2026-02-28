import test from "node:test";
import assert from "node:assert/strict";
import { startApiServer } from "../src/server.mjs";
import { resetStore } from "../src/core.mjs";

test("http server exposes deterministic JSON operation routes", async () => {
  resetStore();
  const { server, host, port } = await startApiServer({ host: "127.0.0.1", port: 0 });
  const address = server.address();
  assert(address && typeof address === "object");
  const base = `http://${host}:${address.port}`;

  try {
    const rootRes = await fetch(`${base}/`);
    assert.equal(rootRes.status, 200);
    const rootBody = await rootRes.json();
    assert.equal(rootBody.ok, true);
    assert.equal(rootBody.deterministic, true);

    const ingestRes = await fetch(`${base}/v1/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-ums-store": "coding-agent" },
      body: JSON.stringify({
        profile: "api-test",
        events: [{ type: "note", source: "test", content: "deterministic server response" }]
      })
    });
    assert.equal(ingestRes.status, 200);
    const ingestBody = await ingestRes.json();
    assert.equal(ingestBody.ok, true);
    assert.equal(ingestBody.data.operation, "ingest");
    assert.equal(ingestBody.data.storeId, "coding-agent");
    assert.equal(ingestBody.data.accepted, 1);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("http server rejects non-object JSON payloads", async () => {
  resetStore();
  const { server, host } = await startApiServer({ host: "127.0.0.1", port: 0 });
  const address = server.address();
  assert(address && typeof address === "object");
  const base = `http://${host}:${address.port}`;

  try {
    const response = await fetch(`${base}/v1/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "[]",
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.equal(body.error.code, "BAD_REQUEST");
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
