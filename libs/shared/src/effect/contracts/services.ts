import { Schema } from "effect";

import {
  IngestionMetadataSchema,
  MemoryLayerSchema,
  PolicyContextSchema,
  PolicyOutcomeSchema,
} from "./domains.js";
import {
  EvidenceIdSchema,
  MemoryIdSchema,
  ProfileIdSchema,
  ProjectIdSchema,
  RoleIdSchema,
  SpaceIdSchema,
  UserIdSchema,
} from "./ids.js";

const NonEmptyTrimmedStringSchema = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty()
);
const NonNegativeIntSchema = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0)
);
const Sha256HexSchema = Schema.String.check(
  Schema.isPattern(/^[0-9A-Fa-f]{64}$/)
);
const RetrievalScoreSchema = Schema.Number.check(
  Schema.isBetween({ minimum: 0, maximum: 1 })
);
const RetrievalRankingWeightSchema = Schema.Number.check(
  Schema.isBetween({ minimum: 0, maximum: 1 })
);

export const ScopeAuthorizationInputSchema = Schema.Struct({
  tenantId: Schema.optional(SpaceIdSchema),
  tenant_id: Schema.optional(SpaceIdSchema),
  projectIds: Schema.optional(Schema.Array(ProjectIdSchema)),
  project_ids: Schema.optional(Schema.Array(ProjectIdSchema)),
  roleIds: Schema.optional(Schema.Array(RoleIdSchema)),
  role_ids: Schema.optional(Schema.Array(RoleIdSchema)),
  jobRoleIds: Schema.optional(Schema.Array(RoleIdSchema)),
  job_role_ids: Schema.optional(Schema.Array(RoleIdSchema)),
  userIds: Schema.optional(Schema.Array(UserIdSchema)),
  user_ids: Schema.optional(Schema.Array(UserIdSchema)),
});

export const StorageUpsertRequestSchema = Schema.Struct({
  spaceId: SpaceIdSchema,
  memoryId: MemoryIdSchema,
  layer: MemoryLayerSchema,
  payload: IngestionMetadataSchema,
  scopeAuthorization: Schema.optional(ScopeAuthorizationInputSchema),
  scope_authorization: Schema.optional(ScopeAuthorizationInputSchema),
  idempotencyKey: Schema.optional(Schema.String),
  idempotency_key: Schema.optional(Schema.String),
});

export const StorageUpsertResponseSchema = Schema.Struct({
  spaceId: SpaceIdSchema,
  memoryId: MemoryIdSchema,
  accepted: Schema.Boolean,
  persistedAtMillis: NonNegativeIntSchema,
  version: NonNegativeIntSchema,
});

export const StorageDeleteRequestSchema = Schema.Struct({
  spaceId: SpaceIdSchema,
  memoryId: MemoryIdSchema,
  scopeAuthorization: Schema.optional(ScopeAuthorizationInputSchema),
  scope_authorization: Schema.optional(ScopeAuthorizationInputSchema),
  idempotencyKey: Schema.optional(Schema.String),
  idempotency_key: Schema.optional(Schema.String),
});

export const StorageDeleteResponseSchema = Schema.Struct({
  spaceId: SpaceIdSchema,
  memoryId: MemoryIdSchema,
  deleted: Schema.Boolean,
});

export const StorageSnapshotSignatureAlgorithmSchema =
  Schema.Literal("hmac-sha256");

export const StorageSnapshotExportRequestSchema = Schema.Struct({
  signatureSecret: Schema.String,
  signature_secret: Schema.optional(Schema.String),
});

export const StorageSnapshotExportResponseSchema = Schema.Struct({
  signatureAlgorithm: StorageSnapshotSignatureAlgorithmSchema,
  payload: Schema.String,
  signature: Sha256HexSchema,
  tableCount: NonNegativeIntSchema,
  rowCount: NonNegativeIntSchema,
});

export const StorageSnapshotImportRequestSchema = Schema.Struct({
  signatureSecret: Schema.String,
  signature_secret: Schema.optional(Schema.String),
  signatureAlgorithm: StorageSnapshotSignatureAlgorithmSchema,
  payload: Schema.String,
  signature: Sha256HexSchema,
});

export const StorageSnapshotImportResponseSchema = Schema.Struct({
  imported: Schema.Boolean,
  replayed: Schema.Boolean,
  tableCount: NonNegativeIntSchema,
  rowCount: NonNegativeIntSchema,
});

