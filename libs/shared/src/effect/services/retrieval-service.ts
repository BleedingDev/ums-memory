import { Context, Effect, Layer } from "effect";

import type { RetrievalHit, RetrievalRequest, RetrievalResponse } from "../contracts/index.js";
import type { RetrievalServiceError } from "../errors.js";

export type { RetrievalHit, RetrievalRequest, RetrievalResponse } from "../contracts/index.js";

export interface RetrievalService {
  readonly retrieve: (
    request: RetrievalRequest,
  ) => Effect.Effect<RetrievalResponse, RetrievalServiceError>;
}

export const RetrievalServiceTag = Context.GenericTag<RetrievalService>(
  "@ums/effect/RetrievalService",
);

export const makeNoopRetrievalService = (): RetrievalService => ({
  retrieve: () =>
    Effect.succeed({
      hits: [],
      totalHits: 0,
      nextCursor: null,
    }),
});

export const noopRetrievalLayer: Layer.Layer<RetrievalService> = Layer.succeed(
  RetrievalServiceTag,
  makeNoopRetrievalService(),
);

export const deterministicTestRetrievalLayer: Layer.Layer<RetrievalService> = noopRetrievalLayer;
