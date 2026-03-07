import { Effect, Schema } from "effect";

import { decodeUnknownEffect } from "../../../../libs/shared/src/effect/contracts/validators.ts";
import { ContractValidationError } from "../../../../libs/shared/src/effect/errors.ts";

const FederationShareScopeSchema = Schema.Literals([
  "common",
  "project",
  "job_role",
  "user",
]);

export const FederationCanaryDenyReasonCodeSchema = Schema.Literals([
  "cross_tenant_forbidden",
  "space_not_allowlisted",
  "share_not_allowlisted",
  "selector_mismatch",
  "policy_deny",
]);

const FederationCanaryRouteRequestSchema = Schema.Struct({
  actorTenantId: Schema.String,
  sourceTenantId: Schema.String,
  targetTenantId: Schema.String,
  sourceSpaceId: Schema.String,
  targetSpaceId: Schema.String,
  shareId: Schema.String,
  shareScope: FederationShareScopeSchema,
  allowlistedTargetSpaceIds: Schema.Array(Schema.String),
  allowlistedShareIds: Schema.Array(Schema.String),
  selectorMatches: Schema.Boolean,
  policyAllows: Schema.Boolean,
  userMappingApproved: Schema.optional(Schema.Boolean),
  evaluatedAtMillis: Schema.Number,
});

const FederationCanaryAuditEventSchema = Schema.Struct({
  eventType: Schema.Literals([
    "federation.share.allowed",
    "federation.share.denied",
  ]),
  decision: Schema.Literals(["allow", "deny"]),
  reasonCode: Schema.NullOr(FederationCanaryDenyReasonCodeSchema),
  actorTenantId: Schema.String,
  sourceTenantId: Schema.String,
  targetTenantId: Schema.String,
  sourceSpaceId: Schema.String,
  targetSpaceId: Schema.String,
  shareId: Schema.String,
  shareScope: FederationShareScopeSchema,
  evaluatedAtMillis: Schema.Number,
});

export const FederationCanaryRouteDecisionSchema = Schema.Struct({
  decision: Schema.Literals(["allow", "deny"]),
  reasonCode: Schema.NullOr(FederationCanaryDenyReasonCodeSchema),
  auditEvent: FederationCanaryAuditEventSchema,
});

const decodeFederationCanaryRouteRequest = decodeUnknownEffect(
  FederationCanaryRouteRequestSchema,
  "FederationCanaryRouteRequest"
);

const includesString = (
  values: ReadonlyArray<string>,
  candidate: string
): boolean => values.includes(candidate);

const evaluateFederationCanaryReasonCode = (
  request: FederationCanaryRouteRequest
): FederationCanaryDenyReasonCode | null => {
  if (
    request.actorTenantId !== request.sourceTenantId ||
    request.actorTenantId !== request.targetTenantId
  ) {
    return "cross_tenant_forbidden";
  }
  if (
    !includesString(request.allowlistedTargetSpaceIds, request.targetSpaceId)
  ) {
    return "space_not_allowlisted";
  }
  if (!includesString(request.allowlistedShareIds, request.shareId)) {
    return "share_not_allowlisted";
  }
  if (request.shareScope === "user" && request.userMappingApproved !== true) {
    return "selector_mismatch";
  }
  if (request.selectorMatches !== true) {
    return "selector_mismatch";
  }
  if (request.policyAllows !== true) {
    return "policy_deny";
  }
  return null;
};

const buildFederationCanaryAuditEvent = (
  request: FederationCanaryRouteRequest,
  reasonCode: FederationCanaryDenyReasonCode | null
): FederationCanaryRouteDecision["auditEvent"] => ({
  eventType:
    reasonCode === null
      ? "federation.share.allowed"
      : "federation.share.denied",
  decision: reasonCode === null ? "allow" : "deny",
  reasonCode,
  actorTenantId: request.actorTenantId,
  sourceTenantId: request.sourceTenantId,
  targetTenantId: request.targetTenantId,
  sourceSpaceId: request.sourceSpaceId,
  targetSpaceId: request.targetSpaceId,
  shareId: request.shareId,
  shareScope: request.shareScope,
  evaluatedAtMillis: request.evaluatedAtMillis,
});

export type FederationShareScope = Schema.Schema.Type<
  typeof FederationShareScopeSchema
>;
export type FederationCanaryDenyReasonCode = Schema.Schema.Type<
  typeof FederationCanaryDenyReasonCodeSchema
>;
export type FederationCanaryRouteRequest = Schema.Schema.Type<
  typeof FederationCanaryRouteRequestSchema
>;
export type FederationCanaryRouteDecision = Schema.Schema.Type<
  typeof FederationCanaryRouteDecisionSchema
>;

export const evaluateFederationCanaryRoute: (
  input: unknown
) => Effect.Effect<FederationCanaryRouteDecision, ContractValidationError> =
  Effect.fn("FederationCanaryRouting.evaluate")(function* (input: unknown) {
    const request = yield* decodeFederationCanaryRouteRequest(input);
    const reasonCode = evaluateFederationCanaryReasonCode(request);

    return {
      decision: reasonCode === null ? "allow" : "deny",
      reasonCode,
      auditEvent: buildFederationCanaryAuditEvent(request, reasonCode),
    } satisfies FederationCanaryRouteDecision;
  });
