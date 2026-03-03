import { Deferred, Duration, Effect, Fiber, Layer, ManagedRuntime } from "effect";
import { startApiServer } from "./server.ts";

const DEFAULT_RESTART_LIMIT = 3;
const DEFAULT_RESTART_DELAY_MS = 250;
const DEFAULT_MONITOR_INTERVAL_MS = 100;

function toErrorMessage(cause) {
  if (cause instanceof Error) {
    return cause.message;
  }
  return String(cause);
}

function normalizePort(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(`Invalid API port: ${value}`);
  }
  return parsed;
}

function normalizeNonEmptyString(value, fallback, fieldName) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (normalized) {
    return normalized;
  }
  if (fallback) {
    return fallback;
  }
  throw new Error(`${fieldName} must be a non-empty string.`);
}

function normalizeNonNegativeInteger(value, fallback, fieldName) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  if (parsed < 0) {
    throw new Error(`${fieldName} must be >= 0.`);
  }
  return parsed;
}

function closeServer(server) {
  return new Promise((resolvePromise, rejectPromise) => {
    if (!server || typeof server.close !== "function") {
      resolvePromise();
      return;
    }
    if (server.listening !== true) {
      resolvePromise();
      return;
    }
    if (typeof server.closeIdleConnections === "function") {
      server.closeIdleConnections();
    }
    if (typeof server.closeAllConnections === "function") {
      server.closeAllConnections();
    }
    if (typeof server.unref === "function") {
      server.unref();
    }
    const fallback = setTimeout(() => {
      resolvePromise();
    }, 1000);
    if (typeof fallback.unref === "function") {
      fallback.unref();
    }
    server.close((error) => {
      clearTimeout(fallback);
      if (error) {
        rejectPromise(error);
        return;
      }
      resolvePromise();
    });
  });
}

function nowIso() {
  return new Date().toISOString();
}

