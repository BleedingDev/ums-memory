import { Effect, Layer, ServiceMap } from "effect";

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
    details: cause instanceof Error ? cause.message : String(cause),
  });

const normalizeOperation = (operation: unknown): string =>
  typeof operation === "string" ? operation.trim().toLowerCase() : "";

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
  if (typeof request.execute !== "function") {
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
          cause instanceof ContractValidationError
            ? cause
            : toExecutionError(validatedRequest.operation, cause),
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
