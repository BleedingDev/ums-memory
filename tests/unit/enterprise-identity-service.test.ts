import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { Effect as EffectOriginal } from "effect";
import ts from "typescript";

const either = (effect: any) =>
  EffectOriginal.result(effect).pipe(
    EffectOriginal.map((result) =>
      result._tag === "Failure"
        ? { _tag: "Left", left: result.failure }
        : { _tag: "Right", right: result.success }
    )
  );

const Effect: any = { ...EffectOriginal, either };

const effectModuleDirectory = new URL(
  "../../libs/shared/src/effect/",
  import.meta.url
);

const transpileEffectModule = (sourceFilename: any, tempDirectory: any) => {
  const sourceFileUrl = new URL(sourceFilename, effectModuleDirectory);
  const source = readFileSync(sourceFileUrl, "utf8");
  const transpiled = ts.transpileModule(source, {
    fileName: sourceFileUrl.pathname,
    reportDiagnostics: true,
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  });

  const diagnostics = transpiled.diagnostics ?? [];
  if (diagnostics.length > 0) {
    const diagnosticMessage = diagnostics
      .map((diagnostic) => {
        const messageText = ts.flattenDiagnosticMessageText(
          diagnostic.messageText,
          "\n"
        );
        const position =
          diagnostic.file === undefined || diagnostic.start === undefined
            ? sourceFilename
            : `${sourceFilename}:${diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1}`;
        return `${position} - ${messageText}`;
      })
      .join("\n");
    throw new Error(
      `TypeScript transpile diagnostics for ${sourceFilename}:\n${diagnosticMessage}`
    );
  }

  const outputFilename = join(
    tempDirectory,
    sourceFilename.replace(/\.ts$/, ".js")
  );
  mkdirSync(dirname(outputFilename), { recursive: true });
  writeFileSync(outputFilename, transpiled.outputText, "utf8");
};

const transpileManifest = Object.freeze([
  "contracts/ids.ts",
  "contracts/domains.ts",
  "contracts/services.ts",
  "contracts/validators.ts",
  "contracts/index.ts",
  "errors.ts",
  "services/authorization-service.ts",
  "services/tenant-routing-service.ts",
  "services/enterprise-identity-service.ts",
]);

let modulesPromise: any;
let transpiledDirectoryPath: any;

const loadModules = async () => {
  if (!modulesPromise) {
    const tempRootDirectory = join(process.cwd(), "dist", "tmp");
    mkdirSync(tempRootDirectory, { recursive: true });
    transpiledDirectoryPath = mkdtempSync(
      join(tempRootDirectory, "ums-memory-enterprise-identity-service-")
    );

    for (const modulePath of transpileManifest) {
      transpileEffectModule(modulePath, transpiledDirectoryPath);
    }

    const moduleUrl = pathToFileURL(
      join(transpiledDirectoryPath, "services/enterprise-identity-service.js")
    ).href;
    modulesPromise = import(moduleUrl).then(
      (enterpriseIdentityServiceModule) => ({
        enterpriseIdentityServiceModule,
      })
    );
  }

  return modulesPromise;
};

process.on("exit", () => {
  if (transpiledDirectoryPath) {
    rmSync(transpiledDirectoryPath, { recursive: true, force: true });
  }
});

const baseIssuerBinding = Object.freeze({
  tenantId: "tenant_alpha",
  issuerBindingId: "issuer-alpha-oidc",
  issuer: "https://idp.alpha.example.com",
  issuerKind: "oidc",
  isPrimary: true,
});

const baseUser = Object.freeze({
  tenantId: "tenant_alpha",
  userId: "user_alpha_1",
  email: "alpha@example.com",
  displayName: "Alpha User",
  status: "active",
  createdAtMillis: 1_700_000_000_000,
  updatedAtMillis: 1_700_000_000_000,
});