const RetrievalScopeLevelSchema = Schema.Literals([
  "common",
  "project",
  "job_role",
  "user",
]);

export const RetrievalScopeSelectorsSchema = Schema.Struct({
  projectId: Schema.optional(ProjectIdSchema),
  roleId: Schema.optional(RoleIdSchema),
  jobRoleId: Schema.optional(RoleIdSchema),
  userId: Schema.optional(UserIdSchema),
});

export const RetrievalPolicyInputSchema = Schema.Struct({
  actorId: Schema.optional(UserIdSchema),
  action: Schema.optional(Schema.String),
  evidenceIds: Schema.optional(Schema.Array(EvidenceIdSchema)),
  context: Schema.optional(PolicyContextSchema),
});

export const RetrievalRankingWeightsSchema = Schema.Struct({
  relevance: Schema.optional(RetrievalRankingWeightSchema),
  evidenceStrength: Schema.optional(RetrievalRankingWeightSchema),
  evidence_strength: Schema.optional(RetrievalRankingWeightSchema),
  decay: Schema.optional(RetrievalRankingWeightSchema),
  humanWeight: Schema.optional(RetrievalRankingWeightSchema),
  human_weight: Schema.optional(RetrievalRankingWeightSchema),
  utility: Schema.optional(RetrievalRankingWeightSchema),
  utilityScore: Schema.optional(RetrievalRankingWeightSchema),
  utility_score: Schema.optional(RetrievalRankingWeightSchema),
});

export const RetrievalRequestSchema = Schema.Struct({
  spaceId: SpaceIdSchema,
  query: Schema.String,
  limit: NonNegativeIntSchema,
  cursor: Schema.optional(Schema.NullOr(Schema.String)),
  scopeAuthorization: Schema.optional(ScopeAuthorizationInputSchema),
  scope_authorization: Schema.optional(ScopeAuthorizationInputSchema),
  scope: Schema.optional(RetrievalScopeSelectorsSchema),
  projectId: Schema.optional(ProjectIdSchema),
  roleId: Schema.optional(RoleIdSchema),
  jobRoleId: Schema.optional(RoleIdSchema),
  userId: Schema.optional(UserIdSchema),
  policy: Schema.optional(RetrievalPolicyInputSchema),
  actorId: Schema.optional(UserIdSchema),
  action: Schema.optional(Schema.String),
  evidenceIds: Schema.optional(Schema.Array(EvidenceIdSchema)),
  policyContext: Schema.optional(PolicyContextSchema),
  rankingWeights: Schema.optional(RetrievalRankingWeightsSchema),
  ranking_weights: Schema.optional(RetrievalRankingWeightsSchema),
});

export const RetrievalHitSchema = Schema.Struct({
  memoryId: MemoryIdSchema,
  layer: MemoryLayerSchema,
  score: RetrievalScoreSchema,
  excerpt: Schema.String,
  metadata: Schema.optional(
    Schema.Struct({
      chronology: Schema.Struct({
        contradictsMemoryIds: Schema.Array(MemoryIdSchema),
        supersedesMemoryIds: Schema.Array(MemoryIdSchema),
        reconciledMemoryIds: Schema.Array(MemoryIdSchema),
      }),
    })
  ),
});

export const RetrievalExplainabilityReasonCodeSchema = Schema.Literals([
  "QUERY_TOKEN_MATCH",
  "QUERY_EMPTY_FALLBACK",
  "SCOPE_FILTER_MATCH",
  "SCOPE_SELECTOR_APPLIED",
  "SCOPE_LEVEL_COMMON",
  "SCOPE_LEVEL_PROJECT",
  "SCOPE_LEVEL_JOB_ROLE",
  "SCOPE_LEVEL_USER",
  "POLICY_ALLOW",
  "RANKING_WEIGHTED_SIGNALS",
  "CHRONOLOGY_RECONCILED",
]);

export const RetrievalExplainabilityRankingSignalSchema = Schema.Literals([
  "relevance",
  "evidenceStrength",
  "decay",
  "humanWeight",
  "utility",
]);

