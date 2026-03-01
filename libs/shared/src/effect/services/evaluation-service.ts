import { Context, Effect, Layer } from "effect";

import type { EvaluationRequest, EvaluationResponse } from "../contracts/index.js";
import type { EvaluationServiceError } from "../errors.js";

export type {
  EvaluationRequest,
  EvaluationResponse,
  EvaluationResult,
} from "../contracts/index.js";

export interface EvaluationService {
  readonly evaluate: (
    request: EvaluationRequest,
  ) => Effect.Effect<EvaluationResponse, EvaluationServiceError>;
}

export const EvaluationServiceTag = Context.GenericTag<EvaluationService>(
  "@ums/effect/EvaluationService",
);

const deterministicCandidateScore = (memoryId: string): number => {
  let checksum = 0;
  for (const char of memoryId) {
    checksum = (checksum * 31 + char.charCodeAt(0)) % 1000;
  }
  return checksum / 1000;
};

export const makeNoopEvaluationService = (): EvaluationService => ({
  evaluate: (request) => {
    const results = request.candidateMemoryIds.map((memoryId) => {
      const score = deterministicCandidateScore(memoryId);
      return {
        memoryId,
        score,
        passed: score >= request.minimumScore,
      };
    });

    return Effect.succeed({
      objective: request.objective,
      results,
      selectedMemoryIds: results.filter((result) => result.passed).map((result) => result.memoryId),
    });
  },
});

export const noopEvaluationLayer: Layer.Layer<EvaluationService> = Layer.succeed(
  EvaluationServiceTag,
  makeNoopEvaluationService(),
);

export const deterministicTestEvaluationLayer: Layer.Layer<EvaluationService> = noopEvaluationLayer;
