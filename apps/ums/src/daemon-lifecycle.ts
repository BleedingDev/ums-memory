import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  readFile,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { Effect, Exit, Option, Result, Schema } from "effect";

import { validateUnknownSync } from "../../../libs/shared/src/effect/contracts/validators.ts";
import {
  formatDaemonConfigError,
  readDaemonConfig,
  resolveDaemonConfigFilePath,
  type DaemonConfig,
} from "./daemon-config.ts";
import {
  type DaemonSupervisorCommand,
  type DaemonSupervisorPlan,
  type DaemonSupervisorRegistration,
  resolveDaemonRuntimeInvocation,
  resolveDaemonSupervisorCommands,
  resolveDaemonSupervisorPlan,
} from "./daemon-supervisor.ts";
import {
  clearStaleDaemonPid,
  type DaemonStatusView,
  type DaemonSyncIoError,
  type DaemonSyncParseError,
} from "./daemon-sync.ts";

const ErrnoCauseSchema = Schema.Struct({
  code: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
});
const PositiveIntSchema = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThan(0)
);
const NullableStringSchema = Schema.NullOr(Schema.String);
const DaemonSupervisorRegistrationSchema = Schema.Struct({
  kind: Schema.Literals(["launchd", "systemd", "windows-task"]),
  scope: Schema.Literal("user"),
  label: Schema.String,
  descriptorFile: Schema.String,
  launcherFile: Schema.String,
  enabledFile: NullableStringSchema,
  taskName: NullableStringSchema,
});
const InstallRecordSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  installedAt: Schema.String,
  updatedAt: Schema.String,
  configFile: Schema.String,
  stateRoot: Schema.String,
  logFile: Schema.String,
  lastStartedAt: NullableStringSchema,
  lastStoppedAt: NullableStringSchema,
  lastStopSignal: NullableStringSchema,
  supervisor: Schema.optional(DaemonSupervisorRegistrationSchema),
});
const DoctorCheckSchema = Schema.Struct({
  name: Schema.String,
  status: Schema.Literals(["pass", "fail"]),
  message: Schema.String,
});

type InstallRecord = Schema.Schema.Type<typeof InstallRecordSchema>;
type DoctorCheck = Schema.Schema.Type<typeof DoctorCheckSchema>;
const CONTROL_ROOT_NAME = "daemon-control";
const INSTALL_RECORD_NAME = "install.json";
const LOG_FILE_NAME = "daemon.log";
const DEFAULT_READY_TIMEOUT_MS = 5_000;
const DEFAULT_STOP_TIMEOUT_MS = 5_000;
const DEFAULT_LOG_LINES = 25;
const DEFAULT_STATUS_POLL_MS = 100;

const isErrnoCause = Schema.is(ErrnoCauseSchema);
const decodeInstallRecord = validateUnknownSync(InstallRecordSchema);

const toIsoNow = (): string => new Date().toISOString();

const toCauseDetails = (cause: unknown): string =>
  isErrnoCause(cause) && cause.message ? cause.message : String(cause);

const toErrnoCode = (cause: unknown): string =>
  isErrnoCause(cause) && cause.code ? cause.code : "UNKNOWN";

const toSupervisorCommandIoError = (input: {
  readonly operation: string;
  readonly configFile: string;
  readonly commandFile: string;
  readonly cause: unknown;
}): DaemonLifecycleIoError =>
  new DaemonLifecycleIoError({
    operation: input.operation,
    configFile: input.configFile,
    path: input.commandFile,
    code: toErrnoCode(input.cause),
    message: `Supervisor command '${input.commandFile}' failed to start.`,
    details: toCauseDetails(input.cause),
  });

const toSupervisorCommandExitError = (input: {
  readonly operation: string;
  readonly configFile: string;
  readonly commandFile: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}): DaemonLifecycleIoError =>
  new DaemonLifecycleIoError({
    operation: input.operation,
    configFile: input.configFile,
    path: input.commandFile,
    code: `EXIT_${input.exitCode}`,
    message: `Supervisor command '${input.commandFile}' exited with status ${input.exitCode}.`,
    details: input.stderr.trim() || input.stdout.trim() || "No command output.",
  });

const isPermissionCode = (code: string): boolean =>
  code === "EACCES" || code === "EPERM";

const isProcessAlive = (pid: number): boolean =>
  Result.match(
    Result.try({
      try: () => process.kill(pid, 0),
      catch: (cause) => cause,
    }),
    {
      onSuccess: () => true,
      onFailure: (cause) => {
        const code = toErrnoCode(cause);
        return code !== "ESRCH" && isPermissionCode(code);
      },
    }
  );

const summarizeStatus = (input: {
  readonly installed: boolean;
  readonly daemon: DaemonStatusView["daemon"];
  readonly sync: DaemonStatusView["sync"];
}): string => {
  if (!input.installed) {
    return "Daemon control plane is not installed.";
  }
  if (input.daemon.alive && input.sync.lastError) {
    return `Daemon is running with errors: ${input.sync.lastError}`;
  }
  if (input.daemon.alive && input.sync.lastRunAt === null) {
    return `Daemon is starting (pid ${input.daemon.pid ?? "unknown"}).`;
  }
  if (input.daemon.alive) {
    return `Daemon is running and healthy (pid ${input.daemon.pid ?? "unknown"}).`;
  }
  if (input.sync.lastError) {
    return `Daemon is stopped with the last recorded error: ${input.sync.lastError}`;
  }
  return "Daemon is installed but stopped.";
};

export class DaemonInvalidConfigError extends Schema.TaggedErrorClass<DaemonInvalidConfigError>()(
  "DaemonInvalidConfigError",
  {
    operation: Schema.String,
    configFile: Schema.String,
    message: Schema.String,
    details: Schema.String,
  }
) {}

export class DaemonNotInstalledError extends Schema.TaggedErrorClass<DaemonNotInstalledError>()(
  "DaemonNotInstalledError",
  {
    operation: Schema.String,
    configFile: Schema.String,
    stateRoot: Schema.String,
    logFile: Schema.String,
    message: Schema.String,
  }
) {}

export class DaemonAlreadyRunningError extends Schema.TaggedErrorClass<DaemonAlreadyRunningError>()(
  "DaemonAlreadyRunningError",
  {
    operation: Schema.String,
    configFile: Schema.String,
    pid: PositiveIntSchema,
    startedAt: NullableStringSchema,
    logFile: Schema.String,
    message: Schema.String,
  }
) {}

export class DaemonNotRunningError extends Schema.TaggedErrorClass<DaemonNotRunningError>()(
  "DaemonNotRunningError",
  {
    operation: Schema.String,
    configFile: Schema.String,
    logFile: Schema.String,
    message: Schema.String,
  }
) {}

export class DaemonOperationDeniedError extends Schema.TaggedErrorClass<DaemonOperationDeniedError>()(
  "DaemonOperationDeniedError",
  {
    operation: Schema.String,
    action: Schema.String,
    configFile: Schema.String,
    path: Schema.String,
    code: Schema.String,
    message: Schema.String,
    details: Schema.String,
  }
) {}

export class DaemonLifecycleIoError extends Schema.TaggedErrorClass<DaemonLifecycleIoError>()(
  "DaemonLifecycleIoError",
  {
    operation: Schema.String,
    configFile: Schema.String,
    path: Schema.String,
    code: Schema.String,
    message: Schema.String,
    details: Schema.String,
  }
) {}