export const RetrievalExplainabilityRankingSignalsSchema = Schema.Struct({
  relevance: RetrievalScoreSchema,
  evidenceStrength: RetrievalScoreSchema,
  decay: RetrievalScoreSchema,
  humanWeight: RetrievalScoreSchema,
  utility: RetrievalScoreSchema,
});

export const RetrievalExplainabilityWeightedContributionSchema = Schema.Struct({
  signal: RetrievalExplainabilityRankingSignalSchema,
  signalScore: RetrievalScoreSchema,
  weight: RetrievalRankingWeightSchema,
  weightedContribution: RetrievalScoreSchema,
});

export const RetrievalExplainabilityHitSchema = Schema.Struct({
  memoryId: MemoryIdSchema,
  layer: MemoryLayerSchema,
  score: RetrievalScoreSchema,
  excerpt: Schema.String,
  rank: NonNegativeIntSchema,
  scopeId: Schema.String,
  scopeLevel: RetrievalScopeLevelSchema,
  reasonCodes: Schema.Array(RetrievalExplainabilityReasonCodeSchema),
  rankingSignals: RetrievalExplainabilityRankingSignalsSchema,
  weightedContributions: Schema.Array(
    RetrievalExplainabilityWeightedContributionSchema
  ),
});

const ActionableRetrievalLineSchema = NonEmptyTrimmedStringSchema;

export const ActionableRetrievalPackSourceMetadataSchema = Schema.Struct({
  score: RetrievalScoreSchema,
  layer: MemoryLayerSchema,
});

export const ActionableRetrievalPackSourceSchema = Schema.Struct({
  memoryId: MemoryIdSchema,
  excerpt: Schema.String,
  metadata: ActionableRetrievalPackSourceMetadataSchema,
});

export const ActionableRetrievalPackSchema = Schema.Struct({
  do: Schema.Array(ActionableRetrievalLineSchema),
  dont: Schema.Array(ActionableRetrievalLineSchema),
  examples: Schema.Array(ActionableRetrievalLineSchema),
  risks: Schema.Array(ActionableRetrievalLineSchema),
  sources: Schema.Array(ActionableRetrievalPackSourceSchema),
  warnings: Schema.Array(ActionableRetrievalLineSchema),
});

export const RetrievalResponseSchema = Schema.Struct({
  hits: Schema.Array(RetrievalHitSchema),
  totalHits: NonNegativeIntSchema,
  nextCursor: Schema.NullOr(Schema.String),
  actionablePack: Schema.optional(ActionableRetrievalPackSchema),
});

export const RetrievalExplainabilityResponseSchema = Schema.Struct({
  hits: Schema.Array(RetrievalExplainabilityHitSchema),
  totalHits: NonNegativeIntSchema,
  nextCursor: Schema.NullOr(Schema.String),
});

export const EvaluationRequestSchema = Schema.Struct({
  objective: Schema.String,
  candidateMemoryIds: Schema.Array(MemoryIdSchema),
  minimumScore: RetrievalScoreSchema,
});

export const EvaluationResultSchema = Schema.Struct({
  memoryId: MemoryIdSchema,
  score: RetrievalScoreSchema,
  passed: Schema.Boolean,
});

export const EvaluationResponseSchema = Schema.Struct({
  objective: Schema.String,
  results: Schema.Array(EvaluationResultSchema),
  selectedMemoryIds: Schema.Array(MemoryIdSchema),
});

export const PolicyRequestSchema = Schema.Struct({
  spaceId: SpaceIdSchema,
  actorId: UserIdSchema,
  action: Schema.String,
  resourceId: MemoryIdSchema,
  evidenceIds: Schema.Array(EvidenceIdSchema),
  context: PolicyContextSchema,
});

export const PolicyResponseSchema = Schema.Struct({
  decision: PolicyOutcomeSchema,
  reasonCodes: Schema.Array(Schema.String),
  evaluatedAtMillis: NonNegativeIntSchema,
});

export const PolicyPackPluginContractVersionSchema = Schema.Literal("v1");

