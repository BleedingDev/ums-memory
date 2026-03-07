import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

import { test } from "@effect-native/bun-test";
import { Effect, Schema } from "effect";

const isString = Schema.is(Schema.String);
const isServerAddress = Schema.is(
  Schema.Struct({
    port: Schema.Number,
  })
);

import { executeRuntimeOperation } from "../../api/src/runtime-service.ts";
import { writeDaemonConfig } from "../../ums/src/daemon-config.ts";
import { storeManagedAccountCredential } from "../../ums/src/daemon-credentials.ts";
import {
  discoverDaemonSources,
  getDaemonStatus,
  getDaemonSourceViews,
  runConfiguredSyncCycle,
} from "../../ums/src/daemon-sync.ts";

test("daemon source discovery keeps vscode and codex-native consent-pending while marking them sync-capable", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "ums-daemon-discovery-"));
  const homeDir = resolve(tempDir, "home");
  const codexNativeDir = resolve(homeDir, ".codex-native", "history");
  const vscodeDir = resolve(
    homeDir,
    "Library",
    "Application Support",
    "Code",
    "User",
    "workspaceStorage"
  );
  const repoRoot = resolve(tempDir, "repo");
  const previousCodexNativeRoots =
    process.env["UMS_DISCOVERY_CODEX_NATIVE_ROOTS"];
  const previousVscodeRoots = process.env["UMS_DISCOVERY_VSCODE_ROOTS"];

  try {
    process.env["UMS_DISCOVERY_CODEX_NATIVE_ROOTS"] = codexNativeDir;
    process.env["UMS_DISCOVERY_VSCODE_ROOTS"] = vscodeDir;

    await mkdir(codexNativeDir, { recursive: true });
    await mkdir(vscodeDir, { recursive: true });
    await mkdir(repoRoot, { recursive: true });

    await writeFile(
      resolve(codexNativeDir, "session.jsonl"),
      `${JSON.stringify({
        cwd: repoRoot,
        repoRoot,
        workspaceRoot: repoRoot,
        prompt: "Codex Native discovery candidate",
      })}\n`,
      "utf8"
    );
    await writeFile(
      resolve(vscodeDir, "state.json"),
      `${JSON.stringify({
        conversations: [
          {
            repoRoot,
            workspaceRoot: repoRoot,
            request: { text: "VSCode discovery candidate" },
          },
        ],
      })}\n`,
      "utf8"
    );

    const candidates = await discoverDaemonSources({
      workspaceRoots: [repoRoot],
      sourceFilter: ["codex-native", "vscode"],
    });

    assert.equal(candidates.length, 2);

    const codexNativeCandidate = candidates.find(
      (candidate) => candidate.source === "codex-native"
    );
    assert.ok(codexNativeCandidate);
    assert.equal(codexNativeCandidate.supportedForSync, true);
    assert.equal(codexNativeCandidate.proposedStatus, "pending");
    assert.equal(codexNativeCandidate.kind, "directory");
    assert.equal(codexNativeCandidate.evidenceCount > 0, true);

    const vscodeCandidate = candidates.find(
      (candidate) => candidate.source === "vscode"
    );
    assert.ok(vscodeCandidate);
    assert.equal(vscodeCandidate.supportedForSync, true);
    assert.equal(vscodeCandidate.proposedStatus, "pending");
    assert.equal(vscodeCandidate.kind, "directory");
    assert.equal(vscodeCandidate.evidenceCount > 0, true);
  } finally {
    if (previousCodexNativeRoots === undefined) {
      delete process.env["UMS_DISCOVERY_CODEX_NATIVE_ROOTS"];
    } else {
      process.env["UMS_DISCOVERY_CODEX_NATIVE_ROOTS"] =
        previousCodexNativeRoots;
    }
    if (previousVscodeRoots === undefined) {
      delete process.env["UMS_DISCOVERY_VSCODE_ROOTS"];
    } else {
      process.env["UMS_DISCOVERY_VSCODE_ROOTS"] = previousVscodeRoots;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("daemon source discovery keeps cursor and opencode consent-pending while marking them sync-capable", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "ums-daemon-discovery-"));
  const homeDir = resolve(tempDir, "home");
  const cursorDir = resolve(
    homeDir,
    "Library",
    "Application Support",
    "Cursor",
    "User",
    "workspaceStorage"
  );
  const opencodeDir = resolve(homeDir, ".opencode", "history");
  const repoRoot = resolve(tempDir, "repo");
  const previousCursorRoots = process.env["UMS_DISCOVERY_CURSOR_ROOTS"];
  const previousOpencodeRoots = process.env["UMS_DISCOVERY_OPENCODE_ROOTS"];

  try {
    process.env["UMS_DISCOVERY_CURSOR_ROOTS"] = cursorDir;
    process.env["UMS_DISCOVERY_OPENCODE_ROOTS"] = opencodeDir;

    await mkdir(cursorDir, { recursive: true });
    await mkdir(opencodeDir, { recursive: true });
    await mkdir(repoRoot, { recursive: true });

    await writeFile(
      resolve(cursorDir, "cursor-chat.json"),
      `${JSON.stringify({
        conversations: [
          {
            repoRoot,
            workspaceRoot: repoRoot,
            request: { text: "Cursor discovery candidate" },
          },
        ],
      })}\n`,
      "utf8"
    );
    await writeFile(
      resolve(opencodeDir, "history.json"),
      `${JSON.stringify({
        sessions: [
          {
            repoRoot,
            workspaceRoot: repoRoot,
            prompt: "OpenCode discovery candidate",
          },
        ],
      })}\n`,
      "utf8"
    );

    const candidates = await discoverDaemonSources({
      workspaceRoots: [repoRoot],
      sourceFilter: ["cursor", "opencode"],
    });

    assert.equal(candidates.length, 2);

    const cursorCandidate = candidates.find(
      (candidate) => candidate.source === "cursor"
    );
    assert.ok(cursorCandidate);
    assert.equal(cursorCandidate.supportedForSync, true);
    assert.equal(cursorCandidate.proposedStatus, "pending");
    assert.equal(cursorCandidate.kind, "directory");
    assert.equal(cursorCandidate.evidenceCount > 0, true);

    const opencodeCandidate = candidates.find(
      (candidate) => candidate.source === "opencode"
    );
    assert.ok(opencodeCandidate);
    assert.equal(opencodeCandidate.supportedForSync, true);
    assert.equal(opencodeCandidate.proposedStatus, "pending");
    assert.equal(opencodeCandidate.kind, "directory");
    assert.equal(opencodeCandidate.evidenceCount > 0, true);
  } finally {
    if (previousCursorRoots === undefined) {
      delete process.env["UMS_DISCOVERY_CURSOR_ROOTS"];
    } else {
      process.env["UMS_DISCOVERY_CURSOR_ROOTS"] = previousCursorRoots;
    }
    if (previousOpencodeRoots === undefined) {
      delete process.env["UMS_DISCOVERY_OPENCODE_ROOTS"];
    } else {
      process.env["UMS_DISCOVERY_OPENCODE_ROOTS"] = previousOpencodeRoots;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("daemon source discovery finds plan guidance files inside workspace roots", async () => {
  const tempDir = await mkdtemp(
    resolve(tmpdir(), "ums-daemon-plan-discovery-")
  );
  const workspaceRoot = resolve(tempDir, "workspace");

  try {
    await mkdir(workspaceRoot, { recursive: true });
    await writeFile(
      resolve(workspaceRoot, "PLAN.md"),
      "# Project plan\n",
      "utf8"
    );
    await writeFile(
      resolve(workspaceRoot, "AGENTS.md"),
      "# Agent instructions\n",
      "utf8"
    );

    const candidates = await discoverDaemonSources({
      workspaceRoots: [workspaceRoot],
      sourceFilter: ["plan"],
    });

    assert.equal(candidates.length, 2);
    assert.equal(
      candidates.every(
        (candidate) =>
          candidate.source === "plan" &&
          candidate.kind === "file" &&
          candidate.supportedForSync === true &&
          candidate.proposedStatus === "approved"
      ),
      true
    );
    assert.equal(
      candidates.some(
        (candidate) =>
          candidate.path === resolve(workspaceRoot, "PLAN.md") &&
          candidate.label.includes("Project plan")
      ),
      true
    );
    assert.equal(
      candidates.some(
        (candidate) =>
          candidate.path === resolve(workspaceRoot, "AGENTS.md") &&
          candidate.label.includes("Agent instructions")
      ),
      true
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("configured sync routes vscode and codex-native records deterministically and recovers from checkpoint directories", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "ums-daemon-route-aware-"));
  const homeDir = resolve(tempDir, "home");
  const codexNativeDir = resolve(homeDir, ".codex-native", "history");
  const vscodeDir = resolve(
    homeDir,
    "Library",
    "Application Support",
    "Code",
    "User",
    "workspaceStorage"
  );
  const projectAlpha = resolve(tempDir, "projects", "alpha");
  const projectBeta = resolve(tempDir, "projects", "beta");
  const stateRoot = resolve(tempDir, "ums-state");
  const configFile = resolve(tempDir, "config.jsonc");
  const syncStateFile = resolve(stateRoot, "sync-state.json");
  const runtimeStateFile = resolve(stateRoot, "runtime-state.json");

  try {
    await mkdir(codexNativeDir, { recursive: true });
    await mkdir(vscodeDir, { recursive: true });
    await mkdir(projectAlpha, { recursive: true });
    await mkdir(projectBeta, { recursive: true });

    await writeFile(
      resolve(codexNativeDir, "native-history.jsonl"),
      `${JSON.stringify({
        cwd: projectAlpha,
        repoRoot: projectAlpha,
        workspaceRoot: projectAlpha,
        prompt: "Codex Native routes to alpha.",
      })}\n`,
      "utf8"
    );
    await writeFile(
      resolve(vscodeDir, "conversation-state.json"),
      `${JSON.stringify({
        conversations: [
          {
            repoRoot: projectAlpha,
            workspaceRoot: projectAlpha,
            request: { text: "VSCode alpha route." },
          },
          {
            repoRoot: projectBeta,
            workspaceRoot: projectBeta,
            request: { text: "VSCode beta route." },
          },
        ],
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
        alpha: {
          account: "local",
          storeId: "alpha",
          profile: "main",
        },
        beta: {
          account: "local",
          storeId: "beta",
          profile: "main",
        },
      },
      sources: {
        bindings: [
          {
            source: "codex-native",
            kind: "directory",
            path: codexNativeDir,
            status: "approved",
            label: "Codex Native history",
          },
          {
            source: "vscode",
            kind: "directory",
            path: vscodeDir,
            status: "approved",
            label: "VSCode workspace storage",
          },
        ],
        codex: { enabled: false },
        claude: { enabled: false },
        plan: { enabled: false },
      },
      routes: [
        {
          match: {
            source: "codex-native",
            workspaceRoot: projectAlpha,
          },
          memory: "alpha",
          priority: 20,
        },
        {
          match: {
            source: "vscode",
            pathPrefix: tempDir,
          },
          memory: "alpha",
          priority: 10,
        },
        {
          match: {
            source: "vscode",
            repoRoot: projectBeta,
          },
          memory: "beta",
          priority: 10,
        },
      ],
      defaults: {
        memory: "alpha",
        onAmbiguous: "default",
      },
    });

    const first = await runConfiguredSyncCycle(configFile);
    assert.equal(first.preparedEvents, 3);
    assert.equal(first.journaledEvents, 3);
    assert.equal(first.deliveredEvents, 3);
    assert.equal(first.accepted, 3);
    assert.equal(
      first.sourceStats.some(
        (entry) => entry.source === "codex-native" && entry.eventsPrepared === 1
      ),
      true
    );
    assert.equal(
      first.sourceStats.some(
        (entry) => entry.source === "vscode" && entry.eventsPrepared === 2
      ),
      true
    );

    const alphaNativeContext = await executeRuntimeOperation({
      operation: "context",
      stateFile: runtimeStateFile,
      requestBody: {
        storeId: "alpha",
        profile: "main",
        query: "Codex Native routes to alpha",
      },
    });
    assert.equal(
      (alphaNativeContext as { matches?: readonly unknown[] }).matches?.length,
      1
    );

    const alphaVscodeContext = await executeRuntimeOperation({
      operation: "context",
      stateFile: runtimeStateFile,
      requestBody: {
        storeId: "alpha",
        profile: "main",
        query: "VSCode alpha route",
      },
    });
    assert.equal(
      (alphaVscodeContext as { matches?: readonly unknown[] }).matches?.length,
      1
    );

    const betaVscodeContext = await executeRuntimeOperation({
      operation: "context",
      stateFile: runtimeStateFile,
      requestBody: {
        storeId: "beta",
        profile: "main",
        query: "VSCode beta route",
      },
    });
    assert.equal(
      (betaVscodeContext as { matches?: readonly unknown[] }).matches?.length,
      1
    );

    const sourceCheckpointFiles = await readdir(
      resolve(stateRoot, "checkpoints", "sources")
    );
    assert.equal(sourceCheckpointFiles.length >= 2, true);
    const deliveryCheckpointFiles = await readdir(
      resolve(stateRoot, "checkpoints", "deliveries")
    );
    assert.equal(deliveryCheckpointFiles.length, 2);

    const sourceViews = await getDaemonSourceViews(configFile);
    const codexNativeView = sourceViews.bindings.find(
      (binding) => binding.source === "codex-native"
    );
    assert.ok(codexNativeView);
    assert.equal(codexNativeView.activeForSync, true);
    assert.equal(codexNativeView.checkpointCount, 1);

    const vscodeView = sourceViews.bindings.find(
      (binding) => binding.source === "vscode"
    );
    assert.ok(vscodeView);
    assert.equal(vscodeView.activeForSync, true);
    assert.equal(vscodeView.checkpointCount, 1);

    await rm(syncStateFile, { force: true });

    const recoveredViews = await getDaemonSourceViews(configFile);
    assert.equal(
      recoveredViews.bindings.find((binding) => binding.source === "vscode")
        ?.checkpointCount,
      1
    );
    assert.equal(
      recoveredViews.bindings.find(
        (binding) => binding.source === "codex-native"
      )?.checkpointCount,
      1
    );

    const second = await runConfiguredSyncCycle(configFile);
    assert.equal(second.preparedEvents, 0);
    assert.equal(second.journaledEvents, 0);
    assert.equal(second.deliveredEvents, 0);
    assert.equal(second.accepted, 0);

    const status = await getDaemonStatus(configFile);
    const alphaDelivery = status.deliveries.find(
      (delivery) => delivery.memory === "alpha"
    );
    assert.equal(alphaDelivery?.accepted, 2);
    const betaDelivery = status.deliveries.find(
      (delivery) => delivery.memory === "beta"
    );
    assert.equal(betaDelivery?.accepted, 1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("configured sync recovers from journaled-but-uncheckpointed events without recollecting or redelivering duplicates", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "ums-daemon-sync-recovery-"));
  const homeDir = resolve(tempDir, "home");
  const codexDir = resolve(homeDir, ".codex", "sessions");
  const projectRoot = resolve(tempDir, "projects", "personal-app");
  const stateRoot = resolve(tempDir, "ums-state");
  const configFile = resolve(tempDir, "config.jsonc");
  const syncStateFile = resolve(stateRoot, "sync-state.json");
  const journalFile = resolve(stateRoot, "journal", "events.ndjson");
  const runtimeStateFile = resolve(stateRoot, "runtime-state.json");
  const codexSessionFile = resolve(codexDir, "session.jsonl");
  const eventContent =
    "session.jsonl:2 Recover journaled sync entries without duplicating delivery.";

  try {
    await mkdir(codexDir, { recursive: true });
    await mkdir(projectRoot, { recursive: true });

    await writeFile(
      codexSessionFile,
      `${JSON.stringify({
        type: "session_meta",
        payload: {
          id: "recovery-session",
          cwd: projectRoot,
        },
      })}\n${JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content:
            "Recover journaled sync entries without duplicating delivery.",
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

    await mkdir(dirname(syncStateFile), { recursive: true });
    await mkdir(dirname(journalFile), { recursive: true });
    await writeFile(
      syncStateFile,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          updatedAt: "2026-03-07T00:00:00.000Z",
          daemonPid: null,
          daemonStartedAt: null,
          lastRunAt: null,
          lastSuccessAt: null,
          lastError: null,
          nextSequence: 1,
          sourceCursors: {},
          deliveries: {},
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    await writeFile(
      journalFile,
      `${JSON.stringify({
        sequence: 1,
        collectedAt: "2026-03-07T00:00:00.000Z",
        source: "codex",
        sourceFile: codexSessionFile,
        sourceLine: 2,
        sourceCursor: {
          cursor: 2,
          digest: null,
          updatedAt: "2026-03-07T00:00:00.000Z",
        },
        path: projectRoot,
        repoRoot: projectRoot,
        workspaceRoot: projectRoot,
        routeStatus: "matched",
        memory: "personal",
        routeIndex: 0,
        event: {
          id: "evt_recovery_seed_1",
          type: "note",
          source: "codex-cli",
          content: eventContent,
        },
      })}\n`,
      "utf8"
    );

    const first = await runConfiguredSyncCycle(configFile);
    assert.equal(first.preparedEvents, 0);
    assert.equal(first.journaledEvents, 0);
    assert.equal(first.deliveredEvents, 1);
    assert.equal(first.accepted, 1);
    assert.equal(first.duplicates, 0);

    const status = await getDaemonStatus(configFile);
    assert.equal(status.sync.nextSequence, 2);
    assert.equal(status.journal.entries, 1);
    assert.equal(status.deliveries[0]?.lastDeliveredSequence, 1);
    assert.equal(status.deliveries[0]?.deliveredEvents, 1);
    assert.equal(status.deliveries[0]?.accepted, 1);

    const context = await executeRuntimeOperation({
      operation: "context",
      stateFile: runtimeStateFile,
      requestBody: {
        storeId: "personal",
        profile: "main",
        query: "recover journaled sync entries",
      },
    });
    assert.equal(
      (context as { matches?: readonly unknown[] }).matches?.length,
      1
    );

    const second = await runConfiguredSyncCycle(configFile);
    assert.equal(second.preparedEvents, 0);
    assert.equal(second.journaledEvents, 0);
    assert.equal(second.deliveredEvents, 0);
    assert.equal(second.accepted, 0);

    const journalLines = (await readFile(journalFile, "utf8"))
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0);
    assert.equal(journalLines.length, 1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("configured sync collects vscode and codex native sources and persists per-file checkpoints", async () => {
  const tempDir = await mkdtemp(
    resolve(tmpdir(), "ums-daemon-sync-generic-sources-")
  );
  const projectRoot = resolve(tempDir, "projects", "workspace-app");
  const stateRoot = resolve(tempDir, "ums-state");
  const configFile = resolve(tempDir, "config.jsonc");
  const codexNativeDir = resolve(tempDir, "codex-native", "history");
  const vscodeDir = resolve(tempDir, "vscode");
  const codexNativeFile = resolve(codexNativeDir, "shell-snapshot.jsonl");
  const vscodeFile = resolve(vscodeDir, "copilot-chat.json");
  const sourceCheckpointDir = resolve(stateRoot, "checkpoints", "sources");
  const deliveryCheckpointDir = resolve(stateRoot, "checkpoints", "deliveries");

  try {
    await mkdir(projectRoot, { recursive: true });
    await mkdir(codexNativeDir, { recursive: true });
    await mkdir(vscodeDir, { recursive: true });

    await writeFile(
      codexNativeFile,
      `${JSON.stringify({
        cwd: projectRoot,
        prompt: "Codex Native source candidate for deterministic routing.",
        summary: "Codex Native source candidate for deterministic routing.",
      })}\n`,
      "utf8"
    );
    await writeFile(
      vscodeFile,
      JSON.stringify(
        {
          workspaceRoot: projectRoot,
          path: projectRoot,
          prompt: "VSCode source candidate for deterministic routing.",
          transcript: [
            {
              message: "VSCode source candidate for deterministic routing.",
            },
          ],
        },
        null,
        2
      ),
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
        codex: { enabled: false },
        claude: { enabled: false },
        plan: { enabled: false },
        codexNative: {
          roots: [codexNativeDir],
        },
        vscode: {
          roots: [vscodeDir],
        },
      },
      routes: [
        {
          match: {
            pathPrefix: projectRoot,
            source: "codex-native",
          },
          memory: "personal",
          priority: 20,
        },
        {
          match: {
            pathPrefix: projectRoot,
            source: "vscode",
          },
          memory: "personal",
          priority: 10,
        },
      ],
      defaults: {
        memory: "personal",
        onAmbiguous: "review",
      },
    });

    const summary = await runConfiguredSyncCycle(configFile);
    assert.equal(summary.preparedEvents, 2);
    assert.equal(summary.journaledEvents, 2);
    assert.equal(summary.deliveredEvents, 2);
    assert.equal(summary.accepted, 2);
    assert.equal(
      summary.sourceStats.some(
        (entry) => entry.source === "codex-native" && entry.eventsPrepared === 1
      ),
      true
    );
    assert.equal(
      summary.sourceStats.some(
        (entry) => entry.source === "vscode" && entry.eventsPrepared === 1
      ),
      true
    );

    const status = await getDaemonStatus(configFile);
    assert.equal(status.journal.pendingReview, 0);
    assert.equal(status.journal.pendingDrop, 0);
    assert.equal(status.deliveries[0]?.accepted, 2);
    assert.equal(status.deliveries[0]?.lastDeliveredSequence, 2);

    const sourceCheckpointFiles = (await readdir(sourceCheckpointDir)).sort(
      (left, right) => left.localeCompare(right)
    );
    const deliveryCheckpointFiles = (await readdir(deliveryCheckpointDir)).sort(
      (left, right) => left.localeCompare(right)
    );
    assert.equal(sourceCheckpointFiles.length, 2);
    assert.equal(deliveryCheckpointFiles.length, 1);

    const sourceCheckpointRecords = await Promise.all(
      sourceCheckpointFiles.map(async (fileName) =>
        JSON.parse(
          await readFile(resolve(sourceCheckpointDir, fileName), "utf8")
        )
      )
    );
    assert.equal(
      sourceCheckpointRecords.some(
        (record: { sourceFile: string; digest: string | null }) =>
          record.sourceFile === codexNativeFile && isString(record.digest)
      ),
      true
    );
    assert.equal(
      sourceCheckpointRecords.some(
        (record: { sourceFile: string; digest: string | null }) =>
          record.sourceFile === vscodeFile && isString(record.digest)
      ),
      true
    );

    const deliveryCheckpointRecord = JSON.parse(
      await readFile(
        resolve(deliveryCheckpointDir, deliveryCheckpointFiles[0]!),
        "utf8"
      )
    ) as {
      memory: string;
      accepted: number;
      deliveredEvents: number;
      lastDeliveredSequence: number;
    };
    assert.equal(deliveryCheckpointRecord.memory, "personal");
    assert.equal(deliveryCheckpointRecord.accepted, 2);
    assert.equal(deliveryCheckpointRecord.deliveredEvents, 2);
    assert.equal(deliveryCheckpointRecord.lastDeliveredSequence, 2);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("configured sync collects cursor and opencode sources deterministically", async () => {
  const tempDir = await mkdtemp(
    resolve(tmpdir(), "ums-daemon-sync-cursor-opencode-")
  );
  const projectRoot = resolve(tempDir, "projects", "workspace-app");
  const stateRoot = resolve(tempDir, "ums-state");
  const configFile = resolve(tempDir, "config.jsonc");
  const cursorDir = resolve(tempDir, "cursor", "workspaceStorage");
  const opencodeDir = resolve(tempDir, "opencode", "history");
  const cursorFile = resolve(cursorDir, "cursor-chat.json");
  const opencodeFile = resolve(opencodeDir, "session.jsonl");
  const sourceCheckpointDir = resolve(stateRoot, "checkpoints", "sources");

  try {
    await mkdir(projectRoot, { recursive: true });
    await mkdir(cursorDir, { recursive: true });
    await mkdir(opencodeDir, { recursive: true });

    await writeFile(
      cursorFile,
      JSON.stringify(
        {
          workspaceRoot: projectRoot,
          repoRoot: projectRoot,
          request: {
            text: "Cursor source candidate for deterministic routing.",
          },
        },
        null,
        2
      ),
      "utf8"
    );
    await writeFile(
      opencodeFile,
      `${JSON.stringify({
        workspaceRoot: projectRoot,
        repoRoot: projectRoot,
        prompt: "OpenCode source candidate for deterministic routing.",
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
        codex: { enabled: false },
        claude: { enabled: false },
        plan: { enabled: false },
        cursor: {
          roots: [cursorDir],
        },
        opencode: {
          roots: [opencodeDir],
        },
      },
      routes: [
        {
          match: {
            pathPrefix: projectRoot,
            source: "cursor",
          },
          memory: "personal",
          priority: 20,
        },
        {
          match: {
            pathPrefix: projectRoot,
            source: "opencode",
          },
          memory: "personal",
          priority: 10,
        },
      ],
      defaults: {
        memory: "personal",
        onAmbiguous: "review",
      },
    });

    const summary = await runConfiguredSyncCycle(configFile);
    assert.equal(summary.preparedEvents, 2);
    assert.equal(summary.journaledEvents, 2);
    assert.equal(summary.deliveredEvents, 2);
    assert.equal(summary.accepted, 2);
    assert.equal(
      summary.sourceStats.some(
        (entry) => entry.source === "cursor" && entry.eventsPrepared === 1
      ),
      true
    );
    assert.equal(
      summary.sourceStats.some(
        (entry) => entry.source === "opencode" && entry.eventsPrepared === 1
      ),
      true
    );

    const status = await getDaemonStatus(configFile);
    assert.equal(status.deliveries[0]?.accepted, 2);
    assert.equal(status.deliveries[0]?.lastDeliveredSequence, 2);

    const sourceCheckpointFiles = (await readdir(sourceCheckpointDir)).sort(
      (left, right) => left.localeCompare(right)
    );
    assert.equal(sourceCheckpointFiles.length, 2);

    const sourceCheckpointRecords = await Promise.all(
      sourceCheckpointFiles.map(async (fileName) =>
        JSON.parse(
          await readFile(resolve(sourceCheckpointDir, fileName), "utf8")
        )
      )
    );
    assert.equal(
      sourceCheckpointRecords.some(
        (record: { sourceFile: string; digest: string | null }) =>
          record.sourceFile === cursorFile && isString(record.digest)
      ),
      true
    );
    assert.equal(
      sourceCheckpointRecords.some(
        (record: { sourceFile: string; digest: string | null }) =>
          record.sourceFile === opencodeFile && isString(record.digest)
      ),
      true
    );

    const second = await runConfiguredSyncCycle(configFile);
    assert.equal(second.preparedEvents, 0);
    assert.equal(second.journaledEvents, 0);
    assert.equal(second.deliveredEvents, 0);
    assert.equal(second.accepted, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("configured sync ignores malformed structured source files instead of ingesting raw garbage", async () => {
  const tempDir = await mkdtemp(
    resolve(tmpdir(), "ums-daemon-sync-malformed-structured-")
  );
  const projectRoot = resolve(tempDir, "projects", "workspace-app");
  const stateRoot = resolve(tempDir, "ums-state");
  const configFile = resolve(tempDir, "config.jsonc");
  const vscodeDir = resolve(tempDir, "vscode");
  const vscodeFile = resolve(vscodeDir, "copilot-chat.json");

  try {
    await mkdir(projectRoot, { recursive: true });
    await mkdir(vscodeDir, { recursive: true });

    await writeFile(
      vscodeFile,
      '{"conversations":[{"request":{"text":"bad"}}',
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
        codex: { enabled: false },
        claude: { enabled: false },
        cursor: { enabled: false },
        opencode: { enabled: false },
        plan: { enabled: false },
        vscode: {
          roots: [vscodeDir],
        },
      },
      routes: [
        {
          match: {
            pathPrefix: projectRoot,
            source: "vscode",
          },
          memory: "personal",
          priority: 10,
        },
      ],
      defaults: {
        memory: "personal",
        onAmbiguous: "review",
      },
    });

    const summary = await runConfiguredSyncCycle(configFile);
    assert.equal(summary.preparedEvents, 0);
    assert.equal(summary.journaledEvents, 0);
    assert.equal(summary.deliveredEvents, 0);
    assert.equal(summary.accepted, 0);
    assert.equal(
      summary.sourceStats.some(
        (entry) => entry.source === "vscode" && entry.eventsPrepared === 0
      ),
      true
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("configured sync serializes concurrent cycles with a daemon lock and reclaims stale lock files", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "ums-daemon-sync-lock-"));
  const homeDir = resolve(tempDir, "home");
  const codexDir = resolve(homeDir, ".codex", "sessions");
  const projectRoot = resolve(tempDir, "projects", "new-engine");
  const stateRoot = resolve(tempDir, "ums-state");
  const configFile = resolve(tempDir, "config.jsonc");
  const credentialStoreFile = resolve(tempDir, "credentials.json");
  const syncLockFile = resolve(stateRoot, "sync.lock");
  const codexSessionFile = resolve(codexDir, "session.jsonl");
  const requests: Array<{ authorization: string | null; accepted: number }> =
    [];
  const previousCredentialStore = process.env["UMS_TEST_CREDENTIAL_STORE_FILE"];
  const previousPlaintextCredentialStore =
    process.env["UMS_ALLOW_PLAINTEXT_TEST_CREDENTIAL_STORE"];
  const previousCodexRoots = process.env["UMS_DISCOVERY_CODEX_ROOTS"];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => {
      chunks.push(Buffer.from(chunk));
    });
    request.on("end", () => {
      void (async () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          events?: readonly unknown[];
        };
        requests.push({
          authorization: request.headers["authorization"] ?? null,
          accepted: Array.isArray(body.events) ? body.events.length : 0,
        });
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
        response.statusCode = 200;
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            ok: true,
            data: {
              accepted: Array.isArray(body.events) ? body.events.length : 0,
              duplicates: 0,
            },
          })
        );
      })();
    });
  });

  try {
    process.env["UMS_TEST_CREDENTIAL_STORE_FILE"] = credentialStoreFile;
    process.env["UMS_ALLOW_PLAINTEXT_TEST_CREDENTIAL_STORE"] = "true";
    process.env["UMS_DISCOVERY_CODEX_ROOTS"] = codexDir;
    await mkdir(codexDir, { recursive: true });
    await mkdir(projectRoot, { recursive: true });
    await writeFile(
      codexSessionFile,
      `${JSON.stringify({
        type: "session_meta",
        payload: {
          id: "managed-lock-session",
          cwd: projectRoot,
        },
      })}\n${JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: "Deliver this once even when sync overlaps.",
        },
      })}\n`,
      "utf8"
    );

    await new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(0, "127.0.0.1", () => resolveListen());
    });
    const address = server.address();
    assert.notEqual(address, null);
    assert.equal(isServerAddress(address), true);
    const port = isServerAddress(address) ? address.port : null;
    assert.notEqual(port, null);

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
          apiBaseUrl: `http://127.0.0.1:${port}`,
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
          memory: "company",
          priority: 10,
        },
      ],
      defaults: {
        memory: "company",
        onAmbiguous: "review",
      },
    });

    await Effect.runPromise(
      storeManagedAccountCredential({
        credentialRef: "keychain://ums/company",
        secret: "managed-session-token",
      })
    );

    const firstCyclePromise = runConfiguredSyncCycle(configFile);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    const secondCyclePromise = runConfiguredSyncCycle(configFile);
    const [firstCycle, secondCycle] = await Promise.all([
      firstCyclePromise,
      secondCyclePromise,
    ]);

    assert.equal(firstCycle.deliveredEvents, 1);
    assert.equal(firstCycle.accepted, 1);
    assert.equal(secondCycle.deliveredEvents, 0);
    assert.equal(secondCycle.accepted, 0);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.authorization, "Bearer managed-session-token");
    assert.equal(requests[0]?.accepted, 1);

    const status = await getDaemonStatus(configFile);
    assert.equal(status.deliveries[0]?.lastDeliveredSequence, 1);
    assert.equal(status.deliveries[0]?.accepted, 1);

    await writeFile(syncLockFile, "{invalid lock metadata}\n", "utf8");
    const staleAtSeconds = Date.now() / 1_000 - 120;
    await utimes(syncLockFile, staleAtSeconds, staleAtSeconds);
    const recoveredCycle = await runConfiguredSyncCycle(configFile);
    assert.equal(recoveredCycle.deliveredEvents, 0);
    assert.equal(recoveredCycle.accepted, 0);
  } finally {
    server.close();
    if (previousCredentialStore === undefined) {
      delete process.env["UMS_TEST_CREDENTIAL_STORE_FILE"];
    } else {
      process.env["UMS_TEST_CREDENTIAL_STORE_FILE"] = previousCredentialStore;
    }
    if (previousPlaintextCredentialStore === undefined) {
      delete process.env["UMS_ALLOW_PLAINTEXT_TEST_CREDENTIAL_STORE"];
    } else {
      process.env["UMS_ALLOW_PLAINTEXT_TEST_CREDENTIAL_STORE"] =
        previousPlaintextCredentialStore;
    }
    if (previousCodexRoots === undefined) {
      delete process.env["UMS_DISCOVERY_CODEX_ROOTS"];
    } else {
      process.env["UMS_DISCOVERY_CODEX_ROOTS"] = previousCodexRoots;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("configured sync fails closed when an active daemon lock never becomes reclaimable", async () => {
  const tempDir = await mkdtemp(
    resolve(tmpdir(), "ums-daemon-sync-lock-timeout-")
  );
  const stateRoot = resolve(tempDir, "ums-state");
  const configFile = resolve(tempDir, "config.jsonc");
  const syncLockFile = resolve(stateRoot, "sync.lock");

  try {
    await mkdir(stateRoot, { recursive: true });
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
        codex: { enabled: false },
        claude: { enabled: false },
        plan: { enabled: false },
      },
      routes: [
        {
          match: {
            pathPrefix: tempDir,
            source: "plan",
          },
          memory: "personal",
          priority: 10,
        },
      ],
      defaults: {
        memory: "personal",
        onAmbiguous: "review",
      },
    });
    await writeFile(
      syncLockFile,
      `${JSON.stringify({
        pid: process.pid,
        acquiredAt: "2026-03-07T00:00:00.000Z",
      })}\n`,
      "utf8"
    );

    await assert.rejects(
      runConfiguredSyncCycle(configFile),
      (error: unknown) => {
        assert.match(String(error), /DaemonSyncLockError/);
        assert.match(String(error), /collector lock/);
        return true;
      }
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}, 15_000);

test("configured sync journals unmatched events into the review queue without delivering them", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "ums-daemon-sync-review-"));
  const homeDir = resolve(tempDir, "home");
  const codexDir = resolve(homeDir, ".codex", "sessions");
  const projectRoot = resolve(tempDir, "projects", "unrouted-app");
  const stateRoot = resolve(tempDir, "ums-state");
  const configFile = resolve(tempDir, "config.jsonc");
  const codexSessionFile = resolve(codexDir, "session.jsonl");

  try {
    await mkdir(codexDir, { recursive: true });
    await mkdir(projectRoot, { recursive: true });
    await writeFile(
      codexSessionFile,
      `${JSON.stringify({
        type: "session_meta",
        payload: {
          id: "review-session",
          cwd: projectRoot,
        },
      })}\n${JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: "Route this unmatched history into review only.",
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
        codexNative: { enabled: false },
        vscode: { enabled: false },
      },
      routes: [
        {
          match: {
            pathPrefix: resolve(tempDir, "other-project"),
            source: "codex",
          },
          memory: "personal",
          priority: 10,
        },
      ],
      defaults: {
        memory: "personal",
        onAmbiguous: "review",
      },
    });

    const summary = await runConfiguredSyncCycle(configFile);
    assert.equal(summary.preparedEvents, 1);
    assert.equal(summary.journaledEvents, 1);
    assert.equal(summary.reviewQueueEvents, 1);
    assert.equal(summary.droppedEvents, 0);
    assert.equal(summary.deliveredEvents, 0);
    assert.equal(summary.accepted, 0);

    const status = await getDaemonStatus(configFile);
    assert.equal(status.journal.entries, 1);
    assert.equal(status.journal.pendingReview, 1);
    assert.equal(status.journal.pendingDrop, 0);
    assert.equal(status.deliveries[0]?.pendingEvents, 0);
    assert.equal(status.deliveries[0]?.accepted, 0);
    assert.equal(status.deliveries[0]?.lastDeliveredSequence, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
