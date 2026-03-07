import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type SupportedDaemonSupervisorPlatform = "darwin" | "linux" | "win32";
export type DaemonSupervisorKind = "launchd" | "systemd" | "windows-task";

export interface DaemonSupervisorCommand {
  readonly file: string;
  readonly args: readonly string[];
}

export interface DaemonSupervisorCommands {
  readonly installCommands: readonly DaemonSupervisorCommand[];
  readonly uninstallCommands: readonly DaemonSupervisorCommand[];
  readonly queryCommand: DaemonSupervisorCommand | null;
}

export interface DaemonSupervisorRegistration {
  readonly kind: DaemonSupervisorKind;
  readonly scope: "user";
  readonly label: string;
  readonly descriptorFile: string;
  readonly launcherFile: string;
  readonly enabledFile: string | null;
  readonly taskName: string | null;
}

export interface DaemonSupervisorPlan extends DaemonSupervisorRegistration {
  readonly platform: SupportedDaemonSupervisorPlatform;
  readonly launcherContent: string;
  readonly descriptorContent: string;
  readonly installCommands: readonly DaemonSupervisorCommand[];
  readonly uninstallCommands: readonly DaemonSupervisorCommand[];
  readonly queryCommand: DaemonSupervisorCommand | null;
}

export interface ResolveDaemonSupervisorPlanInput {
  readonly controlRoot: string;
  readonly configFile: string;
  readonly logFile: string;
  readonly stateRoot: string;
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly runtimeExecutable?: string;
  readonly daemonEntrypoint?: string;
  readonly userId?: number;
}

export interface ResolveDaemonRuntimeInvocationInput {
  readonly configFile: string;
  readonly intervalMs?: number | null;
  readonly runtimeExecutable?: string;
  readonly daemonEntrypoint?: string;
}

export interface DaemonRuntimeInvocation {
  readonly runtimeExecutable: string;
  readonly args: readonly string[];
}

const DEFAULT_DAEMON_ENTRYPOINT = fileURLToPath(
  new URL("index.ts", import.meta.url)
);

const normalizeOptionalString = (value: string | undefined): string | null => {
  const normalized = value?.trim();
  return normalized || null;
};

const resolveHomeDirectory = (env: NodeJS.ProcessEnv): string =>
  resolve(
    normalizeOptionalString(env["HOME"]) ??
      normalizeOptionalString(env["USERPROFILE"]) ??
      homedir()
  );

const shellQuote = (value: string): string =>
  `'${value.replaceAll("'", `'"'"'`)}'`;

