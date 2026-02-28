import assert from "node:assert/strict";
import test from "node:test";

import { createEngine } from "../support/engine-adapter.mjs";
import { buildSyntheticEvents } from "../support/fixtures.mjs";

test("idempotent ingestion rejects duplicate replays", async () => {
  const engine = await createEngine({ seed: "idempotent-seed" });
  const events = buildSyntheticEvents({ count: 75, space: "idempotent-space" });

  const firstPass = await engine.ingest(events);
  assert.equal(firstPass.accepted, events.length);
  assert.equal(firstPass.duplicates, 0);

  const secondPass = await engine.ingest(events);
  assert.equal(secondPass.accepted, 0);
  assert.equal(secondPass.duplicates, events.length);
  assert.equal(engine.getEventCount("idempotent-space"), events.length);
});

test("synthetic IDs are replay-safe for repeated events without explicit IDs", async () => {
  const engine = await createEngine({ seed: "synthetic-id-seed" });
  const replayedEvent = {
    space: "replay-space",
    source: "cli",
    timestamp: "2026-01-15T12:00:00.000Z",
    content: "connector retries for jira",
    metadata: { attempt: 1 },
  };

  const first = await engine.ingest(replayedEvent);
  const second = await engine.ingest({ ...replayedEvent });

  assert.equal(first.accepted, 1);
  assert.equal(second.accepted, 0);
  assert.equal(second.duplicates, 1);
  assert.equal(engine.getEventCount("replay-space"), 1);
});
