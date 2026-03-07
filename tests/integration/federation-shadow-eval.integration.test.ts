import assert from "node:assert/strict";

import { test } from "@effect-native/bun-test";
import { Effect } from "effect";

import { evaluateShadowFederationRead } from "../../apps/api/src/federation/shadow-evaluator.ts";

const deepFreeze = <Value>(value: Value): Value => {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    for (const nestedValue of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nestedValue);
    }
  }
  return value;
};

test("ums-memory-6nq.2: shadow federation evaluation stays read-only and merges candidates deterministically", async () => {
  const request = deepFreeze({
    actorTenantId: "tenant-acme",
    sourceTenantId: "tenant-acme",
    targetTenantId: "tenant-acme",
    sourceSpaceId: "space-source",
    targetSpaceId: "space-target",
    shareId: "share-project",
    shareScope: "project" as const,
    allowlistedTargetSpaceIds: ["space-target"],
    allowlistedShareIds: ["share-project"],
    selectorMatches: true,
    policyAllows: true,
    evaluatedAtMillis: 1_730_851_200_000,
    localCandidates: [
      {
        memoryId: "mem-local-b",
        digest: "digest-b",
        statement: "Local project rule",
        score: 0.92,
        updatedAtMillis: 30,
        sourceSpaceId: "space-target",
        scope: "local" as const,
        shareId: null,
        policyDecisionId: null,
      },
      {
        memoryId: "mem-local-a",
        digest: "digest-a",
        statement: "Local incumbent rule",
        score: 0.7,
        updatedAtMillis: 20,
        sourceSpaceId: "space-target",
        scope: "local" as const,
        shareId: null,
        policyDecisionId: null,
      },
    ],
    federatedCandidates: [
      {
        memoryId: "mem-fed-duplicate",
        digest: "digest-a",
        statement: "Federated duplicate rule",
        score: 0.99,
        updatedAtMillis: 99,
        sourceSpaceId: "space-source",
        scope: "project" as const,
        shareId: "share-project",
        policyDecisionId: "decision-project",
      },
      {
        memoryId: "mem-fed-job",
        digest: "digest-c",
        statement: "Federated job-role rule",
        score: 0.88,
        updatedAtMillis: 40,
        sourceSpaceId: "space-source",
        scope: "job_role" as const,
        shareId: "share-project",
        policyDecisionId: "decision-job",
      },
      {
        memoryId: "mem-fed-common",
        digest: "digest-d",
        statement: "Federated common rule",
        score: 0.75,
        updatedAtMillis: 50,
        sourceSpaceId: "space-source",
        scope: "common" as const,
        shareId: "share-project",
        policyDecisionId: "decision-common",
      },
    ],
  });

  const before = structuredClone(request);
  const result = await Effect.runPromise(evaluateShadowFederationRead(request));

  assert.equal(result.decision, "allow");
  assert.equal(result.reasonCode, null);
  assert.deepEqual(result.sideEffects, {
    writeCount: 0,
    persistedAuditEventCount: 0,
    mutatedState: false,
  });
  assert.deepEqual(
    result.servedCandidates.map((candidate) => candidate.memoryId),
    ["mem-local-b", "mem-local-a"]
  );
  assert.deepEqual(
    result.shadowCandidates.map((candidate) => candidate.memoryId),
    ["mem-local-b", "mem-local-a", "mem-fed-job", "mem-fed-common"]
  );
  assert.deepEqual(
    result.shadowCandidates.map((candidate) => candidate.provenance.origin),
    ["local", "local", "federated", "federated"]
  );
  assert.deepEqual(request, before);
});

test("ums-memory-6nq.2: shadow federation evaluation denies cross-tenant requests without serving federated candidates", async () => {
  const result = await Effect.runPromise(
    evaluateShadowFederationRead({
      actorTenantId: "tenant-acme",
      sourceTenantId: "tenant-acme",
      targetTenantId: "tenant-other",
      sourceSpaceId: "space-source",
      targetSpaceId: "space-target",
      shareId: "share-project",
      shareScope: "project",
      allowlistedTargetSpaceIds: ["space-target"],
      allowlistedShareIds: ["share-project"],
      selectorMatches: true,
      policyAllows: true,
      evaluatedAtMillis: 1_730_851_200_000,
      localCandidates: [
        {
          memoryId: "mem-local-a",
          digest: "digest-a",
          statement: "Local incumbent rule",
          score: 0.7,
          updatedAtMillis: 20,
          sourceSpaceId: "space-target",
          scope: "local",
          shareId: null,
          policyDecisionId: null,
        },
      ],
      federatedCandidates: [
        {
          memoryId: "mem-fed-a",
          digest: "digest-fed",
          statement: "Forbidden federated rule",
          score: 0.99,
          updatedAtMillis: 99,
          sourceSpaceId: "space-source",
          scope: "project",
          shareId: "share-project",
          policyDecisionId: "decision-project",
        },
      ],
    })
  );

  assert.equal(result.decision, "deny");
  assert.equal(result.reasonCode, "cross_tenant_forbidden");
  assert.deepEqual(
    result.servedCandidates.map((candidate) => candidate.memoryId),
    ["mem-local-a"]
  );
  assert.deepEqual(result.shadowCandidates, []);
  assert.equal(result.auditPreview.eventType, "federation.share.denied");
});
