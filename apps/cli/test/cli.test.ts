import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, dirname, resolve } from "node:path";

import { beforeEach, test } from "@effect-native/bun-test";
import { Effect } from "effect";

import { resetStore } from "../../api/src/core.ts";
import { writeDaemonConfig } from "../../ums/src/daemon-config.ts";
import { storeManagedAccountCredential } from "../../ums/src/daemon-credentials.ts";
import { resolveDaemonSupervisorPlan } from "../../ums/src/daemon-supervisor.ts";

const CLI_PATH = resolve(process.cwd(), "apps/cli/src/index.ts");
const UMS_PATH = resolve(process.cwd(), "apps/ums/src/index.ts");

function withPlaintextTestCredentialStoreEnv(
  storeFile: string,
  env: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  return {
    ...env,
    UMS_TEST_CREDENTIAL_STORE_FILE: storeFile,
    UMS_ALLOW_PLAINTEXT_TEST_CREDENTIAL_STORE: "true",
  };
}

function runCli(args: any, stdin = "", { env = process.env } = {}) {
  return new Promise((resolvePromise) => {
    const proc = spawn(process.execPath, [CLI_PATH, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    proc.on("close", (code) => {
      resolvePromise({ code, stdout, stderr });
    });
    if (stdin) {
      proc.stdin.write(stdin);
    }
    proc.stdin.end();
  });
}

function runUms(args: any, stdin = "", { env = process.env } = {}) {
  return new Promise((resolvePromise) => {
    const proc = spawn(process.execPath, [UMS_PATH, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    proc.on("close", (code) => {
      resolvePromise({ code, stdout, stderr });
    });
    if (stdin) {
      proc.stdin.write(stdin);
    }
    proc.stdin.end();
  });
}

async function writeLocalMemoryDaemonConfig(input: {
  readonly configFile: string;
  readonly stateRoot: string;
  readonly memories?: Record<string, unknown>;
  readonly accounts?: Record<string, unknown>;
}): Promise<void> {
  await writeDaemonConfig(input.configFile, {
    version: 1,
    state: {
      rootDir: input.stateRoot,
      journalDir: resolve(input.stateRoot, "journal"),
      checkpointDir: resolve(input.stateRoot, "checkpoints"),
    },
    accounts: input.accounts ?? {
      local: { type: "local" },
    },
    memories: input.memories ?? {
      personal: {
        account: "local",
        storeId: "personal",
        profile: "main",
      },
    },
    sources: {
      defaults: {
        scanIntervalMs: 60_000,
        maxEventsPerCycle: 400,
      },
    },
    routes: [
      {
        match: {
          pathPrefix: input.stateRoot,
        },
        memory: "personal",
        priority: 0,
      },
    ],
    defaults: {
      memory: "personal",
      onAmbiguous: "review",
    },
    policy: {
      allowEnvTokenFallback: false,
      allowPlaintextDevAuth: false,
      requireProjectForManagedWrites: false,
      managedMemoryPrefixes: [],
    },
  });
}

interface SupervisorShimLogEntry {
  readonly kind: string;
  readonly args: readonly string[];
}

async function createSupervisorShim(input: {
  readonly tempDir: string;
  readonly configFile: string;
  readonly stateRoot: string;
  readonly env: NodeJS.ProcessEnv;
}): Promise<{
  readonly env: NodeJS.ProcessEnv;
  readonly commandLogFile: string;
}> {
  const shimDir = resolve(input.tempDir, "supervisor-shim");
  const commandLogFile = resolve(shimDir, "commands.jsonl");
  const baseEnv = { ...input.env };

  if (process.platform === "linux" && !baseEnv["XDG_CONFIG_HOME"]) {
    baseEnv["XDG_CONFIG_HOME"] = resolve(input.tempDir, "xdg-config");
  }

  if (process.platform === "win32") {
    baseEnv["USERPROFILE"] ??=
      baseEnv["HOME"] ?? resolve(input.tempDir, "home");
    baseEnv["APPDATA"] ??= resolve(input.tempDir, "appdata");
  }

  const plan = resolveDaemonSupervisorPlan({
    controlRoot: resolve(input.stateRoot, "daemon-control"),
    configFile: input.configFile,
    logFile: resolve(input.stateRoot, "daemon-control", "daemon.log"),
    stateRoot: input.stateRoot,
    platform: process.platform as "darwin" | "linux" | "win32",
    env: baseEnv,
    ...(process.platform === "darwin"
      ? {
          userId: typeof process.getuid === "function" ? process.getuid() : 501,
        }
      : {}),
  });

  const shimScript = resolve(shimDir, "supervisor-shim.mjs");
  const quoteForShell = (value: string): string =>
    value.replaceAll(/(["\\$`])/g, "\\$1");

  await mkdir(shimDir, { recursive: true });
  await writeFile(
    shimScript,
    `import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative } from "node:path";

const [, , kind, ...args] = process.argv;
const logFile = process.env.UMS_TEST_SUPERVISOR_LOG_FILE;

const log = (entry) => {
  if (logFile) {
    appendFileSync(logFile, \`\${JSON.stringify(entry)}\\n\`, "utf8");
  }
};

const exitWith = (code, stdout = "", stderr = "") => {
  if (stdout) {
    process.stdout.write(stdout);
  }
  if (stderr) {
    process.stderr.write(stderr);
  }
  process.exit(code);
};

log({ kind, args });

switch (kind) {
  case "launchctl": {
    const stateFile = process.env.UMS_TEST_LAUNCHCTL_STATE_FILE;
    const serviceTarget = process.env.UMS_TEST_LAUNCHCTL_SERVICE_TARGET;
    if (args[0] === "bootstrap") {
      if (!stateFile || !serviceTarget) {
        exitWith(64, "", "missing launchctl test state\\n");
      }
      mkdirSync(dirname(stateFile), { recursive: true });
      writeFileSync(stateFile, serviceTarget, "utf8");
      exitWith(0, "bootstrapped\\n");
    }
    if (args[0] === "print") {
      if (
        stateFile &&
        existsSync(stateFile) &&
        readFileSync(stateFile, "utf8").trim() === args[1]
      ) {
        exitWith(0, \`\${args[1]}\\n\`);
      }
      exitWith(1, "", "service missing\\n");
    }
    if (args[0] === "bootout") {
      if (stateFile) {
        rmSync(stateFile, { force: true });
      }
      exitWith(0, "booted out\\n");
    }
    break;
  }
  case "systemctl": {
    const descriptorFile = process.env.UMS_TEST_SYSTEMD_DESCRIPTOR_FILE;
    const enabledFile = process.env.UMS_TEST_SYSTEMD_ENABLED_FILE;
    if (args[0] === "--user" && args[1] === "daemon-reload") {
      exitWith(0, "reloaded\\n");
    }
    if (args[0] === "--user" && args[1] === "enable") {
      if (!descriptorFile || !enabledFile) {
        exitWith(64, "", "missing systemd test files\\n");
      }
      mkdirSync(dirname(enabledFile), { recursive: true });
      rmSync(enabledFile, { force: true });
      symlinkSync(relative(dirname(enabledFile), descriptorFile), enabledFile);
      exitWith(0, \`\${args[2]} enabled\\n\`);
    }
    if (args[0] === "--user" && args[1] === "disable") {
      if (!enabledFile) {
        exitWith(64, "", "missing systemd enabled file\\n");
      }
      rmSync(enabledFile, { force: true });
      exitWith(0, \`\${args[2]} disabled\\n\`);
    }
    if (args[0] === "--user" && args[1] === "is-enabled") {
      if (
        descriptorFile &&
        enabledFile &&
        existsSync(enabledFile) &&
        readlinkSync(enabledFile) === relative(dirname(enabledFile), descriptorFile)
      ) {
        exitWith(0, "enabled\\n");
      }
      exitWith(1, "disabled\\n");
    }
    break;
  }
  case "schtasks": {
    const stateFile = process.env.UMS_TEST_WINDOWS_TASK_STATE_FILE;
    const taskName = process.env.UMS_TEST_WINDOWS_TASK_NAME;
    if (args[0] === "/create") {
      if (!stateFile || !taskName) {
        exitWith(64, "", "missing schtasks test state\\n");
      }
      mkdirSync(dirname(stateFile), { recursive: true });
      writeFileSync(stateFile, taskName, "utf8");
      exitWith(0, "created\\n");
    }
    if (args[0] === "/delete") {
      if (stateFile) {
        rmSync(stateFile, { force: true });
      }
      exitWith(0, "deleted\\n");
    }
    if (args[0] === "/query") {
      if (
        stateFile &&
        taskName &&
        existsSync(stateFile) &&
        readFileSync(stateFile, "utf8").trim() === taskName
      ) {
        exitWith(0, "listed\\n");
      }
      exitWith(1, "", "task missing\\n");
    }
    break;
  }
  default:
    break;
}

exitWith(64, "", \`unsupported supervisor invocation: \${kind} \${args.join(" ")}\\n\`);
`,
    "utf8"
  );

  if (process.platform === "darwin" || process.platform === "linux") {
    const commandName =
      process.platform === "darwin" ? "launchctl" : "systemctl";
    const wrapperFile = resolve(shimDir, commandName);
    await writeFile(
      wrapperFile,
      `#!/bin/sh\nexec "${quoteForShell(process.execPath)}" "${quoteForShell(shimScript)}" "${commandName}" "$@"\n`,
      "utf8"
    );
    await chmod(wrapperFile, 0o755);
  } else if (process.platform === "win32") {
    await writeFile(
      resolve(shimDir, "schtasks.cmd"),
      `@echo off\r\n"${process.execPath}" "${shimScript}" "schtasks" %*\r\n`,
      "utf8"
    );
  }

  return {
    env: {
      ...baseEnv,
      PATH: `${shimDir}${delimiter}${baseEnv["PATH"] ?? ""}`,
      UMS_TEST_SUPERVISOR_LOG_FILE: commandLogFile,
      ...(process.platform === "darwin"
        ? {
            UMS_TEST_LAUNCHCTL_STATE_FILE: resolve(
              shimDir,
              "launchctl-state.txt"
            ),
            UMS_TEST_LAUNCHCTL_SERVICE_TARGET: plan.queryCommand?.args[1] ?? "",
          }
        : {}),
      ...(process.platform === "linux"
        ? {
            UMS_TEST_SYSTEMD_DESCRIPTOR_FILE: plan.descriptorFile,
            UMS_TEST_SYSTEMD_ENABLED_FILE: plan.enabledFile ?? "",
          }
        : {}),
      ...(process.platform === "win32"
        ? {
            UMS_TEST_WINDOWS_TASK_STATE_FILE: resolve(
              shimDir,
              "schtasks-state.txt"
            ),
            UMS_TEST_WINDOWS_TASK_NAME: plan.taskName ?? "",
          }
        : {}),
    },
    commandLogFile,
  };
}

async function readSupervisorShimLog(
  commandLogFile: string
): Promise<readonly SupervisorShimLogEntry[]> {
  const raw = await readFile(commandLogFile, "utf8").catch(() => "");
  return raw
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as SupervisorShimLogEntry);
}

beforeEach(() => {
  resetStore();
});

test("cli maps ingest command to shared operation core", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "ums-cli-test-"));
  const stateFile = resolve(tempDir, "state.json");
  try {
    const ingest = await runCli([
      "ingest",
      "--state-file",
      stateFile,
      "--input",
      JSON.stringify({
        profile: "cli-test",
        events: [{ type: "note", source: "cli", content: "wire same core" }],
      }),
    ]);
    assert.equal((ingest as any).code, 0);
    const ingestBody = JSON.parse((ingest as any).stdout);
    assert.equal(ingestBody.ok, true);
    assert.equal(ingestBody.data.operation, "ingest");
    assert.equal(ingestBody.data.accepted, 1);

    const context = await runCli([
      "context",
      "--state-file",
      stateFile,
      "--input",
      '{"profile":"cli-test","query":"wire"}',
    ]);
    assert.equal((context as any).code, 0);
    const contextBody = JSON.parse((context as any).stdout);
    assert.equal(contextBody.ok, true);
    assert.equal(contextBody.data.operation, "context");
    assert.equal(contextBody.data.matches.length, 1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("cli supports stdin json input", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "ums-cli-test-"));
  const stateFile = resolve(tempDir, "state.json");
  try {
    const ingest = await runCli(
      ["ingest", "--state-file", stateFile],
      JSON.stringify({
        profile: "stdin-test",
        events: [{ type: "task", source: "stdin", content: "stdin payload" }],
      })
    );
    assert.equal((ingest as any).code, 0);
    const body = JSON.parse((ingest as any).stdout);
    assert.equal(body.ok, true);
    assert.equal(body.data.profile, "stdin-test");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("cli honors UMS_STATE_FILE as shared default state path", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "ums-cli-shared-default-"));
  const sharedStateFile = resolve(tempDir, "shared-state.json");
  const env = {
    ...process.env,
    UMS_STATE_FILE: sharedStateFile,
  };
  try {
    const ingest = await runCli(
      [
        "ingest",
        "--input",
        JSON.stringify({
          profile: "shared-default",
          events: [
            {
              type: "note",
              source: "cli",
              content: "shared default state file",
            },
          ],
        }),
      ],
      "",
      { env }
    );
    assert.equal((ingest as any).code, 0);

    const context = await runCli(
      [
        "context",
        "--input",
        JSON.stringify({
          profile: "shared-default",
          query: "shared default state file",
        }),
      ],
      "",
      { env }
    );
    assert.equal((context as any).code, 0);
    const contextBody = JSON.parse((context as any).stdout);
    assert.equal(contextBody.ok, true);
    assert.equal(contextBody.data.matches.length, 1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("cli store-id flag isolates memories across stores", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "ums-cli-test-"));
  const stateFile = resolve(tempDir, "state.json");

  try {
    const jiraIngest = await runCli([
      "ingest",
      "--state-file",
      stateFile,
      "--store-id",
      "jira-history",
      "--input",
      JSON.stringify({
        profile: "shared-profile",
        events: [{ type: "ticket", source: "jira", content: "jira only note" }],
      }),
    ]);
    assert.equal((jiraIngest as any).code, 0);

    const codingIngest = await runCli([
      "ingest",
      "--state-file",
      stateFile,
      "--store-id",
      "coding-agent",
      "--input",
      JSON.stringify({
        profile: "shared-profile",
        events: [
          { type: "note", source: "codex", content: "coding only note" },
        ],
      }),
    ]);
    assert.equal((codingIngest as any).code, 0);

    const jiraContext = await runCli([
      "context",
      "--state-file",
      stateFile,
      "--store-id",
      "jira-history",
      "--input",
      JSON.stringify({ profile: "shared-profile", query: "coding only note" }),
    ]);
    const jiraBody = JSON.parse((jiraContext as any).stdout);
    assert.equal(jiraBody.ok, true);
    assert.equal(jiraBody.data.matches.length, 0);

    const codingContext = await runCli([
      "context",
      "--state-file",
      stateFile,
      "--store-id",
      "coding-agent",
      "--input",
      JSON.stringify({ profile: "shared-profile", query: "jira only note" }),
    ]);
    const codingBody = JSON.parse((codingContext as any).stdout);
    assert.equal(codingBody.ok, true);
    assert.equal(codingBody.data.matches.length, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ums login and connect are removed from the config-backed runtime", async () => {
  const login = await runUms(["login"]);
  assert.equal((login as any).code, 1);
  const loginError = JSON.parse((login as any).stderr);
  assert.equal(loginError.ok, false);
  assert.equal(loginError.error.code, "UMS_RUNTIME_ERROR");
  assert.match(loginError.error.message, /login is removed/i);

  const connect = await runUms(["connect"]);
  assert.equal((connect as any).code, 1);
  const connectError = JSON.parse((connect as any).stderr);
  assert.equal(connectError.ok, false);
  assert.equal(connectError.error.code, "UMS_RUNTIME_ERROR");
  assert.match(connectError.error.message, /connect is removed/i);
});

test("ums sync ingests local codex history into configured local memory", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "ums-config-sync-local-"));
  const homeDir = resolve(tempDir, "home");
  const codexDir = resolve(homeDir, ".codex", "sessions");
  const projectRoot = resolve(tempDir, "projects", "personal-app");
  const configFile = resolve(tempDir, "config.jsonc");
  try {
    await mkdir(codexDir, { recursive: true });
    await mkdir(projectRoot, { recursive: true });
    await writeFile(
      resolve(codexDir, "session.jsonl"),
      `${JSON.stringify({
        type: "session_meta",
        payload: {
          id: "session-local-1",
          cwd: projectRoot,
        },
      })}\n${JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content:
            "Auto-capture knowledge from developer sessions into local memory.",
        },
      })}\n`,
      "utf8"
    );

    await writeDaemonConfig(configFile, {
      version: 1,
      state: {
        rootDir: resolve(tempDir, "ums-state"),
        journalDir: resolve(tempDir, "ums-state", "journal"),
        checkpointDir: resolve(tempDir, "ums-state", "checkpoints"),
      },
      accounts: {
        local: { type: "local" },
      },
      memories: {
        personal: {
          account: "local",
          storeId: "personal",
          profile: "main",
        },
      },
      sources: {
        codex: {
          roots: [codexDir],
        },
        claude: {
          enabled: false,
        },
        plan: {
          enabled: false,
        },
      },
      routes: [
        {
          match: {
            pathPrefix: projectRoot,
            source: "codex",
          },
          memory: "personal",
          priority: 10,
        },
      ],
      defaults: {
        memory: "personal",
        onAmbiguous: "default",
      },
    });

    const sync = await runUms(["sync", "--config-file", configFile], "", {
      env: {
        ...process.env,
        HOME: homeDir,
      },
    });
    assert.equal((sync as any).code, 0, (sync as any).stderr);
    const syncBody = JSON.parse((sync as any).stdout);
    assert.equal(syncBody.ok, true);
    assert.equal(syncBody.data.operation, "sync");
    assert.equal(syncBody.data.preparedEvents >= 1, true);
    assert.equal(syncBody.data.accepted >= 1, true);

    const context = await runCli([
      "context",
      "--state-file",
      syncBody.data.runtimeStateFile,
      "--store-id",
      "personal",
      "--input",
      JSON.stringify({
        profile: "main",
        query: "auto-capture knowledge",
      }),
    ]);
    assert.equal((context as any).code, 0, (context as any).stderr);
    const contextBody = JSON.parse((context as any).stdout);
    assert.equal(contextBody.ok, true);
    assert.equal(contextBody.data.matches.length >= 1, true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ums sync-daemon updates local status and managed http memories fail closed until secure login succeeds", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "ums-config-sync-daemon-"));
  const homeDir = resolve(tempDir, "home");
  const codexDir = resolve(homeDir, ".codex", "sessions");
  const localProjectRoot = resolve(tempDir, "projects", "personal-app");
  const managedProjectRoot = resolve(tempDir, "projects", "new-engine");
  const localConfigFile = resolve(tempDir, "local-config.jsonc");
  const managedConfigFile = resolve(tempDir, "managed-config.jsonc");
  const credentialStoreFile = resolve(tempDir, "managed-credentials.json");
  const managedRequests: Array<{
    readonly authorization: string | null;
    readonly store: string | null;
    readonly accepted: number;
  }> = [];
  const managedServer = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/ingest") {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const accepted = Array.isArray(body.events) ? body.events.length : 0;
      managedRequests.push({
        authorization: request.headers.authorization ?? null,
        store:
          typeof request.headers["x-ums-store"] === "string"
            ? request.headers["x-ums-store"]
            : null,
        accepted,
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          ok: true,
          data: {
            accepted,
            duplicates: 0,
          },
        })
      );
    });
  });
  try {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      managedServer.once("error", rejectPromise);
      managedServer.listen(0, "127.0.0.1", () => {
        resolvePromise();
      });
    });
    const managedAddress = managedServer.address();
    assert.notEqual(managedAddress, null);
    assert.equal(typeof managedAddress === "object", true);
    const managedPort =
      managedAddress !== null && typeof managedAddress === "object"
        ? managedAddress.port
        : null;
    assert.notEqual(managedPort, null);
    const managedApiBaseUrl = `http://127.0.0.1:${managedPort}`;

    await mkdir(codexDir, { recursive: true });
    await mkdir(localProjectRoot, { recursive: true });
    await mkdir(managedProjectRoot, { recursive: true });
    await writeFile(
      resolve(codexDir, "session.jsonl"),
      `${JSON.stringify({
        type: "session_meta",
        payload: {
          id: "session-local-2",
          cwd: localProjectRoot,
        },
      })}\n${JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content:
            "Daemon status should reflect a successful local sync cycle.",
        },
      })}\n`,
      "utf8"
    );

    await writeDaemonConfig(localConfigFile, {
      version: 1,
      state: {
        rootDir: resolve(tempDir, "local-state"),
        journalDir: resolve(tempDir, "local-state", "journal"),
        checkpointDir: resolve(tempDir, "local-state", "checkpoints"),
      },
      accounts: {
        local: { type: "local" },
      },
      memories: {
        personal: {
          account: "local",
          storeId: "personal",
          profile: "main",
        },
      },
      sources: {
        codex: {
          roots: [codexDir],
        },
        claude: { enabled: false },
        plan: { enabled: false },
      },
      routes: [
        {
          match: {
            pathPrefix: localProjectRoot,
            source: "codex",
          },
          memory: "personal",
          priority: 10,
        },
      ],
      defaults: {
        memory: "personal",
        onAmbiguous: "default",
      },
    });

    const daemon = await runUms(
      [
        "sync-daemon",
        "--config-file",
        localConfigFile,
        "--max-cycles",
        "1",
        "--quiet",
      ],
      "",
      {
        env: {
          ...process.env,
          HOME: homeDir,
        },
      }
    );
    assert.equal((daemon as any).code, 0, (daemon as any).stderr);

    const localStatus = await runUms([
      "status",
      "--config-file",
      localConfigFile,
    ]);
    assert.equal((localStatus as any).code, 0, (localStatus as any).stderr);
    const localStatusBody = JSON.parse((localStatus as any).stdout);
    assert.equal(localStatusBody.ok, true);
    assert.equal(localStatusBody.data.operation, "status");
    assert.equal(localStatusBody.data.daemon.pid, null);
    assert.equal(localStatusBody.data.sync.lastSuccessAt !== null, true);
    assert.equal(localStatusBody.data.deliveries[0].accepted >= 1, true);
    const firstAccepted = localStatusBody.data.deliveries[0].accepted;
    const firstSequence =
      localStatusBody.data.deliveries[0].lastDeliveredSequence;

    const repeatDaemon = await runUms(
      [
        "sync-daemon",
        "--config-file",
        localConfigFile,
        "--max-cycles",
        "1",
        "--quiet",
      ],
      "",
      {
        env: {
          ...process.env,
          HOME: homeDir,
        },
      }
    );
    assert.equal((repeatDaemon as any).code, 0, (repeatDaemon as any).stderr);

    const repeatStatus = await runUms([
      "status",
      "--config-file",
      localConfigFile,
    ]);
    assert.equal((repeatStatus as any).code, 0, (repeatStatus as any).stderr);
    const repeatStatusBody = JSON.parse((repeatStatus as any).stdout);
    assert.equal(repeatStatusBody.data.deliveries[0].accepted, firstAccepted);
    assert.equal(
      repeatStatusBody.data.deliveries[0].lastDeliveredSequence,
      firstSequence
    );

    const appendedSession = `${await readFile(
      resolve(codexDir, "session.jsonl"),
      "utf8"
    )}${JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: "A resumed daemon cycle should only ingest fresh history.",
      },
    })}\n`;
    await writeFile(
      resolve(codexDir, "session.jsonl"),
      appendedSession,
      "utf8"
    );

    const resumedDaemon = await runUms(
      [
        "sync-daemon",
        "--config-file",
        localConfigFile,
        "--max-cycles",
        "1",
        "--quiet",
      ],
      "",
      {
        env: {
          ...process.env,
          HOME: homeDir,
        },
      }
    );
    assert.equal((resumedDaemon as any).code, 0, (resumedDaemon as any).stderr);

    const resumedStatus = await runUms([
      "status",
      "--config-file",
      localConfigFile,
    ]);
    assert.equal((resumedStatus as any).code, 0, (resumedStatus as any).stderr);
    const resumedStatusBody = JSON.parse((resumedStatus as any).stdout);
    assert.equal(
      resumedStatusBody.data.deliveries[0].accepted > firstAccepted,
      true
    );
    assert.equal(
      resumedStatusBody.data.deliveries[0].lastDeliveredSequence >
        firstSequence,
      true
    );

    await writeFile(
      resolve(codexDir, "session-managed.jsonl"),
      `${JSON.stringify({
        type: "session_meta",
        payload: {
          id: "session-managed-1",
          cwd: managedProjectRoot,
        },
      })}\n${JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content:
            "Managed memories should stay blocked until remote delivery ships.",
        },
      })}\n`,
      "utf8"
    );

    await writeDaemonConfig(managedConfigFile, {
      version: 1,
      state: {
        rootDir: resolve(tempDir, "managed-state"),
        journalDir: resolve(tempDir, "managed-state", "journal"),
        checkpointDir: resolve(tempDir, "managed-state", "checkpoints"),
      },
      accounts: {
        company: {
          type: "http",
          apiBaseUrl: managedApiBaseUrl,
          auth: {
            mode: "session-ref",
            credentialRef: "keychain://ums/company",
          },
        },
      },
      memories: {
        company: {
          account: "company",
          storeId: "coding-agent",
          profile: "developer-main",
          project: "new-engine",
        },
      },
      sources: {
        codex: {
          roots: [codexDir],
        },
        claude: { enabled: false },
        plan: { enabled: false },
      },
      routes: [
        {
          match: {
            pathPrefix: managedProjectRoot,
            source: "codex",
          },
          memory: "company",
          priority: 10,
        },
      ],
      defaults: {
        memory: "company",
        onAmbiguous: "default",
      },
      policy: {
        allowEnvTokenFallback: false,
      },
    });

    const managedSync = await runUms(
      ["sync", "--config-file", managedConfigFile],
      "",
      {
        env: {
          ...withPlaintextTestCredentialStoreEnv(credentialStoreFile),
          HOME: homeDir,
        },
      }
    );
    assert.equal((managedSync as any).code, 1);
    const managedError = JSON.parse((managedSync as any).stderr);
    assert.equal(managedError.ok, false);
    assert.equal(managedError.error.code, "DAEMON_SYNC_DELIVERY_ERROR");
    assert.match(managedError.error.message, /no secure credential stored/i);

    const managedStatus = await runUms([
      "status",
      "--config-file",
      managedConfigFile,
    ]);
    assert.equal((managedStatus as any).code, 0, (managedStatus as any).stderr);
    const managedStatusBody = JSON.parse((managedStatus as any).stdout);
    assert.equal(managedStatusBody.ok, true);
    assert.match(
      managedStatusBody.data.deliveries[0].lastError,
      /no secure credential stored/i
    );

    const managedLogin = await runUms(
      [
        "account",
        "login",
        "--config-file",
        managedConfigFile,
        "--name",
        "company",
        "--secret-env",
        "COMPANY_SECRET",
      ],
      "",
      {
        env: {
          ...withPlaintextTestCredentialStoreEnv(credentialStoreFile),
          HOME: homeDir,
          COMPANY_SECRET: "managed-session-token",
        },
      }
    );
    assert.equal((managedLogin as any).code, 0, (managedLogin as any).stderr);

    const managedSyncAfterLogin = await runUms(
      ["sync", "--config-file", managedConfigFile],
      "",
      {
        env: {
          ...withPlaintextTestCredentialStoreEnv(credentialStoreFile),
          HOME: homeDir,
        },
      }
    );
    assert.equal(
      (managedSyncAfterLogin as any).code,
      0,
      (managedSyncAfterLogin as any).stderr
    );

    const managedStatusAfterLogin = await runUms([
      "status",
      "--config-file",
      managedConfigFile,
    ]);
    assert.equal(
      (managedStatusAfterLogin as any).code,
      0,
      (managedStatusAfterLogin as any).stderr
    );
    const managedStatusAfterLoginBody = JSON.parse(
      (managedStatusAfterLogin as any).stdout
    );
    assert.equal(managedStatusAfterLoginBody.ok, true);
    assert.equal(
      managedStatusAfterLoginBody.data.deliveries[0].accepted >= 1,
      true
    );
    assert.equal(
      managedStatusAfterLoginBody.data.deliveries[0].lastError,
      null
    );
    assert.equal(managedRequests.length >= 1, true);
    assert.equal(
      managedRequests[0]?.authorization,
      "Bearer managed-session-token"
    );
    assert.equal(managedRequests[0]?.store, "coding-agent");
    assert.equal(managedRequests[0]?.accepted >= 1, true);

    const previousCredentialStore =
      process.env["UMS_TEST_CREDENTIAL_STORE_FILE"];
    const previousAllowPlaintext =
      process.env["UMS_ALLOW_PLAINTEXT_TEST_CREDENTIAL_STORE"];
    try {
      process.env["UMS_TEST_CREDENTIAL_STORE_FILE"] = credentialStoreFile;
      process.env["UMS_ALLOW_PLAINTEXT_TEST_CREDENTIAL_STORE"] = "true";
      await Effect.runPromise(
        storeManagedAccountCredential({
          credentialRef: "keychain://ums/company",
          secret: "expired-managed-session-token",
          storedAt: "2026-03-07T10:00:00.000Z",
          expiresAt: "2000-01-01T00:00:00.000Z",
        })
      );
    } finally {
      if (previousCredentialStore === undefined) {
        delete process.env["UMS_TEST_CREDENTIAL_STORE_FILE"];
      } else {
        process.env["UMS_TEST_CREDENTIAL_STORE_FILE"] = previousCredentialStore;
      }
      if (previousAllowPlaintext === undefined) {
        delete process.env["UMS_ALLOW_PLAINTEXT_TEST_CREDENTIAL_STORE"];
      } else {
        process.env["UMS_ALLOW_PLAINTEXT_TEST_CREDENTIAL_STORE"] =
          previousAllowPlaintext;
      }
    }

    await writeFile(
      resolve(codexDir, "session-managed.jsonl"),
      `${await readFile(
        resolve(codexDir, "session-managed.jsonl"),
        "utf8"
      )}${JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content:
            "Expired managed credentials must fail closed before remote delivery.",
        },
      })}\n`,
      "utf8"
    );

    const managedAccountsAfterExpiry = await runUms(
      ["account", "list", "--config-file", managedConfigFile],
      "",
      {
        env: {
          ...withPlaintextTestCredentialStoreEnv(credentialStoreFile),
          HOME: homeDir,
        },
      }
    );
    assert.equal(
      (managedAccountsAfterExpiry as any).code,
      0,
      (managedAccountsAfterExpiry as any).stderr
    );
    const managedAccountsAfterExpiryBody = JSON.parse(
      (managedAccountsAfterExpiry as any).stdout
    );
    const managedCompanyAfterExpiry =
      managedAccountsAfterExpiryBody.data.accounts.find(
        (account: any) => account.name === "company"
      );
    assert.deepEqual(managedCompanyAfterExpiry.credentialState, {
      status: "expired",
      storedAt: "2026-03-07T10:00:00.000Z",
      expiresAt: "2000-01-01T00:00:00.000Z",
    });

    const managedSyncAfterExpiry = await runUms(
      ["sync", "--config-file", managedConfigFile],
      "",
      {
        env: {
          ...withPlaintextTestCredentialStoreEnv(credentialStoreFile),
          HOME: homeDir,
        },
      }
    );
    assert.equal((managedSyncAfterExpiry as any).code, 1);
    const managedExpiryError = JSON.parse(
      (managedSyncAfterExpiry as any).stderr
    );
    assert.equal(managedExpiryError.ok, false);
    assert.equal(managedExpiryError.error.code, "DAEMON_SYNC_DELIVERY_ERROR");
    assert.match(managedExpiryError.error.message, /expired/i);
    assert.equal(managedRequests.length, 1);

    const managedStatusAfterExpiry = await runUms([
      "status",
      "--config-file",
      managedConfigFile,
    ]);
    assert.equal(
      (managedStatusAfterExpiry as any).code,
      0,
      (managedStatusAfterExpiry as any).stderr
    );
    const managedStatusAfterExpiryBody = JSON.parse(
      (managedStatusAfterExpiry as any).stdout
    );
    assert.match(
      managedStatusAfterExpiryBody.data.deliveries[0].lastError,
      /expired/i
    );
  } finally {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      managedServer.close((error) => {
        if (error) {
          rejectPromise(error);
          return;
        }
        resolvePromise();
      });
    });
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ums daemon lifecycle commands install, start, restart, logs, doctor, stop, and uninstall through the CLI control plane", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "ums-daemon-lifecycle-"));
  const homeDir = resolve(tempDir, "home");
  const codexDir = resolve(homeDir, ".codex", "sessions");
  const repoRoot = resolve(tempDir, "repo");
  const stateRoot = resolve(tempDir, "daemon-state");
  const configFile = resolve(tempDir, "config.jsonc");
  const baseEnv = {
    ...process.env,
    HOME: homeDir,
  };
  let cleanupEnv: NodeJS.ProcessEnv = baseEnv;

  try {
    await mkdir(codexDir, { recursive: true });
    await mkdir(repoRoot, { recursive: true });
    await writeFile(
      resolve(codexDir, "session.jsonl"),
      `${JSON.stringify({
        type: "session_meta",
        payload: {
          id: "session-daemon-1",
          cwd: repoRoot,
        },
      })}\n${JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: "Daemon lifecycle health should be deterministic.",
        },
      })}\n`,
      "utf8"
    );

    await writeDaemonConfig(configFile, {
      version: 1,
      state: {
        rootDir: stateRoot,
        journalDir: resolve(stateRoot, "journal"),
        checkpointDir: resolve(stateRoot, "checkpoints"),
      },
      accounts: {
        local: { type: "local" },
      },
      memories: {
        personal: {
          account: "local",
          storeId: "personal",
          profile: "main",
        },
      },
      sources: {
        codex: {
          roots: [codexDir],
        },
        claude: { enabled: false },
        plan: { enabled: false },
      },
      routes: [
        {
          match: {
            pathPrefix: repoRoot,
            source: "codex",
          },
          memory: "personal",
          priority: 10,
        },
      ],
      defaults: {
        memory: "personal",
        onAmbiguous: "default",
      },
    });
    const supervisorShim = await createSupervisorShim({
      tempDir,
      configFile,
      stateRoot,
      env: baseEnv,
    });
    cleanupEnv = supervisorShim.env;
    const env = supervisorShim.env;

    const install = await runUms(["install", "--config-file", configFile], "", {
      env,
    });
    assert.equal((install as any).code, 0, (install as any).stderr);
    const installBody = JSON.parse((install as any).stdout);
    assert.equal(installBody.ok, true);
    assert.equal(installBody.data.operation, "install");
    assert.equal(installBody.data.status, "installed");
    assert.equal(installBody.data.supervisor.registered, true);
    await access(installBody.data.supervisor.descriptorFile);
    await access(installBody.data.supervisor.launcherFile);
    if (installBody.data.supervisor.enabledFile) {
      assert.equal(
        resolve(
          dirname(installBody.data.supervisor.enabledFile),
          await readlink(installBody.data.supervisor.enabledFile)
        ),
        installBody.data.supervisor.descriptorFile
      );
    }

    const reinstall = await runUms(
      ["install", "--config-file", configFile],
      "",
      { env }
    );
    assert.equal((reinstall as any).code, 0, (reinstall as any).stderr);
    const reinstallBody = JSON.parse((reinstall as any).stdout);
    assert.equal(reinstallBody.ok, true);
    assert.equal(reinstallBody.data.operation, "install");
    assert.equal(reinstallBody.data.status, "already_installed");
    assert.equal(reinstallBody.data.supervisor.registered, true);

    const start = await runUms(
      [
        "start",
        "--config-file",
        configFile,
        "--interval-ms",
        "100",
        "--ready-timeout-ms",
        "10000",
      ],
      "",
      { env }
    );
    assert.equal((start as any).code, 0, (start as any).stderr);
    const startBody = JSON.parse((start as any).stdout);
    assert.equal(startBody.ok, true);
    assert.equal(startBody.data.operation, "start");
    assert.equal(startBody.data.status, "started");
    assert.equal(startBody.data.daemon.alive, true);
    assert.equal(typeof startBody.data.pid, "number");

    const startAgain = await runUms(
      [
        "start",
        "--config-file",
        configFile,
        "--interval-ms",
        "100",
        "--ready-timeout-ms",
        "1000",
      ],
      "",
      { env }
    );
    assert.equal((startAgain as any).code, 1);
    const startAgainBody = JSON.parse((startAgain as any).stderr);
    assert.equal(startAgainBody.ok, false);
    assert.equal(startAgainBody.error.code, "DAEMON_ALREADY_RUNNING");

    const status = await runUms(["status", "--config-file", configFile], "", {
      env,
    });
    assert.equal((status as any).code, 0, (status as any).stderr);
    const statusBody = JSON.parse((status as any).stdout);
    assert.equal(statusBody.ok, true);
    assert.equal(statusBody.data.operation, "status");
    assert.equal(statusBody.data.installed, true);
    assert.equal(statusBody.data.health, "healthy");
    assert.equal(statusBody.data.supervisor.registered, true);
    assert.equal(statusBody.data.daemon.alive, true);

    const logs = await runUms(["logs", "--config-file", configFile], "", {
      env,
    });
    assert.equal((logs as any).code, 0, (logs as any).stderr);
    const logsBody = JSON.parse((logs as any).stdout);
    assert.equal(logsBody.ok, true);
    assert.equal(logsBody.data.operation, "logs");
    assert.equal(logsBody.data.entries.length >= 1, true);

    const doctor = await runUms(["doctor", "--config-file", configFile], "", {
      env,
    });
    assert.equal((doctor as any).code, 0, (doctor as any).stderr);
    const doctorBody = JSON.parse((doctor as any).stdout);
    assert.equal(doctorBody.ok, true);
    assert.equal(doctorBody.data.operation, "doctor");
    assert.equal(doctorBody.data.healthy, true);
    assert.equal(
      doctorBody.data.checks.some(
        (check: { name: string; status: string }) =>
          check.name === "supervisor" && check.status === "pass"
      ),
      true
    );

    const restart = await runUms(
      [
        "restart",
        "--config-file",
        configFile,
        "--interval-ms",
        "100",
        "--ready-timeout-ms",
        "10000",
        "--timeout-ms",
        "10000",
      ],
      "",
      { env }
    );
    assert.equal((restart as any).code, 0, (restart as any).stderr);
    const restartBody = JSON.parse((restart as any).stdout);
    assert.equal(restartBody.ok, true);
    assert.equal(restartBody.data.operation, "restart");
    assert.equal(restartBody.data.status, "restarted");
    assert.notEqual(restartBody.data.pid, startBody.data.pid);
    assert.equal(restartBody.data.stoppedPid, startBody.data.pid);

    const stop = await runUms(
      ["stop", "--config-file", configFile, "--timeout-ms", "10000"],
      "",
      { env }
    );
    assert.equal((stop as any).code, 0, (stop as any).stderr);
    const stopBody = JSON.parse((stop as any).stdout);
    assert.equal(stopBody.ok, true);
    assert.equal(stopBody.data.operation, "stop");
    assert.equal(stopBody.data.status, "stopped");
    assert.equal(stopBody.data.stoppedPid, restartBody.data.pid);

    const stopAgain = await runUms(
      ["stop", "--config-file", configFile, "--timeout-ms", "1000"],
      "",
      { env }
    );
    assert.equal((stopAgain as any).code, 1);
    const stopAgainBody = JSON.parse((stopAgain as any).stderr);
    assert.equal(stopAgainBody.ok, false);
    assert.equal(stopAgainBody.error.code, "DAEMON_NOT_RUNNING");

    const uninstall = await runUms(
      ["uninstall", "--config-file", configFile, "--timeout-ms", "10000"],
      "",
      { env }
    );
    assert.equal((uninstall as any).code, 0, (uninstall as any).stderr);
    const uninstallBody = JSON.parse((uninstall as any).stdout);
    assert.equal(uninstallBody.ok, true);
    assert.equal(uninstallBody.data.operation, "uninstall");
    assert.equal(uninstallBody.data.status, "uninstalled");
    assert.equal(uninstallBody.data.supervisor.registered, false);
    await assert.rejects(access(installBody.data.supervisor.launcherFile));
    await assert.rejects(access(installBody.data.supervisor.descriptorFile));
    if (installBody.data.supervisor.enabledFile) {
      await assert.rejects(access(installBody.data.supervisor.enabledFile));
    }
    const supervisorLog = await readSupervisorShimLog(
      supervisorShim.commandLogFile
    );
    if (process.platform === "darwin") {
      const operations = new Set(
        supervisorLog
          .filter((entry) => entry.kind === "launchctl")
          .map((entry) => entry.args[0])
      );
      assert.equal(operations.has("bootstrap"), true);
      assert.equal(operations.has("print"), true);
      assert.equal(operations.has("bootout"), true);
    }
    if (process.platform === "linux") {
      const operations = new Set(
        supervisorLog
          .filter((entry) => entry.kind === "systemctl")
          .map((entry) => entry.args.slice(0, 2).join(" "))
      );
      assert.equal(operations.has("--user daemon-reload"), true);
      assert.equal(operations.has("--user enable"), true);
      assert.equal(operations.has("--user is-enabled"), true);
      assert.equal(operations.has("--user disable"), true);
    }
    if (process.platform === "win32") {
      const operations = new Set(
        supervisorLog
          .filter((entry) => entry.kind === "schtasks")
          .map((entry) => entry.args[0])
      );
      assert.equal(operations.has("/create"), true);
      assert.equal(operations.has("/query"), true);
      assert.equal(operations.has("/delete"), true);
    }
  } finally {
    await runUms(
      ["stop", "--config-file", configFile, "--timeout-ms", "1000"],
      "",
      { env: cleanupEnv }
    ).catch(() => {});
    await runUms(
      ["uninstall", "--config-file", configFile, "--timeout-ms", "1000"],
      "",
      { env: cleanupEnv }
    ).catch(() => {});
    await rm(tempDir, { recursive: true, force: true });
  }
}, 15_000);

