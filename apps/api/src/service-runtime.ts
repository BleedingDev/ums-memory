import { startApiServer } from "./server.ts";

const DEFAULT_RESTART_LIMIT = 3;
const DEFAULT_RESTART_DELAY_MS = 250;
const DEFAULT_MONITOR_INTERVAL_MS = 100;
const MIN_RESTART_DELAY_MS = 1;
const MIN_MONITOR_INTERVAL_MS = 10;
const SERVER_CLOSE_TIMEOUT_MS = 1000;

type ServicePhase =
  | "idle"
  | "starting"
  | "running"
  | "restarting"
  | "stopping"
  | "stopped"
  | "failed";

interface ApiServer {
  listening?: boolean;
  close: (callback?: (error?: Error | null) => void) => unknown;
  closeIdleConnections?: () => void;
  closeAllConnections?: () => void;
  unref?: () => void;
}

interface StartServerOptions {
  host: string;
  port: number;
  stateFile?: string | null | undefined;
}

interface StartServerResult {
  server: ApiServer;
  host: string;
  port: number;
}

type StartServer = (
  options: StartServerOptions
) => Promise<StartServerResult> | StartServerResult;

export interface SupervisedApiServiceOptions {
  host?: unknown;
  port?: unknown;
  stateFile?: string | null;
  restartLimit?: unknown;
  restartDelayMs?: unknown;
  monitorIntervalMs?: unknown;
  captureProcessSignals?: boolean;
  startServer?: StartServer;
}

interface ReadySnapshot {
  host: string;
  port: number;
}

interface StatusSnapshot {
  phase: ServicePhase;
  host: string;
  port: number | null;
  restartCount: number;
  restartLimit: number;
  lastError: string | null;
  startedAt: string | null;
  stoppedAt: string | null;
}

interface StatusState extends StatusSnapshot {}

export interface SupervisedApiService {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  ready: () => Promise<ReadySnapshot>;
  status: () => StatusSnapshot;
  unsafeCurrentServer: () => ApiServer | null;
}

function toErrorMessage(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.message;
  }
  return String(cause);
}

function normalizePort(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(`Invalid API port: ${value}`);
  }
  return parsed;
}

function normalizeNonEmptyString(
  value: unknown,
  fallback: string | null,
  fieldName: string
): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (normalized.length > 0) {
    return normalized;
  }
  if (fallback !== null && fallback.trim().length > 0) {
    return fallback.trim();
  }
  throw new Error(`${fieldName} must be a non-empty string.`);
}

function normalizeNonNegativeInteger(
  value: unknown,
  fallback: number,
  fieldName: string
): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  if (parsed < 0) {
    throw new Error(`${fieldName} must be >= 0.`);
  }
  return parsed;
}

function nowIso(): string {
  return new Date().toISOString();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    const timer = setTimeout(resolvePromise, ms);
    if (typeof timer.unref === "function") {
      timer.unref();
    }
  });
}

function closeServer(server: ApiServer | null): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    if (server === null || typeof server.close !== "function") {
      resolvePromise();
      return;
    }

    if (server.listening !== true) {
      resolvePromise();
      return;
    }

    server.closeIdleConnections?.();
    server.closeAllConnections?.();
    server.unref?.();

    const fallback = setTimeout(resolvePromise, SERVER_CLOSE_TIMEOUT_MS);
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

function wrapStartupError(cause: unknown): Error {
  return new Error(`Failed to start API server: ${toErrorMessage(cause)}`);
}