const baseSubjectBinding = Object.freeze({
  tenantId: "tenant_alpha",
  issuerBindingId: "issuer-alpha-oidc",
  externalSubjectId: "sub-alpha-1",
  userId: "user_alpha_1",
  subjectHashSha256:
    "8de7f4f7f4f46b9a770f302e2756a30bb4cebc9fda91f00a0d8f26f53f0df8ec",
  subjectSource: "sso",
  firstSeenAtMillis: 1_700_000_000_000,
  lastSeenAtMillis: 1_700_000_000_000,
});

test("ums-memory-wt0.3: resolveSessionBoundary maps issuer subject to tenant-scoped principal deterministically", async () => {
  const { enterpriseIdentityServiceModule } = await loadModules();
  const service =
    enterpriseIdentityServiceModule.makeDeterministicEnterpriseIdentityService();

  const response = await Effect.runPromise(
    service.resolveSessionBoundary({
      issuer: "https://idp.alpha.example.com",
      externalSubjectId: "sub-alpha-1",
      occurredAtMillis: 1_700_100_000_000,
      tenantSlugClaim: "tenant-alpha",
      tenants: [{ tenantId: "tenant_alpha", tenantSlug: "tenant-alpha" }],
      issuerBindings: [baseIssuerBinding],
      users: [baseUser],
      subjectBindings: [baseSubjectBinding],
    })
  );

  assert.equal(response.tenantId, "tenant_alpha");
  assert.equal(response.userId, "user_alpha_1");
  assert.equal(response.routeSource, "tenant_slug_claim");
  assert.equal(response.principalId, "principal:tenant_alpha:user_alpha_1");
  assert.match(response.sessionId, /^session:[0-9a-f]{64}$/);
  assert.equal(response.expiresAtMillis > response.issuedAtMillis, true);
});

