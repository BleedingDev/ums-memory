import assert from "node:assert/strict";
import test from "node:test";

import {
  assertIdentityEdgeInSpace,
  assertLearnerProfileLinks,
  createIdentityGraphEdge,
  createLearnerProfile,
  IdentityGraphRelationKind,
  isLearnerProfileActive,
  LearnerProfileStatus,
} from "../../libs/shared/src/entities.js";
import { ErrorCode } from "../../libs/shared/src/errors.js";

test("createLearnerProfile enforces canonical identity normalization and deterministic IDs", () => {
  const createdAt = "2026-02-28T00:00:00.000Z";
  const left = createLearnerProfile({
    spaceId: "tenant-a",
    learnerId: "learner-42",
    displayName: " Learner ",
    identityRefs: [
      { namespace: "email", value: "learner@example.com" },
      { namespace: "agent", value: "codex:session-1", isPrimary: true },
      { namespace: "email", value: "learner@example.com", verified: true },
    ],
    goals: ["graph traversal", "graph traversal", "dynamic programming"],
    createdAt,
  });
  const right = createLearnerProfile({
    spaceId: "tenant-a",
    learnerId: "learner-42",
    displayName: "Learner",
    identityRefs: [
      { namespace: "agent", value: "codex:session-1", isPrimary: true },
      { namespace: "email", value: "learner@example.com", verified: true },
    ],
    goals: ["dynamic programming", "graph traversal"],
    createdAt,
  });

  assert.equal(left.id, right.id);
  assert.equal(left.entityType, "learner_profile");
  assert.equal(left.displayName, "Learner");
  assert.equal(left.identityRefs.length, 2);
  assert.deepEqual(left.goals, ["dynamic programming", "graph traversal"]);
  assert.equal(left.identityRefs.filter((identityRef) => identityRef.isPrimary).length, 1);
});

test("createLearnerProfile rejects missing identity references", () => {
  assert.throws(
    () =>
      createLearnerProfile({
        spaceId: "tenant-a",
        learnerId: "learner-42",
        identityRefs: [],
      }),
    (error) => error?.code === ErrorCode.IDENTITY_INVARIANT,
  );
});

test("createLearnerProfile rejects impossible timestamp ordering", () => {
  assert.throws(
    () =>
      createLearnerProfile({
        spaceId: "tenant-a",
        learnerId: "learner-42",
        identityRefs: [{ namespace: "email", value: "learner@example.com" }],
        createdAt: "2026-02-28T00:00:00.000Z",
        updatedAt: "2026-02-27T23:59:59.000Z",
      }),
    (error) => error?.code === ErrorCode.IDENTITY_INVARIANT,
  );
});

test("createIdentityGraphEdge requires evidence for misconception relations", () => {
  assert.throws(
    () =>
      createIdentityGraphEdge({
        spaceId: "tenant-a",
        profileId: "lp_1",
        relation: IdentityGraphRelationKind.MISCONCEPTION_OF,
        fromRef: { namespace: "misconception", value: "loop-off-by-one" },
        toRef: { namespace: "learner", value: "learner-42" },
      }),
    (error) => error?.code === ErrorCode.EVIDENCE_REQUIRED,
  );
});

test("identity graph edge helpers enforce space boundaries", () => {
  const edge = createIdentityGraphEdge({
    spaceId: "tenant-a",
    profileId: "lp_1",
    relation: IdentityGraphRelationKind.ALIAS_OF,
    fromRef: { namespace: "email", value: "learner@example.com" },
    toRef: { namespace: "agent", value: "codex:session-1" },
    confidence: 0.8,
  });

  assert.equal(edge.entityType, "identity_graph_edge");
  assert.equal(edge.evidenceEpisodeIds.length, 0);
  assert.doesNotThrow(() => assertIdentityEdgeInSpace(edge, "tenant-a"));
  assert.throws(
    () => assertIdentityEdgeInSpace(edge, "tenant-b"),
    (error) => error?.code === ErrorCode.ISOLATION_VIOLATION,
  );
});

test("learner profile helpers capture link and lifecycle invariants", () => {
  const profile = createLearnerProfile({
    spaceId: "tenant-a",
    learnerId: "learner-42",
    identityRefs: [{ namespace: "email", value: "learner@example.com" }],
    status: LearnerProfileStatus.ACTIVE,
  });
  assert.doesNotThrow(() => assertLearnerProfileLinks(profile));
  assert.equal(isLearnerProfileActive(profile), true);
  assert.equal(
    isLearnerProfileActive({
      ...profile,
      status: LearnerProfileStatus.ARCHIVED,
    }),
    false,
  );
});
