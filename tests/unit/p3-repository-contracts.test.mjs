import assert from "node:assert/strict";
import test from "node:test";

import {
  createAntiPattern,
  createProceduralRule,
  createWorkingMemoryEntry,
  IdentityGraphRelationKind,
  ProceduralEntryStatus,
  WorkingMemoryKind,
} from "../../libs/shared/src/entities.js";
import { ErrorCode } from "../../libs/shared/src/errors.js";
import {
  InMemoryIdentityGraphRepository,
  InMemoryKeywordIndex,
  InMemoryProceduralRepository,
  InMemoryWorkingMemoryRepository,
  assertIdentityGraphRepositoryContract,
  assertMemoryIndexContract,
  assertProceduralRepositoryContract,
  assertWorkingMemoryRepositoryContract,
} from "../../libs/shared/src/repositories.js";

test("ums-memory-d6q.2.3: misconception identity-edge contracts and upserts are deterministic", () => {
  const repository = new InMemoryIdentityGraphRepository();

  assert.doesNotThrow(() => assertIdentityGraphRepositoryContract(repository));
  assert.throws(
    () =>
      assertIdentityGraphRepositoryContract({
        upsertEdge() {},
        getEdgeById() {},
        listEdges() {},
      }),
    (error) =>
      error?.code === ErrorCode.CONTRACT_VIOLATION && error?.details?.missingMethod === "countEdges",
  );

  const base = {
    spaceId: "tenant-feedback",
    profileId: "lp-feedback",
    relation: IdentityGraphRelationKind.MISCONCEPTION_OF,
    fromRef: { namespace: "misconception", value: "loop-invariant" },
    toRef: { namespace: "learner", value: "learner-42" },
    createdAt: "2026-03-01T00:00:00.000Z",
    metadata: { channel: "feedback" },
  };

  const first = repository.upsertEdge({
    ...base,
    evidenceEpisodeIds: ["ep-2", "ep-1", "ep-1"],
  });
  const second = repository.upsertEdge({
    ...base,
    id: first.id,
    evidenceEpisodeIds: ["ep-3", "ep-2"],
    metadata: { phase: "review" },
  });

  assert.equal(second.id, first.id);
  assert.deepEqual(second.evidenceEpisodeIds, ["ep-1", "ep-2", "ep-3"]);
  assert.deepEqual(second.metadata, { channel: "feedback", phase: "review" });
  assert.equal(repository.countEdges("tenant-feedback"), 1);

  const list = repository.listEdges("tenant-feedback", {
    relation: IdentityGraphRelationKind.MISCONCEPTION_OF,
    profileId: "lp-feedback",
  });
  assert.equal(list.length, 1);
  assert.equal(list[0].id, first.id);
});

test("ums-memory-d6q.3.3: curriculum repositories and index ranking remain idempotent", () => {
  const procedural = new InMemoryProceduralRepository();
  const index = new InMemoryKeywordIndex();

  assert.doesNotThrow(() => assertProceduralRepositoryContract(procedural));
  assert.doesNotThrow(() => assertMemoryIndexContract(index));

  const firstRule = createProceduralRule({
    spaceId: "tenant-curriculum",
    statement: "Break large goals into weekly milestones",
    evidenceEpisodeIds: ["ep-plan-a"],
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
    lastValidatedAt: "2026-03-01T00:00:00.000Z",
  });
  const replayedFirstRule = procedural.upsertRule(firstRule);
  const replayedAgain = procedural.upsertRule(firstRule);
  assert.deepEqual(replayedAgain, replayedFirstRule);

  const secondRule = procedural.upsertRule(
    createProceduralRule({
      spaceId: "tenant-curriculum",
      statement: "Use spaced retrieval checkpoints for weak skills",
      evidenceEpisodeIds: ["ep-plan-b"],
      createdAt: "2026-03-01T01:00:00.000Z",
      updatedAt: "2026-03-01T01:00:00.000Z",
      lastValidatedAt: "2026-03-01T01:00:00.000Z",
    }),
  );

  const orderedRules = procedural.listRules("tenant-curriculum");
  assert.deepEqual(orderedRules.map((rule) => rule.id), [secondRule.id, firstRule.id]);

  index.upsert({
    id: firstRule.id,
    spaceId: "tenant-curriculum",
    kind: "procedural_rule",
    text: firstRule.statement,
    tags: ["curriculum", "milestones"],
    createdAt: firstRule.createdAt,
  });
  index.upsert({
    id: secondRule.id,
    spaceId: "tenant-curriculum",
    kind: "procedural_rule",
    text: secondRule.statement,
    tags: ["curriculum", "retrieval"],
    createdAt: secondRule.createdAt,
  });

  const search = index.search({
    spaceId: "tenant-curriculum",
    query: "retrieval checkpoints",
    kinds: ["procedural_rule"],
  });
  assert.ok(search.length >= 1);
  assert.equal(search[0].id, secondRule.id);
  assert.match(search[0].reason, /^matched \d+ query tokens$/);
});

