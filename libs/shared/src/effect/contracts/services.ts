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
  ProjectIdSchema,
  RoleIdSchema,
  SpaceIdSchema,
  UserIdSchema,
} from "./ids.js";

const NonNegativeIntSchema = Schema.NonNegativeInt;
const Sha256HexSchema = Schema.String.pipe(Schema.pattern(/^[0-9A-Fa-f]{64}$/));

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

const RetrievalScoreSchema = Schema.Number.pipe(Schema.between(0, 1));
const RetrievalScopeLevelSchema = Schema.Literal(
  "common",
  "project",
  "job_role",
  "user"
);

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

const RetrievalRankingWeightSchema = Schema.Number.pipe(Schema.between(0, 1));

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

export const RetrievalExplainabilityReasonCodeSchema = Schema.Literal(
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
  "CHRONOLOGY_RECONCILED"
);

export const RetrievalExplainabilityRankingSignalSchema = Schema.Literal(
  "relevance",
  "evidenceStrength",
  "decay",
  "humanWeight",
  "utility"
);

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

const ActionableRetrievalLineSchema = Schema.NonEmptyTrimmedString;

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

export const AuthorizationRoleSchema = Schema.Literal(
  "admin",
  "lead",
  "dev",
  "auditor"
);

export const AuthorizationActionSchema = Schema.Literal(
  "memory.read",
  "memory.write",
  "memory.promote",
  "memory.demote",
  "memory.replay_eval",
  "policy.read",
  "policy.write",
  "policy.override",
  "compliance.read",
  "compliance.export"
);

export const AuthorizationDecisionReasonCodeSchema = Schema.Literal(
  "RBAC_ALLOW",
  "RBAC_DENY_ROLE_ACTION"
);

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
