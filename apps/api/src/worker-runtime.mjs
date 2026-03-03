import { Deferred, Duration, Effect, Fiber, Layer, ManagedRuntime } from "effect";
import { exportStoreSnapshot } from "./core.mjs";
import {
  DEFAULT_SHARED_STATE_FILE,
  executeOperationWithSharedState,
} from "./persistence.ts";
import { executeRuntimeOperation } from "./runtime-adapter.mjs";

const DEFAULT_REPLAY_EVAL_MAX_PER_PROFILE = 5;
const DEFAULT_MAX_ERROR_ENTRIES = 25;
const DEFAULT_WORKER_INTERVAL_MS = 30_000;
const DEFAULT_RESTART_LIMIT = 3;
const DEFAULT_RESTART_DELAY_MS = 250;
const DEFAULT_STORE_ID = "coding-agent";

function nowIso() {
  return new Date().toISOString();
}

function toErrorMessage(cause) {
  if (cause instanceof Error) {
    return cause.message;
  }
  return String(cause);
}

function normalizeNonEmptyString(value) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized ? normalized : null;
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

function normalizePositiveInteger(value, fallback, fieldName) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  if (parsed <= 0) {
    throw new Error(`${fieldName} must be > 0.`);
  }
  return parsed;
}

async function loadSnapshotFromStateFile(stateFile = DEFAULT_SHARED_STATE_FILE) {
  return executeOperationWithSharedState({
    operation: "doctor",
    stateFile,
    executor: () => exportStoreSnapshot(),
  });
}

function listStoreProfilePairs(snapshot) {
  const pairs = [];
  if (!snapshot || typeof snapshot !== "object") {
    return pairs;
  }

  if (snapshot.stores && typeof snapshot.stores === "object" && !Array.isArray(snapshot.stores)) {
    const stores = snapshot.stores;
    for (const storeId of Object.keys(stores).sort((left, right) => left.localeCompare(right))) {
      const storeEntry = stores[storeId];
      const profiles =
        storeEntry &&
        typeof storeEntry === "object" &&
        storeEntry.profiles &&
        typeof storeEntry.profiles === "object" &&
        !Array.isArray(storeEntry.profiles)
          ? storeEntry.profiles
          : {};
      for (const profile of Object.keys(profiles).sort((left, right) => left.localeCompare(right))) {
        pairs.push({ storeId, profile });
      }
    }
    return pairs;
  }

  if (snapshot.profiles && typeof snapshot.profiles === "object" && !Array.isArray(snapshot.profiles)) {
    for (const profile of Object.keys(snapshot.profiles).sort((left, right) => left.localeCompare(right))) {
      pairs.push({ storeId: DEFAULT_STORE_ID, profile });
    }
  }

  return pairs;
}

function getProfileSnapshot(snapshot, storeId, profile) {
  if (!snapshot || typeof snapshot !== "object") {
    return null;
  }

  if (snapshot.stores && typeof snapshot.stores === "object" && !Array.isArray(snapshot.stores)) {
    const storeEntry = snapshot.stores[storeId];
    if (
      storeEntry &&
      typeof storeEntry === "object" &&
      storeEntry.profiles &&
      typeof storeEntry.profiles === "object" &&
      !Array.isArray(storeEntry.profiles)
    ) {
      const profileEntry = storeEntry.profiles[profile];
      return profileEntry && typeof profileEntry === "object" ? profileEntry : null;
    }
    return null;
  }

  if (snapshot.profiles && typeof snapshot.profiles === "object" && !Array.isArray(snapshot.profiles)) {
    const profileEntry = snapshot.profiles[profile];
    return profileEntry && typeof profileEntry === "object" ? profileEntry : null;
  }

  return null;
}

function listShadowCandidateIds(profileState) {
  if (!profileState || typeof profileState !== "object" || !Array.isArray(profileState.shadowCandidates)) {
    return [];
  }
  const ids = new Set();
  for (const candidate of profileState.shadowCandidates) {
    if (!candidate || typeof candidate !== "object") {
      continue;
    }
    const candidateId = normalizeNonEmptyString(candidate.candidateId);
    if (!candidateId) {
      continue;
    }
    const status = normalizeNonEmptyString(candidate.status)?.toLowerCase();
    if (status && status !== "shadow") {
      continue;
    }
    ids.add(candidateId);
  }
  return [...ids].sort((left, right) => left.localeCompare(right));
}

