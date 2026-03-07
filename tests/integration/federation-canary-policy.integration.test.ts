import assert from "node:assert/strict";

import { test } from "@effect-native/bun-test";
import { Effect } from "effect";

import { evaluateFederationCanaryRoute } from "../../apps/api/src/federation/canary-routing.ts";

const baseRequest = Object.freeze({
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
});

test("ums-memory-6nq.3: canary routing allows same-tenant allowlisted requests and emits deterministic audit", async () => {
  const result = await Effect.runPromise(
    evaluateFederationCanaryRoute(baseRequest)
  );

  assert.deepEqual(result, {
    decision: "allow",
    reasonCode: null,
    auditEvent: {
      eventType: "federation.share.allowed",
      decision: "allow",
      reasonCode: null,
      actorTenantId: "tenant-acme",
      sourceTenantId: "tenant-acme",
      targetTenantId: "tenant-acme",
      sourceSpaceId: "space-source",
      targetSpaceId: "space-target",
      shareId: "share-project",
      shareScope: "project",
      evaluatedAtMillis: 1_730_851_200_000,
    },
  });
});

test("ums-memory-6nq.3: canary routing denies every blocked path with complete deterministic reason codes", async () => {
  const cases = [
    {
      name: "cross-tenant",
      request: {
        ...baseRequest,
        targetTenantId: "tenant-other",
      },
      reasonCode: "cross_tenant_forbidden",
    },
    {
      name: "space-not-allowlisted",
      request: {
        ...baseRequest,
        allowlistedTargetSpaceIds: [],
      },
      reasonCode: "space_not_allowlisted",
    },
    {
      name: "share-not-allowlisted",
      request: {
        ...baseRequest,
        allowlistedShareIds: [],
      },
      reasonCode: "share_not_allowlisted",
    },
    {
      name: "selector-mismatch",
      request: {
        ...baseRequest,
        selectorMatches: false,
      },
      reasonCode: "selector_mismatch",
    },
    {
      name: "policy-deny",
      request: {
        ...baseRequest,
        policyAllows: false,
      },
      reasonCode: "policy_deny",
    },
    {
      name: "user-scope-without-explicit-mapping",
      request: {
        ...baseRequest,
        shareId: "share-user",
        shareScope: "user" as const,
        allowlistedShareIds: ["share-user"],
      },
      reasonCode: "selector_mismatch",
    },
  ] as const;

  const results = await Effect.runPromise(
    Effect.forEach(cases, (entry) =>
      evaluateFederationCanaryRoute(entry.request)
    )
  );

  assert.deepEqual(
    results.map((result, index) => ({
      case: cases[index]?.name,
      decision: result.decision,
      reasonCode: result.reasonCode,
      eventType: result.auditEvent.eventType,
    })),
    [
      {
        case: "cross-tenant",
        decision: "deny",
        reasonCode: "cross_tenant_forbidden",
        eventType: "federation.share.denied",
      },
      {
        case: "space-not-allowlisted",
        decision: "deny",
        reasonCode: "space_not_allowlisted",
        eventType: "federation.share.denied",
      },
      {
        case: "share-not-allowlisted",
        decision: "deny",
        reasonCode: "share_not_allowlisted",
        eventType: "federation.share.denied",
      },
      {
        case: "selector-mismatch",
        decision: "deny",
        reasonCode: "selector_mismatch",
        eventType: "federation.share.denied",
      },
      {
        case: "policy-deny",
        decision: "deny",
        reasonCode: "policy_deny",
        eventType: "federation.share.denied",
      },
      {
        case: "user-scope-without-explicit-mapping",
        decision: "deny",
        reasonCode: "selector_mismatch",
        eventType: "federation.share.denied",
      },
    ]
  );
});
