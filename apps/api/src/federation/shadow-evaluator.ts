import { Effect, Schema } from "effect";

import { decodeUnknownEffect } from "../../../../libs/shared/src/effect/contracts/validators.ts";
import { ContractValidationError } from "../../../../libs/shared/src/effect/errors.ts";
import {
  evaluateFederationCanaryRoute,
  type FederationCanaryRouteDecision,
  FederationCanaryDenyReasonCodeSchema,
} from "./canary-routing.ts";

const FederationCandidateScopeSchema = Schema.Literals([
  "local",
  "project",
  "job_role",
  "common",
  "user",
]);

const FederationCandidateSchema = Schema.Struct({
  memoryId: Schema.String,
  digest: Schema.String,
  statement: Schema.String,
  score: Schema.Number,
  updatedAtMillis: Schema.Number,
  sourceSpaceId: Schema.String,
  scope: FederationCandidateScopeSchema,
  shareId: Schema.NullOr(Schema.String),
  policyDecisionId: Schema.NullOr(Schema.String),
});

const FederationShadowReadRequestSchema = Schema.Struct({
  actorTenantId: Schema.String,
  sourceTenantId: Schema.String,
  targetTenantId: Schema.String,
  sourceSpaceId: Schema.String,
  targetSpaceId: Schema.String,
  shareId: Schema.String,
  shareScope: Schema.Literals(["common", "project", "job_role", "user"]),
  allowlistedTargetSpaceIds: Schema.Array(Schema.String),
  allowlistedShareIds: Schema.Array(Schema.String),
  selectorMatches: Schema.Boolean,
  policyAllows: Schema.Boolean,
  userMappingApproved: Schema.optional(Schema.Boolean),
  evaluatedAtMillis: Schema.Number,
  localCandidates: Schema.Array(FederationCandidateSchema),
  federatedCandidates: Schema.Array(FederationCandidateSchema),
});

const FederationShadowReadCandidateSchema = Schema.Struct({
  memoryId: Schema.String,
  digest: Schema.String,
  statement: Schema.String,
  score: Schema.Number,
  updatedAtMillis: Schema.Number,
  sourceSpaceId: Schema.String,
  scope: FederationCandidateScopeSchema,
  provenance: Schema.Struct({
    origin: Schema.Literals(["local", "federated"]),
    sourceSpaceId: Schema.String,
    shareId: Schema.NullOr(Schema.String),
    policyDecisionId: Schema.NullOr(Schema.String),
  }),
});

export const FederationShadowReadReportSchema = Schema.Struct({
  operation: Schema.Literal("federation_shadow_evaluation"),
  decision: Schema.Literals(["allow", "deny"]),
  reasonCode: Schema.NullOr(FederationCanaryDenyReasonCodeSchema),
  servedCandidates: Schema.Array(FederationShadowReadCandidateSchema),
  shadowCandidates: Schema.Array(FederationShadowReadCandidateSchema),
  auditPreview: Schema.Struct({
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
    shareScope: Schema.Literals(["common", "project", "job_role", "user"]),
    evaluatedAtMillis: Schema.Number,
  }),
  sideEffects: Schema.Struct({
    writeCount: Schema.Number,
    persistedAuditEventCount: Schema.Number,
    mutatedState: Schema.Boolean,
  }),
});

const decodeFederationShadowReadRequest = decodeUnknownEffect(
  FederationShadowReadRequestSchema,
  "FederationShadowReadRequest"
);

type FederationCandidate = Schema.Schema.Type<typeof FederationCandidateSchema>;
export type FederationShadowReadRequest = Schema.Schema.Type<
  typeof FederationShadowReadRequestSchema
>;
export type FederationShadowReadCandidate = Schema.Schema.Type<
  typeof FederationShadowReadCandidateSchema
>;
export type FederationShadowReadReport = Schema.Schema.Type<
  typeof FederationShadowReadReportSchema
>;

