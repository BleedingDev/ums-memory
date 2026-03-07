import assert from "node:assert/strict";

import { test } from "@effect-native/bun-test";

import { buildContextPack } from "../../apps/api/src/ace/context-pack.ts";

test("context-pack stays deterministic for identical snapshot and query", () => {
  const input = {
    packId: "pack_demo",
    query: "evidence",
    limit: 2,
    chronologyLimit: 2,
    events: [
      {
        eventId: "evt-1",
        type: "note",
        source: "codex",
        content: "evidence first",
        digest: "dig-1",
      },
      {
        eventId: "evt-2",
        type: "ticket",
        source: "jira",
        content: "second evidence item",
        digest: "dig-2",
      },
    ],
    chronologyHistory: [
      {
        noteId: "note-2",
        misconceptionId: "mis-2",
        misconceptionKey: "recall-bounds",
        profileId: "demo",
        timestamp: "2026-02-02T00:00:00.000Z",
        changedFields: ["status"],
        previousDigest: null,
        nextDigest: "next-2",
        confidence: 0.4,
        harmfulSignalCount: 0,
        evidenceEventIds: ["evt-2"],
      },
      {
        noteId: "note-1",
        misconceptionId: "mis-1",
        misconceptionKey: "evidence-depth",
        profileId: "demo",
        timestamp: "2026-02-01T00:00:00.000Z",
        changedFields: ["harmfulSignalCount", "confidence"],
        previousDigest: null,
        nextDigest: "next-1",
        confidence: 0.7,
        harmfulSignalCount: 2,
        evidenceEventIds: ["evt-1"],
      },
    ],
    makeUsageId: (event: { eventId: string }) => `usage_${event.eventId}`,
  } as const;

  const first = buildContextPack(input);
  const second = buildContextPack(input);

  assert.deepEqual(first, second);
  assert.deepEqual(
    first.matches.map((match) => match.usageId),
    ["usage_evt-1", "usage_evt-2"]
  );
  assert.deepEqual(
    first.misconceptionChronology.notes.map((note) => note.noteId),
    ["note-1", "note-2"]
  );
  assert.equal(first.misconceptionChronology.bounded, true);
  assert.equal(first.misconceptionChronology.truncated, false);
});