export class DaemonStateInvalidError extends Schema.TaggedErrorClass<DaemonStateInvalidError>()(
  "DaemonStateInvalidError",
  {
    operation: Schema.String,
    configFile: Schema.String,
    path: Schema.String,
    message: Schema.String,
    details: Schema.String,
  }
) {}

export class DaemonStartTimeoutError extends Schema.TaggedErrorClass<DaemonStartTimeoutError>()(
  "DaemonStartTimeoutError",
  {
    operation: Schema.String,
    configFile: Schema.String,
    pid: PositiveIntSchema,
    timeoutMs: PositiveIntSchema,
    logFile: Schema.String,
    message: Schema.String,
  }
) {}

export class DaemonStopTimeoutError extends Schema.TaggedErrorClass<DaemonStopTimeoutError>()(
  "DaemonStopTimeoutError",
  {
    operation: Schema.String,
    configFile: Schema.String,
    pid: PositiveIntSchema,
    timeoutMs: PositiveIntSchema,
    logFile: Schema.String,
    message: Schema.String,
  }
) {}

export class DaemonUnhealthyError extends Schema.TaggedErrorClass<DaemonUnhealthyError>()(
  "DaemonUnhealthyError",
  {
    operation: Schema.String,
    configFile: Schema.String,
    health: Schema.String,
    installed: Schema.Boolean,
    pid: Schema.NullOr(PositiveIntSchema),
    alive: Schema.Boolean,
    lastRunAt: NullableStringSchema,
    lastSuccessAt: NullableStringSchema,
    lastError: NullableStringSchema,
    logFile: Schema.String,
    message: Schema.String,
    checks: Schema.Array(DoctorCheckSchema),
  }
) {}

export class DaemonUnsupportedSupervisorError extends Schema.TaggedErrorClass<DaemonUnsupportedSupervisorError>()(
  "DaemonUnsupportedSupervisorError",
  {
    operation: Schema.String,
    configFile: Schema.String,
    platform: Schema.String,
    message: Schema.String,
    details: Schema.String,
  }
) {}

const TAGGED_ERROR_SCHEMA = Schema.Struct({
  _tag: Schema.String,
  message: Schema.String,
});
const isTaggedError = Schema.is(TAGGED_ERROR_SCHEMA);

interface DaemonControlPaths {
  readonly controlRoot: string;
  readonly installRecordFile: string;
  readonly logFile: string;
}

interface DaemonContext {
  readonly operation: string;
  readonly configFile: string;
  readonly config: DaemonConfig;
  readonly paths: DaemonControlPaths;
  readonly installRecord: InstallRecord | null;
}

interface DaemonSupervisorState extends DaemonSupervisorRegistration {
  readonly registered: boolean;
}

interface DaemonSignalStopResult {
  readonly pid: number;
  readonly signal: "SIGTERM" | "SIGKILL";
}

export interface InstallDaemonOptions {
  readonly configFile?: string | null;
}

export interface StartDaemonOptions {
  readonly configFile?: string | null;
  readonly intervalMs?: number | null;
  readonly readyTimeoutMs?: number | null;
}

export interface StopDaemonOptions {
  readonly configFile?: string | null;
  readonly timeoutMs?: number | null;
}

export interface RestartDaemonOptions
  extends StartDaemonOptions, StopDaemonOptions {}

export interface StatusDaemonOptions {
  readonly configFile?: string | null;
}

export interface LogsDaemonOptions {
  readonly configFile?: string | null;
  readonly lines?: number | null;
}

export interface DoctorDaemonOptions {
  readonly configFile?: string | null;
}

export interface UninstallDaemonOptions extends StopDaemonOptions {}

export interface DaemonLifecycleStatusView extends DaemonStatusView {
  readonly installed: boolean;
  readonly health:
    | "not_installed"
    | "starting"
    | "healthy"
    | "degraded"
    | "stopped";
  readonly logFile: string;
  readonly supervisor: DaemonSupervisorState | null;
  readonly service: {
    readonly installedAt: string | null;
    readonly updatedAt: string | null;
    readonly lastStartedAt: string | null;
    readonly lastStoppedAt: string | null;
    readonly lastStopSignal: string | null;
    readonly supervisor: DaemonSupervisorState | null;
  } | null;
  readonly summary: string;
}

const resolveControlPaths = (config: DaemonConfig): DaemonControlPaths => {
  const controlRoot = resolve(config.state.rootDir, CONTROL_ROOT_NAME);
  return {
    controlRoot,
    installRecordFile: resolve(controlRoot, INSTALL_RECORD_NAME),
    logFile: resolve(controlRoot, LOG_FILE_NAME),
  };
};

const toLifecycleFsError = (input: {
  readonly operation: string;
  readonly action: string;
  readonly configFile: string;
  readonly path: string;
  readonly cause: unknown;
}) => {
  const code = toErrnoCode(input.cause);
  if (isPermissionCode(code)) {
    return new DaemonOperationDeniedError({
      operation: input.operation,
      action: input.action,
      configFile: input.configFile,
      path: input.path,
      code,
      message: `${input.action} is not permitted for ${input.path}.`,
      details: toCauseDetails(input.cause),
    });
  }
  return new DaemonLifecycleIoError({
    operation: input.operation,
    configFile: input.configFile,
    path: input.path,
    code,
    message: `${input.action} failed for ${input.path}.`,
    details: toCauseDetails(input.cause),
  });
};

const fileExistsEffect = (
  operation: string,
  configFile: string,
  path: string
) =>
  Effect.tryPromise({
    try: async () => {
      await access(path);
      return true;
    },
    catch: (cause) =>
      toLifecycleFsError({
        operation,
        action: "access",
        configFile,
        path,
        cause,
      }),
  }).pipe(
    Effect.catchTag("DaemonLifecycleIoError", (error) =>
      error.code === "ENOENT" ? Effect.succeed(false) : Effect.fail(error)
    ),
    Effect.flatMap((result) =>
      result === true ? Effect.succeed(true) : Effect.succeed(false)
    )
  );

const ensureDirEffect = (operation: string, configFile: string, path: string) =>
  Effect.tryPromise({
    try: () => mkdir(path, { recursive: true }),
    catch: (cause) =>
      toLifecycleFsError({
        operation,
        action: "mkdir",
        configFile,
        path,
        cause,
      }),
  });

const ensureRuntimeDirsEffect = (
  operation: string,
  configFile: string,
  config: DaemonConfig
) => {
  const paths = resolveControlPaths(config);
  return Effect.all(
    [
      config.state.rootDir,
      config.state.journalDir,
      config.state.checkpointDir,
      paths.controlRoot,
    ].map((path) => ensureDirEffect(operation, configFile, path)),
    { concurrency: 1 }
  ).pipe(Effect.asVoid);
};

const writeTextAtomicEffect = (
  operation: string,
  configFile: string,
  path: string,
  content: string
) => {
  return Effect.gen(function* () {
    yield* ensureDirEffect(operation, configFile, dirname(path));
    yield* Effect.tryPromise({
      try: () => writeFile(path, content, "utf8"),
      catch: (cause) =>
        toLifecycleFsError({
          operation,
          action: "writeFile",
          configFile,
          path,
          cause,
        }),
    });
  });
};

