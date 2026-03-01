import { Effect } from "effect";

import { ClockServiceTag } from "./services/clock-service.js";
import { ConfigServiceTag } from "./services/config-service.js";
import { LoggerServiceTag } from "./services/logger-service.js";
import { runtimeLayer } from "./runtime-layer.js";

export interface SampleProgramResult {
  readonly environment: "development" | "test" | "production";
  readonly serviceName: string;
  readonly nowMillis: number;
}

export const sampleProgram: Effect.Effect<SampleProgramResult, never, never> = Effect.gen(
  function* () {
    const config = yield* ConfigServiceTag;
    const logger = yield* LoggerServiceTag;
    const clock = yield* ClockServiceTag;

    const environment = config.get("environment");
    const serviceName = config.get("serviceName");
    const nowMillis = yield* clock.nowMillis;

    yield* logger.info("Effect runtime baseline sample", {
      environment,
      serviceName,
      nowMillis,
    });

    return {
      environment,
      serviceName,
      nowMillis,
    };
  },
).pipe(Effect.provide(runtimeLayer));
