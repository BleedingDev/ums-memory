import { createHash } from "node:crypto";

import { Effect, Layer, ServiceMap } from "effect";

import type {
  AuthorizationAction,
  AuthorizationDecisionReasonCode,
  AuthorizationRole,
  TenantCatalogEntry,
  TenantId,
  TenantRouteResolutionSource,
  UserId,
} from "../contracts/index.js";
import {
  ContractValidationError,
  type TenantRoutingServiceError,
} from "../errors.js";
import {
  makeRuntimeAuthorizationService,
  type AuthorizationService,
} from "./authorization-service.js";
import {
  makeRuntimeTenantRoutingService,
  type TenantRoutingService,
} from "./tenant-routing-service.js";

type UserStatus = "active" | "disabled" | "pending";
type IdentityIssuerKind = "oidc" | "saml" | "scim";
type IdentitySubjectSource = "sso" | "scim" | "manual";
type IdentitySyncChannel = "scim_users" | "scim_groups";
type EnterpriseIdentityAuditEventType =
  | "identity.sso.login"
  | "identity.user.provision"
  | "identity.user.sync"
  | "identity.group.sync";

type EnterpriseIdentityAuditEventDetailValue = string | number | boolean | null;

export interface EnterpriseIdentityAuditEvent {
  readonly eventType: EnterpriseIdentityAuditEventType;
  readonly tenantId: TenantId;
  readonly userId: UserId | null;
  readonly occurredAtMillis: number;
  readonly details: Readonly<
    Record<string, EnterpriseIdentityAuditEventDetailValue>
  >;
}

export interface EnterpriseIdentityIssuerBinding {
  readonly tenantId: TenantId;
  readonly issuerBindingId: string;
  readonly issuer: string;
  readonly issuerKind: IdentityIssuerKind;
  readonly isPrimary: boolean;
}

export interface EnterpriseIdentityUserRecord {
  readonly tenantId: TenantId;
  readonly userId: UserId;
  readonly email: string;
  readonly displayName: string;
  readonly status: UserStatus;
  readonly createdAtMillis: number;
  readonly updatedAtMillis: number;
}

export interface EnterpriseIdentityExternalSubjectRecord {
  readonly tenantId: TenantId;
  readonly issuerBindingId: string;
  readonly externalSubjectId: string;
  readonly userId: UserId;
  readonly subjectHashSha256: string;
  readonly subjectSource: IdentitySubjectSource;
  readonly firstSeenAtMillis: number;
  readonly lastSeenAtMillis: number;
}

export interface EnterpriseIdentitySyncCheckpointRecord {
  readonly tenantId: TenantId;
  readonly issuerBindingId: string;
  readonly syncChannel: IdentitySyncChannel;
  readonly checkpointCursor: string;
  readonly cursorHashSha256: string;
  readonly cursorSequence: number;
  readonly checkpointedAtMillis: number;
  readonly updatedAtMillis: number;
}

export interface EnterpriseIdentityUserRoleAssignmentRecord {
  readonly tenantId: TenantId;
  readonly userId: UserId;
  readonly roleId: string;
  readonly assignedAtMillis: number;
  readonly assignedByUserId: string | null;
}

export interface EnterpriseIdentityProjectMembershipRecord {
  readonly tenantId: TenantId;
  readonly projectId: string;
  readonly userId: UserId;
  readonly roleId: string | null;
  readonly assignedAtMillis: number;
}

export interface EnterpriseIdentityScimGroupBinding {
  readonly tenantId: TenantId;
  readonly issuerBindingId: string;
  readonly externalGroupId: string;
  readonly roleId: string | null;
  readonly projectId: string | null;
}

export interface EnterpriseIdentitySessionRequest {
  readonly issuer: string;
  readonly externalSubjectId: string;
  readonly occurredAtMillis: number;
  readonly tenantIdClaim?: TenantId;
  readonly tenantSlugClaim?: string;
  readonly sessionTtlMillis?: number;
  readonly tenants: readonly TenantCatalogEntry[];
  readonly issuerBindings: readonly EnterpriseIdentityIssuerBinding[];
  readonly users: readonly EnterpriseIdentityUserRecord[];
  readonly subjectBindings: readonly EnterpriseIdentityExternalSubjectRecord[];
}

export interface EnterpriseIdentitySessionResponse {
  readonly sessionId: string;
  readonly principalId: string;
  readonly tenantId: TenantId;
  readonly userId: UserId;
  readonly routeSource: TenantRouteResolutionSource;
  readonly expiresAtMillis: number;
  readonly issuedAtMillis: number;
  readonly auditEvents: readonly EnterpriseIdentityAuditEvent[];
}

export type ScimUserLifecycleOperation =
  | "create"
  | "update"
  | "disable"
  | "reprovision";

