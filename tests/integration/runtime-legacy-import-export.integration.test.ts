import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { test } from "@effect-native/bun-test";

import {
  exportStoreSnapshot,
  importStoreSnapshot,
  resetStore,
} from "../../apps/api/src/core.ts";

const ROOT = process.cwd();
const CLI_PATH = resolve(ROOT, "apps/cli/src/index.ts");
const IMPORT_SCRIPT_PATH = resolve(
  ROOT,
  "scripts/import-legacy-shared-state.ts"
);
const EXPORT_SCRIPT_PATH = resolve(
  ROOT,
  "scripts/export-legacy-shared-state.ts"
);

interface CommandResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

const runNode = (
  scriptPath: string,
  args: readonly string[],
  cwd: string
): Promise<CommandResult> =>
  new Promise((resolvePromise) => {
    const proc = spawn(process.execPath, [scriptPath, ...args], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
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
  });

test("ums-memory-2dc.5: legacy shared-state import/export tooling round-trips explicit compatibility snapshots", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "ums-legacy-import-export-"));
  const sourceFile = resolve(tempDir, "legacy-source.json");
  const stateFile = resolve(tempDir, ".ums-state.json");
  const outputFile = resolve(tempDir, "legacy-export.json");
  const sourceSnapshot = {
    stores: {
      "coding-agent": {
        profiles: {
          "legacy-profile": {
            events: [
              {
                id: "evt-legacy-import-1",
                source: "legacy",
                type: "note",
                content: "compat import export event",
              },
            ],
            rules: [],
            feedback: [],
            outcomes: [],
          },
        },
      },
    },
  };

  try {
    await writeFile(
      sourceFile,
      `${JSON.stringify(sourceSnapshot, null, 2)}\n`,
      "utf8"
    );

    const importResult = await runNode(
      IMPORT_SCRIPT_PATH,
      ["--source-file", sourceFile, "--state-file", stateFile],
      tempDir
    );
    assert.equal(importResult.code, 0, importResult.stderr);

    const contextResult = await runNode(
      CLI_PATH,
      [
        "context",
        "--state-file",
        stateFile,
        "--store-id",
        "coding-agent",
        "--input",
        JSON.stringify({
          profile: "legacy-profile",
          query: "compat import export event",
        }),
      ],
      tempDir
    );
    assert.equal(contextResult.code, 0, contextResult.stderr);
    const contextBody = JSON.parse(contextResult.stdout);
    assert.equal(contextBody.ok, true);
    assert.equal(contextBody.data.matches.length, 1);

    const exportResult = await runNode(
      EXPORT_SCRIPT_PATH,
      ["--state-file", stateFile, "--output-file", outputFile],
      tempDir
    );
    assert.equal(exportResult.code, 0, exportResult.stderr);

    const exportedSnapshot = JSON.parse(await readFile(outputFile, "utf8"));
    resetStore();
    importStoreSnapshot(sourceSnapshot);
    const expectedSnapshot = exportStoreSnapshot();
    assert.deepEqual(exportedSnapshot, expectedSnapshot);
  } finally {
    resetStore();
    await rm(tempDir, { recursive: true, force: true });
  }
});