const writeExecutableTextEffect = (
  operation: string,
  configFile: string,
  path: string,
  content: string
) =>
  Effect.gen(function* () {
    yield* writeTextAtomicEffect(operation, configFile, path, content);
    if (process.platform !== "win32") {
      yield* Effect.tryPromise({
        try: () => chmod(path, 0o755),
        catch: (cause) =>
          toLifecycleFsError({
            operation,
            action: "chmod",
            configFile,
            path,
            cause,
          }),
      });
    }
  });

const touchFileEffect = (operation: string, configFile: string, path: string) =>
  Effect.tryPromise({
    try: () => writeFile(path, "", { encoding: "utf8", flag: "a" }),
    catch: (cause) =>
      toLifecycleFsError({
        operation,
        action: "writeFile",
        configFile,
        path,
        cause,
      }),
  });

const appendJsonLogEntryEffect = (
  operation: string,
  configFile: string,
  logFile: string,
  entry: unknown
) =>
  Effect.tryPromise({
    try: () =>
      writeFile(logFile, `${JSON.stringify(entry)}\n`, {
        encoding: "utf8",
        flag: "a",
      }),
    catch: (cause) =>
      toLifecycleFsError({
        operation,
        action: "writeFile",
        configFile,
        path: logFile,
        cause,
      }),
  });

const readInstallRecordEffect = (
  operation: string,
  configFile: string,
  installRecordFile: string
) =>
  Effect.tryPromise({
    try: () => readFile(installRecordFile, "utf8"),
    catch: (cause) =>
      toLifecycleFsError({
        operation,
        action: "readFile",
        configFile,
        path: installRecordFile,
        cause,
      }),
  }).pipe(
    Effect.flatMap((raw) =>
      Effect.try({
        try: () => decodeInstallRecord(JSON.parse(raw)),
        catch: (cause) =>
          new DaemonStateInvalidError({
            operation,
            configFile,
            path: installRecordFile,
            message: "Daemon control state is not valid JSON.",
            details: toCauseDetails(cause),
          }),
      })
    )
  );

const readInstallRecordOptionalEffect = (
  operation: string,
  configFile: string,
  installRecordFile: string
) =>
  fileExistsEffect(operation, configFile, installRecordFile).pipe(
    Effect.flatMap((exists) =>
      exists
        ? readInstallRecordEffect(
            operation,
            configFile,
            installRecordFile
          ).pipe(Effect.map((record) => record as InstallRecord | null))
        : Effect.succeed<InstallRecord | null>(null)
    )
  );

const removePathIfExistsEffect = (
  operation: string,
  configFile: string,
  path: string
) =>
  Effect.tryPromise({
    try: () => rm(path, { recursive: false, force: true }),
    catch: (cause) =>
      toLifecycleFsError({
        operation,
        action: "rm",
        configFile,
        path,
        cause,
      }),
  });

const writeInstallRecordEffect = (
  operation: string,
  configFile: string,
  installRecordFile: string,
  record: InstallRecord
) =>
  writeTextAtomicEffect(
    operation,
    configFile,
    installRecordFile,
    `${JSON.stringify(record, null, 2)}\n`
  );

const buildSupervisorPlan = (
  context: DaemonContext
): Effect.Effect<DaemonSupervisorPlan, DaemonUnsupportedSupervisorError> =>
  Effect.try({
    try: () =>
      resolveDaemonSupervisorPlan({
        controlRoot: context.paths.controlRoot,
        configFile: context.configFile,
        logFile: context.paths.logFile,
        stateRoot: context.config.state.rootDir,
      }),
    catch: (cause) =>
      new DaemonUnsupportedSupervisorError({
        operation: context.operation,
        configFile: context.configFile,
        platform: process.platform,
        message: `Unsupported daemon supervisor platform '${process.platform}'.`,
        details: toCauseDetails(cause),
      }),
  });

const toSupervisorRegistration = (
  plan: Pick<
    DaemonSupervisorPlan,
    | "kind"
    | "scope"
    | "label"
    | "descriptorFile"
    | "launcherFile"
    | "enabledFile"
    | "taskName"
  >
): DaemonSupervisorRegistration => ({
  kind: plan.kind,
  scope: plan.scope,
  label: plan.label,
  descriptorFile: plan.descriptorFile,
  launcherFile: plan.launcherFile,
  enabledFile: plan.enabledFile,
  taskName: plan.taskName,
});

const runSupervisorCommandEffect = (input: {
  readonly operation: string;
  readonly configFile: string;
  readonly allowFailure?: boolean;
  readonly command: DaemonSupervisorCommand;
}): Effect.Effect<
  {
    readonly code: number;
    readonly stdout: string;
    readonly stderr: string;
  },
  DaemonLifecycleIoError
> =>
  Effect.acquireUseRelease(
    Effect.try({
      try: () =>
        spawn(input.command.file, [...input.command.args], {
          stdio: ["ignore", "pipe", "pipe"],
          env: process.env,
        }),
      catch: (cause) =>
        toSupervisorCommandIoError({
          operation: input.operation,
          configFile: input.configFile,
          commandFile: input.command.file,
          cause,
        }),
    }),
    (child) =>
      Effect.callback<
        {
          readonly code: number;
          readonly stdout: string;
          readonly stderr: string;
        },
        DaemonLifecycleIoError
      >((resume) => {
        let stdout = "";
        let stderr = "";
        const onStdout = (chunk: Buffer | string): void => {
          stdout += chunk.toString("utf8");
        };
        const onStderr = (chunk: Buffer | string): void => {
          stderr += chunk.toString("utf8");
        };
        const cleanup = (): void => {
          child.stdout?.off("data", onStdout);
          child.stderr?.off("data", onStderr);
          child.off("error", onError);
          child.off("close", onClose);
        };
        const onError = (cause: unknown): void => {
          cleanup();
          resume(
            Effect.fail(
              toSupervisorCommandIoError({
                operation: input.operation,
                configFile: input.configFile,
                commandFile: input.command.file,
                cause,
              })
            )
          );
        };
        const onClose = (code: number | null): void => {
          cleanup();
          const exitCode = code ?? 0;
          if (exitCode === 0 || input.allowFailure) {
            resume(
              Effect.succeed({
                code: exitCode,
                stdout,
                stderr,
              })
            );
            return;
          }
          resume(
            Effect.fail(
              toSupervisorCommandExitError({
                operation: input.operation,
                configFile: input.configFile,
                commandFile: input.command.file,
                exitCode,
                stdout,
                stderr,
              })
            )
          );
        };

        child.stdout?.on("data", onStdout);
        child.stderr?.on("data", onStderr);
        child.on("error", onError);
        child.on("close", onClose);

        return Effect.sync(cleanup);
      }),
    (child) =>
      Effect.sync(() => {
        if (child.exitCode !== null || child.killed) {
          return;
        }
        Result.match(
          Result.try({
            try: () => child.kill("SIGTERM"),
            catch: (cause) => cause,
          }),
          {
            onSuccess: () => null,
            onFailure: () => null,
          }
        );
      }).pipe(Effect.ignore)
  );

