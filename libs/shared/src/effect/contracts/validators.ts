import { Effect, Schema, SchemaIssue } from "effect";

import { ContractValidationError } from "../errors.js";
import {
  AdapterSessionEnvelopeSchema,
  AuthorizationRequestSchema,
  AuthorizationResponseSchema,
  DeterministicDedupeDecisionSchema,
  EvaluationRequestSchema,
  IngestionRequestSchema,
  MemoryLifecycleDemoteRequestSchema,
  MemoryLifecyclePromoteRequestSchema,
  MemoryLifecycleReplayEvalRequestSchema,
  MemoryLifecycleShadowWriteRequestSchema,
  PolicyRequestSchema,
  RetrievalRequestSchema,
  StorageDeleteRequestSchema,
  TenantRoutingRequestSchema,
  TenantRoutingResponseSchema,
  StorageUpsertRequestSchema,
} from "./services.js";

type SyncDecodingSchema<S extends Schema.Top> = S & {
  readonly DecodingServices: never;
};

export const decodeUnknownSync = <S extends Schema.Top>(schema: S) =>
  Schema.decodeUnknownSync(schema as SyncDecodingSchema<S>);

export const validateUnknownSync = <S extends Schema.Top>(schema: S) =>
  Schema.decodeUnknownSync(schema as SyncDecodingSchema<S>);