export const PolicyPackPluginRequestSchema = Schema.Struct({
  contractVersion: PolicyPackPluginContractVersionSchema,
  operation: Schema.Literal("policy_decision_update"),
  storeId: SpaceIdSchema,
  profileId: ProfileIdSchema,
  decisionId: NonEmptyTrimmedStringSchema,
  policyKey: NonEmptyTrimmedStringSchema,
  action: NonEmptyTrimmedStringSchema,
  surface: NonEmptyTrimmedStringSchema,
  outcome: PolicyOutcomeSchema,
  reasonCodes: Schema.Array(Schema.String),
  provenanceEventIds: Schema.Array(EvidenceIdSchema),
  evidenceEventIds: Schema.Array(EvidenceIdSchema),
  metadata: PolicyContextSchema,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

export const PolicyPackPluginOutcomeSchema = Schema.Literals(["pass", "deny"]);

export const PolicyPackPluginResponseSchema = Schema.Struct({
  contractVersion: PolicyPackPluginContractVersionSchema,
  outcome: PolicyPackPluginOutcomeSchema,
  reasonCodes: Schema.Array(Schema.String),
  metadata: Schema.optional(PolicyContextSchema),
});

export const AuthorizationRoleSchema = Schema.Literals([
  "admin",
  "lead",
  "dev",
  "auditor",
]);

export const AuthorizationActionSchema = Schema.Literals([
  "memory.read",
  "memory.write",
  "memory.promote",
  "memory.demote",
  "memory.replay_eval",
  "policy.read",
  "policy.write",
  "policy.override",
  "compliance.read",
  "compliance.export",
]);

export const AuthorizationDecisionReasonCodeSchema = Schema.Literals([
  "RBAC_ALLOW",
  "RBAC_DENY_ROLE_ACTION",
]);

export const AuthorizationRequestSchema = Schema.Struct({
  role: AuthorizationRoleSchema,
  action: AuthorizationActionSchema,
});

export const AuthorizationResponseSchema = Schema.Struct({
  role: AuthorizationRoleSchema,
  action: AuthorizationActionSchema,
  allowed: Schema.Boolean,
  reasonCode: AuthorizationDecisionReasonCodeSchema,
  evaluatedAtMillis: NonNegativeIntSchema,
});

export const IngestionRecordSchema = Schema.Struct({
  recordId: EvidenceIdSchema,
  content: Schema.String,
  metadata: IngestionMetadataSchema,
});

export const IngestionRequestSchema = Schema.Struct({
  source: Schema.String,
  idempotencyKey: Schema.String,
  occurredAtMillis: NonNegativeIntSchema,
  records: Schema.Array(IngestionRecordSchema),
});

export const IngestionResponseSchema = Schema.Struct({
  acceptedRecordIds: Schema.Array(EvidenceIdSchema),
  duplicateRecordIds: Schema.Array(EvidenceIdSchema),
  ingestedAtMillis: NonNegativeIntSchema,
});

const LifecycleEntityIdSchema = NonEmptyTrimmedStringSchema;
const LifecycleReasonCodeSchema = NonEmptyTrimmedStringSchema;
const LifecycleDeltaScoreSchema = Schema.Number.check(
  Schema.isBetween({ minimum: -1, maximum: 1 })
);
const LifecycleDeltaMillisSchema = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: -86_400_000, maximum: 86_400_000 })
);
const LifecycleDeltaCountSchema = Schema.Number.check(Schema.isInt());

export const MemoryLifecycleOperationSchema = Schema.Literals([
  "shadow_write",
  "replay_eval",
  "promote",
  "demote",
]);

export const MemoryLifecycleCandidateStatusSchema = Schema.Literals([
  "shadow",
  "promoted",
  "demoted",
]);

export const MemoryLifecycleGateStatusSchema = Schema.Literals([
  "pass",
  "fail",
]);

export const MemoryLifecyclePreconditionReasonCodeSchema = Schema.Literals([
  "SHADOW_WRITE_REQUIRES_SOURCE_EPISODES",
  "SHADOW_WRITE_REJECTS_PROMOTED_CANDIDATE",
  "REPLAY_EVAL_REQUIRES_SHADOW_CANDIDATE",
  "PROMOTE_REQUIRES_EXISTING_CANDIDATE",
  "PROMOTE_REQUIRES_PASSING_REPLAY_EVAL",
  "PROMOTE_REQUIRES_FRESH_EVIDENCE",
  "DEMOTE_REQUIRES_EXISTING_CANDIDATE",
  "DEMOTE_REQUIRES_REASON_CODES",
]);

export const MemoryLifecycleQualityDeltaSchema = Schema.Struct({
  successRateDelta: LifecycleDeltaScoreSchema,
  reopenRateDelta: LifecycleDeltaScoreSchema,
});

