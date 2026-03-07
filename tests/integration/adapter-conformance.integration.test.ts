import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { test } from "@effect-native/bun-test";

import {
  SUPPORTED_ADAPTERS,
  evaluateAdapterConformance,
} from "../../scripts/eval-adapter-conformance.ts";

test("ums-memory-jny.2: adapter conformance corpus covers every supported adapter plus malformed and replay cases", async () => {
  const result = await evaluateAdapterConformance();

  assert.equal(result.ok, true);
  assert.deepEqual(result.adaptersCovered, [...SUPPORTED_ADAPTERS]);
  assert.deepEqual(result.passingAdapters, [...SUPPORTED_ADAPTERS]);
  assert.deepEqual(result.missingAdapters, []);
  assert.equal(result.replayCaseCount >= SUPPORTED_ADAPTERS.length, true);
  assert.equal(result.malformedCaseCount >= 2, true);
  assert.deepEqual(result.failedCaseIds, []);
  assert.ok(result.caseResults.every((entry) => entry.ok));
});

test("ums-memory-jny.2: adapter conformance checker fails when a temporary corpus omits supported adapters", async () => {
  const fixtureDirectory = await mkdtemp(
    resolve(tmpdir(), "adapter-conformance-missing-")
  );

  try {
    await mkdir(fixtureDirectory, { recursive: true });
    await writeFile(
      resolve(fixtureDirectory, "replay-codex-cli.json"),
      `${JSON.stringify(
        {
          schemaVersion: "adapter_conformance_fixture.v1",
          id: "replay-codex-cli-only",
          description:
            "Temporary corpus covers only one supported adapter to exercise missing-adapter failures.",
          kind: "replay",
          adapter: "codex-cli",
          replayCount: 2,
          input: {
            tenantId: "tenant-temp",
            spaceId: "workspace-temp",
            source: "codex-cli",
            sessionId: "session-temp",
            runId: "run-temp",
            startedAt: "2026-03-04T18:00:00.000Z",
            messages: [
              {
                eventId: "event-temp-1",
                messageId: "message-temp-1",
                role: "user",
                content: "Only one adapter is present.",
                createdAt: "2026-03-04T18:00:00.000Z",
                citations: [],
              },
            ],
          },
          expected: {
            tenantId: "tenant-temp",
            spaceId: "workspace-temp",
            source: "codex-cli",
            sessionId: "session-temp",
            messageCount: 1,
            roles: ["user"],
            citationCounts: [0],
          },
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    await writeFile(
      resolve(fixtureDirectory, "malformed-source.json"),
      `${JSON.stringify(
        {
          schemaVersion: "adapter_conformance_fixture.v1",
          id: "malformed-source-temp",
          description: "Temporary malformed source fixture.",
          kind: "malformed",
          input: {
            tenantId: "tenant-temp",
            spaceId: "workspace-temp",
            source: "unsupported-source",
            sessionId: "session-temp-malformed",
            runId: "run-temp-malformed",
            startedAt: "2026-03-04T18:05:00.000Z",
            messages: [
              {
                eventId: "event-temp-2",
                messageId: "message-temp-2",
                role: "assistant",
                content: "This should not pass.",
                createdAt: "2026-03-04T18:05:00.000Z",
                citations: [],
              },
            ],
          },
          expectedErrorPattern: "ParseError|source",
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const result = await evaluateAdapterConformance({ fixtureDirectory });

    assert.equal(result.ok, false);
    assert.deepEqual(result.adaptersCovered, ["codex-cli"]);
    assert.deepEqual(
      result.missingAdapters,
      SUPPORTED_ADAPTERS.filter((adapter) => adapter !== "codex-cli")
    );
    assert.equal(result.replayCaseCount, 1);
    assert.equal(result.malformedCaseCount, 1);
    assert.deepEqual(result.failedCaseIds, []);
  } finally {
    await rm(fixtureDirectory, { recursive: true, force: true });
  }
});