export interface ScimUserLifecycleRequest {
  readonly operation: ScimUserLifecycleOperation;
  readonly tenantId: TenantId;
  readonly issuerBindingId: string;
  readonly issuer: string;
  readonly externalSubjectId: string;
  readonly userId: UserId;
  readonly email: string;
  readonly displayName: string;
  readonly cursor: string;
  readonly cursorSequence: number;
  readonly occurredAtMillis: number;
  readonly users: readonly EnterpriseIdentityUserRecord[];
  readonly subjectBindings: readonly EnterpriseIdentityExternalSubjectRecord[];
  readonly checkpoints: readonly EnterpriseIdentitySyncCheckpointRecord[];
}

export interface ScimUserLifecycleResponse {
  readonly operation: ScimUserLifecycleOperation;
  readonly action:
    | "created"
    | "updated"
    | "disabled"
    | "reprovisioned"
    | "replayed";
  readonly staleRejected: boolean;
  readonly idempotentReplay: boolean;
  readonly user: EnterpriseIdentityUserRecord;
  readonly users: readonly EnterpriseIdentityUserRecord[];
  readonly subjectBindings: readonly EnterpriseIdentityExternalSubjectRecord[];
  readonly checkpoints: readonly EnterpriseIdentitySyncCheckpointRecord[];
  readonly auditEvents: readonly EnterpriseIdentityAuditEvent[];
}

export interface ScimGroupReconciliationRequest {
  readonly tenantId: TenantId;
  readonly issuerBindingId: string;
  readonly issuer: string;
  readonly userId: UserId;
  readonly externalGroupIds: readonly string[];
  readonly groupBindings: readonly EnterpriseIdentityScimGroupBinding[];
  readonly userRoleAssignments: readonly EnterpriseIdentityUserRoleAssignmentRecord[];
  readonly projectMemberships: readonly EnterpriseIdentityProjectMembershipRecord[];
  readonly checkpoints: readonly EnterpriseIdentitySyncCheckpointRecord[];
  readonly cursor: string;
  readonly cursorSequence: number;
  readonly occurredAtMillis: number;
}

export interface ScimGroupReconciliationResponse {
  readonly action: "reconciled" | "replayed";
  readonly staleRejected: boolean;
  readonly idempotentReplay: boolean;
  readonly userRoleAssignments: readonly EnterpriseIdentityUserRoleAssignmentRecord[];
  readonly projectMemberships: readonly EnterpriseIdentityProjectMembershipRecord[];
  readonly checkpoints: readonly EnterpriseIdentitySyncCheckpointRecord[];
  readonly auditEvents: readonly EnterpriseIdentityAuditEvent[];
}

export interface EnterpriseIdentityAuthorizationRequest {
  readonly tenantId: TenantId;
  readonly userId: UserId;
  readonly action: AuthorizationAction;
  readonly resourceTenantId: TenantId;
  readonly resourceProjectId?: string;
  readonly userRoleAssignments: readonly EnterpriseIdentityUserRoleAssignmentRecord[];
  readonly projectMemberships: readonly EnterpriseIdentityProjectMembershipRecord[];
}

export interface EnterpriseIdentityAuthorizationResponse {
  readonly tenantId: TenantId;
  readonly userId: UserId;
  readonly action: AuthorizationAction;
  readonly role: AuthorizationRole;
  readonly allowed: boolean;
  readonly reasonCode: AuthorizationDecisionReasonCode;
  readonly crossTenantDenied: boolean;
  readonly evaluatedAtMillis: number;
}

export interface EnterpriseIdentityService {
  readonly resolveSessionBoundary: (
    request: EnterpriseIdentitySessionRequest
  ) => Effect.Effect<
    EnterpriseIdentitySessionResponse,
    ContractValidationError | TenantRoutingServiceError
  >;
  readonly applyScimUserLifecycle: (
    request: ScimUserLifecycleRequest
  ) => Effect.Effect<ScimUserLifecycleResponse, ContractValidationError>;
  readonly applyScimGroupReconciliation: (
    request: ScimGroupReconciliationRequest
  ) => Effect.Effect<ScimGroupReconciliationResponse, ContractValidationError>;
  readonly evaluateAuthorization: (
    request: EnterpriseIdentityAuthorizationRequest
  ) => Effect.Effect<
    EnterpriseIdentityAuthorizationResponse,
    ContractValidationError
  >;
}

export const EnterpriseIdentityServiceTag =
  ServiceMap.Service<EnterpriseIdentityService>(
    "@ums/effect/EnterpriseIdentityService"
  );

const defaultSessionTtlMillis = 8 * 60 * 60 * 1_000;
const scimUsersSyncChannel: IdentitySyncChannel = "scim_users";
const scimGroupsSyncChannel: IdentitySyncChannel = "scim_groups";

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const normalizeTrimmedNonEmpty = (
  value: string,
  contract: string,
  field: string
): string => {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new ContractValidationError({
      contract,
      message: `${field} must be a non-empty trimmed string.`,
      details: `${field} received an empty or whitespace-only value.`,
    });
  }
  return normalized;
};

const normalizeEmail = (
  value: string,
  contract: string,
  field: string
): string => {
  const normalized = normalizeTrimmedNonEmpty(value, contract, field);
  if (!normalized.includes("@")) {
    throw new ContractValidationError({
      contract,
      message: `${field} must contain '@'.`,
      details: `${field} "${normalized}" is not a valid email-like identifier.`,
    });
  }
  return normalized.toLowerCase();
};

