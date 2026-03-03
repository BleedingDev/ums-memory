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
  deterministicTestPolicyPackPluginLayer,
  noopPolicyPackPluginLayer,
} from "./services/policy-pack-plugin-service.js";
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
import {
  deterministicTestTenantRoutingLayer,
  noopTenantRoutingLayer,
} from "./services/tenant-routing-service.js";

export const serviceBoundariesLayer = Layer.mergeAll(
  noopAuthorizationLayer,
  noopStorageLayer,
  noopRetrievalLayer,
  noopEvaluationLayer,
  noopPolicyPackPluginLayer,
  noopPolicyLayer,
  noopIngestionLayer,
  noopMemoryLifecycleLayer,
  noopTenantRoutingLayer
);

export const deterministicTestServiceBoundariesLayer = Layer.mergeAll(
  deterministicTestAuthorizationLayer,
  deterministicTestStorageLayer,
  deterministicTestRetrievalLayer,
  deterministicTestEvaluationLayer,
  deterministicTestPolicyPackPluginLayer,
  deterministicTestPolicyLayer,
  deterministicTestIngestionLayer,
  deterministicTestMemoryLifecycleLayer,
  deterministicTestTenantRoutingLayer
);