export const MemoryLifecycleEfficiencyDeltaSchema = Schema.Struct({
  latencyP95DeltaMs: LifecycleDeltaMillisSchema,
  tokenCostDelta: Schema.Number.check(
    Schema.isBetween({ minimum: -100_000, maximum: 100_000 })
  ),
});

export const MemoryLifecycleSafetyDeltaSchema = Schema.Struct({
  policyViolationsDelta: LifecycleDeltaCountSchema,
  hallucinationFlagDelta: LifecycleDeltaCountSchema,
});

export const MemoryLifecycleCandidateSchema = Schema.Struct({
  spaceId: SpaceIdSchema,
  candidateId: LifecycleEntityIdSchema,
  statement: NonEmptyTrimmedStringSchema,
  scope: NonEmptyTrimmedStringSchema,
  sourceEpisodeIds: Schema.Array(EvidenceIdSchema),
  status: MemoryLifecycleCandidateStatusSchema,
  expiresAtMillis: NonNegativeIntSchema,
  latestReplayEvalId: Schema.NullOr(LifecycleEntityIdSchema),
  promotedRuleId: Schema.NullOr(LifecycleEntityIdSchema),
  promotedAtMillis: Schema.NullOr(NonNegativeIntSchema),
  demotedAtMillis: Schema.NullOr(NonNegativeIntSchema),
  updatedAtMillis: NonNegativeIntSchema,
});

export const MemoryLifecycleShadowWriteRequestSchema = Schema.Struct({
  spaceId: SpaceIdSchema,
  candidateId: LifecycleEntityIdSchema,
  statement: NonEmptyTrimmedStringSchema,
  scope: Schema.optional(NonEmptyTrimmedStringSchema),
  sourceEpisodeIds: Schema.Array(EvidenceIdSchema),
  expiresAtMillis: NonNegativeIntSchema,
  writtenAtMillis: NonNegativeIntSchema,
});

export const MemoryLifecycleShadowWriteResponseSchema = Schema.Struct({
  operation: Schema.Literal("shadow_write"),
  requestDigest: Sha256HexSchema,
  action: Schema.Literals(["created", "updated", "noop"]),
  candidate: MemoryLifecycleCandidateSchema,
});

export const MemoryLifecycleReplayEvalRequestSchema = Schema.Struct({
  spaceId: SpaceIdSchema,
  candidateId: LifecycleEntityIdSchema,
  evaluationPackId: LifecycleEntityIdSchema,
  targetMemorySpace: SpaceIdSchema,
  evaluatedAtMillis: NonNegativeIntSchema,
  qualityDelta: MemoryLifecycleQualityDeltaSchema,
  efficiencyDelta: MemoryLifecycleEfficiencyDeltaSchema,
  safetyDelta: MemoryLifecycleSafetyDeltaSchema,
});

export const MemoryLifecycleReplayEvalResponseSchema = Schema.Struct({
  operation: Schema.Literal("replay_eval"),
  requestDigest: Sha256HexSchema,
  replayEvalId: LifecycleEntityIdSchema,
  candidateId: LifecycleEntityIdSchema,
  evaluationPackId: LifecycleEntityIdSchema,
  targetMemorySpace: SpaceIdSchema,
  qualityDelta: MemoryLifecycleQualityDeltaSchema,
  efficiencyDelta: MemoryLifecycleEfficiencyDeltaSchema,
  safetyDelta: MemoryLifecycleSafetyDeltaSchema,
  netValueScore: Schema.Number,
  gateStatus: MemoryLifecycleGateStatusSchema,
});

export const MemoryLifecyclePromoteRequestSchema = Schema.Struct({
  spaceId: SpaceIdSchema,
  candidateId: LifecycleEntityIdSchema,
  promotedAtMillis: NonNegativeIntSchema,
});

export const MemoryLifecyclePromoteResponseSchema = Schema.Struct({
  operation: Schema.Literal("promote"),
  requestDigest: Sha256HexSchema,
  action: Schema.Literals(["promoted", "noop"]),
  candidate: MemoryLifecycleCandidateSchema,
  ruleId: Schema.NullOr(LifecycleEntityIdSchema),
  replayEvalId: Schema.NullOr(LifecycleEntityIdSchema),
  gateStatus: MemoryLifecycleGateStatusSchema,
});

