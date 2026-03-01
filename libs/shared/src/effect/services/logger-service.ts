import { Context, Effect, Layer } from "effect";

import type { RuntimeLogLevel } from "./config-service.js";

export interface LogContext {
  readonly [key: string]: unknown;
}

export interface LoggerService {
  readonly debug: (message: string, context?: LogContext) => Effect.Effect<void>;
  readonly info: (message: string, context?: LogContext) => Effect.Effect<void>;
  readonly warn: (message: string, context?: LogContext) => Effect.Effect<void>;
  readonly error: (message: string, context?: LogContext) => Effect.Effect<void>;
}

export const LoggerServiceTag = Context.GenericTag<LoggerService>("@ums/effect/LoggerService");

const LOG_SEVERITY: Readonly<Record<RuntimeLogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const shouldLog = (level: RuntimeLogLevel, minimumLevel: RuntimeLogLevel) =>
  LOG_SEVERITY[level] >= LOG_SEVERITY[minimumLevel];

const logWithLevel = (
  level: RuntimeLogLevel,
  minimumLevel: RuntimeLogLevel,
  message: string,
  context: LogContext = {},
): Effect.Effect<void> => {
  if (!shouldLog(level, minimumLevel)) {
    return Effect.void;
  }

  return Effect.log(message, {
    level,
    ...context,
  });
};

export const makeLoggerService = (minimumLevel: RuntimeLogLevel): LoggerService => ({
  debug: (message, context) => logWithLevel("debug", minimumLevel, message, context),
  info: (message, context) => logWithLevel("info", minimumLevel, message, context),
  warn: (message, context) => logWithLevel("warn", minimumLevel, message, context),
  error: (message, context) => logWithLevel("error", minimumLevel, message, context),
});

export const makeLoggerLayer = (minimumLevel: RuntimeLogLevel): Layer.Layer<LoggerService> =>
  Layer.sync(LoggerServiceTag, () => makeLoggerService(minimumLevel));

export const deterministicTestLoggerLayer: Layer.Layer<LoggerService> = Layer.sync(
  LoggerServiceTag,
  () => {
    const capture = (
      _level: RuntimeLogLevel,
      _message: string,
      _context: LogContext = {},
    ): Effect.Effect<void> => Effect.void;

    return {
      debug: (message, context) => capture("debug", message, context),
      info: (message, context) => capture("info", message, context),
      warn: (message, context) => capture("warn", message, context),
      error: (message, context) => capture("error", message, context),
    };
  },
);
