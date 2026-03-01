import { Layer } from "effect";

import {
  deterministicTestEvaluationLayer,
  noopEvaluationLayer,
} from "./services/evaluation-service.js";
import {
  deterministicTestIngestionLayer,
  noopIngestionLayer,
} from "./services/ingestion-service.js";
import { deterministicTestPolicyLayer, noopPolicyLayer } from "./services/policy-service.js";
import {
  deterministicTestRetrievalLayer,
  noopRetrievalLayer,
} from "./services/retrieval-service.js";
import { deterministicTestStorageLayer, noopStorageLayer } from "./services/storage-service.js";

export const serviceBoundariesLayer = Layer.mergeAll(
  noopStorageLayer,
  noopRetrievalLayer,
  noopEvaluationLayer,
  noopPolicyLayer,
  noopIngestionLayer,
);

export const deterministicTestServiceBoundariesLayer = Layer.mergeAll(
  deterministicTestStorageLayer,
  deterministicTestRetrievalLayer,
  deterministicTestEvaluationLayer,
  deterministicTestPolicyLayer,
  deterministicTestIngestionLayer,
);
