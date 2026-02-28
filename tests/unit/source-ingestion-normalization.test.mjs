import assert from "node:assert/strict";
import test from "node:test";

import { createEngine } from "../support/engine-adapter.mjs";

test("source normalization: jira issues/comments ingest deterministically with replay safety", async () => {
  const engine = await createEngine({ seed: "jira-source-seed" });

  const jiraPayload = {
    storeId: "jira-history",
    space: "ferndesk",
    issues: [
      {
        id: "777",
        key: "FD-777",
        fields: {
          summary: "Sanitize connector payloads",
          description: {
            type: "doc",
            content: [{ type: "paragraph", content: [{ type: "text", text: "api_key=secret123" }] }],
          },
          created: "2026-02-01T01:00:00.000Z",
        },
        comments: [
          {
            id: "c1",
            body: "Need redaction for token=abc123",
            created: "2026-02-01T01:10:00.000Z",
            author: { displayName: "Security Team" },
            public: false,
          },
        ],
      },
    ],
  };

  const first = await engine.ingest(jiraPayload);
  const second = await engine.ingest(jiraPayload);

  assert.equal(first.accepted, 2);
  assert.equal(second.accepted, 0);
  assert.equal(second.duplicates, 2);

  const recall = await engine.recall({
    storeId: "jira-history",
    space: "ferndesk",
    query: "redaction token",
    maxItems: 5,
    tokenBudget: 220,
  });
  assert.ok(recall.items.length >= 1);
  assert.ok(recall.items.every((item) => !item.content.includes("secret123")));
  assert.ok(recall.items.every((item) => !item.content.includes("abc123")));

  const snapshot = engine.exportState();
  const jiraStore = snapshot.stores.find((entry) => entry.storeId === "jira-history");
  assert.ok(jiraStore);
  assert.equal(jiraStore.totals.eventCount, 2);
});

test("source normalization: conversation batches support codex/claude style messages", async () => {
  const engine = await createEngine({ seed: "conversation-source-seed" });

  const conversationPayload = {
    storeId: "coding-agent",
    space: "agent-mailbox",
    platform: "claude-code",
    conversations: [
      {
        id: "ses-123",
        messages: [
          {
            id: "u1",
            role: "user",
            createdAt: "2026-02-11T09:00:00.000Z",
            content: { key: "prompt", value: "Summarize jira connector risks" },
          },
          {
            id: "a1",
            role: "assistant",
            createdAt: "2026-02-11T09:01:00.000Z",
            text: "Use separate memory stores to avoid cross-project contamination.",
          },
        ],
      },
      {
        id: "rollout-456",
        messages: [
          {
            id: "u2",
            role: "user",
            createdAt: "2026-02-11T10:00:00.000Z",
            message: "Run benchmark and test loops until all beads are done.",
          },
        ],
      },
    ],
  };

  const ingest = await engine.ingest(conversationPayload);
  assert.equal(ingest.accepted, 3);

  const recall = await engine.recall({
    storeId: "coding-agent",
    space: "agent-mailbox",
    query: "separate memory stores cross-project contamination",
    maxItems: 5,
    tokenBudget: 220,
  });

  assert.ok(recall.items.length >= 1);
  assert.ok(
    recall.items.some((item) =>
      item.content.toLowerCase().includes("separate memory stores to avoid cross-project contamination"),
    ),
  );
});

test("source normalization: anonymous conversations avoid fallback ID collisions", async () => {
  const engine = await createEngine({ seed: "anonymous-conversation-seed" });

  const payload = {
    storeId: "coding-agent",
    space: "anonymous-space",
    platform: "codex-cli",
    conversations: [
      {
        messages: [{ role: "user", createdAt: "2026-02-11T11:00:00.000Z", content: "first conversation" }],
      },
      {
        messages: [{ role: "user", createdAt: "2026-02-11T11:01:00.000Z", content: "second conversation" }],
      },
    ],
  };

  const first = await engine.ingest(payload);
  const second = await engine.ingest(payload);

  assert.equal(first.accepted, 2);
  assert.equal(first.duplicates, 0);
  assert.equal(second.accepted, 0);
  assert.equal(second.duplicates, 2);
});
