import { Clock, Duration, Effect, Layer, ServiceMap } from "effect";

export interface ClockService {
  readonly nowMillis: Effect.Effect<number>;
  readonly sleep: (milliseconds: number) => Effect.Effect<void>;
}

export const ClockServiceTag = ServiceMap.Service<ClockService>(
  "@ums/effect/ClockService"
);

export const systemClockLayer: Layer.Layer<ClockService> = Layer.succeed(
  ClockServiceTag,
  {
    nowMillis: Clock.currentTimeMillis,
    sleep: (milliseconds) => Effect.sleep(Duration.millis(milliseconds)),
  }
);

export const makeDeterministicClockLayer = (
  fixedNowMillis: number
): Layer.Layer<ClockService> =>
  Layer.succeed(ClockServiceTag, {
    nowMillis: Effect.succeed(fixedNowMillis),
    sleep: () => Effect.void,
  });