export const MemoryLifecycleDemoteRequestSchema = Schema.Struct({
  spaceId: SpaceIdSchema,
  candidateId: LifecycleEntityIdSchema,
  demotedAtMillis: NonNegativeIntSchema,
  reasonCodes: Schema.Array(LifecycleReasonCodeSchema),
});

export const MemoryLifecycleDemoteResponseSchema = Schema.Struct({
  operation: Schema.Literal("demote"),
  requestDigest: Sha256HexSchema,
  action: Schema.Literals(["demoted", "noop"]),
  candidate: MemoryLifecycleCandidateSchema,
  removedRuleId: Schema.NullOr(LifecycleEntityIdSchema),
  reasonCodes: Schema.Array(LifecycleReasonCodeSchema),
});

export type StorageUpsertRequest = Schema.Schema.Type<
  typeof StorageUpsertRequestSchema
>;
export type StorageUpsertResponse = Schema.Schema.Type<
  typeof StorageUpsertResponseSchema
>;
export type StorageDeleteRequest = Schema.Schema.Type<
  typeof StorageDeleteRequestSchema
>;
export type StorageDeleteResponse = Schema.Schema.Type<
  typeof StorageDeleteResponseSchema
>;
export type StorageSnapshotSignatureAlgorithm = Schema.Schema.Type<
  typeof StorageSnapshotSignatureAlgorithmSchema
>;
export type StorageSnapshotExportRequest = Schema.Schema.Type<
  typeof StorageSnapshotExportRequestSchema
>;
export type StorageSnapshotExportResponse = Schema.Schema.Type<
  typeof StorageSnapshotExportResponseSchema
>;
export type StorageSnapshotImportRequest = Schema.Schema.Type<
  typeof StorageSnapshotImportRequestSchema
>;
export type StorageSnapshotImportResponse = Schema.Schema.Type<
  typeof StorageSnapshotImportResponseSchema
>;
export type ScopeAuthorizationInput = Schema.Schema.Type<
  typeof ScopeAuthorizationInputSchema
>;
export type RetrievalScopeSelectors = Schema.Schema.Type<
  typeof RetrievalScopeSelectorsSchema
>;
export type RetrievalPolicyInput = Schema.Schema.Type<
  typeof RetrievalPolicyInputSchema
>;
export type RetrievalRankingWeights = Schema.Schema.Type<
  typeof RetrievalRankingWeightsSchema
>;
export type RetrievalRequest = Schema.Schema.Type<
  typeof RetrievalRequestSchema
>;
export type RetrievalScopeLevel = Schema.Schema.Type<
  typeof RetrievalScopeLevelSchema
>;
export type RetrievalHit = Schema.Schema.Type<typeof RetrievalHitSchema>;
export type RetrievalExplainabilityReasonCode = Schema.Schema.Type<
  typeof RetrievalExplainabilityReasonCodeSchema
>;
export type RetrievalExplainabilityRankingSignal = Schema.Schema.Type<
  typeof RetrievalExplainabilityRankingSignalSchema
>;
export type RetrievalExplainabilityRankingSignals = Schema.Schema.Type<
  typeof RetrievalExplainabilityRankingSignalsSchema
>;
export type RetrievalExplainabilityWeightedContribution = Schema.Schema.Type<
  typeof RetrievalExplainabilityWeightedContributionSchema
>;
export type RetrievalExplainabilityHit = Schema.Schema.Type<
  typeof RetrievalExplainabilityHitSchema
>;
export type ActionableRetrievalPackSourceMetadata = Schema.Schema.Type<
  typeof ActionableRetrievalPackSourceMetadataSchema
>;
export type ActionableRetrievalPackSource = Schema.Schema.Type<
  typeof ActionableRetrievalPackSourceSchema
>;
export type ActionableRetrievalPack = Schema.Schema.Type<
  typeof ActionableRetrievalPackSchema
>;
export type RetrievalResponse = Schema.Schema.Type<
  typeof RetrievalResponseSchema
>;
export type RetrievalExplainabilityResponse = Schema.Schema.Type<
  typeof RetrievalExplainabilityResponseSchema
>;
export type EvaluationRequest = Schema.Schema.Type<
  typeof EvaluationRequestSchema
>;
export type EvaluationResult = Schema.Schema.Type<
  typeof EvaluationResultSchema
