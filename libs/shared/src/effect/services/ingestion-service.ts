import { Context, Effect, Layer } from "effect";

import type {
  IngestionRecord,
  IngestionRecordValue,
  IngestionRequest,
  IngestionResponse,
} from "../contracts/index.js";
import type { IngestionServiceError } from "../errors.js";

export type {
  IngestionRecord,
  IngestionRecordValue,
  IngestionRequest,
  IngestionResponse,
} from "../contracts/index.js";

export interface IngestionService {
  readonly ingest: (
    request: IngestionRequest,
  ) => Effect.Effect<IngestionResponse, IngestionServiceError>;
}

export const IngestionServiceTag = Context.GenericTag<IngestionService>(
  "@ums/effect/IngestionService",
);

export const makeNoopIngestionService = (): IngestionService => ({
  ingest: (request) =>
    Effect.succeed({
      acceptedRecordIds: request.records.map((record) => record.recordId),
      duplicateRecordIds: [],
      ingestedAtMillis: 0,
    }),
});

export const noopIngestionLayer: Layer.Layer<IngestionService> = Layer.succeed(
  IngestionServiceTag,
  makeNoopIngestionService(),
);

export const deterministicTestIngestionLayer: Layer.Layer<IngestionService> = noopIngestionLayer;
