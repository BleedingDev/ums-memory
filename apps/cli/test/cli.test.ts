import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { resetStore } from "../../api/src/core.ts";
import { writeDaemonConfig } from "../../ums/src/daemon-config.ts";

const CLI_PATH = resolve(process.cwd(), "apps/cli/src/index.ts");
const UMS_PATH = resolve(process.cwd(), "apps/ums/src/index.ts");

function runCli(args: any, stdin = "", { env = process.env } = {}) {
  return new Promise((resolvePromise) => {
    const proc = spawn(
      process.execPath,
      ["--import", "tsx", CLI_PATH, ...args],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env,
      }
    );
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
    const proc = spawn(
      process.execPath,
      ["--import", "tsx", UMS_PATH, ...args],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env,
      }
    );
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

test.beforeEach(() => {
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

test("ums sync-daemon updates local status and http memories stay blocked", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "ums-config-sync-daemon-"));
  const homeDir = resolve(tempDir, "home");
  const codexDir = resolve(homeDir, ".codex", "sessions");
  const localProjectRoot = resolve(tempDir, "projects", "personal-app");
  const managedProjectRoot = resolve(tempDir, "projects", "new-engine");
  const localConfigFile = resolve(tempDir, "local-config.jsonc");
  const managedConfigFile = resolve(tempDir, "managed-config.jsonc");
  try {
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
          content: "Daemon status should reflect a successful local sync cycle.",
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

    const localStatus = await runUms(["status", "--config-file", localConfigFile]);
    assert.equal((localStatus as any).code, 0, (localStatus as any).stderr);
    const localStatusBody = JSON.parse((localStatus as any).stdout);
    assert.equal(localStatusBody.ok, true);
    assert.equal(localStatusBody.data.operation, "status");
    assert.equal(localStatusBody.data.daemon.pid, null);
    assert.equal(localStatusBody.data.sync.lastSuccessAt !== null, true);
    assert.equal(localStatusBody.data.deliveries[0].accepted >= 1, true);

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
          content: "Managed memories should stay blocked until remote delivery ships.",
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
          ...process.env,
          HOME: homeDir,
        },
      }
    );
    assert.equal((managedSync as any).code, 1);
    const managedError = JSON.parse((managedSync as any).stderr);
    assert.equal(managedError.ok, false);
    assert.equal(managedError.error.code, "UMS_RUNTIME_ERROR");
    assert.match(managedError.error.message, /delivery errors/i);

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
      /not yet supported by config-backed sync/i
    );
  } finally {
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
    assert.equal((doctor as any).code, 0, (doctor as any).stderr);
    const doctorBody = JSON.parse((doctor as any).stdout);
    assert.equal(doctorBody.ok, true);
    assert.equal(doctorBody.data.operation, "config.doctor");
    assert.equal(doctorBody.data.status, "needs_rewrite");
    assert.equal(doctorBody.data.healthy, true);
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
    assert.match(removeAccountError.error.message, /memories still reference it/i);
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
