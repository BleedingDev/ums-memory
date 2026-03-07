import { Effect, Layer, Predicate, Schema, ServiceMap } from "effect";

import {
  ContractValidationError,
  RuntimePersistenceExecutionError,
  type RuntimePersistenceServiceError,
} from "../errors.js";

export interface RuntimePersistenceExecutionRequest<TResponse = unknown> {
  readonly operation: string;
  readonly requestBody?: unknown;
  readonly scopeKey?: string | null;
  readonly execute: () => Promise<TResponse> | TResponse;
}

export interface RuntimePersistenceService {
  readonly execute: <TResponse>(
    request: RuntimePersistenceExecutionRequest<TResponse>
  ) => Effect.Effect<TResponse, RuntimePersistenceServiceError>;
}

export interface RuntimePersistenceRepository {
  readonly execute: <TResponse>(
    request: RuntimePersistenceExecutionRequest<TResponse>
  ) => Effect.Effect<TResponse, RuntimePersistenceServiceError>;
}

export const RuntimePersistenceServiceTag =
  ServiceMap.Service<RuntimePersistenceService>(
    "@ums/effect/RuntimePersistenceService"
  );

const ErrorWithMessageSchema = Schema.Struct({
  message: Schema.String,
});
const CodedErrorSchema = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
});
const ContractValidationErrorSchema = Schema.Struct({
  _tag: Schema.Literal("ContractValidationError"),
  contract: Schema.String,
  message: Schema.String,
  details: Schema.String,
});
const RuntimePersistenceExecutionErrorSchema = Schema.Struct({
  _tag: Schema.Literal("RuntimePersistenceExecutionError"),
  operation: Schema.String,
  code: Schema.optional(Schema.String),
  message: Schema.String,
  details: Schema.String,
});

const isErrorWithMessage = Schema.is(ErrorWithMessageSchema);
const isCodedError = Schema.is(CodedErrorSchema);
const isContractValidationError = Schema.is(ContractValidationErrorSchema);
const isRuntimePersistenceExecutionError = Schema.is(
  RuntimePersistenceExecutionErrorSchema
);
const isTaggedContractValidationError = (
  cause: unknown
): cause is ContractValidationError => isContractValidationError(cause);
const isTaggedRuntimePersistenceExecutionError = (
  cause: unknown
): cause is RuntimePersistenceExecutionError =>
  isRuntimePersistenceExecutionError(cause);

const toContractValidationError = (
  message: string,
  details: string
): ContractValidationError =>
  new ContractValidationError({
    contract: "RuntimePersistenceExecutionRequest",
    message,
    details,
  });

const toExecutionError = (
  operation: string,
  cause: unknown
): RuntimePersistenceExecutionError =>
  new RuntimePersistenceExecutionError({
    operation,
    message: "Runtime persistence executor failed.",
    details: isErrorWithMessage(cause) ? cause.message : String(cause),
  });

const normalizeExecutorFailure = (
  operation: string,
  cause: unknown
): RuntimePersistenceServiceError => {
  if (isTaggedContractValidationError(cause)) {
    return cause;
  }
  if (isTaggedRuntimePersistenceExecutionError(cause)) {
    return cause;
  }
  if (isCodedError(cause)) {
    return new RuntimePersistenceExecutionError({
      operation,
      code: cause.code,
      message: cause.message,
      details: cause.code,
    });
  }
  return toExecutionError(operation, cause);
};

const normalizeOperation = (operation: unknown): string =>
  Predicate.isString(operation) ? operation.trim().toLowerCase() : "";

const validateRequest = (
  request: RuntimePersistenceExecutionRequest<unknown>
): Effect.Effect<
  RuntimePersistenceExecutionRequest<unknown>,
  RuntimePersistenceServiceError
> => {
  const operation = normalizeOperation(request.operation);
  if (!operation) {
    return Effect.fail(
      toContractValidationError(
        "Runtime persistence operation must be a non-empty string.",
        "Provide a normalized runtime operation name."
      )
    );
  }
  if (!Predicate.isFunction(request.execute)) {
    return Effect.fail(
      toContractValidationError(
        "Runtime persistence request must provide an executor function.",
        "The execute field must be a function returning the operation result."
      )
    );
  }
  return Effect.succeed({
    ...request,
    operation,
  });
};

const executeWithValidation = <TResponse>(
  request: RuntimePersistenceExecutionRequest<TResponse>
): Effect.Effect<TResponse, RuntimePersistenceServiceError> =>
  validateRequest(request as RuntimePersistenceExecutionRequest<unknown>).pipe(
    Effect.flatMap((validatedRequest) =>
      Effect.tryPromise({
        try: async () => (await validatedRequest.execute()) as TResponse,
        catch: (cause) =>
          normalizeExecutorFailure(validatedRequest.operation, cause),
      })
    )
  );

const executeRepositoryWithValidation = <TResponse>(
  repository: RuntimePersistenceRepository,
  request: RuntimePersistenceExecutionRequest<TResponse>
): Effect.Effect<TResponse, RuntimePersistenceServiceError> =>
  validateRequest(request as RuntimePersistenceExecutionRequest<unknown>).pipe(
    Effect.flatMap((validatedRequest) =>
      repository.execute(
        validatedRequest as RuntimePersistenceExecutionRequest<TResponse>
      )
    )
  );

export const makeNoopRuntimePersistenceService =
  (): RuntimePersistenceService => ({
    execute: <TResponse>(
      request: RuntimePersistenceExecutionRequest<TResponse>
    ) => executeWithValidation(request),
  });

export const makeRuntimePersistenceServiceFromRepository = (
  repository: RuntimePersistenceRepository
): RuntimePersistenceService => ({
  execute: <TResponse>(
    request: RuntimePersistenceExecutionRequest<TResponse>
  ) => executeRepositoryWithValidation(repository, request),
});

export const noopRuntimePersistenceLayer: Layer.Layer<RuntimePersistenceService> =
  Layer.sync(RuntimePersistenceServiceTag, makeNoopRuntimePersistenceService);

export const deterministicTestRuntimePersistenceLayer: Layer.Layer<RuntimePersistenceService> =
  noopRuntimePersistenceLayer;