const normalizeSequence = (
  value: number,
  contract: string,
  field: string
): number => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ContractValidationError({
      contract,
      message: `${field} must be a non-negative safe integer.`,
      details: `${field} received ${String(value)}.`,
    });
  }
  return value;
};

const normalizeMillis = (
  value: number,
  contract: string,
  field: string
): number => normalizeSequence(value, contract, field);

const toSortedUsers = (
  users: readonly EnterpriseIdentityUserRecord[]
): readonly EnterpriseIdentityUserRecord[] =>
  Object.freeze(
    [...users].sort((left, right) =>
      `${left.tenantId}:${left.userId}`.localeCompare(
        `${right.tenantId}:${right.userId}`
      )
    )
  );

const toSortedSubjectBindings = (
  subjectBindings: readonly EnterpriseIdentityExternalSubjectRecord[]
): readonly EnterpriseIdentityExternalSubjectRecord[] =>
  Object.freeze(
    [...subjectBindings].sort((left, right) =>
      `${left.tenantId}:${left.issuerBindingId}:${left.externalSubjectId}`.localeCompare(
        `${right.tenantId}:${right.issuerBindingId}:${right.externalSubjectId}`
      )
    )
  );

const toSortedCheckpoints = (
  checkpoints: readonly EnterpriseIdentitySyncCheckpointRecord[]
): readonly EnterpriseIdentitySyncCheckpointRecord[] =>
  Object.freeze(
    [...checkpoints].sort((left, right) =>
      `${left.tenantId}:${left.issuerBindingId}:${left.syncChannel}`.localeCompare(
        `${right.tenantId}:${right.issuerBindingId}:${right.syncChannel}`
      )
    )
  );

const toSortedUserRoleAssignments = (
  userRoleAssignments: readonly EnterpriseIdentityUserRoleAssignmentRecord[]
): readonly EnterpriseIdentityUserRoleAssignmentRecord[] =>
  Object.freeze(
    [...userRoleAssignments].sort((left, right) =>
      `${left.tenantId}:${left.userId}:${left.roleId}`.localeCompare(
        `${right.tenantId}:${right.userId}:${right.roleId}`
      )
    )
  );

const toSortedProjectMemberships = (
  projectMemberships: readonly EnterpriseIdentityProjectMembershipRecord[]
): readonly EnterpriseIdentityProjectMembershipRecord[] =>
  Object.freeze(
    [...projectMemberships].sort((left, right) =>
      `${left.tenantId}:${left.userId}:${left.projectId}:${left.roleId ?? ""}`.localeCompare(
        `${right.tenantId}:${right.userId}:${right.projectId}:${right.roleId ?? ""}`
      )
    )
  );

const toCursorHash = (cursor: string): string => sha256(cursor);

const toSessionId = (
  tenantId: TenantId,
  userId: UserId,
  issuerBindingId: string,
  externalSubjectId: string,
  issuedAtMillis: number
): string =>
  `session:${sha256(
    [
      tenantId,
      userId,
      issuerBindingId,
      externalSubjectId,
      String(issuedAtMillis),
    ].join("\n")
  )}`;

const toPrincipalId = (tenantId: TenantId, userId: UserId): string =>
  `principal:${tenantId}:${userId}`;

const createEnterpriseIdentityAuditEvent = (event: {
  readonly eventType: EnterpriseIdentityAuditEventType;
  readonly tenantId: TenantId;
  readonly userId: UserId | null;
  readonly occurredAtMillis: number;
  readonly details: Record<string, EnterpriseIdentityAuditEventDetailValue>;
}): EnterpriseIdentityAuditEvent =>
  Object.freeze({
    eventType: event.eventType,
    tenantId: event.tenantId,
    userId: event.userId,
    occurredAtMillis: event.occurredAtMillis,
    details: Object.freeze({
      ...event.details,
    }),
  });

const authorizationRoleRank: Readonly<Record<AuthorizationRole, number>> =
  Object.freeze({
    admin: 4,
    lead: 3,
    dev: 2,
    auditor: 1,
  });

const toAuthorizationRoleFromRoleId = (
  roleId: string | null
): AuthorizationRole | null => {
  if (roleId === null) {
    return null;
  }
  const normalized = roleId.trim().toLowerCase();
  if (normalized.length === 0) {
    return null;
  }
  if (normalized.includes("admin")) {
    return "admin";
  }
  if (
    normalized.includes("lead") ||
    normalized.includes("maintainer") ||
    normalized.includes("owner")
  ) {
    return "lead";
  }
  if (
    normalized.includes("audit") ||
    normalized.includes("compliance") ||
    normalized.includes("read_only")
  ) {
    return "auditor";
  }
  return "dev";
};