const scopePrecedence = (scope: FederationCandidate["scope"]): number =>
  ({
    local: 0,
    user: 1,
    project: 2,
    job_role: 3,
    common: 4,
  })[scope];

const compareShadowCandidates = (
  left: FederationCandidate,
  right: FederationCandidate
): number => {
  const precedenceDelta =
    scopePrecedence(left.scope) - scopePrecedence(right.scope);
  if (precedenceDelta !== 0) {
    return precedenceDelta;
  }
  if (left.score !== right.score) {
    return right.score - left.score;
  }
  if (left.updatedAtMillis !== right.updatedAtMillis) {
    return right.updatedAtMillis - left.updatedAtMillis;
  }
  const memoryIdDelta = left.memoryId.localeCompare(right.memoryId);
  if (memoryIdDelta !== 0) {
    return memoryIdDelta;
  }
  return left.sourceSpaceId.localeCompare(right.sourceSpaceId);
};

const normalizeShadowCandidate = (
  candidate: FederationCandidate
): FederationShadowReadCandidate => ({
  memoryId: candidate.memoryId,
  digest: candidate.digest,
  statement: candidate.statement,
  score: candidate.score,
  updatedAtMillis: candidate.updatedAtMillis,
  sourceSpaceId: candidate.sourceSpaceId,
  scope: candidate.scope,
  provenance: {
    origin: candidate.scope === "local" ? "local" : "federated",
    sourceSpaceId: candidate.sourceSpaceId,
    shareId: candidate.shareId,
    policyDecisionId: candidate.policyDecisionId,
  },
});

const deduplicateShadowCandidates = (
  candidates: ReadonlyArray<FederationCandidate>
): ReadonlyArray<FederationShadowReadCandidate> => {
  const selectedByDigest = new Map<string, FederationCandidate>();
  for (const candidate of [...candidates].sort(compareShadowCandidates)) {
    if (!selectedByDigest.has(candidate.digest)) {
      selectedByDigest.set(candidate.digest, candidate);
    }
  }

  return [...selectedByDigest.values()]
    .sort(compareShadowCandidates)
    .map(normalizeShadowCandidate);
};

const buildShadowReport = (
  canaryDecision: FederationCanaryRouteDecision,
  request: FederationShadowReadRequest
): FederationShadowReadReport => {
  const servedCandidates = deduplicateShadowCandidates(request.localCandidates);
  const shadowCandidates =
    canaryDecision.decision === "allow"
      ? deduplicateShadowCandidates([
          ...request.localCandidates,
          ...request.federatedCandidates,
        ])
      : [];

  return {
    operation: "federation_shadow_evaluation",
    decision: canaryDecision.decision,
    reasonCode: canaryDecision.reasonCode,
    servedCandidates,
    shadowCandidates,
    auditPreview: canaryDecision.auditEvent,
    sideEffects: {
      writeCount: 0,
      persistedAuditEventCount: 0,
      mutatedState: false,
    },
  };
};

export const evaluateShadowFederationRead: (
  input: unknown
) => Effect.Effect<FederationShadowReadReport, ContractValidationError> =
  Effect.fn("FederationShadowEvaluator.evaluate")(function* (input: unknown) {
    const request = yield* decodeFederationShadowReadRequest(input);
    const canaryDecision = yield* evaluateFederationCanaryRoute({
      actorTenantId: request.actorTenantId,
      sourceTenantId: request.sourceTenantId,
      targetTenantId: request.targetTenantId,
      sourceSpaceId: request.sourceSpaceId,
      targetSpaceId: request.targetSpaceId,
      shareId: request.shareId,
      shareScope: request.shareScope,
      allowlistedTargetSpaceIds: request.allowlistedTargetSpaceIds,
      allowlistedShareIds: request.allowlistedShareIds,
      selectorMatches: request.selectorMatches,
      policyAllows: request.policyAllows,
      userMappingApproved: request.userMappingApproved,
      evaluatedAtMillis: request.evaluatedAtMillis,
    });

    return buildShadowReport(canaryDecision, request);
  });