export function createSupervisedApiService(
  options: SupervisedApiServiceOptions = {}
): SupervisedApiService {
  const host = normalizeNonEmptyString(
    options.host,
    typeof process.env["UMS_API_HOST"] === "string"
      ? process.env["UMS_API_HOST"]
      : "127.0.0.1",
    "host"
  );
  const port = normalizePort(
    options.port ?? process.env["UMS_API_PORT"] ?? 8787
  );
  const stateFile = Object.hasOwn(options, "stateFile")
    ? options.stateFile
    : undefined;
  const restartLimit = normalizeNonNegativeInteger(
    options.restartLimit,
    DEFAULT_RESTART_LIMIT,
    "restartLimit"
  );
  const restartDelayMs = Math.max(
    normalizeNonNegativeInteger(
      options.restartDelayMs,
      DEFAULT_RESTART_DELAY_MS,
      "restartDelayMs"
    ),
    MIN_RESTART_DELAY_MS
  );
  const monitorIntervalMs = Math.max(
    normalizeNonNegativeInteger(
      options.monitorIntervalMs,
      DEFAULT_MONITOR_INTERVAL_MS,
      "monitorIntervalMs"
    ),
    MIN_MONITOR_INTERVAL_MS
  );
  const captureProcessSignals = options.captureProcessSignals !== false;
  const startServer: StartServer =
    typeof options.startServer === "function"
      ? options.startServer
      : ({ host, port, stateFile }) =>
          stateFile === undefined
            ? startApiServer({ host, port })
            : startApiServer({ host, port, stateFile });

  const status: StatusState = {
    phase: "idle",
    host,
    port: null,
    restartCount: 0,
    restartLimit,
    lastError: null,
    startedAt: null,
    stoppedAt: null,
  };

  let currentServer: ApiServer | null = null;
  let supervisorPromise: Promise<void> | null = null;
  let shutdownRequested = false;
  let signalCleanup: (() => void) | null = null;
  let startAttempted = false;

  let readySettled = false;
  let readyResolve: ((snapshot: ReadySnapshot) => void) | undefined;
  let readyReject: ((error: Error) => void) | undefined;
  const readyPromise = new Promise<ReadySnapshot>((resolvePromise, rejectPromise) => {
    readyResolve = resolvePromise;
    readyReject = rejectPromise;
  });

  const updateStatus = (next: Partial<StatusState>): void => {
    Object.assign(status, next);
  };

  const settleReadySuccess = (snapshot: ReadySnapshot): void => {
    if (readySettled) {
      return;
    }
    readySettled = true;
    readyResolve?.(snapshot);
  };

  const settleReadyFailure = (error: Error): void => {
    if (readySettled) {
      return;
    }
    readySettled = true;
    readyReject?.(error);
  };

  const installSignalHandlers = (): void => {
    if (!captureProcessSignals || signalCleanup !== null) {
      return;
    }
    const onSignal = (): void => {
      void stop();
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    signalCleanup = () => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      signalCleanup = null;
    };
  };

  const removeSignalHandlers = (): void => {
    signalCleanup?.();
  };

  const waitForCycleExit = async (
    server: ApiServer
  ): Promise<"shutdown" | "failure"> => {
    while (true) {
      if (shutdownRequested) {
        return "shutdown";
      }
      if (server.listening !== true) {
        return "failure";
      }
      await delay(monitorIntervalMs);
    }
  };

  const runSupervisor = async (): Promise<void> => {
    installSignalHandlers();
    let restartCount = 0;

    try {
      while (true) {
        if (shutdownRequested) {
          updateStatus({
            phase: "stopped",
            stoppedAt: nowIso(),
          });
          return;
        }

        let cycleError: Error | null = null;
        let startResult: StartServerResult | null = null;

        try {
          startResult = await startServer({ host, port, stateFile });
          currentServer = startResult.server;
          updateStatus({
            phase: "running",
            host: startResult.host,
            port: startResult.port,
            startedAt: status.startedAt ?? nowIso(),
            stoppedAt: null,
            lastError: null,
          });

          settleReadySuccess({
            host: startResult.host,
            port: startResult.port,
          });

          const cycleExit = await waitForCycleExit(startResult.server);
          if (cycleExit === "shutdown") {
            updateStatus({
              phase: "stopped",
              stoppedAt: nowIso(),
            });
            return;
          }

          cycleError = new Error("API server listener stopped unexpectedly.");
        } catch (error) {
          cycleError =
            status.port === null
              ? wrapStartupError(error)
              : error instanceof Error
                ? error
                : new Error(toErrorMessage(error));
        } finally {
          try {
            await closeServer(currentServer);
          } catch (closeError) {
            if (cycleError === null) {
              cycleError =
                closeError instanceof Error
                  ? closeError
                  : new Error(toErrorMessage(closeError));
            }
          }
          currentServer = null;
        }

        if (shutdownRequested) {
          updateStatus({
            phase: "stopped",
            stoppedAt: nowIso(),
          });
          return;
        }

        const failure =
          cycleError ?? new Error("API service exited unexpectedly.");
        const isStartupFailure = startResult === null;

        if (isStartupFailure) {
          settleReadyFailure(failure);
          updateStatus({
            phase: "failed",
            stoppedAt: nowIso(),
            lastError: toErrorMessage(failure),
          });
          return;
        }

        restartCount += 1;
        updateStatus({
          phase: "restarting",
          restartCount,
          lastError: toErrorMessage(failure),
        });

        if (restartCount > restartLimit) {
          if (!readySettled) {
            settleReadyFailure(failure);
          }
          updateStatus({
            phase: "failed",
            stoppedAt: nowIso(),
            lastError: toErrorMessage(failure),
          });
          return;
        }

        await delay(restartDelayMs);
      }
    } finally {
      currentServer = null;
      removeSignalHandlers();
    }
  };

  const start = async (): Promise<void> => {
    if (supervisorPromise !== null) {
      return;
    }
    if (
      startAttempted &&
      (status.phase === "stopped" || status.phase === "failed")
    ) {
      throw new Error(
        "Supervised API service runtime cannot be restarted after stop/failure."
      );
    }
    startAttempted = true;
    shutdownRequested = false;
    updateStatus({
      phase: "starting",
      startedAt: status.startedAt ?? nowIso(),
      stoppedAt: null,
    });
    supervisorPromise = runSupervisor();
  };

  const stop = async (): Promise<void> => {
    shutdownRequested = true;
    if (status.phase !== "failed" && status.phase !== "stopped") {
      updateStatus({ phase: "stopping" });
    }

    if (currentServer !== null) {
      try {
        await closeServer(currentServer);
      } catch {
        // status is managed by supervisor transitions
      }
    }

    if (supervisorPromise !== null) {
      try {
        await supervisorPromise;
      } catch {
        // status is already captured deterministically
      }
      supervisorPromise = null;
    }

    if (status.phase !== "failed") {
      updateStatus({
        phase: "stopped",
        stoppedAt: status.stoppedAt ?? nowIso(),
      });
    }

    removeSignalHandlers();
  };

  return {
    start,
    stop,
    ready() {
      return readyPromise;
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

export async function startSupervisedApiService(
  options: SupervisedApiServiceOptions = {}
): Promise<{
  service: SupervisedApiService;
  host: string;
  port: number;
}> {
  const service = createSupervisedApiService(options);
  await service.start();
  const { host, port } = await service.ready();
  return {
    service,
    host,
    port,
  };
}