const runSupervisorCommandsEffect = (input: {
  readonly operation: string;
  readonly configFile: string;
  readonly allowFailure?: boolean;
  readonly commands: readonly DaemonSupervisorCommand[];
}) =>
  Effect.forEach(
    input.commands,
    (command) =>
      runSupervisorCommandEffect({
        operation: input.operation,
        configFile: input.configFile,
        command,
        ...(input.allowFailure === undefined
          ? {}
          : {
              allowFailure: input.allowFailure,
            }),
      }),
    { concurrency: 1 }
  );

const resolveRegistrationCommands = (
  supervisor: DaemonSupervisorRegistration
) =>
  resolveDaemonSupervisorCommands({
    kind: supervisor.kind,
    label: supervisor.label,
    descriptorFile: supervisor.descriptorFile,
    taskName: supervisor.taskName,
  });

const writeSupervisorPlanEffect = (
  context: DaemonContext,
  plan: DaemonSupervisorPlan
) =>
  Effect.gen(function* () {
    yield* writeExecutableTextEffect(
      context.operation,
      context.configFile,
      plan.launcherFile,
      plan.launcherContent
    );
    yield* writeTextAtomicEffect(
      context.operation,
      context.configFile,
      plan.descriptorFile,
      plan.descriptorContent
    );
    const existingRegistration = plan.queryCommand
      ? yield* runSupervisorCommandEffect({
          operation: context.operation,
          configFile: context.configFile,
          allowFailure: true,
          command: plan.queryCommand,
        }).pipe(Effect.map((result) => result.code === 0))
      : false;
    if (existingRegistration && plan.uninstallCommands.length > 0) {
      yield* runSupervisorCommandsEffect({
        operation: context.operation,
        configFile: context.configFile,
        commands: plan.uninstallCommands,
      });
    }
    yield* runSupervisorCommandsEffect({
      operation: context.operation,
      configFile: context.configFile,
      commands: plan.installCommands,
    });
    return toSupervisorRegistration(plan);
  });

const unregisterSupervisorEffect = (input: {
  readonly operation: string;
  readonly configFile: string;
  readonly supervisor: DaemonSupervisorRegistration;
}) =>
  Effect.gen(function* () {
    const commands = resolveRegistrationCommands(input.supervisor);
    if (commands.queryCommand) {
      const queryResult = yield* runSupervisorCommandEffect({
        operation: input.operation,
        configFile: input.configFile,
        command: commands.queryCommand,
        allowFailure: true,
      });
      if (queryResult.code === 0 && commands.uninstallCommands.length > 0) {
        yield* runSupervisorCommandsEffect({
          operation: input.operation,
          configFile: input.configFile,
          commands: commands.uninstallCommands,
        });
      }
    } else if (commands.uninstallCommands.length > 0) {
      yield* runSupervisorCommandsEffect({
        operation: input.operation,
        configFile: input.configFile,
        commands: commands.uninstallCommands,
      });
    }
    if (input.supervisor.enabledFile) {
      yield* removePathIfExistsEffect(
        input.operation,
        input.configFile,
        input.supervisor.enabledFile
      );
    }
    yield* removePathIfExistsEffect(
      input.operation,
      input.configFile,
      input.supervisor.descriptorFile
    );
  });

const readSupervisorStateEffect = (input: {
  readonly operation: string;
  readonly configFile: string;
  readonly supervisor: DaemonSupervisorRegistration;
}) =>
  Effect.gen(function* () {
    const descriptorExists = yield* fileExistsEffect(
      input.operation,
      input.configFile,
      input.supervisor.descriptorFile
    );
    const launcherExists = yield* fileExistsEffect(
      input.operation,
      input.configFile,
      input.supervisor.launcherFile
    );
    let registered =
      descriptorExists &&
      launcherExists &&
      (input.supervisor.enabledFile === null ||
        (yield* fileExistsEffect(
          input.operation,
          input.configFile,
          input.supervisor.enabledFile
        )));
    if (registered && input.supervisor.enabledFile) {
      const enabledTarget = yield* Effect.tryPromise({
        try: () => readlink(input.supervisor.enabledFile as string),
        catch: (cause) =>
          toLifecycleFsError({
            operation: input.operation,
            action: "readlink",
            configFile: input.configFile,
            path: input.supervisor.enabledFile as string,
            cause,
          }),
      }).pipe(
        Effect.catchTag("DaemonLifecycleIoError", (error) =>
          error.code === "EINVAL"
            ? Effect.succeed<string | null>(null)
            : Effect.fail(error)
        )
      );
      registered =
        enabledTarget !== null &&
        resolve(dirname(input.supervisor.enabledFile), enabledTarget) ===
          input.supervisor.descriptorFile;
    }
    if (registered) {
      const commands = resolveRegistrationCommands(input.supervisor);
      if (commands.queryCommand) {
        const queryResult = yield* runSupervisorCommandEffect({
          operation: input.operation,
          configFile: input.configFile,
          command: commands.queryCommand,
          allowFailure: true,
        });
        registered = queryResult.code === 0;
      }
    }
    return {
      ...input.supervisor,
      registered,
    } satisfies DaemonSupervisorState;
  });

const readStatusEffect = (operation: string, configFile: string) =>
  Effect.tryPromise({
    try: () => clearStaleDaemonPid(configFile),
    catch: (cause) =>
      isTaggedError(cause) && cause._tag === "DaemonSyncParseError"
        ? new DaemonStateInvalidError({
            operation,
            configFile,
            path: (cause as DaemonSyncParseError).path,
            message: cause.message,
            details: (cause as DaemonSyncParseError).details,
          })
        : isTaggedError(cause) && cause._tag === "DaemonSyncIoError"
          ? toLifecycleFsError({
              operation,
              action: (cause as DaemonSyncIoError).operation,
              configFile,
              path: (cause as DaemonSyncIoError).path,
              cause,
            })
          : new DaemonLifecycleIoError({
              operation,
              configFile,
              path: configFile,
              code: "UNKNOWN",
              message: "Unable to read daemon status.",
              details: toCauseDetails(cause),
            }),
  });

const loadDaemonContextEffect = (
  operation: string,
  configFile: string | null | undefined
) => {
  const resolvedConfigFile = resolveDaemonConfigFilePath(configFile);
  return Effect.tryPromise({
    try: () => readDaemonConfig(configFile),
    catch: (cause) =>
      new DaemonInvalidConfigError({
        operation,
        configFile: resolvedConfigFile,
        message: `Unable to load daemon config '${resolvedConfigFile}'.`,
        details: formatDaemonConfigError(cause),
      }),
  }).pipe(
    Effect.flatMap((loaded) =>
      ensureRuntimeDirsEffect(operation, loaded.configFile, loaded.config).pipe(
        Effect.flatMap(() => {
          const paths = resolveControlPaths(loaded.config);
          return readInstallRecordOptionalEffect(
            operation,
            loaded.configFile,
            paths.installRecordFile
          ).pipe(
            Effect.map(
              (installRecord): DaemonContext => ({
                operation,
                configFile: loaded.configFile,
                config: loaded.config,
                paths,
                installRecord,
              })
            )
          );
        })
      )
    )
  );
};

const requireInstalled = (context: DaemonContext) =>
  context.installRecord
    ? Effect.succeed(context.installRecord)
    : Effect.fail(
        new DaemonNotInstalledError({
          operation: context.operation,
          configFile: context.configFile,
          stateRoot: context.config.state.rootDir,
          logFile: context.paths.logFile,
          message: `Daemon control plane is not installed for '${context.configFile}'. Run 'ums install --config-file ${context.configFile}' first.`,
        })
      );

