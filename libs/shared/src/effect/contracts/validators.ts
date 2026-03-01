import { Effect, ParseResult, Schema } from "effect";

import {
  EvaluationRequestSchema,
  IngestionRequestSchema,
  PolicyRequestSchema,
  RetrievalRequestSchema,
  StorageDeleteRequestSchema,
  StorageUpsertRequestSchema,
} from "./services.js";
import { ContractValidationError } from "../errors.js";

type SchemaWithoutContext<A, I = A> = Schema.Schema<A, I, never>;

export const decodeUnknownSync = <A, I>(schema: SchemaWithoutContext<A, I>) =>
  Schema.decodeUnknownSync(schema);

export const validateUnknownSync = <A, I>(schema: SchemaWithoutContext<A, I>) =>
  Schema.validateSync(schema);

const formatParseError = (error: ParseResult.ParseError): string =>
  ParseResult.TreeFormatter.formatErrorSync(error);

export const decodeUnknownEffect = <A, I>(schema: SchemaWithoutContext<A, I>, contract: string) => {
  const decode = Schema.decodeUnknown(schema);

  return (input: unknown): Effect.Effect<A, ContractValidationError> =>
    decode(input).pipe(
      Effect.mapError(
        (error) =>
          new ContractValidationError({
            contract,
            message: `Contract validation failed for ${contract}`,
            details: formatParseError(error),
          }),
      ),
    );
};

export const decodeStorageUpsertRequest = decodeUnknownSync(StorageUpsertRequestSchema);
export const validateStorageUpsertRequest = validateUnknownSync(StorageUpsertRequestSchema);
export const decodeStorageUpsertRequestEffect = decodeUnknownEffect(
  StorageUpsertRequestSchema,
  "StorageUpsertRequest",
);

export const decodeStorageDeleteRequest = decodeUnknownSync(StorageDeleteRequestSchema);
export const validateStorageDeleteRequest = validateUnknownSync(StorageDeleteRequestSchema);
export const decodeStorageDeleteRequestEffect = decodeUnknownEffect(
  StorageDeleteRequestSchema,
  "StorageDeleteRequest",
);

export const decodeRetrievalRequest = decodeUnknownSync(RetrievalRequestSchema);
export const validateRetrievalRequest = validateUnknownSync(RetrievalRequestSchema);
export const decodeRetrievalRequestEffect = decodeUnknownEffect(
  RetrievalRequestSchema,
  "RetrievalRequest",
);

export const decodeEvaluationRequest = decodeUnknownSync(EvaluationRequestSchema);
export const validateEvaluationRequest = validateUnknownSync(EvaluationRequestSchema);
export const decodeEvaluationRequestEffect = decodeUnknownEffect(
  EvaluationRequestSchema,
  "EvaluationRequest",
);

export const decodePolicyRequest = decodeUnknownSync(PolicyRequestSchema);
export const validatePolicyRequest = validateUnknownSync(PolicyRequestSchema);
export const decodePolicyRequestEffect = decodeUnknownEffect(PolicyRequestSchema, "PolicyRequest");

export const decodeIngestionRequest = decodeUnknownSync(IngestionRequestSchema);
export const validateIngestionRequest = validateUnknownSync(IngestionRequestSchema);
export const decodeIngestionRequestEffect = decodeUnknownEffect(
  IngestionRequestSchema,
  "IngestionRequest",
);
