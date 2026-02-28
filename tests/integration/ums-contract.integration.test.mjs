import assert from "node:assert/strict";
import test from "node:test";

import { createEngine } from "../support/engine-adapter.mjs";
import { buildSyntheticEvents } from "../support/fixtures.mjs";

test("integration: replay-safe ingestion, bounded recall, and tenant isolation", async () => {
  const tenantAEvents = buildSyntheticEvents({
    count: 120,
    space: "tenant-a",
    includeSecrets: true,
    includeUnsafe: true,
  });
  const tenantBEvents = buildSyntheticEvents({
    count: 120,
    space: "tenant-b",
    includeSecrets: false,
    includeUnsafe: false,
  });

  const engine = await createEngine({ seed: "integration-seed" });
  await engine.ingest([...tenantAEvents, ...tenantBEvents]);

  const recallA = await engine.recall({
    space: "tenant-a",
    query: "tenant boundary policy",
    maxItems: 10,
    tokenBudget: 140,
  });
  const recallB = await engine.recall({
    space: "tenant-b",
    query: "tenant boundary policy",
    maxItems: 10,
    tokenBudget: 140,
  });

  assert.ok(recallA.items.every((item) => item.space === "tenant-a"));
  assert.ok(recallB.items.every((item) => item.space === "tenant-b"));
  assert.ok(recallA.payloadBytes <= 4096);
  assert.ok(recallB.payloadBytes <= 4096);

  const digestBeforeReplay = engine.stateDigest();
  const replay = await engine.ingest(tenantAEvents);
  assert.equal(replay.accepted, 0);
  assert.equal(replay.duplicates, tenantAEvents.length);
  assert.equal(engine.stateDigest(), digestBeforeReplay);

  const snapshot = engine.exportState();
  const restoredEngine = await createEngine({
    seed: "integration-seed",
    initialState: snapshot,
  });
  assert.equal(restoredEngine.stateDigest(), engine.stateDigest());

  const restoredRecall = await restoredEngine.recall({
    space: "tenant-a",
    query: "tenant boundary policy",
    maxItems: 10,
    tokenBudget: 140,
  });
  assert.deepEqual(restoredRecall.items, recallA.items);
});