const resolveInstalledSupervisorEffect = (context: DaemonContext) =>
  context.installRecord === null
    ? Effect.succeed<DaemonSupervisorState | null>(null)
    : Effect.gen(function* () {
        const fallbackPlan = yield* buildSupervisorPlan(context);
        const supervisor =
          context.installRecord?.supervisor ??
          toSupervisorRegistration(fallbackPlan);
        return yield* readSupervisorStateEffect({
          operation: context.operation,
          configFile: context.configFile,
          supervisor,
        });
      });

const pollUntil = <A>(
  timeoutMs: number,
  effect: Effect.Effect<A | null, unknown>,
  onTimeout: () => unknown
) =>
  Effect.gen(function* () {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const result = yield* effect;
      if (result !== null) {
        return result;
      }
      if (Date.now() >= deadline) {
        return yield* Effect.fail(onTimeout());
      }
      yield* Effect.tryPromise({
        try: () => delay(DEFAULT_STATUS_POLL_MS),
        catch: (cause) =>
          new DaemonLifecycleIoError({
            operation: "poll",
            configFile: "<internal>",
            path: "<internal>",
            code: "DELAY_FAILED",
            message: "Status poll delay failed.",
            details: toCauseDetails(cause),
          }),
      });
    }
  });

const stopDaemonPidEffect = (input: {
  readonly operation: string;
  readonly configFile: string;
  readonly logFile: string;
  readonly pid: number;
  readonly timeoutMs: number;
}) =>
  Effect.gen(function* () {
    const resolveSignalError = (
      signal: "SIGTERM" | "SIGKILL",
      cause: unknown
    ): Option.Option<DaemonOperationDeniedError | DaemonLifecycleIoError> => {
      const code = toErrnoCode(cause);
      if (code === "ESRCH") {
        return Option.none();
      }
      if (isPermissionCode(code)) {
        return Option.some(
          new DaemonOperationDeniedError({
            operation: input.operation,
            action: signal,
            configFile: input.configFile,
            path: `${input.pid}`,
            code,
            message: `Unable to send ${signal} to daemon pid ${input.pid}.`,
            details: toCauseDetails(cause),
          })
        );
      }
      return Option.some(
        new DaemonLifecycleIoError({
          operation: input.operation,
          configFile: input.configFile,
          path: `${input.pid}`,
          code,
          message: `Unable to send ${signal} to daemon pid ${input.pid}.`,
          details: toCauseDetails(cause),
        })
      );
    };

    const sendSignal = (signal: "SIGTERM" | "SIGKILL") =>
      Effect.try({
        try: () => process.kill(input.pid, signal),
        catch: (cause) => resolveSignalError(signal, cause),
      }).pipe(
        Effect.matchEffect({
          onSuccess: () => Effect.succeed(signal),
          onFailure: (resolution) =>
            Option.match(resolution, {
              onNone: () => Effect.succeed(signal),
              onSome: (error) => Effect.fail(error),
            }),
        })
      );

    const waitForExit = (signal: "SIGTERM" | "SIGKILL") =>
      pollUntil(
        input.timeoutMs,
        Effect.sync(() => (isProcessAlive(input.pid) ? null : signal)),
        () =>
          new DaemonStopTimeoutError({
            operation: input.operation,
            configFile: input.configFile,
            pid: input.pid,
            timeoutMs: input.timeoutMs,
            logFile: input.logFile,
            message: `Daemon pid ${input.pid} did not stop after ${signal}.`,
          })
      );

    yield* sendSignal("SIGTERM");
    const sigtermExit = yield* waitForExit("SIGTERM").pipe(Effect.exit);
    if (Exit.isSuccess(sigtermExit)) {
      return {
        pid: input.pid,
        signal: sigtermExit.value,
      } satisfies DaemonSignalStopResult;
    }

    yield* sendSignal("SIGKILL");
    const finalSignal = yield* waitForExit("SIGKILL");
    return {
      pid: input.pid,
      signal: finalSignal,
    } satisfies DaemonSignalStopResult;
  });

const spawnDaemonEffect = (input: {
  readonly configFile: string;
  readonly logFile: string;
  readonly intervalMs: number | null;
}) =>
  Effect.acquireUseRelease(
    Effect.try({
      try: () => openSync(input.logFile, "a"),
      catch: (cause) =>
        toLifecycleFsError({
          operation: "start",
          action: "openSync",
          configFile: input.configFile,
          path: input.logFile,
          cause,
        }),
    }),
    (logFd) => {
      const runtime = resolveDaemonRuntimeInvocation({
        configFile: input.configFile,
        intervalMs: input.intervalMs,
      });
      return Effect.try({
        try: () => {
          const child = spawn(runtime.runtimeExecutable, [...runtime.args], {
            cwd: process.cwd(),
            detached: true,
            stdio: ["ignore", logFd, logFd],
            env: {
              ...process.env,
              UMS_JSON_COMPACT: "1",
            },
          });
          if (child.pid === undefined) {
            throw new Error("Daemon background process did not expose a pid.");
          }
          child.unref();
          return child.pid;
        },
        catch: (cause) =>
          toLifecycleFsError({
            operation: "start",
            action: "spawn",
            configFile: input.configFile,
            path: input.logFile,
            cause,
          }),
      });
    },
    (logFd) =>
      Effect.ignore(
        Effect.try({
          try: () => closeSync(logFd),
          catch: (cause) =>
            toLifecycleFsError({
              operation: "start",
              action: "closeSync",
              configFile: input.configFile,
              path: input.logFile,
              cause,
            }),
        })
      )
  );

const parseDaemonLogEntry = (
  index: number,
  rawLine: string
):
  | {
      readonly index: number;
      readonly kind: "json";
      readonly raw: string;
      readonly data: unknown;
    }
  | {
      readonly index: number;
      readonly kind: "text";
      readonly raw: string;
    } =>
  Result.match(
    Result.try({
      try: () => JSON.parse(rawLine),
      catch: (cause) => cause,
    }),
    {
      onSuccess: (data) => ({
        index,
        kind: "json" as const,
        raw: rawLine,
        data,
      }),
      onFailure: () => ({
        index,
        kind: "text" as const,
        raw: rawLine,
      }),
    }
  );

const waitForHealthyDaemonEffect = (input: {
  readonly configFile: string;
  readonly logFile: string;
  readonly pid: number;
  readonly timeoutMs: number;
}) =>
  pollUntil(
    input.timeoutMs,
    readStatusEffect("start", input.configFile).pipe(
      Effect.flatMap((status) => {
        if (!isProcessAlive(input.pid) && !status.daemon.alive) {
          return Effect.fail(
            new DaemonUnhealthyError({
              operation: "start",
              configFile: input.configFile,
              health: "unhealthy",
              installed: true,
              pid: status.daemon.pid,
              alive: status.daemon.alive,
              lastRunAt: status.sync.lastRunAt,
              lastSuccessAt: status.sync.lastSuccessAt,
              lastError: status.sync.lastError,
              logFile: input.logFile,
              message: `Daemon exited before reporting healthy status. Inspect '${input.logFile}'.`,
              checks: [],
            })
          );
        }
        if (status.sync.lastError) {
          return Effect.fail(
            new DaemonUnhealthyError({
              operation: "start",
              configFile: input.configFile,
              health: "unhealthy",
              installed: true,
              pid: status.daemon.pid,
              alive: status.daemon.alive,
              lastRunAt: status.sync.lastRunAt,
              lastSuccessAt: status.sync.lastSuccessAt,
              lastError: status.sync.lastError,
              logFile: input.logFile,
              message: `Daemon reported unhealthy status: ${status.sync.lastError}`,
              checks: [],
            })
          );
        }
        if (
          status.daemon.pid === input.pid &&
          status.daemon.alive &&
          status.sync.lastRunAt !== null
        ) {
          return Effect.succeed(status);
        }
        return Effect.succeed<DaemonStatusView | null>(null);
      })
    ),
    () =>
      new DaemonStartTimeoutError({
        operation: "start",
        configFile: input.configFile,
        pid: input.pid,
        timeoutMs: input.timeoutMs,
        logFile: input.logFile,
        message: `Daemon pid ${input.pid} did not become healthy within ${input.timeoutMs}ms.`,
      })
  );

