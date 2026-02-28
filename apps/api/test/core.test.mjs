import test from "node:test";
import assert from "node:assert/strict";
import { executeOperation, listOperations, resetStore, snapshotProfile } from "../src/core.mjs";

test.beforeEach(() => {
  resetStore();
});

test("core exposes the full required operation surface", () => {
  assert.deepEqual(listOperations(), [
    "ingest",
    "context",
    "reflect",
    "validate",
    "curate",
    "feedback",
    "outcome",
    "audit",
    "export",
    "doctor"
  ]);
});

test("ingest is deterministic for identical request payload", () => {
  const request = {
    profile: "demo",
    events: [
      { type: "commit", source: "git", content: "fix: normalize ids" },
      { type: "note", source: "chat", content: "remember deterministic output" }
    ]
  };

  const first = executeOperation("ingest", request);
  resetStore();
  const second = executeOperation("ingest", request);

  assert.equal(first.requestDigest, second.requestDigest);
  assert.equal(first.ledgerDigest, second.ledgerDigest);
  assert.deepEqual(first.eventRefs, second.eventRefs);
});

test("context and curate operate on shared profile state", () => {
  executeOperation("ingest", {
    profile: "demo",
    events: [{ type: "ticket", source: "jira", content: "Always include acceptance criteria." }]
  });
  const reflected = executeOperation("reflect", { profile: "demo", maxCandidates: 1 });
  const curated = executeOperation("curate", {
    profile: "demo",
    candidates: reflected.candidates
  });
  const context = executeOperation("context", {
    profile: "demo",
    query: "acceptance"
  });

  assert.equal(curated.applied.length, 1);
  assert.equal(context.matches.length, 1);
  assert.equal(snapshotProfile("demo").rules.length, 1);
});