test("ums managed configs keep the same daemon lifecycle control surface as solo configs", async () => {
  const tempDir = await mkdtemp(
    resolve(tmpdir(), "ums-daemon-managed-lifecycle-")
  );
  const homeDir = resolve(tempDir, "home");
  const repoRoot = resolve(tempDir, "repo");
  const stateRoot = resolve(tempDir, "daemon-state");
  const configFile = resolve(tempDir, "config.jsonc");
  const baseEnv = {
    ...process.env,
    HOME: homeDir,
  };
  let cleanupEnv: NodeJS.ProcessEnv = baseEnv;

  try {
    await mkdir(repoRoot, { recursive: true });
    await writeDaemonConfig(configFile, {
      version: 1,
      state: {
        rootDir: stateRoot,
        journalDir: resolve(stateRoot, "journal"),
        checkpointDir: resolve(stateRoot, "checkpoints"),
      },
      accounts: {
        company: {
          type: "http",
          apiBaseUrl: "https://ums.company.internal",
          auth: {
            mode: "session-ref",
            credentialRef: "keychain://ums/company",
          },
        },
      },
      memories: {
        company: {
          account: "company",
          storeId: "coding-agent",
          profile: "developer-main",
        },
      },
      sources: {
        codex: { enabled: false },
        claude: { enabled: false },
        plan: { enabled: false },
      },
      routes: [
        {
          match: {
            pathPrefix: repoRoot,
            source: "plan",
          },
          memory: "company",
          priority: 10,
        },
      ],
      defaults: {
        memory: "company",
        onAmbiguous: "review",
      },
    });
    const supervisorShim = await createSupervisorShim({
      tempDir,
      configFile,
      stateRoot,
      env: baseEnv,
    });
    cleanupEnv = supervisorShim.env;
    const env = supervisorShim.env;

    const install = await runUms(["install", "--config-file", configFile], "", {
      env,
    });
    assert.equal((install as any).code, 0, (install as any).stderr);

    const start = await runUms(
      [
        "start",
        "--config-file",
        configFile,
        "--interval-ms",
        "100",
        "--ready-timeout-ms",
        "10000",
      ],
      "",
      { env }
    );
    assert.equal((start as any).code, 0, (start as any).stderr);

    const status = await runUms(["status", "--config-file", configFile], "", {
      env,
    });
    assert.equal((status as any).code, 0, (status as any).stderr);
    const statusBody = JSON.parse((status as any).stdout);
    assert.equal(statusBody.data.operation, "status");
    assert.equal(statusBody.data.installed, true);

    const doctor = await runUms(["doctor", "--config-file", configFile], "", {
      env,
    });
    assert.equal((doctor as any).code, 0, (doctor as any).stderr);
    const doctorBody = JSON.parse((doctor as any).stdout);
    assert.equal(doctorBody.data.operation, "doctor");
    assert.equal(doctorBody.ok, true);

    const stop = await runUms(
      ["stop", "--config-file", configFile, "--timeout-ms", "10000"],
      "",
      { env }
    );
    assert.equal((stop as any).code, 0, (stop as any).stderr);

    const uninstall = await runUms(
      ["uninstall", "--config-file", configFile, "--timeout-ms", "10000"],
      "",
      { env }
    );
    assert.equal((uninstall as any).code, 0, (uninstall as any).stderr);
    const supervisorLog = await readSupervisorShimLog(
      supervisorShim.commandLogFile
    );
    if (process.platform === "darwin") {
      assert.equal(
        supervisorLog.some(
          (entry) => entry.kind === "launchctl" && entry.args[0] === "print"
        ),
        true
      );
    }
    if (process.platform === "linux") {
      assert.equal(
        supervisorLog.some(
          (entry) =>
            entry.kind === "systemctl" &&
            entry.args[0] === "--user" &&
            entry.args[1] === "is-enabled"
        ),
        true
      );
    }
  } finally {
    await runUms(
      ["stop", "--config-file", configFile, "--timeout-ms", "1000"],
      "",
      { env: cleanupEnv }
    ).catch(() => {});
    await runUms(
      ["uninstall", "--config-file", configFile, "--timeout-ms", "1000"],
      "",
      { env: cleanupEnv }
    ).catch(() => {});
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ums config init writes starter config and validate accepts it", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "ums-config-init-"));
  const configFile = resolve(tempDir, "config.jsonc");
  try {
    const init = await runUms(["config", "init", "--config-file", configFile]);
    assert.equal((init as any).code, 0, (init as any).stderr);
    const initBody = JSON.parse((init as any).stdout);
    assert.equal(initBody.ok, true);
    assert.equal(initBody.data.operation, "config.init");
    assert.equal(initBody.data.summary.defaultMemory, "personal");

    const written = JSON.parse(await readFile(configFile, "utf8"));
    assert.equal(written.version, 1);
    assert.equal(written.memories.personal.storeId, "personal");

    const validate = await runUms([
      "config",
      "validate",
      "--config-file",
      configFile,
    ]);
    assert.equal((validate as any).code, 0, (validate as any).stderr);
    const validateBody = JSON.parse((validate as any).stdout);
    assert.equal(validateBody.ok, true);
    assert.equal(validateBody.data.operation, "config.validate");
    assert.equal(validateBody.data.summary.accounts, 1);
    assert.equal(validateBody.data.summary.memories, 1);
    assert.equal(validateBody.data.summary.routes, 1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ums config validate surfaces schema and cross-reference errors", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "ums-config-validate-"));
  const configFile = resolve(tempDir, "config.jsonc");
  try {
    await writeFile(
      configFile,
      JSON.stringify(
        {
          version: 1,
          accounts: {
            local: { type: "local" },
          },
          memories: {
            personal: {
              account: "local",
              storeId: "personal",
              profile: "main",
            },
          },
          routes: [],
          defaults: {
            memory: "company",
            onAmbiguous: "review",
            sync: {
              intervalMs: 60_000,
              maxEventsPerCycle: 400,
            },
          },
          policy: {},
        },
        null,
        2
      ),
      "utf8"
    );

    const validate = await runUms([
      "config",
      "validate",
      "--config-file",
      configFile,
    ]);
    assert.equal((validate as any).code, 1);
    const errorBody = JSON.parse((validate as any).stderr);
    assert.equal(errorBody.ok, false);
    assert.equal(errorBody.error.code, "DAEMON_CONFIG_VALIDATION_ERROR");
    assert.match(
      errorBody.error.message,
      /defaults\.memory: references unknown memory 'company'/
    );
    assert.match(
      errorBody.error.message,
      /routes: must contain at least one route/
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ums config doctor reports rewrite needs and can fix canonical output", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "ums-config-doctor-"));
  const configFile = resolve(tempDir, "config.jsonc");
  try {
    await writeFile(
      configFile,
      `{
  // intentionally non-canonical ordering and trailing commas
  "version": 1,
  "memories": {
    "personal": {
      "profile": "main",
      "storeId": "personal",
      "account": "local",
    },
  },
  "accounts": {
    "local": {
      "type": "local",
    },
  },
  "routes": [
    {
      "memory": "personal",
      "match": {
        "pathPrefix": "${tempDir.replace(/\\/g, "\\\\")}"
      },
    },
  ],
  "defaults": {
    "onAmbiguous": "review",
    "memory": "personal",
  },
  "policy": {},
  "sources": {}
}
`,
      "utf8"
    );

    const doctor = await runUms([
      "config",
      "doctor",
      "--config-file",
      configFile,
    ]);
    assert.equal((doctor as any).code, 1, (doctor as any).stderr);
    const doctorBody = JSON.parse((doctor as any).stdout);
    assert.equal(doctorBody.ok, true);
    assert.equal(doctorBody.data.operation, "config.doctor");
    assert.equal(doctorBody.data.status, "needs_rewrite");
    assert.equal(doctorBody.data.healthy, false);
    assert.equal(doctorBody.data.canonical, false);

    const fixed = await runUms([
      "config",
      "doctor",
      "--config-file",
      configFile,
      "--fix",
    ]);
    assert.equal((fixed as any).code, 0, (fixed as any).stderr);
    const fixedBody = JSON.parse((fixed as any).stdout);
    assert.equal(fixedBody.ok, true);
    assert.equal(fixedBody.data.status, "rewritten");
    assert.equal(fixedBody.data.rewritten, true);

    const written = await readFile(configFile, "utf8");
    assert.doesNotMatch(written, /\/\/ intentionally non-canonical/);
    assert.match(written, /"accounts"/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ums config doctor reports unreadable files as invalid payloads", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "ums-config-doctor-read-"));
  const configFile = resolve(tempDir, "config.jsonc");
  try {
    await writeFile(configFile, "{ not valid jsonc", "utf8");
    const renamed = resolve(tempDir, "config-dir");
    await rm(renamed, { recursive: true, force: true });
    await mkdir(renamed, { recursive: true });
    await rm(configFile, { force: true });
    await mkdir(configFile, { recursive: true });

    const doctor = await runUms([
      "config",
      "doctor",
      "--config-file",
      configFile,
    ]);
    assert.equal((doctor as any).code, 1, (doctor as any).stderr);
    const doctorBody = JSON.parse((doctor as any).stdout);
    assert.equal(doctorBody.ok, true);
    assert.equal(doctorBody.data.operation, "config.doctor");
    assert.equal(doctorBody.data.status, "invalid");
    assert.equal(doctorBody.data.healthy, false);
    assert.match(doctorBody.data.message, /Unable to read daemon config file/i);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ums config doctor --fix reports rewrite failures as invalid payloads", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "ums-config-doctor-fix-"));
  const configDir = resolve(tempDir, "locked");
  const configFile = resolve(configDir, "config.jsonc");
  try {
    await mkdir(configDir, { recursive: true });
    await writeFile(
      configFile,
      `{
  // intentionally non-canonical ordering and trailing commas
  "version": 1,
  "memories": {
    "personal": {
      "profile": "main",
      "storeId": "personal",
      "account": "local",
    },
  },
  "accounts": {
    "local": {
      "type": "local",
    },
  },
  "routes": [
    {
      "memory": "personal",
      "match": {
        "pathPrefix": "./",
      },
    },
  ],
  "defaults": {
    "memory": "personal",
    "onAmbiguous": "default",
  },
}`,
      "utf8"
    );
    await chmod(configDir, 0o500);

    const doctor = await runUms([
      "config",
      "doctor",
      "--config-file",
      configFile,
      "--fix",
    ]);
    assert.equal((doctor as any).code, 1, (doctor as any).stderr);
    const doctorBody = JSON.parse((doctor as any).stdout);
    assert.equal(doctorBody.ok, true);
    assert.equal(doctorBody.data.operation, "config.doctor");
    assert.equal(doctorBody.data.status, "invalid");
    assert.equal(doctorBody.data.healthy, false);
    assert.equal(doctorBody.data.rewritten, false);
    assert.match(
      doctorBody.data.message,
      /Unable to rewrite daemon config file/i
    );
  } finally {
    await chmod(configDir, 0o700).catch(() => {});
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ums agent skill exposes canonical CLI-first skill metadata", async () => {
  const skill = await runUms(["agent", "skill", "--format", "markdown"]);
  assert.equal((skill as any).code, 0, (skill as any).stderr);
  const skillBody = JSON.parse((skill as any).stdout);
  assert.equal(skillBody.ok, true);
  assert.equal(skillBody.data.operation, "agent.skill");
  assert.equal(skillBody.data.skillName, "ums-memory");
  assert.match(skillBody.data.skillPath, /skills\/ums-memory\/SKILL\.md$/);
  assert.match(
    skillBody.data.content,
    /Use `ums context` before any non-trivial task\./
  );
  assert.match(
    skillBody.data.content,
    /Cite provenance when recalled memory changes implementation, architecture, or policy decisions\./
  );
  const skillFile = await readFile(skillBody.data.skillPath, "utf8");
  assert.equal(skillBody.data.content, skillFile);
});

test("ums agent bootstrap writes thin repo snippets and detects drift", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "ums-agent-bootstrap-"));
  const repoRoot = resolve(tempDir, "repo");
  const configFile = resolve(tempDir, "config.jsonc");
  try {
    await mkdir(repoRoot, { recursive: true });
    await writeDaemonConfig(configFile, {
      version: 1,
      accounts: {
        local: { type: "local" },
      },
      memories: {
        company: {
          account: "local",
          storeId: "coding-agent",
          profile: "developer-main",
          project: "new-engine",
        },
      },
      routes: [
        {
          match: {
            pathPrefix: repoRoot,
          },
          memory: "company",
          priority: 10,
        },
      ],
      defaults: {
        memory: "company",
        onAmbiguous: "default",
      },
    });

    const bootstrap = await runUms([
      "agent",
      "bootstrap",
      "--config-file",
      configFile,
      "--repo-root",
      repoRoot,
      "--format",
      "all",
    ]);
    assert.equal((bootstrap as any).code, 0, (bootstrap as any).stderr);
    const bootstrapBody = JSON.parse((bootstrap as any).stdout);
    assert.equal(bootstrapBody.ok, true);
    assert.equal(bootstrapBody.data.operation, "agent.bootstrap");
    assert.equal(bootstrapBody.data.files.length, 3);
    assert.equal(bootstrapBody.data.binding.storeId, "coding-agent");
    assert.equal(bootstrapBody.data.binding.profile, "developer-main");

    const agentsFile = await readFile(resolve(repoRoot, "AGENTS.md"), "utf8");
    assert.match(agentsFile, /BEGIN UMS MEMORY/);
    assert.match(
      agentsFile,
      /Resolved store\/profile: `coding-agent` \/ `developer-main`/
    );

    const claudeFile = await readFile(resolve(repoRoot, "CLAUDE.md"), "utf8");
    assert.match(claudeFile, /Load the canonical `ums-memory` skill/);

    const copilotFile = await readFile(
      resolve(repoRoot, ".github", "copilot-instructions.md"),
      "utf8"
    );
    assert.match(copilotFile, /repo-local thin wrapper/);

    const checkOk = await runUms([
      "agent",
      "bootstrap",
      "--config-file",
      configFile,
      "--repo-root",
      repoRoot,
      "--format",
      "all",
      "--check",
    ]);
    assert.equal((checkOk as any).code, 0, (checkOk as any).stderr);
    const checkOkBody = JSON.parse((checkOk as any).stdout);
    assert.equal(checkOkBody.ok, true);
    assert.equal(checkOkBody.data.operation, "agent.bootstrap.check");
    assert.equal(checkOkBody.data.healthy, true);

    await writeFile(
      resolve(repoRoot, "AGENTS.md"),
      agentsFile.replace("Use `ums context`", "Use `ums broken-context`"),
      "utf8"
    );

    const checkFail = await runUms([
      "agent",
      "bootstrap",
      "--config-file",
      configFile,
      "--repo-root",
      repoRoot,
      "--format",
      "all",
      "--check",
    ]);
    assert.equal((checkFail as any).code, 1);
    const checkFailBody = JSON.parse((checkFail as any).stdout);
    assert.equal(checkFailBody.ok, true);
    assert.equal(checkFailBody.data.operation, "agent.bootstrap.check");
    assert.equal(checkFailBody.data.healthy, false);
    assert.equal(checkFailBody.data.files.length, 3);
    assert.match(checkFailBody.data.message, /drift detected/i);
    const driftedAgents = checkFailBody.data.files.find(
      (entry: { format: string; status: string }) => entry.format === "agents"
    );
    assert.equal(driftedAgents?.status, "out_of_date");

    const refresh = await runUms([
      "agent",
      "bootstrap",
      "--config-file",
      configFile,
      "--repo-root",
      repoRoot,
      "--format",
      "agents",
    ]);
    assert.equal((refresh as any).code, 0, (refresh as any).stderr);
    const refreshBody = JSON.parse((refresh as any).stdout);
    assert.equal(refreshBody.ok, true);
    assert.equal(refreshBody.data.operation, "agent.bootstrap");
    assert.equal(refreshBody.data.files.length, 1);
    assert.equal(refreshBody.data.files[0]?.changed, true);
    const refreshedAgentsFile = await readFile(
      resolve(repoRoot, "AGENTS.md"),
      "utf8"
    );
    assert.match(
      refreshedAgentsFile,
      /Use `ums context` before any non-trivial task\./
    );
    assert.doesNotMatch(refreshedAgentsFile, /ums broken-context/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ums agent bootstrap refuses to clobber unmanaged instruction files without force", async () => {
  const tempDir = await mkdtemp(
    resolve(tmpdir(), "ums-agent-bootstrap-guard-")
  );
  const repoRoot = resolve(tempDir, "repo");
  try {
    await mkdir(repoRoot, { recursive: true });
    await writeFile(
      resolve(repoRoot, "AGENTS.md"),
      "# Existing unmanaged instructions\n",
      "utf8"
    );

    const bootstrap = await runUms([
      "agent",
      "bootstrap",
      "--repo-root",
      repoRoot,
      "--format",
      "agents",
    ]);
    assert.equal((bootstrap as any).code, 1);
    const errorBody = JSON.parse((bootstrap as any).stderr);
    assert.equal(errorBody.ok, false);
    assert.equal(errorBody.error.code, "AGENT_GUIDANCE_CONFLICT_ERROR");
    assert.match(errorBody.error.message, /without a managed UMS block/i);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ums account/memory/route registry commands manage config and explain deterministic routing", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "ums-registry-"));
  const configFile = resolve(tempDir, "config.jsonc");
  const developerRoot = resolve(tempDir, "Developer");
  const engineRoot = resolve(developerRoot, "new-engine");
  try {
    await mkdir(engineRoot, { recursive: true });

    const init = await runUms(["config", "init", "--config-file", configFile]);
    assert.equal((init as any).code, 0, (init as any).stderr);

    const addAccount = await runUms([
      "account",
      "add",
      "--config-file",
      configFile,
      "--name",
      "company",
      "--type",
      "http",
      "--api-url",
      "https://ums.company.internal",
      "--auth-mode",
      "session-ref",
      "--credential-ref",
      "keychain://ums/company",
    ]);
    assert.equal((addAccount as any).code, 0, (addAccount as any).stderr);

    const addMemory = await runUms([
      "memory",
      "add",
      "--config-file",
      configFile,
      "--name",
      "company-new-engine",
      "--account",
      "company",
      "--store-id",
      "coding-agent",
      "--profile",
      "developer-main",
      "--project",
      "new-engine",
    ]);
    assert.equal((addMemory as any).code, 0, (addMemory as any).stderr);

    const addPersonalRoute = await runUms([
      "route",
      "add",
      "--config-file",
      configFile,
      "--path-prefix",
      developerRoot,
      "--memory",
      "personal",
    ]);
    assert.equal(
      (addPersonalRoute as any).code,
      0,
      (addPersonalRoute as any).stderr
    );

    const addCompanyRoute = await runUms([
      "route",
      "add",
      "--config-file",
      configFile,
      "--path-prefix",
      engineRoot,
      "--memory",
      "company-new-engine",
      "--priority",
      "25",
    ]);
    assert.equal(
      (addCompanyRoute as any).code,
      0,
      (addCompanyRoute as any).stderr
    );

    const accounts = await runUms([
      "account",
      "list",
      "--config-file",
      configFile,
    ]);
    assert.equal((accounts as any).code, 0, (accounts as any).stderr);
    const accountsBody = JSON.parse((accounts as any).stdout);
    assert.equal(accountsBody.data.accounts.length, 2);

    const memories = await runUms([
      "memory",
      "list",
      "--config-file",
      configFile,
    ]);
    assert.equal((memories as any).code, 0, (memories as any).stderr);
    const memoriesBody = JSON.parse((memories as any).stdout);
    assert.equal(
      memoriesBody.data.memories.some(
        (memory: { name: string }) => memory.name === "company-new-engine"
      ),
      true
    );

    const routeList = await runUms([
      "route",
      "list",
      "--config-file",
      configFile,
    ]);
    assert.equal((routeList as any).code, 0, (routeList as any).stderr);
    const routeListBody = JSON.parse((routeList as any).stdout);
    assert.equal(routeListBody.data.routes[0].memory, "company-new-engine");

    const explain = await runUms([
      "route",
      "explain",
      "--config-file",
      configFile,
      "--path",
      resolve(engineRoot, "src/index.ts"),
    ]);
    assert.equal((explain as any).code, 0, (explain as any).stderr);
    const explainBody = JSON.parse((explain as any).stdout);
    assert.equal(explainBody.data.operation, "route.explain");
    assert.equal(explainBody.data.status, "matched");
    assert.equal(explainBody.data.memory, "company-new-engine");
    assert.equal(explainBody.data.candidates.length >= 2, true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ums account secure login stores managed credentials outside config and doctor reports health", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "ums-account-login-"));
  const configFile = resolve(tempDir, "config.jsonc");
  const credentialStoreFile = resolve(tempDir, "credentials.json");
  const expiresAt = "2099-01-01T00:00:00.000Z";
  const env = {
    ...withPlaintextTestCredentialStoreEnv(credentialStoreFile),
    COMPANY_SECRET: "managed-session-token",
  };
  try {
    const init = await runUms(
      ["config", "init", "--config-file", configFile],
      "",
      {
        env,
      }
    );
    assert.equal((init as any).code, 0, (init as any).stderr);

    const addAccount = await runUms(
      [
        "account",
        "add",
        "--config-file",
        configFile,
        "--name",
        "company",
        "--type",
        "http",
        "--api-url",
        "https://ums.company.internal",
        "--auth-mode",
        "session-ref",
      ],
      "",
      {
        env,
      }
    );
    assert.equal((addAccount as any).code, 0, (addAccount as any).stderr);

    const accountsBeforeLogin = await runUms(
      ["account", "list", "--config-file", configFile],
      "",
      {
        env,
      }
    );
    assert.equal(
      (accountsBeforeLogin as any).code,
      0,
      (accountsBeforeLogin as any).stderr
    );
    const accountsBeforeLoginBody = JSON.parse(
      (accountsBeforeLogin as any).stdout
    );
    const companyBeforeLogin = accountsBeforeLoginBody.data.accounts.find(
      (account: any) => account.name === "company"
    );
    assert.equal(
      companyBeforeLogin.auth.credentialRef,
      "keychain://ums/company"
    );
    assert.deepEqual(companyBeforeLogin.credentialState, {
      status: "missing",
      storedAt: null,
      expiresAt: null,
    });

    const doctorBeforeLogin = await runUms(
      ["config", "doctor", "--config-file", configFile],
      "",
      {
        env,
      }
    );
    assert.equal(
      (doctorBeforeLogin as any).code,
      0,
      (doctorBeforeLogin as any).stderr
    );
    const doctorBeforeLoginBody = JSON.parse((doctorBeforeLogin as any).stdout);
    assert.equal(
      doctorBeforeLoginBody.data.warnings.some((warning: string) =>
        warning.includes("no secure credential stored yet")
      ),
      true
    );

    const login = await runUms(
      [
        "account",
        "login",
        "--config-file",
        configFile,
        "--name",
        "company",
        "--secret-env",
        "COMPANY_SECRET",
        "--expires-at",
        expiresAt,
      ],
      "",
      {
        env,
      }
    );
    assert.equal((login as any).code, 0, (login as any).stderr);
    const loginBody = JSON.parse((login as any).stdout);
    assert.equal(loginBody.data.operation, "account.login");
    assert.equal(loginBody.data.credentialRef, "keychain://ums/company");
    assert.equal(loginBody.data.expiresAt, expiresAt);

    const configContents = await readFile(configFile, "utf8");
    assert.doesNotMatch(configContents, /managed-session-token/);

    const accountsAfterLogin = await runUms(
      ["account", "list", "--config-file", configFile],
      "",
      {
        env,
      }
    );
    assert.equal(
      (accountsAfterLogin as any).code,
      0,
      (accountsAfterLogin as any).stderr
    );
    const accountsAfterLoginBody = JSON.parse(
      (accountsAfterLogin as any).stdout
    );
    const companyAfterLogin = accountsAfterLoginBody.data.accounts.find(
      (account: any) => account.name === "company"
    );
    assert.equal(companyAfterLogin.credentialState.status, "present");
    assert.equal(companyAfterLogin.credentialState.storedAt !== null, true);
    assert.equal(companyAfterLogin.credentialState.expiresAt, expiresAt);

    const logout = await runUms(
      ["account", "logout", "--config-file", configFile, "--name", "company"],
      "",
      {
        env,
      }
    );
    assert.equal((logout as any).code, 0, (logout as any).stderr);
    const logoutBody = JSON.parse((logout as any).stdout);
    assert.equal(logoutBody.data.cleared, true);

    const accountsAfterLogout = await runUms(
      ["account", "list", "--config-file", configFile],
      "",
      {
        env,
      }
    );
    assert.equal(
      (accountsAfterLogout as any).code,
      0,
      (accountsAfterLogout as any).stderr
    );
    const accountsAfterLogoutBody = JSON.parse(
      (accountsAfterLogout as any).stdout
    );
    const companyAfterLogout = accountsAfterLogoutBody.data.accounts.find(
      (account: any) => account.name === "company"
    );
    assert.deepEqual(companyAfterLogout.credentialState, {
      status: "missing",
      storedAt: null,
      expiresAt: null,
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ums account login surfaces typed secure-store failures", async () => {
  const tempDir = await mkdtemp(
    resolve(tmpdir(), "ums-account-login-failure-")
  );
  const configFile = resolve(tempDir, "config.jsonc");
  const env = {
    ...withPlaintextTestCredentialStoreEnv(tempDir),
    COMPANY_SECRET: "managed-session-token",
  };
  try {
    const init = await runUms(
      ["config", "init", "--config-file", configFile],
      "",
      {
        env,
      }
    );
    assert.equal((init as any).code, 0, (init as any).stderr);

    const addAccount = await runUms(
      [
        "account",
        "add",
        "--config-file",
        configFile,
        "--name",
        "company",
        "--type",
        "http",
        "--api-url",
        "https://ums.company.internal",
        "--auth-mode",
        "session-ref",
      ],
      "",
      { env }
    );
    assert.equal((addAccount as any).code, 0, (addAccount as any).stderr);

    const login = await runUms(
      [
        "account",
        "login",
        "--config-file",
        configFile,
        "--name",
        "company",
        "--secret-env",
        "COMPANY_SECRET",
      ],
      "",
      { env }
    );
    assert.equal((login as any).code, 1);
    const loginBody = JSON.parse((login as any).stderr);
    assert.equal(loginBody.ok, false);
    assert.equal(loginBody.error.code, "DAEMON_CREDENTIAL_STORE_ERROR");
    assert.match(loginBody.error.message, /Failed to .*credential/i);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ums memory management commands expose search/provenance/audit/anomaly flows plus corrective controls", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "ums-memory-ops-"));
  const stateRoot = resolve(tempDir, "state");
  const configFile = resolve(tempDir, "config.jsonc");
  const runtimeStateFile = resolve(stateRoot, "runtime-state.json");

  try {
    await writeLocalMemoryDaemonConfig({
      configFile,
      stateRoot,
    });

    const ingest = await runCli([
      "ingest",
      "--state-file",
      runtimeStateFile,
      "--store-id",
      "personal",
      "--input",
      JSON.stringify({
        profile: "main",
        events: [
          {
            type: "note",
            source: "cli",
            content:
              "Use bounded memory commands for deterministic operator flows.",
          },
        ],
      }),
    ]);
    assert.equal((ingest as any).code, 0, (ingest as any).stderr);

    const initialFeedback = await runCli([
      "feedback",
      "--state-file",
      runtimeStateFile,
      "--store-id",
      "personal",
      "--input",
      JSON.stringify({
        profile: "main",
        signal: "helpful",
        actor: "seed-reviewer",
        targetRuleId: "rule-seed-1",
        note: "Seeded helpful feedback for provenance.",
      }),
    ]);
    assert.equal(
      (initialFeedback as any).code,
      0,
      (initialFeedback as any).stderr
    );
    const initialFeedbackBody = JSON.parse((initialFeedback as any).stdout);

    const failedOutcome = await runCli([
      "outcome",
      "--state-file",
      runtimeStateFile,
      "--store-id",
      "personal",
      "--input",
      JSON.stringify({
        profile: "main",
        task: "memory-anomaly-check",
        outcome: "failure",
        usedRuleIds: ["rule-seed-1"],
      }),
    ]);
    assert.equal((failedOutcome as any).code, 0, (failedOutcome as any).stderr);

    const search = await runUms([
      "memory",
      "search",
      "--config-file",
      configFile,
      "--memory",
      "personal",
      "--query",
      "Seeded helpful feedback",
      "--format",
      "json",
    ]);
    assert.equal((search as any).code, 0, (search as any).stderr);
    const searchBody = JSON.parse((search as any).stdout);
    assert.equal(searchBody.ok, true);
    assert.equal(searchBody.data.operation, "memory.search");
    assert.equal(searchBody.data.response.totalMatches >= 1, true);

    const timeline = await runUms([
      "memory",
      "timeline",
      "--config-file",
      configFile,
      "--memory",
      "personal",
      "--limit",
      "10",
      "--format",
      "json",
    ]);
    assert.equal((timeline as any).code, 0, (timeline as any).stderr);
    const timelineBody = JSON.parse((timeline as any).stdout);
    assert.equal(timelineBody.ok, true);
    assert.equal(timelineBody.data.operation, "memory.timeline");
    assert.equal(timelineBody.data.response.totalEvents >= 2, true);

    const provenance = await runUms([
      "memory",
      "provenance",
      "--config-file",
      configFile,
      "--memory",
      "personal",
      "--entity-ref",
      `feedback:${initialFeedbackBody.data.feedbackId}`,
      "--format",
      "json",
    ]);
    assert.equal((provenance as any).code, 0, (provenance as any).stderr);
    const provenanceBody = JSON.parse((provenance as any).stdout);
    assert.equal(provenanceBody.ok, true);
    assert.equal(provenanceBody.data.operation, "memory.provenance");
    assert.equal(provenanceBody.data.response.resolution.resolved, 1);

    const textSearch = await runUms([
      "memory",
      "search",
      "--config-file",
      configFile,
      "--memory",
      "personal",
      "--query",
      "Seeded helpful feedback",
      "--format",
      "text",
    ]);
    assert.equal((textSearch as any).code, 0, (textSearch as any).stderr);
    assert.match((textSearch as any).stdout, /Memory search for 'personal'/);

    const harmfulFeedback = await runUms([
      "memory",
      "feedback",
      "--config-file",
      configFile,
      "--memory",
      "personal",
      "--signal",
      "harmful",
      "--actor",
      "operator-1",
      "--target-rule-id",
      "rule-seed-1",
      "--note",
      "Unsafe memory output.",
      "--format",
      "json",
    ]);
    assert.equal(
      (harmfulFeedback as any).code,
      0,
      (harmfulFeedback as any).stderr
    );
    const harmfulFeedbackBody = JSON.parse((harmfulFeedback as any).stdout);
    assert.equal(harmfulFeedbackBody.ok, true);
    assert.equal(harmfulFeedbackBody.data.operation, "memory.feedback");
    assert.equal(harmfulFeedbackBody.data.response.signal, "harmful");

    const quarantineGuard = await runUms([
      "memory",
      "quarantine",
      "--config-file",
      configFile,
      "--memory",
      "personal",
      "--actor",
      "operator-1",
      "--reason",
      "Escalated unsafe memory.",
      "--target-rule-id",
      "rule-seed-1",
    ]);
    assert.equal((quarantineGuard as any).code, 1);
    const quarantineGuardBody = JSON.parse((quarantineGuard as any).stderr);
    assert.match(quarantineGuardBody.error.message, /requires --confirm/i);

    const quarantine = await runUms([
      "memory",
      "quarantine",
      "--config-file",
      configFile,
      "--memory",
      "personal",
      "--actor",
      "operator-1",
      "--reason",
      "Escalated unsafe memory.",
      "--target-rule-id",
      "rule-seed-1",
      "--reason-code",
      "unsafe_output",
      "--confirm",
      "--format",
      "json",
    ]);
    assert.equal((quarantine as any).code, 0, (quarantine as any).stderr);
    const quarantineBody = JSON.parse((quarantine as any).stdout);
    assert.equal(quarantineBody.ok, true);
    assert.equal(quarantineBody.data.operation, "memory.quarantine");
    assert.equal(quarantineBody.data.response.override.action, "suppress");

    const forget = await runUms([
      "memory",
      "forget",
      "--config-file",
      configFile,
      "--memory",
      "personal",
      "--actor",
      "operator-1",
      "--reason",
      "User requested suppression.",
      "--target-candidate-id",
      "candidate-seed-2",
      "--confirm",
      "--format",
      "json",
    ]);
    assert.equal((forget as any).code, 0, (forget as any).stderr);
    const forgetBody = JSON.parse((forget as any).stdout);
    assert.equal(forgetBody.ok, true);
    assert.equal(forgetBody.data.operation, "memory.forget");
    assert.equal(forgetBody.data.response.override.action, "suppress");

    const pin = await runUms([
      "memory",
      "pin",
      "--config-file",
      configFile,
      "--memory",
      "personal",
      "--actor",
      "operator-1",
      "--reason",
      "Pin reviewed safe memory.",
      "--target-rule-id",
      "rule-seed-1",
      "--confirm",
      "--format",
      "json",
    ]);
    assert.equal((pin as any).code, 0, (pin as any).stderr);
    const pinBody = JSON.parse((pin as any).stdout);
    assert.equal(pinBody.ok, true);
    assert.equal(pinBody.data.operation, "memory.pin");
    assert.equal(pinBody.data.response.override.action, "promote");

    const policyAudit = await runUms([
      "memory",
      "policy-audit",
      "--config-file",
      configFile,
      "--memory",
      "personal",
      "--format",
      "json",
    ]);
    assert.equal((policyAudit as any).code, 0, (policyAudit as any).stderr);
    const policyAuditBody = JSON.parse((policyAudit as any).stdout);
    assert.equal(policyAuditBody.ok, true);
    assert.equal(policyAuditBody.data.operation, "memory.policy-audit");
    assert.equal(
      policyAuditBody.data.response.totalAuditTrailEvents >= 3,
      true
    );

    const anomalies = await runUms([
      "memory",
      "anomalies",
      "--config-file",
      configFile,
      "--memory",
      "personal",
      "--window-hours",
      "24",
      "--format",
      "json",
    ]);
    assert.equal((anomalies as any).code, 0, (anomalies as any).stderr);
    const anomaliesBody = JSON.parse((anomalies as any).stdout);
    assert.equal(anomaliesBody.ok, true);
    assert.equal(anomaliesBody.data.operation, "memory.anomalies");
    assert.equal(
      anomaliesBody.data.response.signals.harmfulSignalSpike.observationCount >=
        1,
      true
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ums memory commands accept JSON request bodies from --file and stdin", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "ums-memory-ops-input-"));
  const stateRoot = resolve(tempDir, "state");
  const configFile = resolve(tempDir, "config.jsonc");
  const searchFile = resolve(tempDir, "search-request.json");

  try {
    await writeLocalMemoryDaemonConfig({
      configFile,
      stateRoot,
    });

    const ingest = await runCli([
      "ingest",
      "--state-file",
      resolve(stateRoot, "runtime-state.json"),
      "--store-id",
      "personal",
      "--input",
      JSON.stringify({
        profile: "main",
        events: [
          {
            type: "note",
            source: "cli",
            content: "bounded operator flow request alpha",
          },
          {
            type: "note",
            source: "cli",
            content: "bounded operator flow request beta",
          },
        ],
      }),
    ]);
    assert.equal((ingest as any).code, 0, (ingest as any).stderr);

    const feedback = await runCli([
      "feedback",
      "--state-file",
      resolve(stateRoot, "runtime-state.json"),
      "--store-id",
      "personal",
      "--input",
      JSON.stringify({
        profile: "main",
        signal: "helpful",
        actor: "operator-stdin",
        targetRuleId: "rule-seed-stdin",
        note: "stdin limit coverage",
      }),
    ]);
    assert.equal((feedback as any).code, 0, (feedback as any).stderr);

    await writeFile(searchFile, '{ "limit": 1 }\n', "utf8");

    const timelineFromFile = await runUms([
      "memory",
      "timeline",
      "--config-file",
      configFile,
      "--memory",
      "personal",
      "--file",
      searchFile,
      "--format",
      "json",
    ]);
    assert.equal(
      (timelineFromFile as any).code,
      0,
      (timelineFromFile as any).stderr
    );
    const timelineFromFileBody = JSON.parse((timelineFromFile as any).stdout);
    assert.equal(timelineFromFileBody.data.response.totalEvents >= 2, true);
    assert.equal(timelineFromFileBody.data.response.events.length, 1);

    const timelineFromStdin = await runUms(
      [
        "memory",
        "timeline",
        "--config-file",
        configFile,
        "--memory",
        "personal",
        "--format",
        "json",
      ],
      '{ "limit": 2 }\n'
    );
    assert.equal(
      (timelineFromStdin as any).code,
      0,
      (timelineFromStdin as any).stderr
    );
    const timelineFromStdinBody = JSON.parse((timelineFromStdin as any).stdout);
    assert.equal(timelineFromStdinBody.data.response.totalEvents >= 2, true);
    assert.equal(timelineFromStdinBody.data.response.events.length, 2);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ums memory commands keep managed and solo surfaces aligned while preserving local read-only guards", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "ums-memory-ops-guard-"));
  const stateRoot = resolve(tempDir, "state");
  const configFile = resolve(tempDir, "config.jsonc");
  const credentialStoreFile = resolve(tempDir, "credentials.json");
  const managedRequests: Array<{
    readonly path: string | undefined;
    readonly authorization: string | undefined;
    readonly store: string | undefined;
    readonly profile: unknown;
  }> = [];
  const managedServer = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    request.on("end", () => {
      const operationBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      managedRequests.push({
        path: request.url ?? undefined,
        authorization:
          typeof request.headers.authorization === "string"
            ? request.headers.authorization
            : undefined,
        store:
          typeof request.headers["x-ums-store"] === "string"
            ? request.headers["x-ums-store"]
            : undefined,
        profile: operationBody.profile,
      });
      if (request.method !== "POST") {
        response.writeHead(405).end();
        return;
      }
      if (request.url === "/v1/memory_console_search") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            ok: true,
            data: {
              query: operationBody.query ?? null,
              totalMatches: 1,
              results: [
                {
                  entityType: "rule",
                  entityId: "rule-seed-1",
                  timestamp: "2026-03-07T00:00:00.000Z",
                  summary: "Managed memory rule",
                },
              ],
            },
          })
        );
        return;
      }
      if (request.url === "/v1/manual_override_control") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            ok: true,
            data: {
              action: "created",
              override: {
                action: operationBody.overrideAction ?? "promote",
                changed: true,
                targetRuleIds: operationBody.targetRuleIds ?? [],
                targetCandidateIds: operationBody.targetCandidateIds ?? [],
              },
            },
          })
        );
        return;
      }
      response.writeHead(404).end();
    });
  });

  try {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      managedServer.once("error", rejectPromise);
      managedServer.listen(0, "127.0.0.1", () => {
        resolvePromise();
      });
    });
    const managedAddress = managedServer.address();
    assert.notEqual(managedAddress, null);
    assert.equal(typeof managedAddress === "object", true);
    const managedPort =
      managedAddress !== null && typeof managedAddress === "object"
        ? managedAddress.port
        : null;
    assert.notEqual(managedPort, null);
    const env = {
      ...withPlaintextTestCredentialStoreEnv(credentialStoreFile),
    };

    await writeLocalMemoryDaemonConfig({
      configFile,
      stateRoot,
      accounts: {
        local: { type: "local" },
        company: {
          type: "http",
          apiBaseUrl: `http://127.0.0.1:${managedPort}`,
          auth: {
            mode: "session-ref",
            credentialRef: "keychain://ums/company",
          },
        },
      },
      memories: {
        personal: {
          account: "local",
          storeId: "personal",
          profile: "main",
          readOnly: true,
        },
        company: {
          account: "company",
          storeId: "coding-agent",
          profile: "developer-main",
        },
      },
    });

    const readOnly = await runUms(
      [
        "memory",
        "feedback",
        "--config-file",
        configFile,
        "--memory",
        "personal",
        "--signal",
        "helpful",
        "--actor",
        "operator-1",
        "--target-rule-id",
        "rule-seed-1",
      ],
      "",
      { env }
    );
    assert.equal((readOnly as any).code, 1);
    const readOnlyBody = JSON.parse((readOnly as any).stderr);
    assert.match(readOnlyBody.error.message, /read-only/i);

    const readOnlyForget = await runUms(
      [
        "memory",
        "forget",
        "--config-file",
        configFile,
        "--memory",
        "personal",
        "--actor",
        "operator-1",
        "--reason",
        "Suppress read-only memory.",
        "--target-rule-id",
        "rule-seed-1",
        "--confirm",
      ],
      "",
      { env }
    );
    assert.equal((readOnlyForget as any).code, 1);
    const readOnlyForgetBody = JSON.parse((readOnlyForget as any).stderr);
    assert.match(readOnlyForgetBody.error.message, /read-only/i);

    const remote = await runUms(
      [
        "memory",
        "search",
        "--config-file",
        configFile,
        "--memory",
        "company",
        "--query",
        "anything",
        "--format",
        "json",
      ],
      "",
      { env }
    );
    assert.equal((remote as any).code, 1);
    const remoteBody = JSON.parse((remote as any).stderr);
    assert.match(remoteBody.error.message, /no secure credential stored/i);

    const login = await runUms(
      [
        "account",
        "login",
        "--config-file",
        configFile,
        "--name",
        "company",
        "--secret-stdin",
      ],
      "managed-memory-token\n",
      { env }
    );
    assert.equal((login as any).code, 0, (login as any).stderr);

    const remoteSearch = await runUms(
      [
        "memory",
        "search",
        "--config-file",
        configFile,
        "--memory",
        "company",
        "--query",
        "anything",
        "--format",
        "json",
      ],
      "",
      { env }
    );
    assert.equal((remoteSearch as any).code, 0, (remoteSearch as any).stderr);
    const remoteSearchBody = JSON.parse((remoteSearch as any).stdout);
    assert.equal(remoteSearchBody.data.response.totalMatches, 1);

    const remotePin = await runUms(
      [
        "memory",
        "pin",
        "--config-file",
        configFile,
        "--memory",
        "company",
        "--actor",
        "operator-1",
        "--reason",
        "Promote managed rule.",
        "--target-rule-id",
        "rule-seed-1",
        "--confirm",
        "--format",
        "json",
      ],
      "",
      { env }
    );
    assert.equal((remotePin as any).code, 0, (remotePin as any).stderr);
    const remotePinBody = JSON.parse((remotePin as any).stdout);
    assert.equal(remotePinBody.data.response.action, "created");
    assert.deepEqual(
      managedRequests.map((entry) => entry.path),
      ["/v1/memory_console_search", "/v1/manual_override_control"]
    );
    assert.deepEqual(
      managedRequests.map((entry) => entry.authorization),
      ["Bearer managed-memory-token", "Bearer managed-memory-token"]
    );
    assert.deepEqual(
      managedRequests.map((entry) => entry.store),
      ["coding-agent", "coding-agent"]
    );
    assert.deepEqual(
      managedRequests.map((entry) => entry.profile),
      ["developer-main", "developer-main"]
    );
  } finally {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      managedServer.close((error) => {
        if (error) {
          rejectPromise(error);
          return;
        }
        resolvePromise();
      });
    });
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ums memory commands propagate backend validation failures", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "ums-memory-ops-error-"));
  const stateRoot = resolve(tempDir, "state");
  const configFile = resolve(tempDir, "config.jsonc");

  try {
    await writeLocalMemoryDaemonConfig({
      configFile,
      stateRoot,
    });

    const invalidTimeline = await runUms([
      "memory",
      "timeline",
      "--config-file",
      configFile,
      "--memory",
      "personal",
      "--since",
      "not-an-iso-timestamp",
      "--format",
      "json",
    ]);
    assert.equal((invalidTimeline as any).code, 1);
    const errorBody = JSON.parse((invalidTimeline as any).stderr);
    assert.equal(errorBody.ok, false);
    assert.equal(errorBody.error.code, "UMS_RUNTIME_ERROR");
    assert.match(errorBody.error.message, /memory_console_timeline\.since/i);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ums memory search requires query and override commands require confirm", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "ums-memory-ops-contract-"));
  const stateRoot = resolve(tempDir, "state");
  const configFile = resolve(tempDir, "config.jsonc");

  try {
    await writeLocalMemoryDaemonConfig({
      configFile,
      stateRoot,
    });

    const missingQuery = await runUms([
      "memory",
      "search",
      "--config-file",
      configFile,
      "--memory",
      "personal",
    ]);
    assert.equal((missingQuery as any).code, 1);
    const missingQueryBody = JSON.parse((missingQuery as any).stderr);
    assert.match(missingQueryBody.error.message, /requires --query/i);

    const forgetGuard = await runUms([
      "memory",
      "forget",
      "--config-file",
      configFile,
      "--memory",
      "personal",
      "--actor",
      "operator-1",
      "--reason",
      "Suppress candidate.",
      "--target-candidate-id",
      "candidate-seed-2",
    ]);
    assert.equal((forgetGuard as any).code, 1);
    const forgetGuardBody = JSON.parse((forgetGuard as any).stderr);
    assert.match(forgetGuardBody.error.message, /requires --confirm/i);

    const pinGuard = await runUms([
      "memory",
      "pin",
      "--config-file",
      configFile,
      "--memory",
      "personal",
      "--actor",
      "operator-1",
      "--reason",
      "Promote rule.",
      "--target-rule-id",
      "rule-seed-1",
    ]);
    assert.equal((pinGuard as any).code, 1);
    const pinGuardBody = JSON.parse((pinGuard as any).stderr);
    assert.match(pinGuardBody.error.message, /requires --confirm/i);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ums source onboarding discovers consented bindings and drives sync without manual roots", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "ums-source-onboarding-"));
  const homeDir = resolve(tempDir, "home");
  const codexDir = resolve(homeDir, ".codex", "sessions");
  const codexNativeDir = resolve(homeDir, ".codex-native", "history");
  const vscodeDir = resolve(
    homeDir,
    "Library",
    "Application Support",
    "Code",
    "User",
    "globalStorage",
    "github.copilot-chat"
  );
  const repoRoot = resolve(tempDir, "repo");
  const stateRoot = resolve(tempDir, "daemon-state");
  const configFile = resolve(tempDir, "config.jsonc");
  const codexSessionFile = resolve(codexDir, "session.jsonl");
  const env = {
    ...process.env,
    HOME: homeDir,
    UMS_DISCOVERY_CODEX_ROOTS: codexDir,
    UMS_DISCOVERY_CODEX_NATIVE_ROOTS: codexNativeDir,
    UMS_DISCOVERY_VSCODE_ROOTS: vscodeDir,
  };

  try {
    await mkdir(codexDir, { recursive: true });
    await mkdir(codexNativeDir, { recursive: true });
    await mkdir(vscodeDir, { recursive: true });
    await mkdir(repoRoot, { recursive: true });
    await writeFile(
      resolve(repoRoot, "PLAN.md"),
      "# Plan\nShip daemon-first source onboarding.\n",
      "utf8"
    );
    await writeFile(
      resolve(repoRoot, "AGENTS.md"),
      "# Notes\nUse UMS onboarding.\n",
      "utf8"
    );
    const initialCodexSession = `${JSON.stringify({
      type: "session_meta",
      payload: {
        id: "source-onboarding-session",
        cwd: repoRoot,
      },
    })}\n${JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: "Source onboarding should find this Codex history.",
      },
    })}\n`;
    await writeFile(codexSessionFile, initialCodexSession, "utf8");

    await writeDaemonConfig(configFile, {
      version: 1,
      state: {
        rootDir: stateRoot,
        journalDir: resolve(stateRoot, "journal"),
        checkpointDir: resolve(stateRoot, "checkpoints"),
      },
      accounts: {
        local: { type: "local" },
      },
      memories: {
        personal: {
          account: "local",
          storeId: "personal",
          profile: "main",
        },
      },
      sources: {
        defaults: {
          scanIntervalMs: 60_000,
          maxEventsPerCycle: 400,
        },
      },
      routes: [
        {
          match: {
            pathPrefix: repoRoot,
            source: "codex",
          },
          memory: "personal",
          priority: 20,
        },
        {
          match: {
            pathPrefix: repoRoot,
            source: "plan",
          },
          memory: "personal",
          priority: 10,
        },
      ],
      defaults: {
        memory: "personal",
        onAmbiguous: "default",
      },
    });

    const discover = await runUms(
      [
        "source",
        "discover",
        "--config-file",
        configFile,
        "--workspace-root",
        repoRoot,
      ],
      "",
      { env }
    );
    assert.equal((discover as any).code, 0, (discover as any).stderr);
    const discoverBody = JSON.parse((discover as any).stdout);
    assert.equal(discoverBody.ok, true);
    assert.equal(discoverBody.data.operation, "source.discover");
    const detectedSources = new Set(
      discoverBody.data.candidates.map(
        (candidate: { source: string }) => candidate.source
      )
    );
    assert.equal(detectedSources.has("codex"), true);
    assert.equal(detectedSources.has("codex-native"), true);
    assert.equal(detectedSources.has("vscode"), true);
    assert.equal(detectedSources.has("plan"), true);
    const codexCandidate = discoverBody.data.candidates.find(
      (candidate: { source: string }) => candidate.source === "codex"
    );
    assert.equal(codexCandidate?.proposedStatus, "approved");
    const vscodeCandidate = discoverBody.data.candidates.find(
      (candidate: { source: string }) => candidate.source === "vscode"
    );
    assert.equal(vscodeCandidate?.proposedStatus, "pending");

    const discoverCodexOnly = await runUms(
      [
        "source",
        "discover",
        "--config-file",
        configFile,
        "--workspace-root",
        repoRoot,
        "--source",
        "codex",
      ],
      "",
      { env }
    );
    assert.equal(
      (discoverCodexOnly as any).code,
      0,
      (discoverCodexOnly as any).stderr
    );
    const discoverCodexOnlyBody = JSON.parse((discoverCodexOnly as any).stdout);
    assert.equal(discoverCodexOnlyBody.ok, true);
    assert.deepEqual(
      discoverCodexOnlyBody.data.candidates.map(
        (candidate: { source: string }) => candidate.source
      ),
      ["codex"]
    );

    const onboard = await runUms(
      [
        "source",
        "onboard",
        "--config-file",
        configFile,
        "--workspace-root",
        repoRoot,
      ],
      "",
      { env }
    );
    assert.equal((onboard as any).code, 0, (onboard as any).stderr);
    const onboardBody = JSON.parse((onboard as any).stdout);
    assert.equal(onboardBody.ok, true);
    assert.equal(onboardBody.data.operation, "source.onboard");
    assert.equal(onboardBody.data.summary.approved >= 2, true);
    assert.equal(onboardBody.data.summary.pending >= 1, true);

    const writtenConfig = JSON.parse(await readFile(configFile, "utf8"));
    assert.equal(writtenConfig.sources.codex?.roots?.length ?? 0, 0);
    assert.equal(Array.isArray(writtenConfig.sources.bindings), true);
    const codexBinding = writtenConfig.sources.bindings.find(
      (binding: { source: string }) => binding.source === "codex"
    );
    assert.ok(codexBinding);
    assert.equal(codexBinding?.status, "approved");
    const vscodeBinding = writtenConfig.sources.bindings.find(
      (binding: { source: string }) => binding.source === "vscode"
    );
    assert.ok(vscodeBinding);
    assert.equal(vscodeBinding?.status, "pending");

    const sync = await runUms(["sync", "--config-file", configFile], "", {
      env,
    });
    assert.equal((sync as any).code, 0, (sync as any).stderr);
    const syncBody = JSON.parse((sync as any).stdout);
    assert.equal(syncBody.ok, true);
    assert.equal(
      syncBody.data.sourceStats.some(
        (entry: { source: string; eventsPrepared: number }) =>
          entry.source === "codex" && entry.eventsPrepared > 0
      ),
      true
    );
    assert.equal(
      syncBody.data.sourceStats.some(
        (entry: { source: string; eventsPrepared: number }) =>
          entry.source === "plan" && entry.eventsPrepared > 0
      ),
      true
    );

    const inspect = await runUms(
      [
        "source",
        "inspect",
        "--config-file",
        configFile,
        "--id",
        codexBinding.id,
      ],
      "",
      { env }
    );
    assert.equal((inspect as any).code, 0, (inspect as any).stderr);
    const inspectBody = JSON.parse((inspect as any).stdout);
    assert.equal(inspectBody.ok, true);
    assert.equal(inspectBody.data.operation, "source.inspect");
    assert.equal(inspectBody.data.binding.activeForSync, true);
    assert.equal(inspectBody.data.binding.checkpointCount >= 1, true);

    const listCodexOnly = await runUms(
      ["source", "list", "--config-file", configFile, "--source", "codex"],
      "",
      { env }
    );
    assert.equal((listCodexOnly as any).code, 0, (listCodexOnly as any).stderr);
    const listCodexOnlyBody = JSON.parse((listCodexOnly as any).stdout);
    assert.equal(listCodexOnlyBody.ok, true);
    assert.equal(listCodexOnlyBody.data.bindings.length, 1);
    assert.equal(listCodexOnlyBody.data.bindings[0]?.source, "codex");

    const disable = await runUms(
      [
        "source",
        "disable",
        "--config-file",
        configFile,
        "--id",
        codexBinding.id,
      ],
      "",
      { env }
    );
    assert.equal((disable as any).code, 0, (disable as any).stderr);
    const disableBody = JSON.parse((disable as any).stdout);
    assert.equal(disableBody.ok, true);
    assert.equal(disableBody.data.operation, "source.disable");
    assert.equal(disableBody.data.binding.status, "disabled");
    assert.equal(disableBody.data.binding.activeForSync, false);

    await writeFile(
      codexSessionFile,
      `${initialCodexSession}${JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: "Disabled bindings must stop new Codex ingestion.",
        },
      })}\n`,
      "utf8"
    );

    const syncAfterDisable = await runUms(
      ["sync", "--config-file", configFile],
      "",
      { env }
    );
    assert.equal(
      (syncAfterDisable as any).code,
      0,
      (syncAfterDisable as any).stderr
    );
    const syncAfterDisableBody = JSON.parse((syncAfterDisable as any).stdout);
    assert.equal(
      syncAfterDisableBody.data.sourceStats.find(
        (entry: { source: string }) => entry.source === "codex"
      )?.eventsPrepared ?? 0,
      0
    );

    const approve = await runUms(
      [
        "source",
        "approve",
        "--config-file",
        configFile,
        "--id",
        codexBinding.id,
      ],
      "",
      { env }
    );
    assert.equal((approve as any).code, 0, (approve as any).stderr);
    const approveBody = JSON.parse((approve as any).stdout);
    assert.equal(approveBody.ok, true);
    assert.equal(approveBody.data.operation, "source.approve");
    assert.equal(approveBody.data.binding.status, "approved");
    assert.equal(approveBody.data.binding.activeForSync, true);

    await writeFile(
      codexSessionFile,
      `${initialCodexSession}${JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: "Approved bindings must resume new Codex ingestion.",
        },
      })}\n`,
      "utf8"
    );

    const syncAfterApprove = await runUms(
      ["sync", "--config-file", configFile],
      "",
      { env }
    );
    assert.equal(
      (syncAfterApprove as any).code,
      0,
      (syncAfterApprove as any).stderr
    );
    const syncAfterApproveBody = JSON.parse((syncAfterApprove as any).stdout);
    assert.equal(
      syncAfterApproveBody.data.sourceStats.some(
        (entry: { source: string }) => entry.source === "codex"
      ),
      true
    );

    const ignore = await runUms(
      [
        "source",
        "ignore",
        "--config-file",
        configFile,
        "--id",
        vscodeBinding.id,
      ],
      "",
      { env }
    );
    assert.equal((ignore as any).code, 0, (ignore as any).stderr);
    const ignoreBody = JSON.parse((ignore as any).stdout);
    assert.equal(ignoreBody.ok, true);
    assert.equal(ignoreBody.data.operation, "source.ignore");
    assert.equal(ignoreBody.data.binding.status, "ignored");

    const list = await runUms(
      ["source", "list", "--config-file", configFile],
      "",
      {
        env,
      }
    );
    assert.equal((list as any).code, 0, (list as any).stderr);
    const listBody = JSON.parse((list as any).stdout);
    const listedCodex = listBody.data.bindings.find(
      (binding: { id: string }) => binding.id === codexBinding.id
    );
    const listedVsCode = listBody.data.bindings.find(
      (binding: { id: string }) => binding.id === vscodeBinding.id
    );
    assert.equal(listedCodex?.status, "approved");
    assert.equal(listedVsCode?.status, "ignored");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}, 15_000);

test("ums route explain respects review fallback and remove commands block referenced entities", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "ums-registry-guard-"));
  const configFile = resolve(tempDir, "config.jsonc");
  const projectRoot = resolve(tempDir, "project");
  try {
    await mkdir(projectRoot, { recursive: true });

    const init = await runUms(["config", "init", "--config-file", configFile]);
    assert.equal((init as any).code, 0, (init as any).stderr);

    const addAccount = await runUms([
      "account",
      "add",
      "--config-file",
      configFile,
      "--name",
      "company",
      "--type",
      "http",
      "--api-url",
      "https://ums.company.internal",
      "--auth-mode",
      "session-ref",
      "--credential-ref",
      "keychain://ums/company",
    ]);
    assert.equal((addAccount as any).code, 0, (addAccount as any).stderr);

    const addMemory = await runUms([
      "memory",
      "add",
      "--config-file",
      configFile,
      "--name",
      "company-project",
      "--account",
      "company",
      "--store-id",
      "coding-agent",
      "--profile",
      "developer-main",
    ]);
    assert.equal((addMemory as any).code, 0, (addMemory as any).stderr);

    const addRoute = await runUms([
      "route",
      "add",
      "--config-file",
      configFile,
      "--path-prefix",
      projectRoot,
      "--memory",
      "company-project",
    ]);
    assert.equal((addRoute as any).code, 0, (addRoute as any).stderr);

    const unmatched = await runUms([
      "route",
      "explain",
      "--config-file",
      configFile,
      "--path",
      resolve(tempDir, "somewhere-else/file.ts"),
    ]);
    assert.equal((unmatched as any).code, 0, (unmatched as any).stderr);
    const unmatchedBody = JSON.parse((unmatched as any).stdout);
    assert.equal(unmatchedBody.data.status, "review");
    assert.equal(unmatchedBody.data.memory, null);

    const setDefault = await runUms([
      "route",
      "set-default",
      "--config-file",
      configFile,
      "--memory",
      "personal",
      "--on-ambiguous",
      "default",
    ]);
    assert.equal((setDefault as any).code, 0, (setDefault as any).stderr);

    const showDefault = await runUms([
      "route",
      "show-default",
      "--config-file",
      configFile,
    ]);
    assert.equal((showDefault as any).code, 0, (showDefault as any).stderr);
    const showDefaultBody = JSON.parse((showDefault as any).stdout);
    assert.equal(showDefaultBody.data.defaults.memory, "personal");
    assert.equal(showDefaultBody.data.defaults.onAmbiguous, "default");

    const defaulted = await runUms([
      "route",
      "explain",
      "--config-file",
      configFile,
      "--path",
      resolve(tempDir, "another-place/file.ts"),
    ]);
    assert.equal((defaulted as any).code, 0, (defaulted as any).stderr);
    const defaultedBody = JSON.parse((defaulted as any).stdout);
    assert.equal(defaultedBody.data.status, "default");
    assert.equal(defaultedBody.data.memory, "personal");

    const dropDefault = await runUms([
      "route",
      "set-default",
      "--config-file",
      configFile,
      "--memory",
      "personal",
      "--on-ambiguous",
      "drop",
    ]);
    assert.equal((dropDefault as any).code, 0, (dropDefault as any).stderr);

    const dropped = await runUms([
      "route",
      "explain",
      "--config-file",
      configFile,
      "--path",
      resolve(tempDir, "dropped/file.ts"),
    ]);
    assert.equal((dropped as any).code, 0, (dropped as any).stderr);
    const droppedBody = JSON.parse((dropped as any).stdout);
    assert.equal(droppedBody.data.status, "drop");
    assert.equal(droppedBody.data.memory, null);

    const removeMemory = await runUms([
      "memory",
      "remove",
      "--config-file",
      configFile,
      "--name",
      "company-project",
    ]);
    assert.equal((removeMemory as any).code, 1);
    const removeMemoryError = JSON.parse((removeMemory as any).stderr);
    assert.match(removeMemoryError.error.message, /routes still reference it/i);

    const removeAccount = await runUms([
      "account",
      "remove",
      "--config-file",
      configFile,
      "--name",
      "company",
    ]);
    assert.equal((removeAccount as any).code, 1);
    const removeAccountError = JSON.parse((removeAccount as any).stderr);
    assert.match(
      removeAccountError.error.message,
      /memories still reference it/i
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}, 15_000);

test("ums route add reports the inserted route index when overlapping metadata already exists", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "ums-route-add-index-"));
  const configFile = resolve(tempDir, "config.jsonc");
  const developerRoot = resolve(tempDir, "Developer");
  const projectOne = resolve(developerRoot, "project-one");
  const projectTwo = resolve(developerRoot, "project-two");

  try {
    await mkdir(projectOne, { recursive: true });
    await mkdir(projectTwo, { recursive: true });

    const init = await runUms(["config", "init", "--config-file", configFile]);
    assert.equal((init as any).code, 0, (init as any).stderr);

    const firstRoute = await runUms([
      "route",
      "add",
      "--config-file",
      configFile,
      "--path-prefix",
      projectOne,
      "--memory",
      "personal",
    ]);
    assert.equal((firstRoute as any).code, 0, (firstRoute as any).stderr);
    const firstRouteBody = JSON.parse((firstRoute as any).stdout);

    const secondRoute = await runUms([
      "route",
      "add",
      "--config-file",
      configFile,
      "--path-prefix",
      projectTwo,
      "--memory",
      "personal",
    ]);
    assert.equal((secondRoute as any).code, 0, (secondRoute as any).stderr);
    const secondRouteBody = JSON.parse((secondRoute as any).stdout);

    assert.notEqual(
      secondRouteBody.data.routeIndex,
      firstRouteBody.data.routeIndex
    );
    assert.equal(secondRouteBody.data.route.match.pathPrefix, projectTwo);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ums source discovery and binding controls manage persisted source onboarding", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "ums-source-onboard-"));
  const homeDir = resolve(tempDir, "home");
  const repoRoot = resolve(tempDir, "repo");
  const configFile = resolve(tempDir, "config.jsonc");
  const codexDir = resolve(homeDir, ".codex", "sessions");
  const claudeDir = resolve(homeDir, ".claude", "transcripts");
  const codexNativeDir = resolve(homeDir, ".codex-native", "history");
  const vscodeDir = resolve(
    homeDir,
    "Library",
    "Application Support",
    "Code",
    "User",
    "workspaceStorage"
  );
  const env = {
    ...process.env,
    HOME: homeDir,
  };

  try {
    await mkdir(codexDir, { recursive: true });
    await mkdir(claudeDir, { recursive: true });
    await mkdir(codexNativeDir, { recursive: true });
    await mkdir(vscodeDir, { recursive: true });
    await mkdir(repoRoot, { recursive: true });

    await writeFile(
      resolve(codexDir, "session.jsonl"),
      `${JSON.stringify({
        type: "session_meta",
        payload: {
          id: "session-source-1",
          cwd: repoRoot,
        },
      })}\n${JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: "codex source candidate",
        },
      })}\n`,
      "utf8"
    );
    await writeFile(
      resolve(claudeDir, "transcript.jsonl"),
      `${JSON.stringify({
        type: "user",
        content: "claude source candidate",
      })}\n`,
      "utf8"
    );
    await writeFile(resolve(repoRoot, "PLAN.md"), "# Plan\n", "utf8");
    await writeFile(resolve(repoRoot, "AGENTS.md"), "# Agent notes\n", "utf8");

    await writeDaemonConfig(configFile, {
      version: 1,
      accounts: {
        local: { type: "local" },
      },
      memories: {
        personal: {
          account: "local",
          storeId: "personal",
          profile: "main",
        },
      },
      routes: [
        {
          match: {
            pathPrefix: repoRoot,
          },
          memory: "personal",
          priority: 10,
        },
      ],
      defaults: {
        memory: "personal",
        onAmbiguous: "default",
      },
    });

    const discover = await runUms(
      [
        "source",
        "discover",
        "--config-file",
        configFile,
        "--workspace-root",
        repoRoot,
      ],
      "",
      { env }
    );
    assert.equal((discover as any).code, 0, (discover as any).stderr);
    const discoverBody = JSON.parse((discover as any).stdout);
    assert.equal(discoverBody.ok, true);
    assert.equal(discoverBody.data.operation, "source.discover");
    assert.equal(discoverBody.data.candidates.length >= 5, true);
    assert.equal(
      discoverBody.data.candidates.some(
        (candidate: { source: string }) => candidate.source === "codex"
      ),
      true
    );
    assert.equal(
      discoverBody.data.candidates.some(
        (candidate: { source: string }) => candidate.source === "codex-native"
      ),
      true
    );
    assert.equal(
      discoverBody.data.candidates.some(
        (candidate: { source: string }) => candidate.source === "vscode"
      ),
      true
    );
    assert.equal(
      discoverBody.data.candidates.some(
        (candidate: { source: string }) => candidate.source === "plan"
      ),
      true
    );

    const onboard = await runUms(
      [
        "source",
        "onboard",
        "--config-file",
        configFile,
        "--workspace-root",
        repoRoot,
      ],
      "",
      { env }
    );
    assert.equal((onboard as any).code, 0, (onboard as any).stderr);
    const onboardBody = JSON.parse((onboard as any).stdout);
    assert.equal(onboardBody.ok, true);
    assert.equal(onboardBody.data.operation, "source.onboard");
    assert.equal(onboardBody.data.bindings.length >= 5, true);

    const sourceList = await runUms(
      ["source", "list", "--config-file", configFile],
      "",
      { env }
    );
    assert.equal((sourceList as any).code, 0, (sourceList as any).stderr);
    const sourceListBody = JSON.parse((sourceList as any).stdout);
    assert.equal(sourceListBody.ok, true);
    assert.equal(sourceListBody.data.operation, "source.list");
    const codexBinding = sourceListBody.data.bindings.find(
      (binding: { source: string }) => binding.source === "codex"
    );
    assert.ok(codexBinding);
    assert.equal(codexBinding.status, "approved");
    assert.equal(codexBinding.activeForSync, true);

    const inspect = await runUms(
      [
        "source",
        "inspect",
        "--config-file",
        configFile,
        "--id",
        codexBinding.id,
      ],
      "",
      { env }
    );
    assert.equal((inspect as any).code, 0, (inspect as any).stderr);
    const inspectBody = JSON.parse((inspect as any).stdout);
    assert.equal(inspectBody.ok, true);
    assert.equal(inspectBody.data.binding.id, codexBinding.id);

    const disable = await runUms(
      [
        "source",
        "disable",
        "--config-file",
        configFile,
        "--id",
        codexBinding.id,
      ],
      "",
      { env }
    );
    assert.equal((disable as any).code, 0, (disable as any).stderr);
    const disableBody = JSON.parse((disable as any).stdout);
    assert.equal(disableBody.ok, true);
    assert.equal(disableBody.data.binding.status, "disabled");

    const codexNativeBinding = sourceListBody.data.bindings.find(
      (binding: { source: string }) => binding.source === "codex-native"
    );
    assert.ok(codexNativeBinding);
    const ignore = await runUms(
      [
        "source",
        "ignore",
        "--config-file",
        configFile,
        "--id",
        codexNativeBinding.id,
      ],
      "",
      { env }
    );
    assert.equal((ignore as any).code, 0, (ignore as any).stderr);
    const ignoreBody = JSON.parse((ignore as any).stdout);
    assert.equal(ignoreBody.ok, true);
    assert.equal(ignoreBody.data.binding.status, "ignored");

    const sync = await runUms(["sync", "--config-file", configFile], "", {
      env,
    });
    assert.equal((sync as any).code, 0, (sync as any).stderr);
    const syncBody = JSON.parse((sync as any).stdout);
    assert.equal(syncBody.ok, true);
    assert.equal(
      syncBody.data.sourceStats.some(
        (stat: { source: string }) => stat.source === "codex"
      ),
      false
    );
    assert.equal(
      syncBody.data.sourceStats.some(
        (stat: { source: string }) => stat.source === "plan"
      ),
      true
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ums-memory-d6q.1.4 cli routes learner profile + identity graph updates with replay-safe ids", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "ums-cli-test-"));
  const stateFile = resolve(tempDir, "state.json");

  try {
    const profileCreate = await runCli([
      "learner_profile_update",
      "--state-file",
      stateFile,
      "--store-id",
      "tenant-cli",
      "--input",
      JSON.stringify({
        profile: "learner-cli",
        learnerId: "learner-88",
        identityRefs: [
          {
            namespace: "email",
            value: "learner88@example.com",
            isPrimary: true,
          },
        ],
        goals: ["graph", "dp"],
        evidenceEventIds: ["ep-profile-cli-1"],
      }),
    ]);
    assert.equal((profileCreate as any).code, 0);
    const profileCreateBody = JSON.parse((profileCreate as any).stdout);
    assert.equal(profileCreateBody.ok, true);
    assert.equal(profileCreateBody.data.operation, "learner_profile_update");
    assert.equal(profileCreateBody.data.action, "created");

    const profileReplay = await runCli([
      "learner_profile_update",
      "--state-file",
      stateFile,
      "--store-id",
      "tenant-cli",
      "--input",
      JSON.stringify({
        profile: "learner-cli",
        learnerId: "learner-88",
        identityRefs: [
          {
            namespace: "email",
            value: "learner88@example.com",
            isPrimary: true,
          },
        ],
        goals: ["dp", "graph"],
        evidenceEventIds: ["ep-profile-cli-1"],
      }),
    ]);
    assert.equal((profileReplay as any).code, 0);
    const profileReplayBody = JSON.parse((profileReplay as any).stdout);
    assert.equal(profileReplayBody.ok, true);
    assert.equal(profileReplayBody.data.action, "noop");
    assert.equal(
      profileReplayBody.data.profileId,
      profileCreateBody.data.profileId
    );

    const edgeCreate = await runCli([
      "identity_graph_update",
      "--state-file",
      stateFile,
      "--store-id",
      "tenant-cli",
      "--input",
      JSON.stringify({
        profile: "learner-cli",
        profileId: profileCreateBody.data.profileId,
        relation: "misconception_of",
        fromRef: { namespace: "misconception", value: "off-by-one" },
        toRef: { namespace: "learner", value: "learner-88" },
        evidenceEventIds: ["ep-2", "ep-1", "ep-1"],
      }),
    ]);
    assert.equal((edgeCreate as any).code, 0);
    const edgeCreateBody = JSON.parse((edgeCreate as any).stdout);
    assert.equal(edgeCreateBody.ok, true);
    assert.equal(edgeCreateBody.data.operation, "identity_graph_update");
    assert.equal(edgeCreateBody.data.action, "created");

    const edgeReplay = await runCli([
      "identity_graph_update",
      "--state-file",
      stateFile,
      "--store-id",
      "tenant-cli",
      "--input",
      JSON.stringify({
        profile: "learner-cli",
        profileId: profileCreateBody.data.profileId,
        relation: "misconception_of",
        fromRef: { namespace: "misconception", value: "off-by-one" },
        toRef: { namespace: "learner", value: "learner-88" },
        evidenceEventIds: ["ep-1", "ep-2"],
      }),
    ]);
    assert.equal((edgeReplay as any).code, 0);
    const edgeReplayBody = JSON.parse((edgeReplay as any).stdout);
    assert.equal(edgeReplayBody.ok, true);
    assert.equal(edgeReplayBody.data.action, "noop");
    assert.equal(edgeReplayBody.data.edgeId, edgeCreateBody.data.edgeId);

    const edgeOtherStore = await runCli([
      "identity_graph_update",
      "--state-file",
      stateFile,
      "--store-id",
      "tenant-cli-b",
      "--input",
      JSON.stringify({
        profile: "learner-cli",
        profileId: profileCreateBody.data.profileId,
        relation: "misconception_of",
        fromRef: { namespace: "misconception", value: "off-by-one" },
        toRef: { namespace: "learner", value: "learner-88" },
      }),
    ]);
    assert.equal((edgeOtherStore as any).code, 0);
    const edgeOtherStoreBody = JSON.parse((edgeOtherStore as any).stdout);
    assert.equal(edgeOtherStoreBody.ok, true);
    assert.equal(edgeOtherStoreBody.data.action, "created");
    assert.notEqual(edgeOtherStoreBody.data.edgeId, edgeCreateBody.data.edgeId);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ums-memory-d6q.2.4/3.4/4.4/5.4 cli routes deterministic P3 contract handlers", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "ums-cli-test-"));
  const stateFile = resolve(tempDir, "state.json");

  try {
    const misconception = await runCli([
      "misconception_update",
      "--state-file",
      stateFile,
      "--store-id",
      "tenant-p3-cli",
      "--input",
      JSON.stringify({
        profile: "learner-p3-cli",
        misconceptionKey: "off-by-one",
        signal: "harmful",
        evidenceEventIds: ["ep-1"],
      }),
    ]);
    assert.equal((misconception as any).code, 0);
    const misconceptionBody = JSON.parse((misconception as any).stdout);
    assert.equal(misconceptionBody.ok, true);
    assert.equal(misconceptionBody.data.operation, "misconception_update");
    assert.equal(misconceptionBody.data.action, "created");

    const curriculum = await runCli([
      "curriculum_plan_update",
      "--state-file",
      stateFile,
      "--store-id",
      "tenant-p3-cli",
      "--input",
      JSON.stringify({
        profile: "learner-p3-cli",
        objectiveId: "objective-1",
        recommendationRank: 2,
        evidenceEventIds: ["ep-2"],
        provenanceSignalIds: ["sig-1"],
      }),
    ]);
    assert.equal((curriculum as any).code, 0);
    const curriculumBody = JSON.parse((curriculum as any).stdout);
    assert.equal(curriculumBody.ok, true);
    assert.equal(curriculumBody.data.operation, "curriculum_plan_update");
    assert.equal(curriculumBody.data.action, "created");

    const review = await runCli([
      "review_schedule_update",
      "--state-file",
      stateFile,
      "--store-id",
      "tenant-p3-cli",
      "--input",
      JSON.stringify({
        profile: "learner-p3-cli",
        targetId: "rule-1",
        dueAt: "2026-03-01T12:00:00.000Z",
        sourceEventIds: ["evt-1"],
      }),
    ]);
    assert.equal((review as any).code, 0);
    const reviewBody = JSON.parse((review as any).stdout);
    assert.equal(reviewBody.ok, true);
    assert.equal(reviewBody.data.operation, "review_schedule_update");
    assert.equal(reviewBody.data.action, "created");

    const policy = await runCli([
      "policy_decision_update",
      "--state-file",
      stateFile,
      "--store-id",
      "tenant-p3-cli",
      "--input",
      JSON.stringify({
        profile: "learner-p3-cli",
        policyKey: "safe-guidance",
        outcome: "deny",
        reasonCodes: ["safety-risk"],
        provenanceEventIds: ["evt-policy-1"],
      }),
    ]);
    assert.equal((policy as any).code, 0);
    const policyBody = JSON.parse((policy as any).stdout);
    assert.equal(policyBody.ok, true);
    assert.equal(policyBody.data.operation, "policy_decision_update");
    assert.equal(policyBody.data.action, "created");
    assert.equal(policyBody.data.observability.denied, true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ums-memory-d6q.1.11/ums-memory-d6q.1.9 cli rejects missing evidence pointers and returns policy exception observability", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "ums-cli-test-"));
  const stateFile = resolve(tempDir, "state.json");

  try {
    const rejected = await runCli([
      "misconception_update",
      "--state-file",
      stateFile,
      "--store-id",
      "tenant-cli-guardrail",
      "--input",
      JSON.stringify({
        profile: "learner-cli-guardrail",
        misconceptionKey: "missing-evidence-pointer",
        signal: "harmful",
      }),
    ]);
    assert.equal((rejected as any).code, 1);
    const rejectedBody = JSON.parse((rejected as any).stderr);
    assert.equal(rejectedBody.ok, false);
    assert.equal(rejectedBody.error.code, "CLI_ERROR");
    assert.match(rejectedBody.error.message, /evidenceeventid/i);

    const policy = await runCli([
      "policy_decision_update",
      "--state-file",
      stateFile,
      "--store-id",
      "tenant-cli-guardrail",
      "--input",
      JSON.stringify({
        profile: "learner-cli-guardrail",
        policyKey: "evidence-pointer-contract",
        outcome: "review",
        reasonCodes: ["policy-exception-evidence-pointer-waiver"],
        provenanceEventIds: ["evt-policy-waiver-cli-1"],
        metadata: {
          exceptionKind: "evidence-pointer-waiver",
          ticketId: "waiver-cli-1",
        },
      }),
    ]);
    assert.equal((policy as any).code, 0);
    const policyBody = JSON.parse((policy as any).stdout);
    assert.equal(policyBody.ok, true);
    assert.equal(policyBody.data.operation, "policy_decision_update");
    assert.equal(policyBody.data.decision.outcome, "review");
    assert.equal(policyBody.data.observability.denied, false);
    assert.equal(policyBody.data.observability.reasonCodeCount, 1);
    assert.equal(policyBody.data.observability.provenanceCount, 1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ums-memory-d6q.2.6/ums-memory-d6q.3.6/ums-memory-d6q.4.6/ums-memory-d6q.5.6 cli guardrails reject invalid domain payloads", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "ums-cli-test-"));
  const stateFile = resolve(tempDir, "state.json");

  const guardrailCases = [
    {
      operation: "misconception_update",
      payload: {
        profile: "learner-cli-guardrails",
        misconceptionKey: "missing-evidence",
        signal: "harmful",
      },
      messagePattern: /evidenceeventid/i,
    },
    {
      operation: "curriculum_plan_update",
      payload: {
        profile: "learner-cli-guardrails",
        objectiveId: "objective-without-evidence",
      },
      messagePattern: /evidenceeventid/i,
    },
    {
      operation: "review_schedule_update",
      payload: {
        profile: "learner-cli-guardrails",
        targetId: "rule-without-source-events",
        dueAt: "2026-03-11T00:00:00.000Z",
      },
      messagePattern: /sourceeventid/i,
    },
    {
      operation: "policy_decision_update",
      payload: {
        profile: "learner-cli-guardrails",
        policyKey: "deny-without-reason-codes",
        outcome: "deny",
        provenanceEventIds: ["evt-cli-pol-1"],
      },
      messagePattern: /reasoncodes/i,
    },
  ];

  try {
    for (const entry of guardrailCases) {
      const result = await runCli([
        entry.operation,
        "--state-file",
        stateFile,
        "--store-id",
        "tenant-cli-guardrails",
        "--input",
        JSON.stringify(entry.payload),
      ]);
      assert.equal((result as any).code, 1);
      const body = JSON.parse((result as any).stderr);
      assert.equal(body.ok, false);
      assert.equal(body.error.code, "CLI_ERROR");
      assert.match(body.error.message, entry.messagePattern);
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ums-memory-d6q.2.7/ums-memory-d6q.2.9/ums-memory-d6q.3.7/ums-memory-d6q.3.9/ums-memory-d6q.4.7/ums-memory-d6q.4.9/ums-memory-d6q.5.7/ums-memory-d6q.5.9 cli positive domain paths include observability fields", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "ums-cli-test-"));
  const stateFile = resolve(tempDir, "state.json");

  try {
    const misconception = await runCli([
      "misconception_update",
      "--state-file",
      stateFile,
      "--store-id",
      "tenant-cli-positive",
      "--input",
      JSON.stringify({
        profile: "learner-cli-positive",
        misconceptionKey: "array-bound-check",
        signal: "harmful",
        signalId: "sig-cli-1",
        evidenceEventIds: ["evt-cli-m-1", "evt-cli-m-2"],
      }),
    ]);
    assert.equal((misconception as any).code, 0);
    const misconceptionBody = JSON.parse((misconception as any).stdout);
    assert.equal(misconceptionBody.ok, true);
    assert.equal(misconceptionBody.data.action, "created");
    assert.equal(misconceptionBody.data.observability.evidenceCount, 2);
    assert.equal(misconceptionBody.data.observability.signalCount, 1);
    assert.equal(misconceptionBody.data.deterministic, true);
    assert.ok(misconceptionBody.data.requestDigest.length > 10);

    const curriculum = await runCli([
      "curriculum_plan_update",
      "--state-file",
      stateFile,
      "--store-id",
      "tenant-cli-positive",
      "--input",
      JSON.stringify({
        profile: "learner-cli-positive",
        objectiveId: "objective-cli-positive",
        recommendationRank: 2,
        evidenceEventIds: ["evt-cli-c-1"],
        provenanceSignalIds: ["sig-cli-1", "sig-cli-2"],
      }),
    ]);
    assert.equal((curriculum as any).code, 0);
    const curriculumBody = JSON.parse((curriculum as any).stdout);
    assert.equal(curriculumBody.ok, true);
    assert.equal(curriculumBody.data.action, "created");
    assert.equal(curriculumBody.data.observability.evidenceCount, 1);
    assert.equal(curriculumBody.data.observability.provenanceCount, 2);
    assert.equal(
      curriculumBody.data.observability.boundedRecommendationRank,
      2
    );
    assert.equal(curriculumBody.data.deterministic, true);
    assert.ok(curriculumBody.data.requestDigest.length > 10);

    const review = await runCli([
      "review_schedule_update",
      "--state-file",
      stateFile,
      "--store-id",
      "tenant-cli-positive",
      "--input",
      JSON.stringify({
        profile: "learner-cli-positive",
        targetId: "rule-cli-positive",
        dueAt: "2026-03-12T00:00:00.000Z",
        sourceEventIds: ["evt-cli-r-1", "evt-cli-r-2"],
      }),
    ]);
    assert.equal((review as any).code, 0);
    const reviewBody = JSON.parse((review as any).stdout);
    assert.equal(reviewBody.ok, true);
    assert.equal(reviewBody.data.action, "created");
    assert.equal(
      reviewBody.data.observability.dueAt,
      "2026-03-12T00:00:00.000Z"
    );
    assert.equal(reviewBody.data.observability.sourceEventCount, 2);
    assert.equal(reviewBody.data.observability.storeIsolationEnforced, true);
    assert.equal(reviewBody.data.deterministic, true);
    assert.ok(reviewBody.data.requestDigest.length > 10);

    const policy = await runCli([
      "policy_decision_update",
      "--state-file",
      stateFile,
      "--store-id",
      "tenant-cli-positive",
      "--input",
      JSON.stringify({
        profile: "learner-cli-positive",
        policyKey: "policy-cli-positive",
        outcome: "deny",
        reasonCodes: ["safety-risk"],
        provenanceEventIds: ["evt-cli-p-1"],
      }),
    ]);
    assert.equal((policy as any).code, 0);
    const policyBody = JSON.parse((policy as any).stdout);
    assert.equal(policyBody.ok, true);
    assert.equal(policyBody.data.action, "created");
    assert.equal(policyBody.data.observability.denied, true);
    assert.equal(policyBody.data.observability.reasonCodeCount, 1);
    assert.equal(policyBody.data.observability.provenanceCount, 1);
    assert.equal(policyBody.data.deterministic, true);
    assert.ok(policyBody.data.requestDigest.length > 10);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ums-memory-d6q.2.11/ums-memory-d6q.2.12/ums-memory-d6q.4.11/ums-memory-d6q.4.12 cli feature payloads remain replay-safe and observable", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "ums-cli-test-"));
  const stateFile = resolve(tempDir, "state.json");

  try {
    const outcome = await runCli([
      "outcome",
      "--state-file",
      stateFile,
      "--store-id",
      "tenant-cli-feature",
      "--input",
      JSON.stringify({
        profile: "learner-cli-feature",
        task: "regression-test-failure",
        outcome: "failure",
        usedRuleIds: ["rule-cli-1"],
      }),
    ]);
    assert.equal((outcome as any).code, 0);
    const outcomeBody = JSON.parse((outcome as any).stdout);
    assert.equal(outcomeBody.ok, true);

    const explicitMisconception = await runCli([
      "misconception_update",
      "--state-file",
      stateFile,
      "--store-id",
      "tenant-cli-feature",
      "--input",
      JSON.stringify({
        profile: "learner-cli-feature",
        misconceptionKey: "boundary-check",
        signal: "harmful",
        signalId: "sig-cli-explicit-1",
        evidenceEventIds: ["evt-cli-explicit-1"],
        metadata: {
          feedbackType: "thumbs-down",
          source: "human-review",
        },
      }),
    ]);
    assert.equal((explicitMisconception as any).code, 0);
    const explicitBody = JSON.parse((explicitMisconception as any).stdout);
    assert.equal(explicitBody.ok, true);
    assert.equal(explicitBody.data.action, "created");
    assert.equal(explicitBody.data.observability.signalCount, 1);

    const implicitMisconception = await runCli([
      "misconception_update",
      "--state-file",
      stateFile,
      "--store-id",
      "tenant-cli-feature",
      "--input",
      JSON.stringify({
        profile: "learner-cli-feature",
        misconceptionKey: "boundary-check",
        signal: "harmful",
        signalId: "sig-cli-implicit-failure-1",
        evidenceEventIds: [outcomeBody.data.outcomeId],
        metadata: {
          mappingSource: "outcome_failure",
          mappedOutcomeId: outcomeBody.data.outcomeId,
          mappedAt: "2026-03-01T12:30:00.000Z",
        },
      }),
    ]);
    assert.equal((implicitMisconception as any).code, 0);
    const implicitBody = JSON.parse((implicitMisconception as any).stdout);
    assert.equal(implicitBody.ok, true);
    assert.equal(implicitBody.data.action, "updated");
    assert.equal(implicitBody.data.observability.signalCount, 2);
    assert.equal(
      implicitBody.data.record.metadata.mappedOutcomeId,
      outcomeBody.data.outcomeId
    );

    const implicitReplay = await runCli([
      "misconception_update",
      "--state-file",
      stateFile,
      "--store-id",
      "tenant-cli-feature",
      "--input",
      JSON.stringify({
        profile: "learner-cli-feature",
        misconceptionKey: "boundary-check",
        signal: "harmful",
        signalId: "sig-cli-implicit-failure-1",
        evidenceEventIds: [outcomeBody.data.outcomeId],
        metadata: {
          mappingSource: "outcome_failure",
          mappedOutcomeId: outcomeBody.data.outcomeId,
          mappedAt: "2026-03-01T12:30:00.000Z",
        },
      }),
    ]);
    assert.equal((implicitReplay as any).code, 0);
    const implicitReplayBody = JSON.parse((implicitReplay as any).stdout);
    assert.equal(implicitReplayBody.ok, true);
    assert.equal(implicitReplayBody.data.action, "noop");

    const schedule = await runCli([
      "review_schedule_update",
      "--state-file",
      stateFile,
      "--store-id",
      "tenant-cli-feature",
      "--input",
      JSON.stringify({
        profile: "learner-cli-feature",
        targetId: "rule-cli-feature",
        dueAt: "2026-03-26T00:00:00.000Z",
        sourceEventIds: ["evt-cli-srs-2", "evt-cli-srs-1"],
        metadata: {
          interactionClock: {
            tick: 4,
            lastInteractionAt: "2026-03-25T23:30:00.000Z",
          },
          sleepClock: {
            window: "nightly",
            nextConsolidationAt: "2026-03-26T02:30:00.000Z",
          },
          activeSet: { limit: 3, size: 2, strategy: "lru" },
          archive: { tier: "warm", tiers: ["hot", "warm", "cold"] },
        },
      }),
    ]);
    assert.equal((schedule as any).code, 0);
    const scheduleBody = JSON.parse((schedule as any).stdout);
    assert.equal(scheduleBody.ok, true);
    assert.equal(scheduleBody.data.action, "created");
    assert.equal(
      scheduleBody.data.scheduleEntry.metadata.interactionClock.tick,
      4
    );
    assert.equal(scheduleBody.data.scheduleEntry.metadata.archive.tier, "warm");

    const scheduleReplay = await runCli([
      "review_schedule_update",
      "--state-file",
      stateFile,
      "--store-id",
      "tenant-cli-feature",
      "--input",
      JSON.stringify({
        profile: "learner-cli-feature",
        targetId: "rule-cli-feature",
        dueAt: "2026-03-26T00:00:00.000Z",
        sourceEventIds: ["evt-cli-srs-1", "evt-cli-srs-2"],
        metadata: {
          interactionClock: {
            tick: 4,
            lastInteractionAt: "2026-03-25T23:30:00.000Z",
          },
          sleepClock: {
            window: "nightly",
            nextConsolidationAt: "2026-03-26T02:30:00.000Z",
          },
          activeSet: { limit: 3, size: 2, strategy: "lru" },
          archive: { tier: "warm", tiers: ["hot", "warm", "cold"] },
        },
      }),
    ]);
    assert.equal((scheduleReplay as any).code, 0);
    const scheduleReplayBody = JSON.parse((scheduleReplay as any).stdout);
    assert.equal(scheduleReplayBody.ok, true);
    assert.equal(scheduleReplayBody.data.action, "noop");
    assert.equal(scheduleReplayBody.data.observability.sourceEventCount, 2);
    assert.equal(scheduleReplayBody.data.observability.slo.replaySafe, true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