export const installDaemonEffect = (options: InstallDaemonOptions = {}) =>
  Effect.gen(function* () {
    const context = yield* loadDaemonContextEffect(
      "install",
      options.configFile
    );
    const supervisorPlan = yield* buildSupervisorPlan(context);
    yield* touchFileEffect(
      "install",
      context.configFile,
      context.paths.logFile
    );
    const now = toIsoNow();
    const record: InstallRecord = context.installRecord ?? {
      schemaVersion: 1,
      installedAt: now,
      updatedAt: now,
      configFile: context.configFile,
      stateRoot: context.config.state.rootDir,
      logFile: context.paths.logFile,
      lastStartedAt: null,
      lastStoppedAt: null,
      lastStopSignal: null,
      supervisor: undefined,
    };
    if (
      context.installRecord?.supervisor &&
      JSON.stringify(context.installRecord.supervisor) !==
        JSON.stringify(toSupervisorRegistration(supervisorPlan))
    ) {
      yield* unregisterSupervisorEffect({
        operation: "install",
        configFile: context.configFile,
        supervisor: context.installRecord.supervisor,
      });
    }
    const supervisor = yield* writeSupervisorPlanEffect(
      context,
      supervisorPlan
    );
    const nextRecord: InstallRecord = {
      ...record,
      updatedAt: now,
      configFile: context.configFile,
      stateRoot: context.config.state.rootDir,
      logFile: context.paths.logFile,
      supervisor,
    };
    yield* writeInstallRecordEffect(
      "install",
      context.configFile,
      context.paths.installRecordFile,
      nextRecord
    );
    const status = yield* readStatusEffect("install", context.configFile);
    const supervisorState = yield* readSupervisorStateEffect({
      operation: "install",
      configFile: context.configFile,
      supervisor,
    });
    return {
      operation: "install" as const,
      status: context.installRecord ? "already_installed" : "installed",
      summary: context.installRecord
        ? `Daemon control plane already installed at ${context.config.state.rootDir} and registered with ${supervisor.kind}.`
        : `Installed daemon control plane at ${context.config.state.rootDir} and registered with ${supervisor.kind}.`,
      configFile: context.configFile,
      stateRoot: context.config.state.rootDir,
      logFile: context.paths.logFile,
      installedAt: nextRecord.installedAt,
      supervisor: supervisorState,
      daemon: status.daemon,
      sync: status.sync,
    };
  });

export const statusDaemonEffect = (
  options: StatusDaemonOptions = {}
): Effect.Effect<
  DaemonLifecycleStatusView,
  | DaemonInvalidConfigError
  | DaemonOperationDeniedError
  | DaemonLifecycleIoError
  | DaemonStateInvalidError
  | DaemonUnsupportedSupervisorError
> =>
  Effect.gen(function* () {
    const context = yield* loadDaemonContextEffect(
      "status",
      options.configFile
    );
    const status = yield* readStatusEffect("status", context.configFile);
    const installed = context.installRecord !== null;
    const supervisor = yield* resolveInstalledSupervisorEffect(context);
    const health = !installed
      ? "not_installed"
      : supervisor !== null && !supervisor.registered
        ? "degraded"
        : status.daemon.alive && status.sync.lastError === null
          ? status.sync.lastRunAt === null
            ? "starting"
            : "healthy"
          : status.sync.lastError
            ? "degraded"
            : "stopped";
    return {
      ...status,
      installed,
      health,
      logFile: context.paths.logFile,
      supervisor,
      service: installed
        ? {
            installedAt: context.installRecord?.installedAt ?? null,
            updatedAt: context.installRecord?.updatedAt ?? null,
            lastStartedAt: context.installRecord?.lastStartedAt ?? null,
            lastStoppedAt: context.installRecord?.lastStoppedAt ?? null,
            lastStopSignal: context.installRecord?.lastStopSignal ?? null,
            supervisor,
          }
        : null,
      summary: summarizeStatus({
        installed,
        daemon: status.daemon,
        sync: status.sync,
      }),
    };
  });

export const startDaemonEffect = (options: StartDaemonOptions = {}) =>
  Effect.gen(function* () {
    const context = yield* loadDaemonContextEffect("start", options.configFile);
    const installRecord = yield* requireInstalled(context);
    const existingStatus = yield* readStatusEffect("start", context.configFile);
    if (existingStatus.daemon.pid && existingStatus.daemon.alive) {
      return yield* Effect.fail(
        new DaemonAlreadyRunningError({
          operation: "start",
          configFile: context.configFile,
          pid: existingStatus.daemon.pid,
          startedAt: existingStatus.daemon.startedAt,
          logFile: context.paths.logFile,
          message: `Daemon is already running with pid ${existingStatus.daemon.pid}.`,
        })
      );
    }
    yield* touchFileEffect("start", context.configFile, context.paths.logFile);
    const pid = yield* spawnDaemonEffect({
      configFile: context.configFile,
      logFile: context.paths.logFile,
      intervalMs:
        options.intervalMs && options.intervalMs > 0
          ? options.intervalMs
          : null,
    });
    const now = toIsoNow();
    yield* writeInstallRecordEffect(
      "start",
      context.configFile,
      context.paths.installRecordFile,
      {
        ...installRecord,
        updatedAt: now,
        lastStartedAt: now,
        lastStopSignal: null,
      }
    );
    yield* appendJsonLogEntryEffect(
      "start",
      context.configFile,
      context.paths.logFile,
      {
        ok: true,
        data: {
          operation: "start",
          status: "spawned",
          pid,
          startedAt: now,
          configFile: context.configFile,
        },
      }
    );
    const readyExit = yield* waitForHealthyDaemonEffect({
      configFile: context.configFile,
      logFile: context.paths.logFile,
      pid,
      timeoutMs:
        options.readyTimeoutMs && options.readyTimeoutMs > 0
          ? options.readyTimeoutMs
          : DEFAULT_READY_TIMEOUT_MS,
    }).pipe(Effect.exit);
    if (readyExit._tag === "Failure") {
      yield* stopDaemonPidEffect({
        operation: "start",
        configFile: context.configFile,
        logFile: context.paths.logFile,
        pid,
        timeoutMs: DEFAULT_STOP_TIMEOUT_MS,
      }).pipe(
        Effect.orElseSucceed(() => ({ pid, signal: "SIGTERM" as const }))
      );
      return yield* Effect.failCause(readyExit.cause);
    }
    const healthyStatus = readyExit.value;
    return {
      operation: "start" as const,
      status: "started",
      summary: `Daemon started in the background with pid ${pid}.`,
      configFile: context.configFile,
      logFile: context.paths.logFile,
      pid,
      startedAt: now,
      intervalMs:
        options.intervalMs && options.intervalMs > 0
          ? options.intervalMs
          : null,
      daemon: healthyStatus.daemon,
      sync: healthyStatus.sync,
    };
  });