async function runOperationWithSharedState({
  operation,
  requestBody,
  stateFile = DEFAULT_SHARED_STATE_FILE,
}) {
  return executeRuntimeOperation({
    operation,
    requestBody,
    stateFile,
  });
}

function cloneJson(value) {
  if (value == null) {
    return value;
  }
  return JSON.parse(JSON.stringify(value));
}

function createEmptyCycleSummary({ startedAt, stateFile, replayEvalMaxPerProfile }) {
  return {
    startedAt,
    completedAt: null,
    durationMs: 0,
    stateFile: stateFile ?? null,
    profileCount: 0,
    replayEvalMaxPerProfile,
    reviewScheduleClock: {
      attempted: 0,
      succeeded: 0,
      failed: 0,
    },
    replayEval: {
      candidatesSeen: 0,
      skippedByLimit: 0,
      attempted: 0,
      succeeded: 0,
      failed: 0,
    },
    doctor: {
      attempted: 0,
      succeeded: 0,
      failed: 0,
    },
    errorCount: 0,
    errorOverflowCount: 0,
    errors: [],
  };
}

function finalizeCycleSummary(summary) {
  const completedAt = nowIso();
  summary.completedAt = completedAt;
  summary.durationMs = Math.max(0, Date.parse(completedAt) - Date.parse(summary.startedAt));
  return summary;
}

export async function runBackgroundWorkerCycle(options = {}) {
  const stateFile = Object.prototype.hasOwnProperty.call(options, "stateFile")
    ? options.stateFile
    : DEFAULT_SHARED_STATE_FILE;
  const replayEvalMaxPerProfile = normalizeNonNegativeInteger(
    options.replayEvalMaxPerProfile,
    DEFAULT_REPLAY_EVAL_MAX_PER_PROFILE,
    "replayEvalMaxPerProfile",
  );
  const maxErrorEntries = normalizePositiveInteger(
    options.maxErrorEntries,
    DEFAULT_MAX_ERROR_ENTRIES,
    "maxErrorEntries",
  );
  const runOperation =
    typeof options.runOperation === "function" ? options.runOperation : runOperationWithSharedState;
  const loadSnapshot =
    typeof options.loadSnapshot === "function"
      ? options.loadSnapshot
      : ({ stateFile: currentStateFile }) => loadSnapshotFromStateFile(currentStateFile);

  const startedAt = nowIso();
  const timestamp = normalizeNonEmptyString(options.timestamp) ?? startedAt;
  const summary = createEmptyCycleSummary({
    startedAt,
    stateFile: stateFile ?? null,
    replayEvalMaxPerProfile,
  });
  const snapshot = await loadSnapshot({ stateFile });
  const pairs = listStoreProfilePairs(snapshot);
  summary.profileCount = pairs.length;

  const appendError = ({ storeId, profile, operation, candidateId = null, error }) => {
    summary.errorCount += 1;
    if (summary.errors.length < maxErrorEntries) {
      const code =
        error && typeof error === "object" && "code" in error && typeof error.code === "string"
          ? error.code
          : null;
      summary.errors.push({
        storeId,
        profile,
        operation,
        candidateId,
        code,
        message: toErrorMessage(error),
      });
      return;
    }
    summary.errorOverflowCount += 1;
  };

  for (const { storeId, profile } of pairs) {
    const baseRequest = {
      storeId,
      profile,
      timestamp,
    };

    summary.reviewScheduleClock.attempted += 1;
    try {
      await runOperation({
        operation: "review_schedule_clock",
        requestBody: baseRequest,
        stateFile,
      });
      summary.reviewScheduleClock.succeeded += 1;
    } catch (error) {
      summary.reviewScheduleClock.failed += 1;
      appendError({
        storeId,
        profile,
        operation: "review_schedule_clock",
        error,
      });
    }

    const candidateIds = listShadowCandidateIds(getProfileSnapshot(snapshot, storeId, profile));
    summary.replayEval.candidatesSeen += candidateIds.length;
    const selectedCandidateIds = candidateIds.slice(0, replayEvalMaxPerProfile);
    summary.replayEval.skippedByLimit += Math.max(0, candidateIds.length - selectedCandidateIds.length);

    for (const candidateId of selectedCandidateIds) {
      summary.replayEval.attempted += 1;
      try {
        await runOperation({
          operation: "replay_eval",
          requestBody: {
            ...baseRequest,
            candidateId,
          },
          stateFile,
        });
        summary.replayEval.succeeded += 1;
      } catch (error) {
        summary.replayEval.failed += 1;
        appendError({
          storeId,
          profile,
          operation: "replay_eval",
          candidateId,
          error,
        });
      }
    }

    summary.doctor.attempted += 1;
    try {
      await runOperation({
        operation: "doctor",
        requestBody: baseRequest,
        stateFile,
      });
      summary.doctor.succeeded += 1;
    } catch (error) {
      summary.doctor.failed += 1;
      appendError({
        storeId,
        profile,
        operation: "doctor",
        error,
      });
    }
  }

  return finalizeCycleSummary(summary);
}