test("ums-memory-wt0.3: resolveSessionBoundary rejects unprovisioned subjects", async () => {
  const { enterpriseIdentityServiceModule } = await loadModules();
  const service =
    enterpriseIdentityServiceModule.makeDeterministicEnterpriseIdentityService();

  await assert.rejects(
    () =>
      Effect.runPromise(
        service.resolveSessionBoundary({
          issuer: "https://idp.alpha.example.com",
          externalSubjectId: "sub-missing",
          occurredAtMillis: 1_700_100_000_000,
          tenantIdClaim: "tenant_alpha",
          tenants: [{ tenantId: "tenant_alpha", tenantSlug: "tenant-alpha" }],
          issuerBindings: [baseIssuerBinding],
          users: [baseUser],
          subjectBindings: [baseSubjectBinding],
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
        candidate.contract === "EnterpriseIdentitySessionRequest" &&
        typeof candidate.details === "string" &&
        candidate.details.includes("sub-missing")
      );
    }
  );
});

test("ums-memory-wt0.4: applyScimUserLifecycle enforces idempotent replay and stale-event rejection", async () => {
  const { enterpriseIdentityServiceModule } = await loadModules();
  const service =
    enterpriseIdentityServiceModule.makeDeterministicEnterpriseIdentityService();

  const created = await Effect.runPromise(
    service.applyScimUserLifecycle({
      operation: "create",
      tenantId: "tenant_alpha",
      issuerBindingId: "issuer-alpha-oidc",
      issuer: "https://idp.alpha.example.com",
      externalSubjectId: "sub-scim-alpha-1",
      userId: "user_scim_alpha_1",
      email: "scim-alpha@example.com",
      displayName: "SCIM Alpha",
      cursor: "cursor-001",
      cursorSequence: 1,
      occurredAtMillis: 1_700_200_000_000,
      users: [],
      subjectBindings: [],
      checkpoints: [],
    })
  );
  assert.equal(created.action, "created");
  assert.equal(created.idempotentReplay, false);
  assert.equal(created.user.status, "active");
  assert.equal(created.users.length, 1);
  assert.equal(created.subjectBindings.length, 1);
  assert.equal(created.checkpoints.length, 1);

  const replayed = await Effect.runPromise(
    service.applyScimUserLifecycle({
      operation: "update",
      tenantId: "tenant_alpha",
      issuerBindingId: "issuer-alpha-oidc",
      issuer: "https://idp.alpha.example.com",
      externalSubjectId: "sub-scim-alpha-1",
      userId: "user_scim_alpha_1",
      email: "scim-alpha@example.com",
      displayName: "SCIM Alpha Updated",
      cursor: "cursor-001",
      cursorSequence: 1,
      occurredAtMillis: 1_700_200_100_000,
      users: created.users,
      subjectBindings: created.subjectBindings,
      checkpoints: created.checkpoints,
    })
  );
  assert.equal(replayed.action, "replayed");
  assert.equal(replayed.idempotentReplay, true);
  assert.deepEqual(replayed.users, created.users);
  assert.deepEqual(replayed.checkpoints, created.checkpoints);

  const disabled = await Effect.runPromise(
    service.applyScimUserLifecycle({
      operation: "disable",
      tenantId: "tenant_alpha",
      issuerBindingId: "issuer-alpha-oidc",
      issuer: "https://idp.alpha.example.com",
      externalSubjectId: "sub-scim-alpha-1",
      userId: "user_scim_alpha_1",
      email: "scim-alpha@example.com",
      displayName: "SCIM Alpha Updated",
      cursor: "cursor-002",
      cursorSequence: 2,
      occurredAtMillis: 1_700_200_200_000,
      users: replayed.users,
      subjectBindings: replayed.subjectBindings,
      checkpoints: replayed.checkpoints,
    })
  );
  assert.equal(disabled.action, "disabled");
  assert.equal(disabled.user.status, "disabled");

  const reprovisioned = await Effect.runPromise(
    service.applyScimUserLifecycle({
      operation: "reprovision",
      tenantId: "tenant_alpha",
      issuerBindingId: "issuer-alpha-oidc",
      issuer: "https://idp.alpha.example.com",
      externalSubjectId: "sub-scim-alpha-1",
      userId: "user_scim_alpha_1",
      email: "scim-alpha@example.com",
      displayName: "SCIM Alpha Reprovisioned",
      cursor: "cursor-003",
      cursorSequence: 3,
      occurredAtMillis: 1_700_200_300_000,
      users: disabled.users,
      subjectBindings: disabled.subjectBindings,
      checkpoints: disabled.checkpoints,
    })
  );
  assert.equal(reprovisioned.action, "reprovisioned");
  assert.equal(reprovisioned.user.status, "active");

  await assert.rejects(
    () =>
      Effect.runPromise(
        service.applyScimUserLifecycle({
          operation: "update",
          tenantId: "tenant_alpha",
          issuerBindingId: "issuer-alpha-oidc",
          issuer: "https://idp.alpha.example.com",
          externalSubjectId: "sub-scim-alpha-1",
          userId: "user_scim_alpha_1",
          email: "scim-alpha@example.com",
          displayName: "SCIM Alpha stale",
          cursor: "cursor-001",
          cursorSequence: 1,
          occurredAtMillis: 1_700_200_400_000,
          users: reprovisioned.users,
          subjectBindings: reprovisioned.subjectBindings,
          checkpoints: reprovisioned.checkpoints,
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
        candidate.details.includes("incoming=1 existing=3")
      );
    }
  );
});

test("ums-memory-wt0.5: applyScimGroupReconciliation maps groups to role/project memberships deterministically", async () => {
  const { enterpriseIdentityServiceModule } = await loadModules();
  const service =
    enterpriseIdentityServiceModule.makeDeterministicEnterpriseIdentityService();

  const first = await Effect.runPromise(
    service.applyScimGroupReconciliation({
      tenantId: "tenant_alpha",
      issuerBindingId: "issuer-alpha-oidc",
      issuer: "https://idp.alpha.example.com",
      userId: "user_scim_alpha_1",
      externalGroupIds: [
        "grp-alpha-maintainers",
        "grp-alpha-observers",
        "grp-reviewers",
        "grp-beta",
        "grp-beta",
      ],
      groupBindings: [
        {
          tenantId: "tenant_alpha",
          issuerBindingId: "issuer-alpha-oidc",
          externalGroupId: "grp-alpha-maintainers",
          roleId: "role-maintainer",
          projectId: "project-alpha",
        },
        {
          tenantId: "tenant_alpha",
          issuerBindingId: "issuer-alpha-oidc",
          externalGroupId: "grp-alpha-observers",
          roleId: "role-observer",
          projectId: "project-alpha",
        },
        {
          tenantId: "tenant_alpha",
          issuerBindingId: "issuer-alpha-oidc",
          externalGroupId: "grp-reviewers",
          roleId: "role-reviewer",
          projectId: null,
        },
        {
          tenantId: "tenant_alpha",
          issuerBindingId: "issuer-alpha-oidc",
          externalGroupId: "grp-beta",
          roleId: null,
          projectId: "project-beta",
        },
        {
          tenantId: "tenant_other",
          issuerBindingId: "issuer-alpha-oidc",
          externalGroupId: "grp-alpha-maintainers",
          roleId: "role-foreign",
          projectId: "project-foreign",
        },
      ],
      userRoleAssignments: [
        {
          tenantId: "tenant_alpha",
          userId: "user_scim_alpha_1",
          roleId: "role-legacy",
          assignedAtMillis: 1_700_300_000_000,
          assignedByUserId: "admin-legacy",
        },
        {
          tenantId: "tenant_alpha",
          userId: "user_other",
          roleId: "role-untouched",
          assignedAtMillis: 1_700_300_000_000,
          assignedByUserId: "admin-other",
        },
      ],
      projectMemberships: [
        {
          tenantId: "tenant_alpha",
          projectId: "project-gamma",
          userId: "user_scim_alpha_1",
          roleId: "role-old-project",
          assignedAtMillis: 1_700_300_000_000,
        },
        {
          tenantId: "tenant_alpha",
          projectId: "project-untouched",
          userId: "user_other",
          roleId: null,
          assignedAtMillis: 1_700_300_000_000,
        },
      ],
      checkpoints: [],
      cursor: "groups-cursor-002",
      cursorSequence: 2,
      occurredAtMillis: 1_700_300_100_000,
    })
  );

  assert.equal(first.action, "reconciled");
  assert.equal(first.idempotentReplay, false);
  assert.deepEqual(
    first.userRoleAssignments.filter(
      (record: any) =>
        record.tenantId === "tenant_alpha" &&
        record.userId === "user_scim_alpha_1"
    ),
    [
      {
        tenantId: "tenant_alpha",
        userId: "user_scim_alpha_1",
        roleId: "role-maintainer",
        assignedAtMillis: 1_700_300_100_000,
        assignedByUserId: null,
      },
      {
        tenantId: "tenant_alpha",
        userId: "user_scim_alpha_1",
        roleId: "role-observer",
        assignedAtMillis: 1_700_300_100_000,
        assignedByUserId: null,
      },
      {
        tenantId: "tenant_alpha",
        userId: "user_scim_alpha_1",
        roleId: "role-reviewer",
        assignedAtMillis: 1_700_300_100_000,
        assignedByUserId: null,
      },
    ]
  );
  assert.deepEqual(
    first.projectMemberships.filter(
      (record: any) =>
        record.tenantId === "tenant_alpha" &&
        record.userId === "user_scim_alpha_1"
    ),
    [
      {
        tenantId: "tenant_alpha",
        projectId: "project-alpha",
        userId: "user_scim_alpha_1",
        roleId: "role-maintainer",
        assignedAtMillis: 1_700_300_100_000,
      },
      {
        tenantId: "tenant_alpha",
        projectId: "project-beta",
        userId: "user_scim_alpha_1",
        roleId: null,
        assignedAtMillis: 1_700_300_100_000,
      },
    ]
  );
  assert.ok(
    first.userRoleAssignments.some(
      (record: any) =>
        record.tenantId === "tenant_alpha" &&
        record.userId === "user_other" &&
        record.roleId === "role-untouched"
    )
  );
  assert.ok(
    first.projectMemberships.some(
      (record: any) =>
        record.tenantId === "tenant_alpha" &&
        record.userId === "user_other" &&
        record.projectId === "project-untouched"
    )
  );
  assert.equal(first.checkpoints.length, 1);
  assert.equal(first.checkpoints[0]?.syncChannel, "scim_groups");

  const replayed = await Effect.runPromise(
    service.applyScimGroupReconciliation({
      tenantId: "tenant_alpha",
      issuerBindingId: "issuer-alpha-oidc",
      issuer: "https://idp.alpha.example.com",
      userId: "user_scim_alpha_1",
      externalGroupIds: [],
      groupBindings: [],
      userRoleAssignments: first.userRoleAssignments,
      projectMemberships: first.projectMemberships,
      checkpoints: first.checkpoints,
      cursor: "groups-cursor-002",
      cursorSequence: 2,
      occurredAtMillis: 1_700_300_110_000,
    })
  );
  assert.equal(replayed.action, "replayed");
  assert.equal(replayed.idempotentReplay, true);
  assert.deepEqual(replayed.userRoleAssignments, first.userRoleAssignments);
  assert.deepEqual(replayed.projectMemberships, first.projectMemberships);

  await assert.rejects(
    () =>
      Effect.runPromise(
        service.applyScimGroupReconciliation({
          tenantId: "tenant_alpha",
          issuerBindingId: "issuer-alpha-oidc",
          issuer: "https://idp.alpha.example.com",
          userId: "user_scim_alpha_1",
          externalGroupIds: ["grp-reviewers"],
          groupBindings: [
            {
              tenantId: "tenant_alpha",
              issuerBindingId: "issuer-alpha-oidc",
              externalGroupId: "grp-reviewers",
              roleId: "role-reviewer",
              projectId: null,
            },
          ],
          userRoleAssignments: replayed.userRoleAssignments,
          projectMemberships: replayed.projectMemberships,
          checkpoints: replayed.checkpoints,
          cursor: "groups-cursor-001",
          cursorSequence: 1,
          occurredAtMillis: 1_700_300_120_000,
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
        candidate.contract === "ScimGroupReconciliationRequest" &&
        typeof candidate.details === "string" &&
        candidate.details.includes("incoming=1 existing=2")
      );
    }
  );
});

test("ums-memory-wt0.6: evaluateAuthorization integrates enterprise identity assignments and fails closed cross-tenant", async () => {
  const { enterpriseIdentityServiceModule } = await loadModules();
  const service =
    enterpriseIdentityServiceModule.makeDeterministicEnterpriseIdentityService();

  const allowed = await Effect.runPromise(
    service.evaluateAuthorization({
      tenantId: "tenant_alpha",
      userId: "user_scim_alpha_1",
      action: "memory.write",
      resourceTenantId: "tenant_alpha",
      resourceProjectId: "project-alpha",
      userRoleAssignments: [
        {
          tenantId: "tenant_alpha",
          userId: "user_scim_alpha_1",
          roleId: "role-reviewer",
          assignedAtMillis: 1_700_400_000_000,
          assignedByUserId: null,
        },
      ],
      projectMemberships: [
        {
          tenantId: "tenant_alpha",
          projectId: "project-alpha",
          userId: "user_scim_alpha_1",
          roleId: "role-maintainer",
          assignedAtMillis: 1_700_400_000_000,
        },
      ],
    })
  );
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.role, "lead");
  assert.equal(allowed.crossTenantDenied, false);

  const deniedCrossTenant = await Effect.runPromise(
    service.evaluateAuthorization({
      tenantId: "tenant_alpha",
      userId: "user_scim_alpha_1",
      action: "memory.read",
      resourceTenantId: "tenant_other",
      userRoleAssignments: [
        {
          tenantId: "tenant_alpha",
          userId: "user_scim_alpha_1",
          roleId: "role-admin",
          assignedAtMillis: 1_700_400_000_000,
          assignedByUserId: null,
        },
      ],
      projectMemberships: [],
    })
  );
  assert.equal(deniedCrossTenant.allowed, false);
  assert.equal(deniedCrossTenant.crossTenantDenied, true);

  const deniedAction = await Effect.runPromise(
    service.evaluateAuthorization({
      tenantId: "tenant_alpha",
      userId: "user_scim_alpha_1",
      action: "policy.write",
      resourceTenantId: "tenant_alpha",
      userRoleAssignments: [],
      projectMemberships: [],
    })
  );
  assert.equal(deniedAction.allowed, false);
  assert.equal(deniedAction.role, "dev");
  assert.equal(deniedAction.reasonCode, "RBAC_DENY_ROLE_ACTION");
});

test("ums-memory-wt0.7: identity responses emit deterministic login/provision/sync audit events", async () => {
  const { enterpriseIdentityServiceModule } = await loadModules();
  const service =
    enterpriseIdentityServiceModule.makeDeterministicEnterpriseIdentityService();

  const session = await Effect.runPromise(
    service.resolveSessionBoundary({
      issuer: "https://idp.alpha.example.com",
      externalSubjectId: "sub-alpha-1",
      occurredAtMillis: 1_700_500_000_000,
      tenantIdClaim: "tenant_alpha",
      tenants: [{ tenantId: "tenant_alpha", tenantSlug: "tenant-alpha" }],
      issuerBindings: [baseIssuerBinding],
      users: [baseUser],
      subjectBindings: [baseSubjectBinding],
    })
  );
  assert.deepEqual(
    session.auditEvents.map((event: any) => event.eventType),
    ["identity.sso.login"]
  );

  const userLifecycle = await Effect.runPromise(
    service.applyScimUserLifecycle({
      operation: "create",
      tenantId: "tenant_alpha",
      issuerBindingId: "issuer-alpha-oidc",
      issuer: "https://idp.alpha.example.com",
      externalSubjectId: "sub-scim-audit-1",
      userId: "user_scim_audit_1",
      email: "scim-audit@example.com",
      displayName: "SCIM Audit",
      cursor: "cursor-audit-001",
      cursorSequence: 1,
      occurredAtMillis: 1_700_500_100_000,
      users: [],
      subjectBindings: [],
      checkpoints: [],
    })
  );
  assert.deepEqual(
    userLifecycle.auditEvents.map((event: any) => event.eventType),
    ["identity.user.provision", "identity.user.sync"]
  );

  const groupLifecycle = await Effect.runPromise(
    service.applyScimGroupReconciliation({
      tenantId: "tenant_alpha",
      issuerBindingId: "issuer-alpha-oidc",
      issuer: "https://idp.alpha.example.com",
      userId: "user_scim_audit_1",
      externalGroupIds: ["grp-audit-maintainers"],
      groupBindings: [
        {
          tenantId: "tenant_alpha",
          issuerBindingId: "issuer-alpha-oidc",
          externalGroupId: "grp-audit-maintainers",
          roleId: "role-maintainer",
          projectId: "project-audit",
        },
      ],
      userRoleAssignments: [],
      projectMemberships: [],
      checkpoints: userLifecycle.checkpoints,
      cursor: "cursor-audit-groups-001",
      cursorSequence: 1,
      occurredAtMillis: 1_700_500_200_000,
    })
  );
  assert.deepEqual(
    groupLifecycle.auditEvents.map((event: any) => event.eventType),
    ["identity.group.sync", "identity.user.sync"]
  );
});
