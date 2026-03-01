import { Layer } from "effect";

import {
  decodeRuntimeConfigFromEnvSync,
  decodeRuntimeConfigSync,
  makeConfigLayer,
  runtimeConfigDefaults,
  type RuntimeConfigEnvRecord,
  type RuntimeConfigFromEnvOptions,
  type RuntimeConfig,
} from "./services/config-service.js";
import { makeLoggerLayer, deterministicTestLoggerLayer } from "./services/logger-service.js";
import { makeDeterministicClockLayer, systemClockLayer } from "./services/clock-service.js";
import {
  deterministicTestServiceBoundariesLayer,
  serviceBoundariesLayer,
} from "./service-boundaries.js";

export const defaultRuntimeConfig: RuntimeConfig = decodeRuntimeConfigSync(runtimeConfigDefaults);

export const deterministicTestConfig: RuntimeConfig = {
  environment: "test",
  serviceName: "ums-memory-test",
  logLevel: "debug",
};

export const deterministicTestNowMillis = 1_704_067_200_000;

export const runtimeLayerFromConfig = (config: RuntimeConfig) =>
  Layer.mergeAll(
    makeConfigLayer(config),
    makeLoggerLayer(config.logLevel),
    systemClockLayer,
    serviceBoundariesLayer,
  );

export const runtimeLayerFromEnv = (
  env: RuntimeConfigEnvRecord = process.env,
  options: RuntimeConfigFromEnvOptions = {},
) => runtimeLayerFromConfig(decodeRuntimeConfigFromEnvSync(env, options));

export interface DeterministicRuntimeLayerOptions {
  readonly config?: RuntimeConfig;
  readonly fixedNowMillis?: number;
}

export const deterministicRuntimeLayer = (options: DeterministicRuntimeLayerOptions = {}) => {
  const config = options.config ?? deterministicTestConfig;
  const fixedNowMillis = options.fixedNowMillis ?? deterministicTestNowMillis;

  return Layer.mergeAll(
    makeConfigLayer(config),
    deterministicTestLoggerLayer,
    makeDeterministicClockLayer(fixedNowMillis),
    deterministicTestServiceBoundariesLayer,
  );
};

export const runtimeLayer = runtimeLayerFromConfig(defaultRuntimeConfig);

export const deterministicTestRuntimeLayer = deterministicRuntimeLayer();
