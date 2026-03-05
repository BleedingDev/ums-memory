import { Schema } from "effect";

import {
  EvidenceIdSchema,
  MemoryIdSchema,
  SpaceIdSchema,
  TenantIdSchema,
  UserIdSchema,
} from "./contracts/ids.js";
import {
  AuthorizationActionSchema,
  AuthorizationDecisionReasonCodeSchema,
  AuthorizationRoleSchema,
  MemoryLifecycleOperationSchema,
  MemoryLifecyclePreconditionReasonCodeSchema,
  TenantRouteDenyReasonCodeSchema,
} from "./contracts/services.js";

const RetrievalScoreSchema = Schema.Number.check(
  Schema.isBetween({ minimum: 0, maximum: 1 })
);
const NonNegativeIntSchema = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0)
);
const NonEmptyTrimmedStringSchema = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty()
);

export class ContractValidationError extends Schema.TaggedErrorClass<ContractValidationError>()(
  "ContractValidationError",
  {
    contract: Schema.String,
    message: Schema.String,
    details: Schema.String,
  }
) {}

export class StorageConflictError extends Schema.TaggedErrorClass<StorageConflictError>()(
  "StorageConflictError",
  {
    spaceId: SpaceIdSchema,
    memoryId: MemoryIdSchema,
    message: Schema.String,
  }
) {}

export class StorageNotFoundError extends Schema.TaggedErrorClass<StorageNotFoundError>()(
  "StorageNotFoundError",
  {
    spaceId: SpaceIdSchema,
    memoryId: MemoryIdSchema,
    message: Schema.String,
  }
) {}

export class RetrievalQueryError extends Schema.TaggedErrorClass<RetrievalQueryError>()(
  "RetrievalQueryError",
  {
    spaceId: SpaceIdSchema,
    query: Schema.String,
    message: Schema.String,
  }
) {}

export class EvaluationThresholdError extends Schema.TaggedErrorClass<EvaluationThresholdError>()(
  "EvaluationThresholdError",
  {
    objective: Schema.String,
    minimumScore: RetrievalScoreSchema,
    message: Schema.String,
  }
) {}

export class PolicyDeniedError extends Schema.TaggedErrorClass<PolicyDeniedError>()(
  "PolicyDeniedError",
  {
    actorId: UserIdSchema,
    action: Schema.String,
    resourceId: MemoryIdSchema,
    message: Schema.String,
  }
) {}

export class AuthorizationDeniedError extends Schema.TaggedErrorClass<AuthorizationDeniedError>()(
  "AuthorizationDeniedError",
  {
    role: AuthorizationRoleSchema,
    action: AuthorizationActionSchema,
    reasonCode: AuthorizationDecisionReasonCodeSchema,
    evaluatedAtMillis: NonNegativeIntSchema,
    message: Schema.String,
  }
) {}

export class IngestionDuplicateError extends Schema.TaggedErrorClass<IngestionDuplicateError>()(
  "IngestionDuplicateError",
  {
    idempotencyKey: Schema.String,
    duplicateRecordIds: Schema.Array(EvidenceIdSchema),
    message: Schema.String,
  }
) {}

export class TenantRoutingDeniedError extends Schema.TaggedErrorClass<TenantRoutingDeniedError>()(
  "TenantRoutingDeniedError",
  {
    denyReasonCode: TenantRouteDenyReasonCodeSchema,
    tenantId: Schema.optional(TenantIdSchema),
    candidateTenantIds: Schema.Array(TenantIdSchema),
    evaluatedAtMillis: NonNegativeIntSchema,
    message: Schema.String,
  }
) {}

export class MemoryLifecyclePreconditionError extends Schema.TaggedErrorClass<MemoryLifecyclePreconditionError>()(
  "MemoryLifecyclePreconditionError",
  {
    operation: MemoryLifecycleOperationSchema,
    spaceId: SpaceIdSchema,
    candidateId: NonEmptyTrimmedStringSchema,
    reasonCode: MemoryLifecyclePreconditionReasonCodeSchema,
    message: Schema.String,
  }
) {}

export class RuntimePersistenceExecutionError extends Schema.TaggedErrorClass<RuntimePersistenceExecutionError>()(
  "RuntimePersistenceExecutionError",
  {
    operation: Schema.String,
    message: Schema.String,
    details: Schema.String,
  }
) {}

export type StorageServiceError =
  | ContractValidationError
  | StorageConflictError
  | StorageNotFoundError;

export type RetrievalServiceError =
  | ContractValidationError
  | RetrievalQueryError;

export type EvaluationServiceError =
  | ContractValidationError
  | EvaluationThresholdError;

export type PolicyServiceError = ContractValidationError | PolicyDeniedError;

export type AuthorizationServiceError =
  | ContractValidationError
  | AuthorizationDeniedError;

export type IngestionServiceError =
  | ContractValidationError
  | IngestionDuplicateError;

export type TenantRoutingServiceError =
  | ContractValidationError
  | TenantRoutingDeniedError;

export type MemoryLifecycleServiceError =
  | ContractValidationError
  | MemoryLifecyclePreconditionError;

export type RuntimePersistenceServiceError =
  | ContractValidationError
  | RuntimePersistenceExecutionError;