export function createSupervisedApiService(options = {}) {
  const host = normalizeNonEmptyString(
    options.host,
    typeof process.env.UMS_API_HOST === "string" ? process.env.UMS_API_HOST.trim() : "127.0.0.1",
    "host",
  );
  const port = normalizePort(options.port ?? process.env.UMS_API_PORT ?? 8787);
  const stateFile = Object.prototype.hasOwnProperty.call(options, "stateFile") ? options.stateFile : undefined;
  const restartLimit = normalizeNonNegativeInteger(
    options.restartLimit,
    DEFAULT_RESTART_LIMIT,
    "restartLimit",
  );
  const restartDelayMs = Math.max(
    normalizeNonNegativeInteger(options.restartDelayMs, DEFAULT_RESTART_DELAY_MS, "restartDelayMs"),
    1,
  );
  const monitorIntervalMs = Math.max(
    normalizeNonNegativeInteger(
      options.monitorIntervalMs,
      DEFAULT_MONITOR_INTERVAL_MS,
      "monitorIntervalMs",
    ),
    10,
  );
  const captureProcessSignals = options.captureProcessSignals !== false;
  const startServer =
    typeof options.startServer === "function" ? options.startServer : startApiServer;

  const runtime = ManagedRuntime.make(Layer.empty);
  const readySignal = runtime.runSync(Deferred.make());
  const shutdownSignal = runtime.runSync(Deferred.make());

  const status = {
    phase: "idle",
    host,
    port: null,
    restartCount: 0,
    restartLimit,
    lastError: null,
    startedAt: null,
    stoppedAt: null,
  };

  let currentServer = null;
  let serviceFiber = null;
  let shutdownRequested = false;
  let signalCleanup = null;
  let startAttempted = false;
  let runtimeDisposed = false;
  let readySignaled = false;

  const updateStatus = (next) => {
    Object.assign(status, next);
  };

  const installSignalHandlers = () => {
    if (!captureProcessSignals || signalCleanup) {
      return;
    }
    const onSignal = () => {
      void requestShutdown();
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    signalCleanup = () => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      signalCleanup = null;
    };
  };

  const removeSignalHandlers = () => {
    if (signalCleanup) {
      signalCleanup();
    }
  };

  const runServerCycle = Effect.tryPromise({
    try: () => startServer({ host, port, stateFile }),
    catch: (cause) => new Error(`Failed to start API server: ${toErrorMessage(cause)}`),
  }).pipe(
    Effect.tap(({ server, host: boundHost, port: boundPort }) =>
      Effect.sync(() => {
        currentServer = server;
        updateStatus({
          phase: "running",
          host: boundHost,
          port: boundPort,
          startedAt: status.startedAt ?? nowIso(),
          stoppedAt: null,
          lastError: null,
        });
      })),
    Effect.tap(({ host: boundHost, port: boundPort }) =>
      Effect.suspend(() => {
        if (readySignaled) {
          return Effect.void;
        }
        readySignaled = true;
        return Deferred.succeed(readySignal, { host: boundHost, port: boundPort }).pipe(Effect.ignore);
      })),
    Effect.flatMap(({ server }) =>
      Effect.raceFirst(
        Deferred.await(shutdownSignal).pipe(Effect.as("shutdown")),
        Effect.forever(
          Effect.sleep(Duration.millis(monitorIntervalMs)).pipe(
            Effect.flatMap(() =>
              server.listening === true
                ? Effect.void
                : Effect.fail(new Error("API server listener stopped unexpectedly.")),
            ),
          ),
        ).pipe(Effect.as("monitor")),
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            currentServer = null;
          }),
        ),
        Effect.ensuring(
          Effect.tryPromise({
            try: () => closeServer(server),
            catch: () => undefined,
          }).pipe(Effect.orDie),
        ),
      )),
  );

  const supervisorProgram = Effect.gen(function* () {
    installSignalHandlers();

    let restartCount = 0;
    while (true) {
      const cycleResult = yield* runServerCycle.pipe(
        Effect.match({
          onSuccess: (signal) => ({ signal, error: null }),
          onFailure: (error) => ({ signal: "failure", error }),
        }),
      );

      if (cycleResult.signal === "shutdown") {
        yield* Effect.sync(() => {
          updateStatus({
            phase: "stopped",
            stoppedAt: nowIso(),
          });
        });
        return;
      }

      if (shutdownRequested) {
        yield* Effect.sync(() => {
          updateStatus({
            phase: "stopped",
            stoppedAt: nowIso(),
          });
        });
        return;
      }

      if (cycleResult.signal === "failure" && status.port === null) {
        const startupFailure =
          cycleResult.error ?? new Error("API service failed before first successful listener bind.");
        if (!readySignaled) {
          readySignaled = true;
          yield* Deferred.fail(readySignal, startupFailure).pipe(Effect.ignore);
        }
        yield* Effect.sync(() => {
          updateStatus({
            phase: "failed",
            stoppedAt: nowIso(),
            lastError: toErrorMessage(startupFailure),
          });
        });
        return yield* Effect.fail(startupFailure);
      }

      restartCount += 1;
      yield* Effect.sync(() => {
        updateStatus({
          phase: "restarting",
          restartCount,
          lastError:
            cycleResult.error === null
              ? "API service monitor exited unexpectedly."
              : toErrorMessage(cycleResult.error),
        });
      });

      if (restartCount > restartLimit) {
        const failure =
          cycleResult.error ?? new Error("API service exited unexpectedly and exhausted restart budget.");
        if (!readySignaled) {
          readySignaled = true;
          yield* Deferred.fail(readySignal, failure).pipe(Effect.ignore);
        }
        yield* Effect.sync(() => {
          updateStatus({
            phase: "failed",
            stoppedAt: nowIso(),
            lastError: toErrorMessage(failure),
          });
        });
        return yield* Effect.fail(failure);
      }

      yield* Effect.sleep(Duration.millis(restartDelayMs));
    }
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        currentServer = null;
        removeSignalHandlers();
      }),
    ),
  );

  const requestShutdown = async () => {
    if (runtimeDisposed) {
      return;
    }
    shutdownRequested = true;
    if (status.phase !== "failed" && status.phase !== "stopped") {
      updateStatus({ phase: "stopping" });
    }
    await runtime.runPromise(Deferred.succeed(shutdownSignal, true).pipe(Effect.ignore));
  };

  const start = async () => {
    if (runtimeDisposed) {
      throw new Error("Supervised API service runtime has been disposed and cannot be restarted.");
    }
    if (serviceFiber) {
      return;
    }
    if (startAttempted && (status.phase === "stopped" || status.phase === "failed")) {
      throw new Error("Supervised API service runtime cannot be restarted after stop/failure.");
    }
    startAttempted = true;
    updateStatus({
      phase: "starting",
      startedAt: status.startedAt ?? nowIso(),
      stoppedAt: null,
    });
    serviceFiber = runtime.runFork(supervisorProgram);
  };

  const disposeRuntime = async () => {
    if (runtimeDisposed) {
      return;
    }
    runtimeDisposed = true;
    await runtime.dispose();
  };

  const stop = async () => {
    if (!serviceFiber) {
      if (status.phase !== "failed") {
        updateStatus({ phase: "stopped", stoppedAt: status.stoppedAt ?? nowIso() });
      }
      removeSignalHandlers();
      await disposeRuntime();
      return;
    }

    await requestShutdown();
    try {
      await runtime.runPromise(Fiber.await(serviceFiber).pipe(Effect.ignore));
    } catch {
      // no-op; status is tracked by supervisor program
    }
    serviceFiber = null;
    if (status.phase !== "failed") {
      updateStatus({
        phase: "stopped",
        stoppedAt: status.stoppedAt ?? nowIso(),
      });
    }
    await disposeRuntime();
  };

  return {
    start,
    stop,
    ready() {
      return runtime.runPromise(Deferred.await(readySignal));
    },
    status() {
      return {
        phase: status.phase,
        host: status.host,
        port: status.port,
        restartCount: status.restartCount,
        restartLimit: status.restartLimit,
        lastError: status.lastError,
        startedAt: status.startedAt,
        stoppedAt: status.stoppedAt,
      };
    },
    unsafeCurrentServer() {
      return currentServer;
    },
  };
}

export async function startSupervisedApiService(options = {}) {
  const service = createSupervisedApiService(options);
  await service.start();
  const { host, port } = await service.ready();
  return {
    service,
    host,
    port,
  };
}