const formatParseError = (error: unknown): string => {
  const formatter = SchemaIssue.makeFormatterDefault();
  if (SchemaIssue.isIssue(error)) {
    return formatter(error);
  }
  if (Schema.isSchemaError(error)) {
    return formatter(error.issue);
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
};

export const decodeUnknownEffect = <S extends Schema.Top>(
  schema: S,
  contract: string
) => {
  const decode = Schema.decodeUnknownEffect(schema as SyncDecodingSchema<S>);

  return (input: unknown): Effect.Effect<S["Type"], ContractValidationError> =>
    decode(input).pipe(
      Effect.mapError(
        (error) =>
          new ContractValidationError({
            contract,
            message: `Contract validation failed for ${contract}`,
            details: formatParseError(error),
          })
      )
    );
};

export const decodeStorageUpsertRequest = decodeUnknownSync(
  StorageUpsertRequestSchema
);
export const validateStorageUpsertRequest = validateUnknownSync(
  StorageUpsertRequestSchema
);
export const decodeStorageUpsertRequestEffect = decodeUnknownEffect(
  StorageUpsertRequestSchema,
  "StorageUpsertRequest"
);

export const decodeStorageDeleteRequest = decodeUnknownSync(
  StorageDeleteRequestSchema
);
export const validateStorageDeleteRequest = validateUnknownSync(
  StorageDeleteRequestSchema
);
export const decodeStorageDeleteRequestEffect = decodeUnknownEffect(
  StorageDeleteRequestSchema,
  "StorageDeleteRequest"
);

export const decodeRetrievalRequest = decodeUnknownSync(RetrievalRequestSchema);
export const validateRetrievalRequest = validateUnknownSync(
  RetrievalRequestSchema
);
export const decodeRetrievalRequestEffect = decodeUnknownEffect(
  RetrievalRequestSchema,
  "RetrievalRequest"
);

export const decodeEvaluationRequest = decodeUnknownSync(
  EvaluationRequestSchema
);
export const validateEvaluationRequest = validateUnknownSync(
  EvaluationRequestSchema
);
export const decodeEvaluationRequestEffect = decodeUnknownEffect(
  EvaluationRequestSchema,
  "EvaluationRequest"
);

export const decodePolicyRequest = decodeUnknownSync(PolicyRequestSchema);
export const validatePolicyRequest = validateUnknownSync(PolicyRequestSchema);
export const decodePolicyRequestEffect = decodeUnknownEffect(
  PolicyRequestSchema,
  "PolicyRequest"
);

export const decodeAuthorizationRequest = decodeUnknownSync(
  AuthorizationRequestSchema
);
export const validateAuthorizationRequest = validateUnknownSync(
  AuthorizationRequestSchema
);
export const decodeAuthorizationRequestEffect = decodeUnknownEffect(
  AuthorizationRequestSchema,
  "AuthorizationRequest"
);

export const decodeAuthorizationResponse = decodeUnknownSync(
  AuthorizationResponseSchema
);
export const validateAuthorizationResponse = validateUnknownSync(
  AuthorizationResponseSchema
);
export const decodeAuthorizationResponseEffect = decodeUnknownEffect(
  AuthorizationResponseSchema,
  "AuthorizationResponse"
);

export const decodeTenantRoutingRequest = decodeUnknownSync(
  TenantRoutingRequestSchema
);
export const validateTenantRoutingRequest = validateUnknownSync(
  TenantRoutingRequestSchema
);
export const decodeTenantRoutingRequestEffect = decodeUnknownEffect(
  TenantRoutingRequestSchema,
  "TenantRoutingRequest"
);

export const decodeTenantRoutingResponse = decodeUnknownSync(
  TenantRoutingResponseSchema
);
export const validateTenantRoutingResponse = validateUnknownSync(
  TenantRoutingResponseSchema
);
export const decodeTenantRoutingResponseEffect = decodeUnknownEffect(
  TenantRoutingResponseSchema,
  "TenantRoutingResponse"
);

export const decodeIngestionRequest = decodeUnknownSync(IngestionRequestSchema);
export const validateIngestionRequest = validateUnknownSync(
  IngestionRequestSchema
);
export const decodeIngestionRequestEffect = decodeUnknownEffect(
  IngestionRequestSchema,
  "IngestionRequest"
);

export const decodeAdapterSessionEnvelope = decodeUnknownSync(
  AdapterSessionEnvelopeSchema
);
export const validateAdapterSessionEnvelope = validateUnknownSync(
  AdapterSessionEnvelopeSchema
);
export const decodeAdapterSessionEnvelopeEffect = decodeUnknownEffect(
  AdapterSessionEnvelopeSchema,
  "AdapterSessionEnvelope"
);

export const decodeDeterministicDedupeDecision = decodeUnknownSync(
  DeterministicDedupeDecisionSchema
);
export const validateDeterministicDedupeDecision = validateUnknownSync(
  DeterministicDedupeDecisionSchema
);
export const decodeDeterministicDedupeDecisionEffect = decodeUnknownEffect(
  DeterministicDedupeDecisionSchema,
  "DeterministicDedupeDecision"
);

export const decodeMemoryLifecycleShadowWriteRequest = decodeUnknownSync(
  MemoryLifecycleShadowWriteRequestSchema
);
export const validateMemoryLifecycleShadowWriteRequest = validateUnknownSync(
  MemoryLifecycleShadowWriteRequestSchema
);
export const decodeMemoryLifecycleShadowWriteRequestEffect =
  decodeUnknownEffect(
    MemoryLifecycleShadowWriteRequestSchema,
    "MemoryLifecycleShadowWriteRequest"
  );

export const decodeMemoryLifecycleReplayEvalRequest = decodeUnknownSync(
  MemoryLifecycleReplayEvalRequestSchema
);
export const validateMemoryLifecycleReplayEvalRequest = validateUnknownSync(
  MemoryLifecycleReplayEvalRequestSchema
);
export const decodeMemoryLifecycleReplayEvalRequestEffect = decodeUnknownEffect(
  MemoryLifecycleReplayEvalRequestSchema,
  "MemoryLifecycleReplayEvalRequest"
);

export const decodeMemoryLifecyclePromoteRequest = decodeUnknownSync(
  MemoryLifecyclePromoteRequestSchema
);
export const validateMemoryLifecyclePromoteRequest = validateUnknownSync(
  MemoryLifecyclePromoteRequestSchema
);
export const decodeMemoryLifecyclePromoteRequestEffect = decodeUnknownEffect(
  MemoryLifecyclePromoteRequestSchema,
  "MemoryLifecyclePromoteRequest"
);

export const decodeMemoryLifecycleDemoteRequest = decodeUnknownSync(
  MemoryLifecycleDemoteRequestSchema
);
export const validateMemoryLifecycleDemoteRequest = validateUnknownSync(
  MemoryLifecycleDemoteRequestSchema
);
export const decodeMemoryLifecycleDemoteRequestEffect = decodeUnknownEffect(
  MemoryLifecycleDemoteRequestSchema,
  "MemoryLifecycleDemoteRequest"
);
