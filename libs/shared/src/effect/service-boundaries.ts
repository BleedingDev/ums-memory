import { Layer } from "effect";

import {
  deterministicTestAuthorizationLayer,
  noopAuthorizationLayer,
} from "./services/authorization-service.js";
import {
  deterministicTestEvaluationLayer,
  noopEvaluationLayer,
} from "./services/evaluation-service.js";
import {
  deterministicTestIngestionLayer,
  noopIngestionLayer,
} from "./services/ingestion-service.js";
import {
  deterministicTestMemoryLifecycleLayer,
  noopMemoryLifecycleLayer,
} from "./services/lifecycle-service.js";
import {
  deterministicTestPolicyLayer,
  noopPolicyLayer,
} from "./services/policy-service.js";
import {
  deterministicTestRetrievalLayer,
  noopRetrievalLayer,
} from "./services/retrieval-service.js";
import {
  deterministicTestStorageLayer,
  noopStorageLayer,
} from "./services/storage-service.js";

export const serviceBoundariesLayer = Layer.mergeAll(
  noopAuthorizationLayer,
  noopStorageLayer,
  noopRetrievalLayer,
  noopEvaluationLayer,
  noopPolicyLayer,
  noopIngestionLayer,
  noopMemoryLifecycleLayer
);

export const deterministicTestServiceBoundariesLayer = Layer.mergeAll(
  deterministicTestAuthorizationLayer,
  deterministicTestStorageLayer,
  deterministicTestRetrievalLayer,
  deterministicTestEvaluationLayer,
  deterministicTestPolicyLayer,
  deterministicTestIngestionLayer,
  deterministicTestMemoryLifecycleLayer
);
