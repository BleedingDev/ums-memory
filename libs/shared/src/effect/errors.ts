import { Schema } from "effect";

import { EvidenceIdSchema, MemoryIdSchema, SpaceIdSchema, UserIdSchema } from "./contracts/ids.js";

const RetrievalScoreSchema = Schema.Number.pipe(Schema.between(0, 1));

export class ContractValidationError extends Schema.TaggedError<ContractValidationError>()(
  "ContractValidationError",
  {
    contract: Schema.String,
    message: Schema.String,
    details: Schema.String,
  },
) {}

export class StorageConflictError extends Schema.TaggedError<StorageConflictError>()(
  "StorageConflictError",
  {
    spaceId: SpaceIdSchema,
    memoryId: MemoryIdSchema,
    message: Schema.String,
  },
) {}

export class StorageNotFoundError extends Schema.TaggedError<StorageNotFoundError>()(
  "StorageNotFoundError",
  {
    spaceId: SpaceIdSchema,
    memoryId: MemoryIdSchema,
    message: Schema.String,
  },
) {}

export class RetrievalQueryError extends Schema.TaggedError<RetrievalQueryError>()(
  "RetrievalQueryError",
  {
    spaceId: SpaceIdSchema,
    query: Schema.String,
    message: Schema.String,
  },
) {}

export class EvaluationThresholdError extends Schema.TaggedError<EvaluationThresholdError>()(
  "EvaluationThresholdError",
  {
    objective: Schema.String,
    minimumScore: RetrievalScoreSchema,
    message: Schema.String,
  },
) {}

export class PolicyDeniedError extends Schema.TaggedError<PolicyDeniedError>()(
  "PolicyDeniedError",
  {
    actorId: UserIdSchema,
    action: Schema.String,
    resourceId: MemoryIdSchema,
    message: Schema.String,
  },
) {}

export class IngestionDuplicateError extends Schema.TaggedError<IngestionDuplicateError>()(
  "IngestionDuplicateError",
  {
    idempotencyKey: Schema.String,
    duplicateRecordIds: Schema.Array(EvidenceIdSchema),
    message: Schema.String,
  },
) {}

export type StorageServiceError =
  | ContractValidationError
  | StorageConflictError
  | StorageNotFoundError;

export type RetrievalServiceError = ContractValidationError | RetrievalQueryError;

export type EvaluationServiceError = ContractValidationError | EvaluationThresholdError;

export type PolicyServiceError = ContractValidationError | PolicyDeniedError;

export type IngestionServiceError = ContractValidationError | IngestionDuplicateError;
