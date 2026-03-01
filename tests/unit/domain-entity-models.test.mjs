import assert from "node:assert/strict";
import test from "node:test";

import {
  ProceduralEntryKind,
  ProceduralEntryStatus,
  WorkingMemoryKind,
  createProceduralRule,
} from "../../libs/shared/src/entities.js";
import { ProceduralMemoryModel, WorkingMemoryModel } from "../../libs/shared/src/memory-models.js";

const workingModel = new WorkingMemoryModel();
const proceduralModel = new ProceduralMemoryModel();

test("ums-memory-d6q.4.2: diary creation is deterministic for spaced-repetition scheduling", () => {
  const now = "2026-03-01T00:00:00.000Z";
  const episodes = [
    { id: "ep-b", type: "error", content: "Second failure" },
    { id: "ep-a", type: "note", content: "First observation" },
  ];

  const diaryA = workingModel.buildDiary({ spaceId: "tenant-a", episodes, now });
  const diaryB = workingModel.buildDiary({ spaceId: "tenant-a", episodes: [...episodes].reverse(), now });

  assert.equal(diaryA.kind, WorkingMemoryKind.DIARY);
  assert.deepEqual(diaryA.evidenceEpisodeIds, ["ep-a", "ep-b"]);
  assert.equal(diaryA.metadata.episodeCount, episodes.length);
  assert.match(diaryA.content, /\[error\]/i);
  assert.match(diaryA.content, /\[note\]/i);
  assert.equal(diaryA.id, diaryB.id, "IDs remain stable even when episode order changes");
});

test("ums-memory-d6q.4.2: digest creation captures sorted type metadata for review planners", () => {
  const now = "2026-03-01T00:00:00.000Z";
  const episodes = [
    { id: "ep-note", type: "note", content: "Intro" },
    { id: "ep-analysis", type: "analysis", content: "Deep dive" },
    { id: "ep-note-2", type: "note", content: "Follow up" },
  ];

  const digest = workingModel.buildDigest({ spaceId: "tenant-a", episodes, now });

  assert.equal(digest.kind, WorkingMemoryKind.DIGEST);
  assert.equal(digest.metadata.episodeCount, episodes.length);
  assert.deepEqual(digest.metadata.types, ["analysis", "note"]);
  assert.equal(digest.content, "Digest: 3 episodes, types=analysis, note");
});

test("ums-memory-d6q.2.2: reinforcement applies harmful-weight decay and tombstones when confidence collapses", () => {
  const now = "2026-03-01T04:00:00.000Z";
  const baseRule = createProceduralRule({
    spaceId: "tenant-b",
    statement: "Log every failed validation",
    evidenceEpisodeIds: ["ep-validate"],
    createdAt: "2026-02-28T00:00:00.000Z",
    confidence: 0.3,
  });

  const reinforced = proceduralModel.reinforceRule(baseRule, {
    helpful: 0,
    harmful: 4,
    now,
  });

  assert.equal(reinforced.id, baseRule.id);
  assert.equal(reinforced.status, ProceduralEntryStatus.TOMBSTONED);
  assert.equal(reinforced.confidence, 0);
  assert.equal(reinforced.lastValidatedAt, now);
});

test("ums-memory-d6q.5.2: tombstone metadata records policy reason and timestamp", () => {
  const now = "2026-03-01T05:00:00.000Z";
  const baseRule = createProceduralRule({
    spaceId: "tenant-b",
    statement: "Promote every heuristic",
    evidenceEpisodeIds: ["ep-policy"],
    createdAt: "2026-02-28T00:00:00.000Z",
  });

  const tombstoned = proceduralModel.tombstoneRule(baseRule, {
    now,
    reason: "policy review",
  });

  assert.equal(tombstoned.status, ProceduralEntryStatus.TOMBSTONED);
  assert.equal(tombstoned.metadata.tombstoneReason, "policy review");
  assert.equal(tombstoned.metadata.tombstonedAt, now);
});

test("ums-memory-d6q.3.2: curriculum planner inverts harmful rules into anti-patterns", () => {
  const now = "2026-03-01T06:00:00.000Z";
  const baseRule = createProceduralRule({
    spaceId: "tenant-b",
    statement: "Always react to every warning",
    evidenceEpisodeIds: ["ep-feedback"],
    createdAt: "2026-02-28T00:00:00.000Z",
    confidence: 0.35,
    tags: ["safety"],
  });

  const antiPattern = proceduralModel.invertRuleToAntiPattern(baseRule, {
    now,
    reason: "harmful",
  });

  assert.equal(antiPattern.kind, ProceduralEntryKind.ANTI_PATTERN);
  assert.equal(antiPattern.sourceRuleId, baseRule.id);
  assert.deepEqual(antiPattern.evidenceEpisodeIds, baseRule.evidenceEpisodeIds);
  assert.match(antiPattern.statement, /^Avoid:/);
  assert.equal(antiPattern.metadata.reason, "harmful");
  assert.ok(antiPattern.confidence >= 0.2);
});