>;
export type EvaluationResponse = Schema.Schema.Type<
  typeof EvaluationResponseSchema
>;
export type PolicyRequest = Schema.Schema.Type<typeof PolicyRequestSchema>;
export type PolicyResponse = Schema.Schema.Type<typeof PolicyResponseSchema>;
export type PolicyPackPluginContractVersion = Schema.Schema.Type<
  typeof PolicyPackPluginContractVersionSchema
>;
export type PolicyPackPluginRequest = Schema.Schema.Type<
  typeof PolicyPackPluginRequestSchema
>;
export type PolicyPackPluginOutcome = Schema.Schema.Type<
  typeof PolicyPackPluginOutcomeSchema
>;
export type PolicyPackPluginResponse = Schema.Schema.Type<
  typeof PolicyPackPluginResponseSchema
>;
export type AuthorizationRole = Schema.Schema.Type<
  typeof AuthorizationRoleSchema
>;
export type AuthorizationAction = Schema.Schema.Type<
  typeof AuthorizationActionSchema
>;
export type AuthorizationDecisionReasonCode = Schema.Schema.Type<
  typeof AuthorizationDecisionReasonCodeSchema
>;
export type AuthorizationRequest = Schema.Schema.Type<
  typeof AuthorizationRequestSchema
>;
export type AuthorizationResponse = Schema.Schema.Type<
  typeof AuthorizationResponseSchema
>;
export type IngestionRecord = Schema.Schema.Type<typeof IngestionRecordSchema>;
export type IngestionRequest = Schema.Schema.Type<
  typeof IngestionRequestSchema
>;
export type IngestionResponse = Schema.Schema.Type<
  typeof IngestionResponseSchema
>;
export type MemoryLifecycleEntityId = Schema.Schema.Type<
  typeof LifecycleEntityIdSchema
>;
export type MemoryLifecycleReasonCode = Schema.Schema.Type<
  typeof LifecycleReasonCodeSchema
>;
export type MemoryLifecycleOperation = Schema.Schema.Type<
  typeof MemoryLifecycleOperationSchema
>;
export type MemoryLifecycleCandidateStatus = Schema.Schema.Type<
  typeof MemoryLifecycleCandidateStatusSchema
>;
export type MemoryLifecycleGateStatus = Schema.Schema.Type<
  typeof MemoryLifecycleGateStatusSchema
>;
export type MemoryLifecyclePreconditionReasonCode = Schema.Schema.Type<
  typeof MemoryLifecyclePreconditionReasonCodeSchema
>;
export type MemoryLifecycleQualityDelta = Schema.Schema.Type<
  typeof MemoryLifecycleQualityDeltaSchema
>;
export type MemoryLifecycleEfficiencyDelta = Schema.Schema.Type<
  typeof MemoryLifecycleEfficiencyDeltaSchema
>;
export type MemoryLifecycleSafetyDelta = Schema.Schema.Type<
  typeof MemoryLifecycleSafetyDeltaSchema
>;
export type MemoryLifecycleCandidate = Schema.Schema.Type<
  typeof MemoryLifecycleCandidateSchema
>;
export type MemoryLifecycleShadowWriteRequest = Schema.Schema.Type<
  typeof MemoryLifecycleShadowWriteRequestSchema
>;
export type MemoryLifecycleShadowWriteResponse = Schema.Schema.Type<
  typeof MemoryLifecycleShadowWriteResponseSchema
>;
export type MemoryLifecycleReplayEvalRequest = Schema.Schema.Type<
  typeof MemoryLifecycleReplayEvalRequestSchema
>;
export type MemoryLifecycleReplayEvalResponse = Schema.Schema.Type<
  typeof MemoryLifecycleReplayEvalResponseSchema
>;
export type MemoryLifecyclePromoteRequest = Schema.Schema.Type<
  typeof MemoryLifecyclePromoteRequestSchema
>;
export type MemoryLifecyclePromoteResponse = Schema.Schema.Type<
  typeof MemoryLifecyclePromoteResponseSchema
>;
export type MemoryLifecycleDemoteRequest = Schema.Schema.Type<
  typeof MemoryLifecycleDemoteRequestSchema
>;
export type MemoryLifecycleDemoteResponse = Schema.Schema.Type<
  typeof MemoryLifecycleDemoteResponseSchema
>;