const systemdQuote = (value: string): string =>
  `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

const xmlEscape = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

const windowsCmdPathQuote = (value: string): string =>
  `""${value.replaceAll('"', '""')}""`;

const buildSupervisorLabel = (stateRoot: string): string =>
  `dev.ums.memory.daemon.${createHash("sha256").update(stateRoot).digest("hex").slice(0, 12)}`;

const resolveNumericUserId = (value: string | undefined): number | null => {
  const normalized = normalizeOptionalString(value);
  if (normalized === null) {
    return null;
  }
  const parsed = Number(normalized);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
};

const resolveLaunchdDomainTarget = (input: {
  readonly env: NodeJS.ProcessEnv;
  readonly userId?: number;
}): string => {
  const userId =
    (typeof input.userId === "number" &&
    Number.isInteger(input.userId) &&
    input.userId >= 0
      ? input.userId
      : null) ??
    resolveNumericUserId(input.env["UID"]) ??
    (typeof process.getuid === "function" ? process.getuid() : 0);
  return `gui/${userId}`;
};

const resolveLaunchdServiceTarget = (input: {
  readonly env: NodeJS.ProcessEnv;
  readonly label: string;
  readonly userId?: number;
}): string => `${resolveLaunchdDomainTarget(input)}/${input.label}`;

const buildPosixLauncherContent = (input: {
  readonly configFile: string;
  readonly daemonEntrypoint: string;
  readonly logFile: string;
  readonly runtimeExecutable: string;
}): string =>
  `${[
    "#!/bin/sh",
    "set -eu",
    `exec >>${shellQuote(input.logFile)} 2>&1`,
    `exec ${shellQuote(input.runtimeExecutable)} ${resolveDaemonRuntimeInvocation(
      {
        configFile: input.configFile,
        daemonEntrypoint: input.daemonEntrypoint,
      }
    )
      .args.map(shellQuote)
      .join(" ")}`,
    "",
  ].join("\n")}`;

const buildWindowsLauncherContent = (input: {
  readonly configFile: string;
  readonly daemonEntrypoint: string;
  readonly logFile: string;
  readonly runtimeExecutable: string;
}): string =>
  `${[
    "@echo off",
    `"${input.runtimeExecutable}" "${input.daemonEntrypoint}" sync-daemon --config-file "${input.configFile}" --quiet >> "${input.logFile}" 2>&1`,
    "",
  ].join("\r\n")}`;

const buildLaunchdDescriptor = (input: {
  readonly controlRoot: string;
  readonly label: string;
  readonly launcherFile: string;
  readonly logFile: string;
}): string =>
  `${[
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${xmlEscape(input.label)}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    `    <string>${xmlEscape(input.launcherFile)}</string>`,
    "  </array>",
    "  <key>RunAtLoad</key>",
    "  <false/>",
    "  <key>KeepAlive</key>",
    "  <false/>",
    "  <key>WorkingDirectory</key>",
    `  <string>${xmlEscape(input.controlRoot)}</string>`,
    "  <key>StandardOutPath</key>",
    `  <string>${xmlEscape(input.logFile)}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${xmlEscape(input.logFile)}</string>`,
    "  <key>ProcessType</key>",
    "  <string>Background</string>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n")}`;

const buildSystemdDescriptor = (input: {
  readonly controlRoot: string;
  readonly label: string;
  readonly launcherFile: string;
}): string =>
  `${[
    "[Unit]",
    `Description=UMS daemon (${input.label})`,
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${systemdQuote(input.launcherFile)}`,
    `WorkingDirectory=${systemdQuote(input.controlRoot)}`,
    "Restart=no",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n")}`;

const buildWindowsTaskDescriptor = (input: {
  readonly controlRoot: string;
  readonly label: string;
  readonly launcherFile: string;
}): string =>
  `${[
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    "  <RegistrationInfo>",
    `    <Description>${xmlEscape(`UMS daemon (${input.label})`)}</Description>`,
    "  </RegistrationInfo>",
    "  <Triggers>",
    "    <LogonTrigger>",
    "      <Enabled>true</Enabled>",
    "    </LogonTrigger>",
    "  </Triggers>",
    "  <Principals>",
    '    <Principal id="Author">',
    "      <LogonType>InteractiveToken</LogonType>",
    "      <RunLevel>LeastPrivilege</RunLevel>",
    "    </Principal>",
    "  </Principals>",
    "  <Settings>",
    "    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
    "    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
    "    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
    "    <AllowHardTerminate>true</AllowHardTerminate>",
    "    <StartWhenAvailable>true</StartWhenAvailable>",
    "    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>",
    "    <IdleSettings>",
    "      <StopOnIdleEnd>false</StopOnIdleEnd>",
    "      <RestartOnIdle>false</RestartOnIdle>",
    "    </IdleSettings>",
    "    <AllowStartOnDemand>true</AllowStartOnDemand>",
    "    <Enabled>true</Enabled>",
    "    <Hidden>false</Hidden>",
    "    <RunOnlyIfIdle>false</RunOnlyIfIdle>",
    "    <WakeToRun>false</WakeToRun>",
    "    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>",
    "    <Priority>7</Priority>",
    "  </Settings>",
    '  <Actions Context="Author">',
    "    <Exec>",
    "      <Command>cmd.exe</Command>",
    `      <Arguments>${xmlEscape(`/d /c ${windowsCmdPathQuote(input.launcherFile)}`)}</Arguments>`,
    `      <WorkingDirectory>${xmlEscape(input.controlRoot)}</WorkingDirectory>`,
    "    </Exec>",
    "  </Actions>",
    "</Task>",
    "",
  ].join("\n")}`;

export interface ResolveDaemonSupervisorCommandsInput {
  readonly kind: DaemonSupervisorKind;
  readonly label: string;
  readonly descriptorFile: string;
  readonly taskName: string | null;
  readonly env?: NodeJS.ProcessEnv;
  readonly userId?: number;
}

export const resolveDaemonSupervisorCommands = (
  input: ResolveDaemonSupervisorCommandsInput
): DaemonSupervisorCommands => {
  const env = input.env ?? process.env;
  const userIdInput =
    input.userId === undefined ? {} : { userId: input.userId };

  if (input.kind === "launchd") {
    const domainTarget = resolveLaunchdDomainTarget({
      env,
      ...userIdInput,
    });
    const serviceTarget = resolveLaunchdServiceTarget({
      env,
      label: input.label,
      ...userIdInput,
    });
    return {
      installCommands: [
        {
          file: "launchctl",
          args: ["bootstrap", domainTarget, input.descriptorFile],
        },
      ],
      uninstallCommands: [
        {
          file: "launchctl",
          args: ["bootout", serviceTarget],
        },
      ],
      queryCommand: {
        file: "launchctl",
        args: ["print", serviceTarget],
      },
    };
  }

  if (input.kind === "systemd") {
    const unitName = basename(input.descriptorFile);
    return {
      installCommands: [
        {
          file: "systemctl",
          args: ["--user", "daemon-reload"],
        },
        {
          file: "systemctl",
          args: ["--user", "enable", unitName],
        },
      ],
      uninstallCommands: [
        {
          file: "systemctl",
          args: ["--user", "disable", unitName],
        },
        {
          file: "systemctl",
          args: ["--user", "daemon-reload"],
        },
      ],
      queryCommand: {
        file: "systemctl",
        args: ["--user", "is-enabled", unitName],
      },
    };
  }

  const taskName =
    input.taskName ??
    `UMS Memory Daemon ${input.label.slice(input.label.lastIndexOf(".") + 1)}`;

  return {
    installCommands: [
      {
        file: "schtasks",
        args: ["/create", "/tn", taskName, "/xml", input.descriptorFile, "/f"],
      },
    ],
    uninstallCommands: [
      {
        file: "schtasks",
        args: ["/delete", "/tn", taskName, "/f"],
      },
    ],
    queryCommand: {
      file: "schtasks",
      args: ["/query", "/tn", taskName],
    },
  };
};

export const isSupportedDaemonSupervisorPlatform = (
  platform: NodeJS.Platform
): platform is SupportedDaemonSupervisorPlatform =>
  platform === "darwin" || platform === "linux" || platform === "win32";

export const resolveDaemonSupervisorPlan = (
  input: ResolveDaemonSupervisorPlanInput
): DaemonSupervisorPlan => {
  const platform = input.platform ?? process.platform;
  if (!isSupportedDaemonSupervisorPlatform(platform)) {
    throw new Error(
      `Unsupported daemon supervisor platform '${platform}'. Expected darwin, linux, or win32.`
    );
  }

  const env = input.env ?? process.env;
  const homeDirectory = resolveHomeDirectory(env);
  const label = buildSupervisorLabel(input.stateRoot);
  const launcherFile = resolve(
    input.controlRoot,
    platform === "win32" ? "supervisor-run.cmd" : "supervisor-run.sh"
  );
  const runtimeExecutable = input.runtimeExecutable ?? process.execPath;
  const daemonEntrypoint = input.daemonEntrypoint ?? DEFAULT_DAEMON_ENTRYPOINT;
  const scope = "user" as const;

  if (platform === "darwin") {
    const descriptorFile = resolve(
      homeDirectory,
      "Library",
      "LaunchAgents",
      `${label}.plist`
    );
    const commands = resolveDaemonSupervisorCommands({
      kind: "launchd",
      label,
      descriptorFile,
      taskName: null,
      env,
      ...(input.userId === undefined ? {} : { userId: input.userId }),
    });
    return {
      platform,
      kind: "launchd",
      scope,
      label,
      descriptorFile,
      launcherFile,
      enabledFile: null,
      taskName: null,
      launcherContent: buildPosixLauncherContent({
        configFile: input.configFile,
        daemonEntrypoint,
        logFile: input.logFile,
        runtimeExecutable,
      }),
      descriptorContent: buildLaunchdDescriptor({
        controlRoot: input.controlRoot,
        label,
        launcherFile,
        logFile: input.logFile,
      }),
      installCommands: commands.installCommands,
      uninstallCommands: commands.uninstallCommands,
      queryCommand: commands.queryCommand,
    };
  }

  if (platform === "linux") {
    const configHome =
      normalizeOptionalString(env["XDG_CONFIG_HOME"]) ??
      resolve(homeDirectory, ".config");
    const descriptorFile = resolve(
      configHome,
      "systemd",
      "user",
      `${label}.service`
    );
    const commands = resolveDaemonSupervisorCommands({
      kind: "systemd",
      label,
      descriptorFile,
      taskName: null,
      env,
      ...(input.userId === undefined ? {} : { userId: input.userId }),
    });
    return {
      platform,
      kind: "systemd",
      scope,
      label,
      descriptorFile,
      launcherFile,
      enabledFile: resolve(
        configHome,
        "systemd",
        "user",
        "default.target.wants",
        `${label}.service`
      ),
      taskName: null,
      launcherContent: buildPosixLauncherContent({
        configFile: input.configFile,
        daemonEntrypoint,
        logFile: input.logFile,
        runtimeExecutable,
      }),
      descriptorContent: buildSystemdDescriptor({
        controlRoot: input.controlRoot,
        label,
        launcherFile,
      }),
      installCommands: commands.installCommands,
      uninstallCommands: commands.uninstallCommands,
      queryCommand: commands.queryCommand,
    };
  }

  const descriptorFile = resolve(input.controlRoot, `${label}.task.xml`);
  const taskName = `UMS Memory Daemon ${label.slice(label.lastIndexOf(".") + 1)}`;
  const commands = resolveDaemonSupervisorCommands({
    kind: "windows-task",
    label,
    descriptorFile,
    taskName,
    env,
    ...(input.userId === undefined ? {} : { userId: input.userId }),
  });

  return {
    platform,
    kind: "windows-task",
    scope,
    label,
    descriptorFile,
    launcherFile,
    enabledFile: null,
    taskName,
    launcherContent: buildWindowsLauncherContent({
      configFile: input.configFile,
      daemonEntrypoint,
      logFile: input.logFile,
      runtimeExecutable,
    }),
    descriptorContent: buildWindowsTaskDescriptor({
      controlRoot: input.controlRoot,
      label,
      launcherFile,
    }),
    installCommands: commands.installCommands,
    uninstallCommands: commands.uninstallCommands,
    queryCommand: commands.queryCommand,
  };
};

export const resolveDaemonRuntimeInvocation = (
  input: ResolveDaemonRuntimeInvocationInput
): DaemonRuntimeInvocation => {
  const args = [
    input.daemonEntrypoint ?? DEFAULT_DAEMON_ENTRYPOINT,
    "sync-daemon",
    "--config-file",
    input.configFile,
  ];

  if (input.intervalMs && input.intervalMs > 0) {
    args.push("--interval-ms", String(input.intervalMs));
  }

  return {
    runtimeExecutable: input.runtimeExecutable ?? process.execPath,
    args,
  };
};
