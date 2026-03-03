import assert from "node:assert/strict";
import test from "node:test";

import { Effect } from "effect";

import type {
  TenantId,
  UserId,
} from "../../libs/shared/src/effect/contracts/ids.ts";
import {
  makeDeterministicEnterpriseIdentityService,
  type EnterpriseIdentityExternalSubjectRecord,
  type EnterpriseIdentityProjectMembershipRecord,
  type EnterpriseIdentitySyncCheckpointRecord,
  type EnterpriseIdentityUserRecord,
  type EnterpriseIdentityUserRoleAssignmentRecord,
} from "../../libs/shared/src/effect/services/enterprise-identity-service.ts";

test("ums-memory-wt0.8: Better Auth + SCIM integration contract covers allow/deny, replay, stale rejection, and tenant isolation", async () => {
  const service = makeDeterministicEnterpriseIdentityService();

  const tenantId = "tenant_alpha" as TenantId;
  const userId = "user_wt0_8_alpha" as UserId;
  const otherTenantId = "tenant_other" as TenantId;
  const issuer = "https://idp.alpha.example.com" as const;
  const issuerBinding = {
    tenantId,
    issuerBindingId: "issuer-alpha-oidc",
    issuer,
    issuerKind: "oidc" as const,
    isPrimary: true,
  };

  let users: readonly EnterpriseIdentityUserRecord[] = [];
  let subjectBindings: readonly EnterpriseIdentityExternalSubjectRecord[] = [];
  let checkpoints: readonly EnterpriseIdentitySyncCheckpointRecord[] = [];
  let userRoleAssignments: readonly EnterpriseIdentityUserRoleAssignmentRecord[] =
    [];
  let projectMemberships: readonly EnterpriseIdentityProjectMembershipRecord[] =
    [];

  const created = await Effect.runPromise(
    service.applyScimUserLifecycle({
      operation: "create",
      tenantId,
      issuerBindingId: issuerBinding.issuerBindingId,
      issuer,
      externalSubjectId: "sub-wt0-8-alpha",
      userId,
      email: "wt0-8-alpha@example.com",
      displayName: "WT0.8 Alpha",
      cursor: "cursor-users-001",
      cursorSequence: 1,
      occurredAtMillis: 1_700_600_000_000,
      users,
      subjectBindings,
      checkpoints,
    })
  );
  users = created.users;
  subjectBindings = created.subjectBindings;
  checkpoints = created.checkpoints;
  assert.equal(created.action, "created");

  const replayed = await Effect.runPromise(
    service.applyScimUserLifecycle({
      operation: "update",
      tenantId,
      issuerBindingId: issuerBinding.issuerBindingId,
      issuer,
      externalSubjectId: "sub-wt0-8-alpha",
      userId,
      email: "wt0-8-alpha@example.com",
      displayName: "WT0.8 Alpha Replay",
      cursor: "cursor-users-001",
      cursorSequence: 1,
      occurredAtMillis: 1_700_600_000_010,
      users,
      subjectBindings,
      checkpoints,
    })
  );
  assert.equal(replayed.action, "replayed");

  const groupReconciled = await Effect.runPromise(
    service.applyScimGroupReconciliation({
      tenantId,
      issuerBindingId: issuerBinding.issuerBindingId,
      issuer,
      userId,
      externalGroupIds: ["grp-maintainers", "grp-reviewers"],
      groupBindings: [
        {
          tenantId,
          issuerBindingId: issuerBinding.issuerBindingId,
          externalGroupId: "grp-maintainers",
          roleId: "role-maintainer",
          projectId: "project-alpha",
        },
        {
          tenantId,
          issuerBindingId: issuerBinding.issuerBindingId,
          externalGroupId: "grp-reviewers",
          roleId: "role-reviewer",
          projectId: null,
        },
      ],
      userRoleAssignments,
      projectMemberships,
      checkpoints,
      cursor: "cursor-groups-002",
      cursorSequence: 2,
      occurredAtMillis: 1_700_600_000_100,
    })
  );
  userRoleAssignments = groupReconciled.userRoleAssignments;
  projectMemberships = groupReconciled.projectMemberships;
  checkpoints = groupReconciled.checkpoints;
  assert.equal(groupReconciled.action, "reconciled");

  const groupReplay = await Effect.runPromise(
    service.applyScimGroupReconciliation({
      tenantId,
      issuerBindingId: issuerBinding.issuerBindingId,
      issuer,
      userId,
      externalGroupIds: [],
      groupBindings: [],
      userRoleAssignments,
      projectMemberships,
      checkpoints,
      cursor: "cursor-groups-002",
      cursorSequence: 2,
      occurredAtMillis: 1_700_600_000_101,
    })
  );
  assert.equal(groupReplay.action, "replayed");

  const session = await Effect.runPromise(
    service.resolveSessionBoundary({
      issuer,
      externalSubjectId: "sub-wt0-8-alpha",
      occurredAtMillis: 1_700_600_000_200,
      tenantIdClaim: tenantId,
      tenants: [{ tenantId, tenantSlug: "tenant-alpha" }],
      issuerBindings: [issuerBinding],
      users,
      subjectBindings,
    })
  );
  assert.equal(session.tenantId, tenantId);
  assert.equal(session.userId, userId);

  const allow = await Effect.runPromise(
    service.evaluateAuthorization({
      tenantId,
      userId,
      action: "memory.write",
      resourceTenantId: tenantId,
      resourceProjectId: "project-alpha",
      userRoleAssignments,
      projectMemberships,
    })
  );
  assert.equal(allow.allowed, true);

  const denyCrossTenant = await Effect.runPromise(
    service.evaluateAuthorization({
      tenantId,
      userId,
      action: "memory.read",
      resourceTenantId: otherTenantId,
      userRoleAssignments,
      projectMemberships,
    })
  );
  assert.equal(denyCrossTenant.allowed, false);
  assert.equal(denyCrossTenant.crossTenantDenied, true);

  await assert.rejects(
    () =>
      Effect.runPromise(
        service.applyScimUserLifecycle({
          operation: "update",
          tenantId,
          issuerBindingId: issuerBinding.issuerBindingId,
          issuer,
          externalSubjectId: "sub-wt0-8-alpha",
          userId,
          email: "wt0-8-alpha@example.com",
          displayName: "WT0.8 Alpha stale",
          cursor: "cursor-users-stale",
          cursorSequence: 0,
          occurredAtMillis: 1_700_600_000_300,
          users,
          subjectBindings,
          checkpoints,
        })
      ),
    (error) => {
      const candidate = error as {
        readonly _tag?: any;
        readonly contract?: any;
        readonly details?: any;
      };
      return (
        candidate._tag === "ContractValidationError" &&
        candidate.contract === "ScimUserLifecycleRequest" &&
        typeof candidate.details === "string" &&
        candidate.details.includes("incoming=0 existing=1")
      );
    }
  );
});
