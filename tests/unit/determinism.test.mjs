import assert from "node:assert/strict";
import test from "node:test";

import { createEngine } from "../support/engine-adapter.mjs";
import { buildSyntheticEvents } from "../support/fixtures.mjs";

test("deterministic state digest for identical ingest stream", async () => {
  const events = buildSyntheticEvents({
    count: 120,
    space: "determinism-space",
    includeSecrets: true,
    includeUnsafe: true,
  });

  const engineA = await createEngine({ seed: "stable-seed" });
  const engineB = await createEngine({ seed: "stable-seed" });

  await engineA.ingest(events);
  await engineB.ingest(events);

  assert.equal(engineA.stateDigest(), engineB.stateDigest());
});

test("deterministic recall ordering for repeated runs", async () => {
  const events = buildSyntheticEvents({
    count: 80,
    space: "ordering-space",
    includeSecrets: true,
    includeUnsafe: false,
  });

  const engineA = await createEngine({ seed: "stable-recall-seed" });
  const engineB = await createEngine({ seed: "stable-recall-seed" });
  await engineA.ingest(events);
  await engineB.ingest(events);

  const request = {
    space: "ordering-space",
    query: "migration rollback playbook",
    maxItems: 8,
    tokenBudget: 200,
  };
  const recallA = await engineA.recall(request);
  const recallB = await engineB.recall(request);

  assert.deepEqual(recallA.items, recallB.items);
  assert.equal(recallA.estimatedTokens, recallB.estimatedTokens);
});
