import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { test } from "@effect-native/bun-test";

import { evaluateGoldenReplayCorpus } from "../../scripts/eval-golden-replay.ts";

const ROOT = process.cwd();
const FIXTURE_DIR = resolve(ROOT, "tests/fixtures/eval/golden-replay");
const SCRIPT_PATH = resolve(ROOT, "scripts/eval-golden-replay.ts");

interface CommandResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

const runBun = (args: readonly string[], cwd: string): Promise<CommandResult> =>
  new Promise((resolvePromise) => {
    const proc = spawn(process.execPath, args, {
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

async function copyFixtureCorpus(targetDir: string): Promise<void> {
  const fixtureFiles = (await readdir(FIXTURE_DIR))
    .filter((entry) => entry.endsWith(".json"))
    .sort((left, right) => left.localeCompare(right));

  for (const fixtureFile of fixtureFiles) {
    const sourcePath = resolve(FIXTURE_DIR, fixtureFile);
    const targetPath = resolve(targetDir, fixtureFile);
    await writeFile(targetPath, await readFile(sourcePath, "utf8"), "utf8");
  }
}

test("ums-memory-jny.1: golden replay corpus passes with stable fixture digests", async () => {
  const result = await evaluateGoldenReplayCorpus();

  assert.equal(result.ok, true);
  assert.deepEqual(result.failures, []);
  assert.equal(result.fixtureCount, 2);
  assert.deepEqual(
    result.results.map((entry) => entry.fixtureId),
    ["redaction-and-guardrails", "store-space-isolation-and-duplicates"]
  );
  assert.ok(
    result.results.every(
      (entry) =>
        entry.ok &&
        entry.fixtureDigest !== null &&
        entry.fixtureDigest === entry.actualFixtureDigest
    )
  );

  const cliResult = await runBun([SCRIPT_PATH, "--json"], ROOT);
  assert.equal(cliResult.code, 0, cliResult.stderr);

  const cliBody = JSON.parse(cliResult.stdout) as {
    ok: boolean;
    fixtureCount: number;
  };
  assert.equal(cliBody.ok, true);
  assert.equal(cliBody.fixtureCount, 2);
});

test("ums-memory-jny.1: golden replay rejects tampered corpus without digest review", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "ums-golden-replay-"));

  try {
    await copyFixtureCorpus(tempDir);

    const tamperedFixturePath = resolve(
      tempDir,
      "redaction-and-guardrails.json"
    );
    const tamperedFixture = JSON.parse(
      await readFile(tamperedFixturePath, "utf8")
    ) as {
      description: string;
    };
    tamperedFixture.description =
      "Tampered without fixtureDigest review to prove the corpus guardrail.";
    await writeFile(
      tamperedFixturePath,
      `${JSON.stringify(tamperedFixture, null, 2)}\n`,
      "utf8"
    );

    const result = await evaluateGoldenReplayCorpus({
      fixtureDir: tempDir,
    });
    assert.equal(result.ok, false);

    const tamperedResult = result.results.find(
      (entry) => entry.fixtureId === "redaction-and-guardrails"
    );
    assert.ok(tamperedResult);
    assert.ok(
      tamperedResult.failures.some(
        (failure) => failure.code === "FIXTURE_DIGEST_MISMATCH"
      )
    );

    const cliResult = await runBun(
      [SCRIPT_PATH, "--fixture-dir", tempDir, "--json"],
      ROOT
    );
    assert.equal(cliResult.code, 1, cliResult.stdout);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
