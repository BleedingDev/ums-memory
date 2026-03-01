import { Schema } from "effect";

import {
  IngestionMetadataSchema,
  MemoryLayerSchema,
  PolicyContextSchema,
  PolicyOutcomeSchema,
} from "./domains.js";
import { EvidenceIdSchema, MemoryIdSchema, SpaceIdSchema, UserIdSchema } from "./ids.js";

const NonNegativeIntSchema = Schema.NonNegativeInt;

export const StorageUpsertRequestSchema = Schema.Struct({
  spaceId: SpaceIdSchema,
  memoryId: MemoryIdSchema,
  layer: MemoryLayerSchema,
  payload: IngestionMetadataSchema,
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
});

export const StorageDeleteResponseSchema = Schema.Struct({
  spaceId: SpaceIdSchema,
  memoryId: MemoryIdSchema,
  deleted: Schema.Boolean,
});

const RetrievalScoreSchema = Schema.Number.pipe(Schema.between(0, 1));

export const RetrievalRequestSchema = Schema.Struct({
  spaceId: SpaceIdSchema,
  query: Schema.String,
  limit: NonNegativeIntSchema,
  cursor: Schema.optional(Schema.NullOr(Schema.String)),
});

export const RetrievalHitSchema = Schema.Struct({
  memoryId: MemoryIdSchema,
  layer: MemoryLayerSchema,
  score: RetrievalScoreSchema,
  excerpt: Schema.String,
});

export const RetrievalResponseSchema = Schema.Struct({
  hits: Schema.Array(RetrievalHitSchema),
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
export type RetrievalRequest = Schema.Schema.Type<typeof RetrievalRequestSchema>;
export type RetrievalHit = Schema.Schema.Type<typeof RetrievalHitSchema>;
export type RetrievalResponse = Schema.Schema.Type<typeof RetrievalResponseSchema>;
export type EvaluationRequest = Schema.Schema.Type<typeof EvaluationRequestSchema>;
export type EvaluationResult = Schema.Schema.Type<typeof EvaluationResultSchema>;
export type EvaluationResponse = Schema.Schema.Type<typeof EvaluationResponseSchema>;
export type PolicyRequest = Schema.Schema.Type<typeof PolicyRequestSchema>;
export type PolicyResponse = Schema.Schema.Type<typeof PolicyResponseSchema>;
export type IngestionRecord = Schema.Schema.Type<typeof IngestionRecordSchema>;
export type IngestionRequest = Schema.Schema.Type<typeof IngestionRequestSchema>;
export type IngestionResponse = Schema.Schema.Type<typeof IngestionResponseSchema>;
