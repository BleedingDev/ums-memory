import assert from "node:assert/strict";
import test from "node:test";

import { createEngine } from "../support/engine-adapter.mjs";

test("integration: multi-store isolation for jira and coding-agent memories", async () => {
  const engine = await createEngine({ seed: "multi-store-seed" });

  const jiraBatch = {
    storeId: "jira-history",
    space: "ferndesk",
    jiraBaseUrl: "https://jira.example.com",
    issues: [
      {
        id: "1001",
        key: "FD-101",
        fields: {
          summary: "Queue backlog spikes overnight",
          description: "Escalate async worker pool and add retry jitter.",
          created: "2026-02-20T12:00:00.000Z",
          comment: {
            comments: [
              {
                id: "c-1",
                created: "2026-02-20T12:05:00.000Z",
                body: "Customer reports midnight latency spikes.",
                author: { displayName: "Ops Team" },
                public: true,
              },
            ],
          },
        },
      },
    ],
  };

  const codingBatch = {
    storeId: "coding-agent",
    space: "ums-memory",
    platform: "codex-cli",
    conversations: [
      {
        id: "session-1",
        messages: [
          {
            id: "m-1",
            role: "user",
            createdAt: "2026-02-20T12:10:00.000Z",
            content: "Need deterministic replay tests for ingestion.",
          },
          {
            id: "m-2",
            role: "assistant",
            createdAt: "2026-02-20T12:11:00.000Z",
            content: "Add duplicate replay assertions and benchmark checks.",
          },
        ],
      },
    ],
  };

  const jiraIngest = await engine.ingest(jiraBatch);
  const codingIngest = await engine.ingest(codingBatch);

  assert.equal(jiraIngest.accepted, 2);
  assert.equal(codingIngest.accepted, 2);

  const jiraRecall = await engine.recall({
    storeId: "jira-history",
    space: "ferndesk",
    query: "latency spikes",
    maxItems: 5,
    tokenBudget: 180,
  });
  const codingRecall = await engine.recall({
    storeId: "coding-agent",
    space: "ums-memory",
    query: "deterministic replay",
    maxItems: 5,
    tokenBudget: 180,
  });
  const crossLeak = await engine.recall({
    storeId: "coding-agent",
    space: "ums-memory",
    query: "customer reports midnight latency spikes",
    maxItems: 5,
    tokenBudget: 180,
  });

  assert.ok(jiraRecall.items.length >= 1);
  assert.ok(codingRecall.items.length >= 1);
  assert.ok(crossLeak.items.every((item) => item.storeId === "coding-agent"));
  assert.ok(
    crossLeak.items.every(
      (item) => !item.content.toLowerCase().includes("customer reports midnight latency spikes"),
    ),
  );
  assert.ok(jiraRecall.items.every((item) => item.storeId === "jira-history"));
  assert.ok(codingRecall.items.every((item) => item.storeId === "coding-agent"));

  assert.equal(engine.getEventCount(undefined, "jira-history"), 2);
  assert.equal(engine.getEventCount(undefined, "coding-agent"), 2);

  const snapshot = engine.exportState();
  assert.equal(snapshot.totals.storeCount, 2);
  assert.equal(snapshot.totals.eventCount, 4);
});
