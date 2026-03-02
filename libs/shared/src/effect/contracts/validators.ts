import { Effect, ParseResult, Schema } from "effect";

import { ContractValidationError } from "../errors.js";
import {
  AuthorizationRequestSchema,
  AuthorizationResponseSchema,
  EvaluationRequestSchema,
  IngestionRequestSchema,
  MemoryLifecycleDemoteRequestSchema,
  MemoryLifecyclePromoteRequestSchema,
  MemoryLifecycleReplayEvalRequestSchema,
  MemoryLifecycleShadowWriteRequestSchema,
  PolicyRequestSchema,
  RetrievalRequestSchema,
  StorageDeleteRequestSchema,
  StorageUpsertRequestSchema,
} from "./services.js";

type SchemaWithoutContext<A, I = A> = Schema.Schema<A, I, never>;

export const decodeUnknownSync = <A, I>(schema: SchemaWithoutContext<A, I>) =>
  Schema.decodeUnknownSync(schema);

export const validateUnknownSync = <A, I>(schema: SchemaWithoutContext<A, I>) =>
  Schema.validateSync(schema);

const formatParseError = (error: ParseResult.ParseError): string =>
  ParseResult.TreeFormatter.formatErrorSync(error);

export const decodeUnknownEffect = <A, I>(
  schema: SchemaWithoutContext<A, I>,
  contract: string
) => {
  const decode = Schema.decodeUnknown(schema);

  return (input: unknown): Effect.Effect<A, ContractValidationError> =>
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

export const decodeIngestionRequest = decodeUnknownSync(IngestionRequestSchema);
export const validateIngestionRequest = validateUnknownSync(
  IngestionRequestSchema
);
export const decodeIngestionRequestEffect = decodeUnknownEffect(
  IngestionRequestSchema,
  "IngestionRequest"
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