export function createSupervisedWorkerService(options = {}) {
  const stateFile = Object.prototype.hasOwnProperty.call(options, "stateFile")
    ? options.stateFile
    : process.env.UMS_WORKER_STATE_FILE ?? DEFAULT_SHARED_STATE_FILE;
  const intervalMs = normalizePositiveInteger(
    options.intervalMs ?? process.env.UMS_WORKER_INTERVAL_MS,
    DEFAULT_WORKER_INTERVAL_MS,
    "intervalMs",
  );
  const restartLimit = normalizeNonNegativeInteger(
    options.restartLimit ?? process.env.UMS_WORKER_RESTART_LIMIT,
    DEFAULT_RESTART_LIMIT,
    "restartLimit",
  );
  const restartDelayMs = normalizePositiveInteger(
    options.restartDelayMs ?? process.env.UMS_WORKER_RESTART_DELAY_MS,
    DEFAULT_RESTART_DELAY_MS,
    "restartDelayMs",
  );
  const replayEvalMaxPerProfile = normalizeNonNegativeInteger(
    options.replayEvalMaxPerProfile ?? process.env.UMS_WORKER_REPLAY_EVAL_MAX_PER_PROFILE,
    DEFAULT_REPLAY_EVAL_MAX_PER_PROFILE,
    "replayEvalMaxPerProfile",
  );
  const maxErrorEntries = normalizePositiveInteger(
    options.maxErrorEntries ?? process.env.UMS_WORKER_MAX_ERROR_ENTRIES,
    DEFAULT_MAX_ERROR_ENTRIES,
    "maxErrorEntries",
  );
  const captureProcessSignals = options.captureProcessSignals !== false;
  const runCycle =
    typeof options.runCycle === "function"
      ? options.runCycle
      : (cycleOptions = {}) =>
          runBackgroundWorkerCycle({
            stateFile,
            replayEvalMaxPerProfile,
            maxErrorEntries,
            runOperation: options.runOperation,
            ...cycleOptions,
          });

  const runtime = ManagedRuntime.make(Layer.empty);
  const readySignal = runtime.runSync(Deferred.make());
  const shutdownSignal = runtime.runSync(Deferred.make());

  const status = {
    phase: "idle",
    stateFile: stateFile ?? null,
    intervalMs,
    restartCount: 0,
    restartLimit,
    cycleCount: 0,
    lastCycle: null,
    lastError: null,
    startedAt: null,
    stoppedAt: null,
  };

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

  const failReadyIfPending = async (error) => {
    if (readySignaled) {
      return;
    }
    readySignaled = true;
    await runtime.runPromise(Deferred.fail(readySignal, error).pipe(Effect.ignore));
  };

  const supervisorProgram = Effect.gen(function* () {
    installSignalHandlers();

    let restartCount = 0;
    while (true) {
      if (shutdownRequested) {
        yield* Effect.sync(() => {
          updateStatus({
            phase: "stopped",
            stoppedAt: nowIso(),
          });
        });
        return;
      }

      const cycleStartedAt = nowIso();
      const cycleResult = yield* Effect.tryPromise({
        try: () => runCycle({ stateFile }),
        catch: (cause) =>
          cause instanceof Error ? cause : new Error(`Worker cycle failed: ${toErrorMessage(cause)}`),
      }).pipe(
        Effect.match({
          onSuccess: (summary) => ({ status: "success", summary }),
          onFailure: (error) => ({ status: "failure", error }),
        }),
      );

      if (cycleResult.status === "success") {
        const nextCycleCount = status.cycleCount + 1;
        updateStatus({
          phase: "running",
          restartCount,
          cycleCount: nextCycleCount,
          lastCycle: {
            startedAt: normalizeNonEmptyString(cycleResult.summary?.startedAt) ?? cycleStartedAt,
            completedAt: normalizeNonEmptyString(cycleResult.summary?.completedAt) ?? nowIso(),
            summary: cycleResult.summary,
          },
          lastError: null,
          stoppedAt: null,
        });
        if (!readySignaled) {
          readySignaled = true;
          yield* Deferred.succeed(readySignal, {
            cycleCount: nextCycleCount,
            lastCycle: status.lastCycle,
          }).pipe(Effect.ignore);
        }

        const pauseSignal = yield* Effect.raceFirst(
          Deferred.await(shutdownSignal).pipe(Effect.as("shutdown")),
          Effect.sleep(Duration.millis(intervalMs)).pipe(Effect.as("next_cycle")),
        );
        if (pauseSignal === "shutdown" || shutdownRequested) {
          yield* Effect.sync(() => {
            updateStatus({
              phase: "stopped",
              stoppedAt: nowIso(),
            });
          });
          return;
        }
        continue;
      }

      const cycleFailure = cycleResult.error;
      restartCount += 1;
      updateStatus({
        phase: "restarting",
        restartCount,
        lastError: toErrorMessage(cycleFailure),
        lastCycle: {
          startedAt: cycleStartedAt,
          completedAt: nowIso(),
          summary: null,
        },
      });

      if (restartCount > restartLimit) {
        if (!readySignaled) {
          readySignaled = true;
          yield* Deferred.fail(readySignal, cycleFailure).pipe(Effect.ignore);
        }
        updateStatus({
          phase: "failed",
          stoppedAt: nowIso(),
          lastError: toErrorMessage(cycleFailure),
        });
        return yield* Effect.fail(cycleFailure);
      }

      const restartSignal = yield* Effect.raceFirst(
        Deferred.await(shutdownSignal).pipe(Effect.as("shutdown")),
        Effect.sleep(Duration.millis(restartDelayMs)).pipe(Effect.as("restart")),
      );
      if (restartSignal === "shutdown" || shutdownRequested) {
        yield* Effect.sync(() => {
          updateStatus({
            phase: "stopped",
            stoppedAt: nowIso(),
          });
        });
        return;
      }
    }
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
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
      throw new Error("Supervised worker service runtime has been disposed and cannot be restarted.");
    }
    if (serviceFiber) {
      return;
    }
    if (startAttempted && (status.phase === "stopped" || status.phase === "failed")) {
      throw new Error("Supervised worker service runtime cannot be restarted after stop/failure.");
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
        updateStatus({
          phase: "stopped",
          stoppedAt: status.stoppedAt ?? nowIso(),
        });
      }
      if (!readySignaled) {
        await failReadyIfPending(new Error("Supervised worker service stopped before first successful cycle."));
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
    if (!readySignaled) {
      await failReadyIfPending(new Error("Supervised worker service stopped before first successful cycle."));
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
        stateFile: status.stateFile,
        intervalMs: status.intervalMs,
        restartCount: status.restartCount,
        restartLimit: status.restartLimit,
        cycleCount: status.cycleCount,
        lastCycle: cloneJson(status.lastCycle),
        lastError: status.lastError,
        startedAt: status.startedAt,
        stoppedAt: status.stoppedAt,
      };
    },
  };
}

export async function startSupervisedWorkerService(options = {}) {
  const service = createSupervisedWorkerService(options);
  await service.start();
  const readiness = await service.ready();
  return {
    service,
    ...readiness,
  };
}