export const stopDaemonEffect = (options: StopDaemonOptions = {}) =>
  Effect.gen(function* () {
    const context = yield* loadDaemonContextEffect("stop", options.configFile);
    const installRecord = yield* requireInstalled(context);
    const status = yield* readStatusEffect("stop", context.configFile);
    if (!status.daemon.pid || !status.daemon.alive) {
      return yield* Effect.fail(
        new DaemonNotRunningError({
          operation: "stop",
          configFile: context.configFile,
          logFile: context.paths.logFile,
          message: `Daemon is not running for '${context.configFile}'.`,
        })
      );
    }
    const stopped = yield* stopDaemonPidEffect({
      operation: "stop",
      configFile: context.configFile,
      logFile: context.paths.logFile,
      pid: status.daemon.pid,
      timeoutMs:
        options.timeoutMs && options.timeoutMs > 0
          ? options.timeoutMs
          : DEFAULT_STOP_TIMEOUT_MS,
    });
    const now = toIsoNow();
    yield* writeInstallRecordEffect(
      "stop",
      context.configFile,
      context.paths.installRecordFile,
      {
        ...installRecord,
        updatedAt: now,
        lastStoppedAt: now,
        lastStopSignal: stopped.signal,
      }
    );
    yield* appendJsonLogEntryEffect(
      "stop",
      context.configFile,
      context.paths.logFile,
      {
        ok: true,
        data: {
          operation: "stop",
          status: "stopped",
          pid: stopped.pid,
          signal: stopped.signal,
          stoppedAt: now,
          configFile: context.configFile,
        },
      }
    );
    const nextStatus = yield* readStatusEffect("stop", context.configFile);
    return {
      operation: "stop" as const,
      status: "stopped",
      summary: `Daemon pid ${stopped.pid} stopped with ${stopped.signal}.`,
      configFile: context.configFile,
      logFile: context.paths.logFile,
      stoppedPid: stopped.pid,
      signal: stopped.signal,
      daemon: nextStatus.daemon,
      sync: nextStatus.sync,
    };
  });

export const restartDaemonEffect = (options: RestartDaemonOptions = {}) =>
  Effect.gen(function* () {
    const stopped = yield* stopDaemonEffect({
      ...(options.configFile !== undefined
        ? { configFile: options.configFile }
        : {}),
      ...(options.timeoutMs !== undefined
        ? { timeoutMs: options.timeoutMs }
        : {}),
    });
    const started = yield* startDaemonEffect({
      ...(options.configFile !== undefined
        ? { configFile: options.configFile }
        : {}),
      ...(options.intervalMs !== undefined
        ? { intervalMs: options.intervalMs }
        : {}),
      ...(options.readyTimeoutMs !== undefined
        ? { readyTimeoutMs: options.readyTimeoutMs }
        : {}),
    });
    return {
      operation: "restart" as const,
      status: "restarted",
      summary: `Restarted daemon from pid ${stopped.stoppedPid} to pid ${started.pid}.`,
      configFile: started.configFile,
      logFile: started.logFile,
      stoppedPid: stopped.stoppedPid,
      signal: stopped.signal,
      pid: started.pid,
      startedAt: started.startedAt,
      daemon: started.daemon,
      sync: started.sync,
    };
  });

export const logsDaemonEffect = (options: LogsDaemonOptions = {}) =>
  Effect.gen(function* () {
    const context = yield* loadDaemonContextEffect("logs", options.configFile);
    yield* requireInstalled(context);
    const raw = yield* Effect.tryPromise({
      try: () => readFile(context.paths.logFile, "utf8"),
      catch: (cause) =>
        toLifecycleFsError({
          operation: "logs",
          action: "readFile",
          configFile: context.configFile,
          path: context.paths.logFile,
          cause,
        }),
    }).pipe(
      Effect.catchTag("DaemonLifecycleIoError", (error) =>
        error.code === "ENOENT" ? Effect.succeed("") : Effect.fail(error)
      )
    );
    const lines = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const count =
      options.lines && options.lines > 0 ? options.lines : DEFAULT_LOG_LINES;
    const startIndex = Math.max(lines.length - count, 0);
    return {
      operation: "logs" as const,
      status: "ok",
      summary: `Showing ${lines.length - startIndex} daemon log entries from ${context.paths.logFile}.`,
      configFile: context.configFile,
      logFile: context.paths.logFile,
      requestedLines: count,
      totalEntries: lines.length,
      truncated: startIndex > 0,
      entries: lines
        .slice(startIndex)
        .map((rawLine, index) =>
          parseDaemonLogEntry(startIndex + index, rawLine)
        ),
    };
  });

export const doctorDaemonEffect = (options: DoctorDaemonOptions = {}) =>
  Effect.gen(function* () {
    const status = yield* statusDaemonEffect(
      options.configFile !== undefined ? { configFile: options.configFile } : {}
    );
    if (!status.installed) {
      return yield* Effect.fail(
        new DaemonNotInstalledError({
          operation: "doctor",
          configFile: status.configFile,
          stateRoot: status.stateRoot,
          logFile: status.logFile,
          message: `Daemon control plane is not installed for '${status.configFile}'.`,
        })
      );
    }
    const checks: DoctorCheck[] = [
      {
        name: "config",
        status: "pass",
        message: `Loaded daemon config from ${status.configFile}.`,
      },
      {
        name: "install",
        status: "pass",
        message: `Daemon control plane is installed at ${status.stateRoot}.`,
      },
      {
        name: "supervisor",
        status:
          status.supervisor !== null && status.supervisor.registered
            ? "pass"
            : "fail",
        message:
          status.supervisor !== null && status.supervisor.registered
            ? `Registered with ${status.supervisor.kind} as ${status.supervisor.label}.`
            : "Daemon supervisor registration is missing.",
      },
      {
        name: "daemon",
        status: status.daemon.alive ? "pass" : "fail",
        message: status.daemon.alive
          ? `Daemon pid ${status.daemon.pid ?? "unknown"} is alive.`
          : "Daemon is not running.",
      },
      {
        name: "sync",
        status:
          status.sync.lastSuccessAt !== null && status.sync.lastError === null
            ? "pass"
            : "fail",
        message:
          status.sync.lastError ??
          (status.sync.lastSuccessAt
            ? `Last successful sync at ${status.sync.lastSuccessAt}.`
            : "Daemon has not completed a successful sync cycle yet."),
      },
    ];
    const healthy = checks.every((check) => check.status === "pass");
    const report = {
      operation: "doctor" as const,
      status: healthy ? "healthy" : "unhealthy",
      healthy,
      summary: healthy
        ? `Daemon is healthy for '${status.configFile}'.`
        : `Daemon is unhealthy for '${status.configFile}'.`,
      configFile: status.configFile,
      stateRoot: status.stateRoot,
      logFile: status.logFile,
      supervisor: status.supervisor,
      daemon: status.daemon,
      sync: status.sync,
      checks,
    };
    if (!healthy) {
      return yield* Effect.fail(
        new DaemonUnhealthyError({
          operation: "doctor",
          configFile: status.configFile,
          health: status.health,
          installed: status.installed,
          pid: status.daemon.pid,
          alive: status.daemon.alive,
          lastRunAt: status.sync.lastRunAt,
          lastSuccessAt: status.sync.lastSuccessAt,
          lastError: status.sync.lastError,
          logFile: status.logFile,
          message: report.summary,
          checks,
        })
      );
    }
    return report;
  });

