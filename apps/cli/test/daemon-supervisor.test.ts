import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { test } from "@effect-native/bun-test";

import { resolveDaemonSupervisorPlan } from "../../ums/src/daemon-supervisor.ts";

test("daemon supervisor plan is deterministic for a given state root", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "ums-daemon-supervisor-"));
  try {
    const input = {
      controlRoot: resolve(tempDir, "state", "daemon-control"),
      configFile: resolve(tempDir, "config.jsonc"),
      logFile: resolve(tempDir, "state", "daemon-control", "daemon.log"),
      stateRoot: resolve(tempDir, "state"),
      env: {
        HOME: resolve(tempDir, "home"),
      },
    };

    const first = resolveDaemonSupervisorPlan({
      ...input,
      platform: "darwin",
    });
    const second = resolveDaemonSupervisorPlan({
      ...input,
      platform: "darwin",
    });

    assert.equal(first.label, second.label);
    assert.equal(first.descriptorFile, second.descriptorFile);
    assert.equal(first.launcherFile, second.launcherFile);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("daemon supervisor plan renders launchd and systemd registration assets", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "ums-daemon-supervisor-"));
  try {
    const baseInput = {
      controlRoot: resolve(tempDir, "state", "daemon-control"),
      configFile: resolve(tempDir, "config.jsonc"),
      logFile: resolve(tempDir, "state", "daemon-control", "daemon.log"),
      stateRoot: resolve(tempDir, "state"),
      env: {
        HOME: resolve(tempDir, "home"),
        XDG_CONFIG_HOME: resolve(tempDir, "xdg-config"),
      },
    };

    const launchd = resolveDaemonSupervisorPlan({
      ...baseInput,
      platform: "darwin",
      userId: 501,
    });
    assert.equal(launchd.kind, "launchd");
    assert.match(launchd.descriptorFile, /Library\/LaunchAgents\/.*\.plist$/);
    assert.match(launchd.launcherFile, /supervisor-run\.sh$/);
    assert.match(
      launchd.descriptorContent,
      /<key>RunAtLoad<\/key>\n  <false\/>/
    );
    assert.match(
      launchd.launcherContent,
      /['"]sync-daemon['"].*['"]--config-file['"]/s
    );
    assert.deepEqual(launchd.installCommands, [
      {
        file: "launchctl",
        args: ["bootstrap", "gui/501", launchd.descriptorFile],
      },
    ]);
    assert.deepEqual(launchd.queryCommand, {
      file: "launchctl",
      args: ["print", `gui/501/${launchd.label}`],
    });
    assert.deepEqual(launchd.uninstallCommands, [
      {
        file: "launchctl",
        args: ["bootout", `gui/501/${launchd.label}`],
      },
    ]);

    const systemd = resolveDaemonSupervisorPlan({
      ...baseInput,
      platform: "linux",
    });
    assert.equal(systemd.kind, "systemd");
    assert.match(systemd.descriptorFile, /systemd\/user\/.*\.service$/);
    assert.match(
      systemd.enabledFile ?? "",
      /systemd\/user\/default\.target\.wants\/.*\.service$/
    );
    assert.match(systemd.descriptorContent, /WantedBy=default.target/);
    assert.match(systemd.descriptorContent, /ExecStart="/);
    assert.deepEqual(systemd.installCommands, [
      {
        file: "systemctl",
        args: ["--user", "daemon-reload"],
      },
      {
        file: "systemctl",
        args: ["--user", "enable", `${systemd.label}.service`],
      },
    ]);
    assert.deepEqual(systemd.queryCommand, {
      file: "systemctl",
      args: ["--user", "is-enabled", `${systemd.label}.service`],
    });
    assert.deepEqual(systemd.uninstallCommands, [
      {
        file: "systemctl",
        args: ["--user", "disable", `${systemd.label}.service`],
      },
      {
        file: "systemctl",
        args: ["--user", "daemon-reload"],
      },
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("daemon supervisor plan renders windows task registration commands", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "ums-daemon-supervisor-"));
  try {
    const windows = resolveDaemonSupervisorPlan({
      controlRoot: resolve(tempDir, "state", "daemon-control"),
      configFile: resolve(tempDir, "config.jsonc"),
      logFile: resolve(tempDir, "state", "daemon-control", "daemon.log"),
      stateRoot: resolve(tempDir, "state"),
      platform: "win32",
      env: {
        USERPROFILE: resolve(tempDir, "home"),
        APPDATA: resolve(tempDir, "appdata"),
      },
    });

    assert.equal(windows.kind, "windows-task");
    assert.ok(windows.taskName);
    assert.deepEqual(windows.installCommands[0]?.args.slice(0, 4), [
      "/create",
      "/tn",
      windows.taskName,
      "/xml",
    ]);
    assert.deepEqual(windows.queryCommand?.args, [
      "/query",
      "/tn",
      windows.taskName,
    ]);
    assert.deepEqual(windows.uninstallCommands, [
      {
        file: "schtasks",
        args: ["/delete", "/tn", windows.taskName, "/f"],
      },
    ]);
    assert.match(windows.descriptorContent, /<LogonTrigger>/);
    assert.match(windows.launcherContent, /sync-daemon --config-file/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
