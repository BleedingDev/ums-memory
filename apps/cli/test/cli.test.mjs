import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { resetStore } from "../../api/src/core.mjs";

const CLI_PATH = resolve(process.cwd(), "apps/cli/src/index.mjs");

function runCli(args, stdin = "") {
  return new Promise((resolvePromise) => {
    const proc = spawn(process.execPath, [CLI_PATH, ...args], {
      stdio: ["pipe", "pipe", "pipe"]
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
        events: [{ type: "note", source: "cli", content: "wire same core" }]
      })
    ]);
    assert.equal(ingest.code, 0);
    const ingestBody = JSON.parse(ingest.stdout);
    assert.equal(ingestBody.ok, true);
    assert.equal(ingestBody.data.operation, "ingest");
    assert.equal(ingestBody.data.accepted, 1);

    const context = await runCli([
      "context",
      "--state-file",
      stateFile,
      "--input",
      "{\"profile\":\"cli-test\",\"query\":\"wire\"}"
    ]);
    assert.equal(context.code, 0);
    const contextBody = JSON.parse(context.stdout);
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
        events: [{ type: "task", source: "stdin", content: "stdin payload" }]
      })
    );
    assert.equal(ingest.code, 0);
    const body = JSON.parse(ingest.stdout);
    assert.equal(body.ok, true);
    assert.equal(body.data.profile, "stdin-test");
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
    assert.equal(jiraIngest.code, 0);

    const codingIngest = await runCli([
      "ingest",
      "--state-file",
      stateFile,
      "--store-id",
      "coding-agent",
      "--input",
      JSON.stringify({
        profile: "shared-profile",
        events: [{ type: "note", source: "codex", content: "coding only note" }],
      }),
    ]);
    assert.equal(codingIngest.code, 0);

    const jiraContext = await runCli([
      "context",
      "--state-file",
      stateFile,
      "--store-id",
      "jira-history",
      "--input",
      JSON.stringify({ profile: "shared-profile", query: "coding only note" }),
    ]);
    const jiraBody = JSON.parse(jiraContext.stdout);
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
    const codingBody = JSON.parse(codingContext.stdout);
    assert.equal(codingBody.ok, true);
    assert.equal(codingBody.data.matches.length, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
