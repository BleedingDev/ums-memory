import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { test } from "@effect-native/bun-test";
import { Effect } from "effect";

import { evaluateFederationCanaryRoute } from "../../apps/api/src/federation/canary-routing.ts";

const RUNBOOK_PATH = path.resolve(
  process.cwd(),
  "docs/runbooks/cross-repo-memory-federation-model.md"
);

const REQUIRED_GA_REFERENCES = Object.freeze([
  "## Implementation Appendix",
  "## GA Readiness Criteria",
  "docs/runbooks/federation-go-no-go-decision.md",
  "bun run ci:verify",
  "tests/integration/federation-shadow-eval.integration.test.ts",
  "tests/integration/federation-canary-policy.integration.test.ts",
  "tests/integration/federation-ga-readiness.integration.test.ts",
  "cross-tenant paths remain impossible",
  "ums-memory-thq",
  "ums-memory-jny",
  "ums-memory-onf",
]);

const readRunbook = () =>
  Effect.runSync(Effect.sync(() => readFileSync(RUNBOOK_PATH, "utf8")));

test("ums-memory-6nq.4: federation runbook publishes implementation appendix and GA criteria", () => {
  const runbook = readRunbook();

  for (const reference of REQUIRED_GA_REFERENCES) {
    assert.match(
      runbook,
      new RegExp(reference.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"),
      `Missing GA readiness reference: ${reference}`
    );
  }
});

test("ums-memory-6nq.4: GA readiness keeps cross-tenant federation impossible", async () => {
  const result = await Effect.runPromise(
    evaluateFederationCanaryRoute({
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
    })
  );

  assert.equal(result.decision, "deny");
  assert.equal(result.reasonCode, "cross_tenant_forbidden");
  assert.equal(result.auditEvent.eventType, "federation.share.denied");
});