test("ums-memory-d6q.4.3: spaced-repetition working-memory repository behavior is replay-safe", () => {
  const working = new InMemoryWorkingMemoryRepository();
  const index = new InMemoryKeywordIndex();

  assert.doesNotThrow(() => assertWorkingMemoryRepositoryContract(working));
  assert.doesNotThrow(() => assertMemoryIndexContract(index));

  const digestEntry = createWorkingMemoryEntry({
    spaceId: "tenant-review",
    kind: WorkingMemoryKind.DIGEST,
    content: "Digest: weak areas in fractions and loop invariants",
    evidenceEpisodeIds: ["ep-1", "ep-2"],
    createdAt: "2026-03-01T02:00:00.000Z",
  });
  const diaryEntry = createWorkingMemoryEntry({
    spaceId: "tenant-review",
    kind: WorkingMemoryKind.DIARY,
    content: "[note] Learner solved two spaced drills",
    evidenceEpisodeIds: ["ep-3"],
    createdAt: "2026-03-01T02:30:00.000Z",
  });

  const first = working.upsertEntry(digestEntry);
  const second = working.upsertEntry(digestEntry);
  assert.deepEqual(second, first);

  working.upsertEntry(diaryEntry);
  assert.equal(working.countEntries("tenant-review"), 2);
  assert.deepEqual(
    working.listEntries("tenant-review").map((entry) => entry.id),
    [diaryEntry.id, digestEntry.id],
  );
  assert.deepEqual(
    working
      .listEntries("tenant-review", { kind: WorkingMemoryKind.DIGEST })
      .map((entry) => entry.id),
    [digestEntry.id],
  );

  index.upsert({
    id: diaryEntry.id,
    spaceId: "tenant-review",
    kind: "working_memory",
    text: diaryEntry.content,
    tags: ["review", "diary"],
    createdAt: diaryEntry.createdAt,
  });
  const recall = index.search({ spaceId: "tenant-review", query: "spaced drills" });
  assert.equal(recall[0]?.id, diaryEntry.id);
});

test("ums-memory-d6q.5.3: policy repository rules keep tombstone visibility deterministic", () => {
  const procedural = new InMemoryProceduralRepository();
  const index = new InMemoryKeywordIndex();

  const activeRule = createProceduralRule({
    spaceId: "tenant-policy",
    statement: "Prefer hints before direct answers",
    evidenceEpisodeIds: ["ep-safe-1"],
    createdAt: "2026-03-01T03:00:00.000Z",
    updatedAt: "2026-03-01T03:00:00.000Z",
    lastValidatedAt: "2026-03-01T03:00:00.000Z",
    confidence: 0.8,
  });
  const tombstonedRule = createProceduralRule({
    spaceId: "tenant-policy",
    statement: "Always provide full solution immediately",
    evidenceEpisodeIds: ["ep-safe-2"],
    createdAt: "2026-03-01T03:05:00.000Z",
    updatedAt: "2026-03-01T03:05:00.000Z",
    lastValidatedAt: "2026-03-01T03:05:00.000Z",
    status: ProceduralEntryStatus.TOMBSTONED,
    metadata: { tombstoneReason: "policy review" },
  });

  procedural.upsertRule(activeRule);
  procedural.upsertRule(tombstonedRule);

  assert.deepEqual(
    procedural.listRules("tenant-policy").map((rule) => rule.id),
    [activeRule.id],
  );
  assert.equal(
    procedural.listRules("tenant-policy", { includeTombstoned: true }).length,
    2,
  );

  const antiPattern = createAntiPattern({
    spaceId: "tenant-policy",
    statement: "Avoid: Always provide full solution immediately",
    evidenceEpisodeIds: ["ep-safe-2"],
    sourceRuleId: tombstonedRule.id,
    createdAt: "2026-03-01T03:10:00.000Z",
    metadata: { reason: "policy review" },
  });
  const firstAntiPattern = procedural.upsertAntiPattern(antiPattern);
  const secondAntiPattern = procedural.upsertAntiPattern(antiPattern);
  assert.deepEqual(secondAntiPattern, firstAntiPattern);
  assert.equal(procedural.countAntiPatterns("tenant-policy"), 1);

  index.upsert({
    id: antiPattern.id,
    spaceId: "tenant-policy",
    kind: "anti_pattern",
    text: `${antiPattern.statement} :: tombstoned by policy`,
    tags: ["policy", "safety"],
    createdAt: antiPattern.createdAt,
  });
  const policyResults = index.search({
    spaceId: "tenant-policy",
    query: "tombstoned policy",
    kinds: ["anti_pattern"],
  });
  assert.equal(policyResults[0]?.id, antiPattern.id);
});
