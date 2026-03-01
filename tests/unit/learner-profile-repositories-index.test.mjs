import assert from "node:assert/strict";
import test from "node:test";

import {
  InMemoryIdentityGraphRepository,
  InMemoryKeywordIndex,
  InMemoryLearnerProfileRepository,
  assertIdentityGraphRepositoryContract,
  assertLearnerProfileRepositoryContract,
  assertMemoryIndexContract,
} from "../../libs/shared/src/repositories.js";
import {
  IdentityGraphRelationKind,
  LearnerProfileStatus,
} from "../../libs/shared/src/entities.js";

test("memory index contract enforces upsert and search methods", () => {
  const fixture = new InMemoryKeywordIndex();

  assert.doesNotThrow(() => assertMemoryIndexContract(fixture));

  assert.throws(
    () => assertMemoryIndexContract({ upsert() {} }),
    (error) =>
      /contract violation/i.test(error?.message ?? "") && error?.details?.missingMethod === "search",
  );
});

test("learner profile repository contract enforces required methods", () => {
  const fixture = new InMemoryLearnerProfileRepository();
  assert.doesNotThrow(() => assertLearnerProfileRepositoryContract(fixture));
  assert.throws(
    () => assertLearnerProfileRepositoryContract({ upsertProfile() {}, getProfileById() {} }),
    (error) =>
      error?.details?.missingMethod === "listProfiles" && /contract violation/i.test(error.message),
  );
});

test("learner profile repository upsert is deterministic and tenant-scoped", () => {
  const repository = new InMemoryLearnerProfileRepository();
  const payload = {
    spaceId: "tenant-a",
    learnerId: "learner-42",
    status: LearnerProfileStatus.ACTIVE,
    identityRefs: [{ namespace: "email", value: "learner@example.com" }],
    goals: ["graph", "graph", "dp"],
    createdAt: "2026-02-28T00:00:00.000Z",
    updatedAt: "2026-02-28T00:00:00.000Z",
  };

  const first = repository.upsertProfile(payload);
  const second = repository.upsertProfile({ ...payload });
  assert.equal(first.id, second.id);
  assert.equal(repository.countProfiles("tenant-a"), 1);

  repository.upsertProfile({
    ...payload,
    spaceId: "tenant-b",
    learnerId: "learner-99",
    identityRefs: [{ namespace: "email", value: "learner99@example.com" }],
  });

  assert.equal(repository.listProfiles("tenant-a").length, 1);
  assert.equal(repository.listProfiles("tenant-b").length, 1);
});

test("identity graph repository contract and deterministic edge indexing", () => {
  const repository = new InMemoryIdentityGraphRepository();
  assert.doesNotThrow(() => assertIdentityGraphRepositoryContract(repository));

  const payload = {
    spaceId: "tenant-a",
    profileId: "lp_1",
    relation: IdentityGraphRelationKind.MISCONCEPTION_OF,
    fromRef: { namespace: "misconception", value: "off-by-one" },
    toRef: { namespace: "learner", value: "learner-42" },
    evidenceEpisodeIds: ["ep-1", "ep-1", "ep-2"],
    createdAt: "2026-02-28T00:00:00.000Z",
  };

  const first = repository.upsertEdge(payload);
  const second = repository.upsertEdge({ ...payload });
  assert.equal(first.id, second.id);
  assert.deepEqual(second.evidenceEpisodeIds, ["ep-1", "ep-2"]);
  assert.equal(repository.countEdges("tenant-a"), 1);
  assert.equal(
    repository.listEdges("tenant-a", { relation: IdentityGraphRelationKind.MISCONCEPTION_OF }).length,
    1,
  );
  assert.equal(repository.listEdges("tenant-b").length, 0);
});

test("InMemoryKeywordIndex upsert is idempotent when given the same payload", () => {
  const index = new InMemoryKeywordIndex();
  const payload = {
    id: "lp-123",
    spaceId: "tenant-a",
    kind: "learner_profile",
    text: "Carefully track learner state",
    tags: ["profile", "tracking"],
    createdAt: "2026-02-28T00:00:00.000Z",
  };

  const first = index.upsert(payload);
  const second = index.upsert({ ...payload });

  assert.deepEqual(first, second);
  assert.equal(first.createdAt, "2026-02-28T00:00:00.000Z");

  const results = index.search({ spaceId: "tenant-a" });
  assert.equal(results.length, 1);
  assert.equal(results[0].id, payload.id);
});

test("InMemoryKeywordIndex searches respect space isolation", () => {
  const index = new InMemoryKeywordIndex();

  index.upsert({
    id: "lp-a",
    spaceId: "tenant-a",
    kind: "learner_profile",
    text: "Alpha learners",
    tags: ["alpha"],
    createdAt: "2026-02-27T00:00:00.000Z",
  });

  index.upsert({
    id: "lp-b",
    spaceId: "tenant-b",
    kind: "learner_profile",
    text: "Beta learners",
    tags: ["beta"],
    createdAt: "2026-02-27T01:00:00.000Z",
  });

  const tenantA = index.search({ spaceId: "tenant-a", query: "learners" });
  const tenantB = index.search({ spaceId: "tenant-b", query: "learners" });

  assert.equal(tenantA.length, 1);
  assert.equal(tenantA[0].id, "lp-a");
  assert.equal(tenantB.length, 1);
  assert.equal(tenantB[0].id, "lp-b");
});
