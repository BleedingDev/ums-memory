import assert from "node:assert/strict";
import test from "node:test";

import { createEngine } from "../support/engine-adapter.mjs";
import { buildSyntheticEvents } from "../support/fixtures.mjs";

test("recall payload is bounded by max items and token budget", async () => {
  const engine = await createEngine({ seed: "bounded-recall-seed" });
  const events = buildSyntheticEvents({
    count: 150,
    space: "bounded-space",
    includeSecrets: true,
    includeUnsafe: true,
  });
  await engine.ingest(events);

  const maxItems = 6;
  const tokenBudget = 120;
  const recall = await engine.recall({
    space: "bounded-space",
    query: "recall ranking evidence",
    maxItems,
    tokenBudget,
  });

  assert.ok(recall.items.length <= maxItems);
  assert.ok(recall.estimatedTokens <= tokenBudget);
  assert.ok(recall.payloadBytes > 0);
  assert.ok(recall.truncated);
});

test("guardrails redact secrets and filter unsafe instructions by default", async () => {
  const engine = await createEngine({ seed: "guardrail-seed" });
  const events = buildSyntheticEvents({
    count: 170,
    space: "guardrail-space",
    includeSecrets: true,
    includeUnsafe: true,
  });
  await engine.ingest(events);

  const safeRecall = await engine.recall({
    space: "guardrail-space",
    query: "system prompt",
    maxItems: 25,
    tokenBudget: 600,
  });

  assert.ok(safeRecall.guardrails.filteredUnsafe > 0);
  for (const item of safeRecall.items) {
    assert.ok(!/ignore previous instructions/i.test(item.content));
    assert.ok(!/sk-[A-Za-z0-9]{8,}/.test(item.content));
    assert.ok(!/api[_-]?key\s*[:=]\s*(?!\[REDACTED\])[^\s,;]+/i.test(item.content));
  }

  const auditRecall = await engine.recall({
    space: "guardrail-space",
    query: "system prompt",
    includeUnsafe: true,
    maxItems: 25,
    tokenBudget: 600,
  });
  assert.ok(auditRecall.items.some((item) => item.flags.unsafeInstruction));
});
