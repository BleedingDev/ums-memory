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

export const StorageUpsertRequestSchema = Schema.Struct({
  spaceId: SpaceIdSchema,
  memoryId: MemoryIdSchema,
  layer: MemoryLayerSchema,
  payload: IngestionMetadataSchema,
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
  idempotencyKey: Schema.optional(Schema.String),
  idempotency_key: Schema.optional(Schema.String),
});

export const StorageDeleteResponseSchema = Schema.Struct({
  spaceId: SpaceIdSchema,
  memoryId: MemoryIdSchema,
  deleted: Schema.Boolean,
});

export const StorageSnapshotSignatureAlgorithmSchema = Schema.Literal("hmac-sha256");

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

export const RetrievalRequestSchema = Schema.Struct({
  spaceId: SpaceIdSchema,
  query: Schema.String,
  limit: NonNegativeIntSchema,
  cursor: Schema.optional(Schema.NullOr(Schema.String)),
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
});

export const RetrievalHitSchema = Schema.Struct({
  memoryId: MemoryIdSchema,
  layer: MemoryLayerSchema,
  score: RetrievalScoreSchema,
  excerpt: Schema.String,
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

export type StorageUpsertRequest = Schema.Schema.Type<typeof StorageUpsertRequestSchema>;
export type StorageUpsertResponse = Schema.Schema.Type<typeof StorageUpsertResponseSchema>;
export type StorageDeleteRequest = Schema.Schema.Type<typeof StorageDeleteRequestSchema>;
export type StorageDeleteResponse = Schema.Schema.Type<typeof StorageDeleteResponseSchema>;
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
export type RetrievalScopeSelectors = Schema.Schema.Type<typeof RetrievalScopeSelectorsSchema>;
export type RetrievalPolicyInput = Schema.Schema.Type<typeof RetrievalPolicyInputSchema>;
export type RetrievalRequest = Schema.Schema.Type<typeof RetrievalRequestSchema>;
export type RetrievalHit = Schema.Schema.Type<typeof RetrievalHitSchema>;
export type ActionableRetrievalPackSourceMetadata = Schema.Schema.Type<
  typeof ActionableRetrievalPackSourceMetadataSchema
>;
export type ActionableRetrievalPackSource = Schema.Schema.Type<
  typeof ActionableRetrievalPackSourceSchema
>;
export type ActionableRetrievalPack = Schema.Schema.Type<typeof ActionableRetrievalPackSchema>;
export type RetrievalResponse = Schema.Schema.Type<typeof RetrievalResponseSchema>;
export type EvaluationRequest = Schema.Schema.Type<typeof EvaluationRequestSchema>;
export type EvaluationResult = Schema.Schema.Type<typeof EvaluationResultSchema>;
export type EvaluationResponse = Schema.Schema.Type<typeof EvaluationResponseSchema>;
export type PolicyRequest = Schema.Schema.Type<typeof PolicyRequestSchema>;
export type PolicyResponse = Schema.Schema.Type<typeof PolicyResponseSchema>;
export type IngestionRecord = Schema.Schema.Type<typeof IngestionRecordSchema>;
export type IngestionRequest = Schema.Schema.Type<typeof IngestionRequestSchema>;
export type IngestionResponse = Schema.Schema.Type<typeof IngestionResponseSchema>;