export const uninstallDaemonEffect = (options: UninstallDaemonOptions = {}) =>
  Effect.gen(function* () {
    const context = yield* loadDaemonContextEffect(
      "uninstall",
      options.configFile
    );
    const installRecord = yield* requireInstalled(context);
    const status = yield* readStatusEffect("uninstall", context.configFile);
    let stopped: DaemonSignalStopResult | null = null;
    if (status.daemon.pid && status.daemon.alive) {
      stopped = yield* stopDaemonPidEffect({
        operation: "uninstall",
        configFile: context.configFile,
        logFile: context.paths.logFile,
        pid: status.daemon.pid,
        timeoutMs:
          options.timeoutMs && options.timeoutMs > 0
            ? options.timeoutMs
            : DEFAULT_STOP_TIMEOUT_MS,
      });
    }
    const supervisor =
      installRecord.supervisor ??
      toSupervisorRegistration(yield* buildSupervisorPlan(context));
    yield* unregisterSupervisorEffect({
      operation: "uninstall",
      configFile: context.configFile,
      supervisor,
    });
    yield* Effect.tryPromise({
      try: () =>
        rm(context.paths.controlRoot, { recursive: true, force: true }),
      catch: (cause) =>
        toLifecycleFsError({
          operation: "uninstall",
          action: "rm",
          configFile: context.configFile,
          path: context.paths.controlRoot,
          cause,
        }),
    });
    const nextStatus = yield* readStatusEffect("uninstall", context.configFile);
    return {
      operation: "uninstall" as const,
      status: "uninstalled",
      summary: `Removed daemon control plane from ${context.paths.controlRoot}.`,
      configFile: context.configFile,
      stateRoot: context.config.state.rootDir,
      controlRoot: context.paths.controlRoot,
      logFile: context.paths.logFile,
      supervisor: {
        ...supervisor,
        registered: false,
      } satisfies DaemonSupervisorState,
      stoppedPid: stopped?.pid ?? null,
      signal: stopped?.signal ?? null,
      daemon: nextStatus.daemon,
      sync: nextStatus.sync,
    };
  });

export const formatDaemonLifecycleCommandError = (
  error: unknown
): {
  readonly code: string;
  readonly message: string;
  readonly data: Record<string, unknown>;
} | null => {
  if (isTaggedError(error)) {
    switch (error._tag) {
      case "DaemonInvalidConfigError": {
        const typedError = error as DaemonInvalidConfigError;
        return {
          code: "DAEMON_INVALID_CONFIG",
          message: typedError.message,
          data: {
            operation: typedError.operation,
            configFile: typedError.configFile,
            details: typedError.details,
          },
        };
      }
      case "DaemonNotInstalledError": {
        const typedError = error as DaemonNotInstalledError;
        return {
          code: "DAEMON_NOT_INSTALLED",
          message: typedError.message,
          data: {
            operation: typedError.operation,
            configFile: typedError.configFile,
            stateRoot: typedError.stateRoot,
            logFile: typedError.logFile,
          },
        };
      }
      case "DaemonAlreadyRunningError": {
        const typedError = error as DaemonAlreadyRunningError;
        return {
          code: "DAEMON_ALREADY_RUNNING",
          message: typedError.message,
          data: {
            operation: typedError.operation,
            configFile: typedError.configFile,
            pid: typedError.pid,
            startedAt: typedError.startedAt,
            logFile: typedError.logFile,
          },
        };
      }
      case "DaemonNotRunningError": {
        const typedError = error as DaemonNotRunningError;
        return {
          code: "DAEMON_NOT_RUNNING",
          message: typedError.message,
          data: {
            operation: typedError.operation,
            configFile: typedError.configFile,
            logFile: typedError.logFile,
          },
        };
      }
      case "DaemonOperationDeniedError": {
        const typedError = error as DaemonOperationDeniedError;
        return {
          code: "DAEMON_OPERATION_DENIED",
          message: typedError.message,
          data: {
            operation: typedError.operation,
            action: typedError.action,
            configFile: typedError.configFile,
            path: typedError.path,
            code: typedError.code,
            details: typedError.details,
          },
        };
      }
      case "DaemonLifecycleIoError": {
        const typedError = error as DaemonLifecycleIoError;
        return {
          code: "DAEMON_IO_ERROR",
          message: typedError.message,
          data: {
            operation: typedError.operation,
            configFile: typedError.configFile,
            path: typedError.path,
            code: typedError.code,
            details: typedError.details,
          },
        };
      }
      case "DaemonStateInvalidError": {
        const typedError = error as DaemonStateInvalidError;
        return {
          code: "DAEMON_STATE_INVALID",
          message: typedError.message,
          data: {
            operation: typedError.operation,
            configFile: typedError.configFile,
            path: typedError.path,
            details: typedError.details,
          },
        };
      }
      case "DaemonStartTimeoutError": {
        const typedError = error as DaemonStartTimeoutError;
        return {
          code: "DAEMON_START_TIMEOUT",
          message: typedError.message,
          data: {
            operation: typedError.operation,
            configFile: typedError.configFile,
            pid: typedError.pid,
            timeoutMs: typedError.timeoutMs,
            logFile: typedError.logFile,
          },
        };
      }
      case "DaemonStopTimeoutError": {
        const typedError = error as DaemonStopTimeoutError;
        return {
          code: "DAEMON_STOP_TIMEOUT",
          message: typedError.message,
          data: {
            operation: typedError.operation,
            configFile: typedError.configFile,
            pid: typedError.pid,
            timeoutMs: typedError.timeoutMs,
            logFile: typedError.logFile,
          },
        };
      }
      case "DaemonUnhealthyError": {
        const typedError = error as DaemonUnhealthyError;
        return {
          code: "DAEMON_UNHEALTHY",
          message: typedError.message,
          data: {
            operation: typedError.operation,
            configFile: typedError.configFile,
            health: typedError.health,
            installed: typedError.installed,
            pid: typedError.pid,
            alive: typedError.alive,
            lastRunAt: typedError.lastRunAt,
            lastSuccessAt: typedError.lastSuccessAt,
            lastError: typedError.lastError,
            logFile: typedError.logFile,
            checks: typedError.checks,
          },
        };
      }
      case "DaemonUnsupportedSupervisorError": {
        const typedError = error as DaemonUnsupportedSupervisorError;
        return {
          code: "DAEMON_SUPERVISOR_UNSUPPORTED",
          message: typedError.message,
          data: {
            operation: typedError.operation,
            configFile: typedError.configFile,
            platform: typedError.platform,
            details: typedError.details,
          },
        };
      }
      default:
        return null;
    }
  }
  return null;
};