const toSortedCandidateAuthorizationRoles = (
  roleIds: readonly string[]
): readonly AuthorizationRole[] => {
  const set = new Set<AuthorizationRole>();
  for (const roleId of roleIds) {
    const mappedRole = toAuthorizationRoleFromRoleId(roleId);
    if (mappedRole !== null) {
      set.add(mappedRole);
    }
  }
  if (set.size === 0) {
    set.add("dev");
  }
  return Object.freeze(
    [...set].sort((left, right) => {
      const byRank = authorizationRoleRank[right] - authorizationRoleRank[left];
      if (byRank !== 0) {
        return byRank;
      }
      return left.localeCompare(right);
    })
  );
};

export interface EnterpriseIdentityServiceOptions {
  readonly tenantRoutingService?: TenantRoutingService;
  readonly authorizationService?: AuthorizationService;
  readonly sessionTtlMillis?: number;
}

export const makeEnterpriseIdentityService = (
  options: EnterpriseIdentityServiceOptions = {}
): EnterpriseIdentityService => {
  const tenantRoutingService =
    options.tenantRoutingService ?? makeRuntimeTenantRoutingService();
  const authorizationService =
    options.authorizationService ?? makeRuntimeAuthorizationService();
  const configuredTtlMillis =
    options.sessionTtlMillis ?? defaultSessionTtlMillis;
  const sessionTtlMillis = Math.max(1, configuredTtlMillis);

  return {
    resolveSessionBoundary: (request) =>
      Effect.suspend(() => {
        const contract = "EnterpriseIdentitySessionRequest";
        const issuer = normalizeTrimmedNonEmpty(
          request.issuer,
          contract,
          "issuer"
        ).toLowerCase();
        const externalSubjectId = normalizeTrimmedNonEmpty(
          request.externalSubjectId,
          contract,
          "externalSubjectId"
        );
        const issuedAtMillis = normalizeMillis(
          request.occurredAtMillis,
          contract,
          "occurredAtMillis"
        );
        const ttlMillis =
          request.sessionTtlMillis === undefined
            ? sessionTtlMillis
            : Math.max(
                1,
                normalizeMillis(
                  request.sessionTtlMillis,
                  contract,
                  "sessionTtlMillis"
                )
              );

        const tenantRoutingBindings = request.issuerBindings.map((binding) => ({
          issuer: binding.issuer,
          tenantId: binding.tenantId,
        }));

        return Effect.flatMap(
          tenantRoutingService.assertResolved({
            tenantIdClaim: request.tenantIdClaim,
            tenantSlugClaim: request.tenantSlugClaim,
            issuer,
            tenants: [...request.tenants],
            issuerBindings: tenantRoutingBindings,
          }),
          (resolution) =>
            Effect.sync(() => {
              const resolvedTenantId = resolution.tenantId;
              if (resolvedTenantId === undefined) {
                throw new ContractValidationError({
                  contract,
                  message: "Tenant routing did not resolve a tenantId.",
                  details:
                    "resolveSessionBoundary requires tenant routing to produce a tenantId.",
                });
              }
              const routeSource = resolution.source;
              if (routeSource === undefined) {
                throw new ContractValidationError({
                  contract,
                  message:
                    "Tenant routing did not produce a resolution source.",
                  details:
                    "resolveSessionBoundary requires a deterministic route source.",
                });
              }

              const issuerBinding = request.issuerBindings.find(
                (binding) =>
                  binding.tenantId === resolvedTenantId &&
                  binding.issuer.trim().toLowerCase() === issuer
              );
              if (issuerBinding === undefined) {
                throw new ContractValidationError({
                  contract,
                  message:
                    "Issuer is not bound to the resolved tenant for session mapping.",
                  details: `issuer=${issuer} tenantId=${resolvedTenantId}`,
                });
              }

              const subjectBinding = request.subjectBindings.find(
                (binding) =>
                  binding.tenantId === resolvedTenantId &&
                  binding.issuerBindingId === issuerBinding.issuerBindingId &&
                  binding.externalSubjectId === externalSubjectId
              );
              if (subjectBinding === undefined) {
                throw new ContractValidationError({
                  contract,
                  message:
                    "Authenticated subject is not provisioned for the resolved tenant.",
                  details: `issuerBindingId=${issuerBinding.issuerBindingId} externalSubjectId=${externalSubjectId}`,
                });
              }

              const user = request.users.find(
                (record) =>
                  record.tenantId === resolvedTenantId &&
                  record.userId === subjectBinding.userId
              );
              if (user === undefined) {
                throw new ContractValidationError({
                  contract,
                  message:
                    "Subject binding references a user that does not exist in tenant scope.",
                  details: `tenantId=${resolvedTenantId} userId=${subjectBinding.userId}`,
                });
              }
              if (user.status === "disabled") {
                throw new ContractValidationError({
                  contract,
                  message:
                    "Subject binding references a disabled user and cannot open a session.",
                  details: `tenantId=${resolvedTenantId} userId=${user.userId}`,
                });
              }

              return {
                sessionId: toSessionId(
                  resolvedTenantId,
                  user.userId,
                  issuerBinding.issuerBindingId,
                  externalSubjectId,
                  issuedAtMillis
                ),
                principalId: toPrincipalId(resolvedTenantId, user.userId),
                tenantId: resolvedTenantId,
                userId: user.userId,
                routeSource,
                issuedAtMillis,
                expiresAtMillis: issuedAtMillis + ttlMillis,
                auditEvents: Object.freeze([
                  createEnterpriseIdentityAuditEvent({
                    eventType: "identity.sso.login",
                    tenantId: resolvedTenantId,
                    userId: user.userId,
                    occurredAtMillis: issuedAtMillis,
                    details: {
                      issuer,
                      issuerBindingId: issuerBinding.issuerBindingId,
                      routeSource,
                      sessionId: toSessionId(
                        resolvedTenantId,
                        user.userId,
                        issuerBinding.issuerBindingId,
                        externalSubjectId,
                        issuedAtMillis
                      ),
                      principalId: toPrincipalId(resolvedTenantId, user.userId),
                    },
                  }),
                ]),
              };
            })
        );
      }),
    applyScimUserLifecycle: (request) =>
      Effect.sync(() => {
        const contract = "ScimUserLifecycleRequest";
        const issuerBindingId = normalizeTrimmedNonEmpty(
          request.issuerBindingId,
          contract,
          "issuerBindingId"
        );
        const issuer = normalizeTrimmedNonEmpty(
          request.issuer,
          contract,
          "issuer"
        ).toLowerCase();
        const externalSubjectId = normalizeTrimmedNonEmpty(
          request.externalSubjectId,
          contract,
          "externalSubjectId"
        );
        const cursor = normalizeTrimmedNonEmpty(
          request.cursor,
          contract,
          "cursor"
        );
        const cursorSequence = normalizeSequence(
          request.cursorSequence,
          contract,
          "cursorSequence"
        );
        const occurredAtMillis = normalizeMillis(
          request.occurredAtMillis,
          contract,
          "occurredAtMillis"
        );
        const email = normalizeEmail(request.email, contract, "email");
        const displayName = normalizeTrimmedNonEmpty(
          request.displayName,
          contract,
          "displayName"
        );
        const checkpointCursorHash = toCursorHash(cursor);

        const checkpointIndex = request.checkpoints.findIndex(
          (checkpoint) =>
            checkpoint.tenantId === request.tenantId &&
            checkpoint.issuerBindingId === issuerBindingId &&
            checkpoint.syncChannel === scimUsersSyncChannel
        );
        const existingCheckpoint =
          checkpointIndex !== -1
            ? (request.checkpoints[checkpointIndex] ?? null)
            : null;

        if (existingCheckpoint !== null) {
          if (cursorSequence < existingCheckpoint.cursorSequence) {
            throw new ContractValidationError({
              contract,
              message:
                "SCIM user lifecycle event rejected as stale based on cursorSequence.",
              details: `incoming=${cursorSequence} existing=${existingCheckpoint.cursorSequence}`,
            });
          }
          if (cursorSequence === existingCheckpoint.cursorSequence) {
            if (checkpointCursorHash !== existingCheckpoint.cursorHashSha256) {
              throw new ContractValidationError({
                contract,
                message:
                  "SCIM user lifecycle event rejected due to conflicting replay cursor hash.",
                details: `incomingHash=${checkpointCursorHash} existingHash=${existingCheckpoint.cursorHashSha256}`,
              });
            }
            const replayUser =
              request.users.find(
                (candidate) =>
                  candidate.tenantId === request.tenantId &&
                  candidate.userId === request.userId
              ) ??
              Object.freeze({
                tenantId: request.tenantId,
                userId: request.userId,
                email,
                displayName,
                status: request.operation === "disable" ? "disabled" : "active",
                createdAtMillis: occurredAtMillis,
                updatedAtMillis: occurredAtMillis,
              } satisfies EnterpriseIdentityUserRecord);

            return {
              operation: request.operation,
              action: "replayed",
              staleRejected: false,
              idempotentReplay: true,
              user: replayUser,
              users: toSortedUsers(request.users),
              subjectBindings: toSortedSubjectBindings(request.subjectBindings),
              checkpoints: toSortedCheckpoints(request.checkpoints),
              auditEvents: Object.freeze([
                createEnterpriseIdentityAuditEvent({
                  eventType: "identity.user.sync",
                  tenantId: request.tenantId,
                  userId: request.userId,
                  occurredAtMillis,
                  details: {
                    channel: scimUsersSyncChannel,
                    operation: request.operation,
                    action: "replayed",
                    cursorSequence,
                    idempotentReplay: true,
                  },
                }),
              ]),
            };
          }
        }

        const currentUserIndex = request.users.findIndex(
          (candidate) =>
            candidate.tenantId === request.tenantId &&
            candidate.userId === request.userId
        );
        const currentUser =
          currentUserIndex !== -1 ? request.users[currentUserIndex] : null;
        const nextStatus: UserStatus =
          request.operation === "disable" ? "disabled" : "active";
        const createdAtMillis =
          currentUser?.createdAtMillis ?? occurredAtMillis;
        const nextUser: EnterpriseIdentityUserRecord = Object.freeze({
          tenantId: request.tenantId,
          userId: request.userId,
          email,
          displayName,
          status: nextStatus,
          createdAtMillis,
          updatedAtMillis: occurredAtMillis,
        });
        const users = [...request.users];
        if (currentUserIndex !== -1) {
          users[currentUserIndex] = nextUser;
        } else {
          users.push(nextUser);
        }

        const subjectRecordIndex = request.subjectBindings.findIndex(
          (candidate) =>
            candidate.tenantId === request.tenantId &&
            candidate.issuerBindingId === issuerBindingId &&
            candidate.externalSubjectId === externalSubjectId
        );
        const existingSubjectRecord =
          subjectRecordIndex !== -1
            ? request.subjectBindings[subjectRecordIndex]
            : null;
        const subjectRecord: EnterpriseIdentityExternalSubjectRecord =
          Object.freeze({
            tenantId: request.tenantId,
            issuerBindingId,
            externalSubjectId,
            userId: request.userId,
            subjectHashSha256: sha256(
              `${request.tenantId}\n${issuer}\n${externalSubjectId}`
            ),
            subjectSource: "scim",
            firstSeenAtMillis:
              existingSubjectRecord?.firstSeenAtMillis ?? occurredAtMillis,
            lastSeenAtMillis: occurredAtMillis,
          });
        const subjectBindings = [...request.subjectBindings];
        if (subjectRecordIndex !== -1) {
          subjectBindings[subjectRecordIndex] = subjectRecord;
        } else {
          subjectBindings.push(subjectRecord);
        }

        const checkpointRecord: EnterpriseIdentitySyncCheckpointRecord =
          Object.freeze({
            tenantId: request.tenantId,
            issuerBindingId,
            syncChannel: scimUsersSyncChannel,
            checkpointCursor: cursor,
            cursorHashSha256: checkpointCursorHash,
            cursorSequence,
            checkpointedAtMillis: occurredAtMillis,
            updatedAtMillis: occurredAtMillis,
          });
        const checkpoints = [...request.checkpoints];
        if (checkpointIndex !== -1) {
          checkpoints[checkpointIndex] = checkpointRecord;
        } else {
          checkpoints.push(checkpointRecord);
        }

        const action: ScimUserLifecycleResponse["action"] =
          request.operation === "disable"
            ? "disabled"
            : request.operation === "reprovision"
              ? "reprovisioned"
              : currentUser === null
                ? "created"
                : "updated";

        return {
          operation: request.operation,
          action,
          staleRejected: false,
          idempotentReplay: false,
          user: nextUser,
          users: toSortedUsers(users),
          subjectBindings: toSortedSubjectBindings(subjectBindings),
          checkpoints: toSortedCheckpoints(checkpoints),
          auditEvents: Object.freeze([
            createEnterpriseIdentityAuditEvent({
              eventType: "identity.user.provision",
              tenantId: request.tenantId,
              userId: request.userId,
              occurredAtMillis,
              details: {
                operation: request.operation,
                action,
                status: nextUser.status,
              },
            }),
            createEnterpriseIdentityAuditEvent({
              eventType: "identity.user.sync",
              tenantId: request.tenantId,
              userId: request.userId,
              occurredAtMillis,
              details: {
                channel: scimUsersSyncChannel,
                operation: request.operation,
                action,
                cursorSequence,
                idempotentReplay: false,
              },
            }),
          ]),
        };
      }),
    applyScimGroupReconciliation: (request) =>
      Effect.sync(() => {
        const contract = "ScimGroupReconciliationRequest";
        const issuerBindingId = normalizeTrimmedNonEmpty(
          request.issuerBindingId,
          contract,
          "issuerBindingId"
        );
        normalizeTrimmedNonEmpty(request.issuer, contract, "issuer");
        const cursor = normalizeTrimmedNonEmpty(
          request.cursor,
          contract,
          "cursor"
        );
        const cursorSequence = normalizeSequence(
          request.cursorSequence,
          contract,
          "cursorSequence"
        );
        const occurredAtMillis = normalizeMillis(
          request.occurredAtMillis,
          contract,
          "occurredAtMillis"
        );
        const checkpointCursorHash = toCursorHash(cursor);

        const checkpointIndex = request.checkpoints.findIndex(
          (checkpoint) =>
            checkpoint.tenantId === request.tenantId &&
            checkpoint.issuerBindingId === issuerBindingId &&
            checkpoint.syncChannel === scimGroupsSyncChannel
        );
        const existingCheckpoint =
          checkpointIndex !== -1
            ? (request.checkpoints[checkpointIndex] ?? null)
            : null;

        if (existingCheckpoint !== null) {
          if (cursorSequence < existingCheckpoint.cursorSequence) {
            throw new ContractValidationError({
              contract,
              message:
                "SCIM group reconciliation event rejected as stale based on cursorSequence.",
              details: `incoming=${cursorSequence} existing=${existingCheckpoint.cursorSequence}`,
            });
          }
          if (cursorSequence === existingCheckpoint.cursorSequence) {
            if (checkpointCursorHash !== existingCheckpoint.cursorHashSha256) {
              throw new ContractValidationError({
                contract,
                message:
                  "SCIM group reconciliation event rejected due to conflicting replay cursor hash.",
                details: `incomingHash=${checkpointCursorHash} existingHash=${existingCheckpoint.cursorHashSha256}`,
              });
            }
            return {
              action: "replayed",
              staleRejected: false,
              idempotentReplay: true,
              userRoleAssignments: toSortedUserRoleAssignments(
                request.userRoleAssignments
              ),
              projectMemberships: toSortedProjectMemberships(
                request.projectMemberships
              ),
              checkpoints: toSortedCheckpoints(request.checkpoints),
              auditEvents: Object.freeze([
                createEnterpriseIdentityAuditEvent({
                  eventType: "identity.group.sync",
                  tenantId: request.tenantId,
                  userId: request.userId,
                  occurredAtMillis,
                  details: {
                    channel: scimGroupsSyncChannel,
                    action: "replayed",
                    cursorSequence,
                    idempotentReplay: true,
                  },
                }),
                createEnterpriseIdentityAuditEvent({
                  eventType: "identity.user.sync",
                  tenantId: request.tenantId,
                  userId: request.userId,
                  occurredAtMillis,
                  details: {
                    channel: scimGroupsSyncChannel,
                    action: "replayed",
                    cursorSequence,
                    idempotentReplay: true,
                  },
                }),
              ]),
            };
          }
        }

        const normalizedExternalGroupIds = Object.freeze(
          [...new Set(request.externalGroupIds)].sort((left, right) =>
            left.localeCompare(right)
          )
        );
        const selectedGroupIdSet = new Set(normalizedExternalGroupIds);
        const matchingBindings = request.groupBindings.filter(
          (binding) =>
            binding.tenantId === request.tenantId &&
            binding.issuerBindingId === issuerBindingId &&
            selectedGroupIdSet.has(binding.externalGroupId)
        );

        const desiredRoleIds = new Set<string>();
        const projectRoleCandidatesByProject = new Map<string, Set<string>>();
        const projectWithoutRoleSet = new Set<string>();
        for (const binding of matchingBindings) {
          if (binding.roleId !== null) {
            desiredRoleIds.add(binding.roleId);
          }
          if (binding.projectId === null) {
            continue;
          }

          if (binding.roleId === null) {
            projectWithoutRoleSet.add(binding.projectId);
            continue;
          }
          let roleSet = projectRoleCandidatesByProject.get(binding.projectId);
          if (roleSet === undefined) {
            roleSet = new Set<string>();
            projectRoleCandidatesByProject.set(binding.projectId, roleSet);
          }
          roleSet.add(binding.roleId);
        }

        const desiredUserRoleAssignments = [...desiredRoleIds]
          .sort((left, right) => left.localeCompare(right))
          .map((roleId) =>
            Object.freeze({
              tenantId: request.tenantId,
              userId: request.userId,
              roleId,
              assignedAtMillis: occurredAtMillis,
              assignedByUserId: null,
            } satisfies EnterpriseIdentityUserRoleAssignmentRecord)
          );

        const desiredProjectMemberships: EnterpriseIdentityProjectMembershipRecord[] =
          [];
        const projectIds = [
          ...new Set([
            ...projectRoleCandidatesByProject.keys(),
            ...projectWithoutRoleSet,
          ]),
        ].sort((left, right) => left.localeCompare(right));
        for (const projectId of projectIds) {
          const roleCandidates = projectRoleCandidatesByProject.get(projectId);
          const sortedRoleCandidates =
            roleCandidates === undefined
              ? []
              : [...roleCandidates].sort((left, right) =>
                  left.localeCompare(right)
                );
          const resolvedRoleId = sortedRoleCandidates[0] ?? null;
          desiredProjectMemberships.push(
            Object.freeze({
              tenantId: request.tenantId,
              projectId,
              userId: request.userId,
              roleId: resolvedRoleId,
              assignedAtMillis: occurredAtMillis,
            } satisfies EnterpriseIdentityProjectMembershipRecord)
          );
        }

        const retainedUserRoleAssignments = request.userRoleAssignments.filter(
          (assignment) =>
            !(
              assignment.tenantId === request.tenantId &&
              assignment.userId === request.userId
            )
        );
        const retainedProjectMemberships = request.projectMemberships.filter(
          (membership) =>
            !(
              membership.tenantId === request.tenantId &&
              membership.userId === request.userId
            )
        );

        const checkpointRecord: EnterpriseIdentitySyncCheckpointRecord =
          Object.freeze({
            tenantId: request.tenantId,
            issuerBindingId,
            syncChannel: scimGroupsSyncChannel,
            checkpointCursor: cursor,
            cursorHashSha256: checkpointCursorHash,
            cursorSequence,
            checkpointedAtMillis: occurredAtMillis,
            updatedAtMillis: occurredAtMillis,
          });
        const checkpoints = [...request.checkpoints];
        if (checkpointIndex !== -1) {
          checkpoints[checkpointIndex] = checkpointRecord;
        } else {
          checkpoints.push(checkpointRecord);
        }

        return {
          action: "reconciled",
          staleRejected: false,
          idempotentReplay: false,
          userRoleAssignments: toSortedUserRoleAssignments([
            ...retainedUserRoleAssignments,
            ...desiredUserRoleAssignments,
          ]),
          projectMemberships: toSortedProjectMemberships([
            ...retainedProjectMemberships,
            ...desiredProjectMemberships,
          ]),
          checkpoints: toSortedCheckpoints(checkpoints),
          auditEvents: Object.freeze([
            createEnterpriseIdentityAuditEvent({
              eventType: "identity.group.sync",
              tenantId: request.tenantId,
              userId: request.userId,
              occurredAtMillis,
              details: {
                channel: scimGroupsSyncChannel,
                action: "reconciled",
                cursorSequence,
                groupCount: normalizedExternalGroupIds.length,
              },
            }),
            createEnterpriseIdentityAuditEvent({
              eventType: "identity.user.sync",
              tenantId: request.tenantId,
              userId: request.userId,
              occurredAtMillis,
              details: {
                channel: scimGroupsSyncChannel,
                action: "reconciled",
                cursorSequence,
                roleAssignmentCount: desiredUserRoleAssignments.length,
                projectMembershipCount: desiredProjectMemberships.length,
              },
            }),
          ]),
        };
      }),
    evaluateAuthorization: (request) =>
      Effect.suspend(() => {
        const contract = "EnterpriseIdentityAuthorizationRequest";
        const resourceProjectId =
          request.resourceProjectId === undefined
            ? null
            : normalizeTrimmedNonEmpty(
                request.resourceProjectId,
                contract,
                "resourceProjectId"
              );
        const action = normalizeTrimmedNonEmpty(
          request.action,
          contract,
          "action"
        ) as AuthorizationAction;

        if (request.resourceTenantId !== request.tenantId) {
          const crossTenantDeniedResponse: EnterpriseIdentityAuthorizationResponse =
            {
              tenantId: request.tenantId,
              userId: request.userId,
              action,
              role: "dev",
              allowed: false,
              reasonCode: "RBAC_DENY_ROLE_ACTION",
              crossTenantDenied: true,
              evaluatedAtMillis: 0,
            };
          return Effect.succeed(crossTenantDeniedResponse);
        }

        const matchingRoleAssignments = request.userRoleAssignments.filter(
          (assignment) =>
            assignment.tenantId === request.tenantId &&
            assignment.userId === request.userId
        );
        const matchingProjectMemberships = request.projectMemberships.filter(
          (membership) =>
            membership.tenantId === request.tenantId &&
            membership.userId === request.userId &&
            (resourceProjectId === null ||
              membership.projectId === resourceProjectId)
        );

        const candidateRoleIds = [
          ...matchingRoleAssignments.map((record) => record.roleId),
          ...matchingProjectMemberships
            .map((record) => record.roleId)
            .filter((roleId): roleId is string => roleId !== null),
        ];
        const candidateRoles =
          toSortedCandidateAuthorizationRoles(candidateRoleIds);

        return Effect.flatMap(
          Effect.all(
            candidateRoles.map((role) =>
              authorizationService.evaluate({
                role,
                action,
              })
            )
          ),
          (decisions) => {
            const firstAllowed = decisions.find((decision) => decision.allowed);
            const selectedDecision = firstAllowed ?? decisions[0];
            if (selectedDecision === undefined) {
              return Effect.fail(
                new ContractValidationError({
                  contract,
                  message:
                    "No authorization decision candidates available for enterprise identity authorization evaluation.",
                  details: `tenantId=${request.tenantId} userId=${request.userId}`,
                })
              );
            }

            const response: EnterpriseIdentityAuthorizationResponse = {
              tenantId: request.tenantId,
              userId: request.userId,
              action,
              role: selectedDecision.role,
              allowed: selectedDecision.allowed,
              reasonCode: selectedDecision.reasonCode,
              crossTenantDenied: false,
              evaluatedAtMillis: selectedDecision.evaluatedAtMillis,
            };
            return Effect.succeed(response);
          }
        );
      }),
  };
};

export const makeDeterministicEnterpriseIdentityService =
  (): EnterpriseIdentityService =>
    makeEnterpriseIdentityService({
      tenantRoutingService: makeRuntimeTenantRoutingService(),
      sessionTtlMillis: defaultSessionTtlMillis,
    });

export const makeRuntimeEnterpriseIdentityService =
  (): EnterpriseIdentityService => makeEnterpriseIdentityService();

export const noopEnterpriseIdentityLayer: Layer.Layer<EnterpriseIdentityService> =
  Layer.succeed(
    EnterpriseIdentityServiceTag,
    makeRuntimeEnterpriseIdentityService()
  );

export const deterministicEnterpriseIdentityLayer: Layer.Layer<EnterpriseIdentityService> =
  Layer.succeed(
    EnterpriseIdentityServiceTag,
    makeDeterministicEnterpriseIdentityService()
  );

export const deterministicTestEnterpriseIdentityLayer: Layer.Layer<EnterpriseIdentityService> =
  Layer.succeed(
    EnterpriseIdentityServiceTag,
    makeDeterministicEnterpriseIdentityService()
  );
