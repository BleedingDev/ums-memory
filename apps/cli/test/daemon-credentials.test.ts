import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { test } from "@effect-native/bun-test";
import { Cause, Effect, Exit } from "effect";

import {
  defaultCredentialRefForAccount,
  deleteManagedAccountCredential,
  getManagedAccountCredentialState,
  loadManagedAccountCredential,
  storeManagedAccountCredential,
} from "../../ums/src/daemon-credentials.ts";

test("daemon credentials store, load, and delete managed session material", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "ums-credentials-"));
  const previousStoreFile = process.env["UMS_TEST_CREDENTIAL_STORE_FILE"];
  const previousAllowPlaintext =
    process.env["UMS_ALLOW_PLAINTEXT_TEST_CREDENTIAL_STORE"];
  const storeFile = resolve(tempDir, "credentials.json");
  try {
    process.env["UMS_TEST_CREDENTIAL_STORE_FILE"] = storeFile;
    process.env["UMS_ALLOW_PLAINTEXT_TEST_CREDENTIAL_STORE"] = "true";

    await Effect.runPromise(
      storeManagedAccountCredential({
        credentialRef: defaultCredentialRefForAccount("company"),
        secret: "managed-session-token",
        storedAt: "2026-03-07T10:00:00.000Z",
      })
    );

    const loaded = await Effect.runPromise(
      loadManagedAccountCredential(defaultCredentialRefForAccount("company"))
    );
    assert.deepEqual(loaded, {
      kind: "managed-session",
      secret: "managed-session-token",
      storedAt: "2026-03-07T10:00:00.000Z",
      expiresAt: null,
    });

    const state = await Effect.runPromise(
      getManagedAccountCredentialState(
        defaultCredentialRefForAccount("company")
      )
    );
    assert.deepEqual(state, {
      status: "present",
      storedAt: "2026-03-07T10:00:00.000Z",
      expiresAt: null,
    });

    const removed = await Effect.runPromise(
      deleteManagedAccountCredential(defaultCredentialRefForAccount("company"))
    );
    assert.equal(removed, true);

    const missingState = await Effect.runPromise(
      getManagedAccountCredentialState(
        defaultCredentialRefForAccount("company")
      )
    );
    assert.deepEqual(missingState, {
      status: "missing",
      storedAt: null,
      expiresAt: null,
    });
  } finally {
    if (previousStoreFile === undefined) {
      delete process.env["UMS_TEST_CREDENTIAL_STORE_FILE"];
    } else {
      process.env["UMS_TEST_CREDENTIAL_STORE_FILE"] = previousStoreFile;
    }
    if (previousAllowPlaintext === undefined) {
      delete process.env["UMS_ALLOW_PLAINTEXT_TEST_CREDENTIAL_STORE"];
    } else {
      process.env["UMS_ALLOW_PLAINTEXT_TEST_CREDENTIAL_STORE"] =
        previousAllowPlaintext;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("daemon credentials reject invalid credential refs with tagged error", async () => {
  const exit = await Effect.runPromiseExit(
    loadManagedAccountCredential("invalid-ref")
  );
  assert.equal(Exit.isFailure(exit), true);
  if (Exit.isSuccess(exit)) {
    return;
  }
  const failure = Cause.squash(exit.cause) as {
    _tag?: string;
    message?: string;
  };
  assert.equal(failure._tag, "DaemonCredentialRefError");
  assert.match(failure.message ?? "", /Credential ref/i);
});

test("daemon credentials mark expired managed session material and fail closed on load", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "ums-credentials-expired-"));
  const previousStoreFile = process.env["UMS_TEST_CREDENTIAL_STORE_FILE"];
  const previousAllowPlaintext =
    process.env["UMS_ALLOW_PLAINTEXT_TEST_CREDENTIAL_STORE"];
  const credentialRef = defaultCredentialRefForAccount("company");
  try {
    process.env["UMS_TEST_CREDENTIAL_STORE_FILE"] = resolve(
      tempDir,
      "credentials.json"
    );
    process.env["UMS_ALLOW_PLAINTEXT_TEST_CREDENTIAL_STORE"] = "true";

    await Effect.runPromise(
      storeManagedAccountCredential({
        credentialRef,
        secret: "expired-managed-session-token",
        storedAt: "2026-03-07T10:00:00.000Z",
        expiresAt: "2000-01-01T00:00:00.000Z",
      })
    );

    const state = await Effect.runPromise(
      getManagedAccountCredentialState(credentialRef)
    );
    assert.deepEqual(state, {
      status: "expired",
      storedAt: "2026-03-07T10:00:00.000Z",
      expiresAt: "2000-01-01T00:00:00.000Z",
    });

    const exit = await Effect.runPromiseExit(
      loadManagedAccountCredential(credentialRef)
    );
    assert.equal(Exit.isFailure(exit), true);
    if (Exit.isSuccess(exit)) {
      return;
    }
    const failure = Cause.squash(exit.cause) as {
      _tag?: string;
      message?: string;
    };
    assert.equal(failure._tag, "DaemonCredentialExpiredError");
    assert.match(failure.message ?? "", /expired/i);
  } finally {
    if (previousStoreFile === undefined) {
      delete process.env["UMS_TEST_CREDENTIAL_STORE_FILE"];
    } else {
      process.env["UMS_TEST_CREDENTIAL_STORE_FILE"] = previousStoreFile;
    }
    if (previousAllowPlaintext === undefined) {
      delete process.env["UMS_ALLOW_PLAINTEXT_TEST_CREDENTIAL_STORE"];
    } else {
      process.env["UMS_ALLOW_PLAINTEXT_TEST_CREDENTIAL_STORE"] =
        previousAllowPlaintext;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("daemon credentials reject corrupt managed credential records with tagged error", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "ums-credentials-corrupt-"));
  const previousStoreFile = process.env["UMS_TEST_CREDENTIAL_STORE_FILE"];
  const previousAllowPlaintext =
    process.env["UMS_ALLOW_PLAINTEXT_TEST_CREDENTIAL_STORE"];
  const storeFile = resolve(tempDir, "credentials.json");
  try {
    process.env["UMS_TEST_CREDENTIAL_STORE_FILE"] = storeFile;
    process.env["UMS_ALLOW_PLAINTEXT_TEST_CREDENTIAL_STORE"] = "true";
    const recordKey = "ums-keychain|ums|company";
    await Effect.runPromise(
      Effect.promise(() =>
        writeFile(
          storeFile,
          `${JSON.stringify({ [recordKey]: "not-json" }, null, 2)}\n`,
          "utf8"
        )
      )
    );

    const exit = await Effect.runPromiseExit(
      loadManagedAccountCredential(defaultCredentialRefForAccount("company"))
    );
    assert.equal(Exit.isFailure(exit), true);
    if (Exit.isSuccess(exit)) {
      return;
    }
    const failure = Cause.squash(exit.cause) as {
      _tag?: string;
      message?: string;
    };
    assert.equal(failure._tag, "DaemonCredentialRecordError");
    assert.match(failure.message ?? "", /invalid/i);
  } finally {
    if (previousStoreFile === undefined) {
      delete process.env["UMS_TEST_CREDENTIAL_STORE_FILE"];
    } else {
      process.env["UMS_TEST_CREDENTIAL_STORE_FILE"] = previousStoreFile;
    }
    if (previousAllowPlaintext === undefined) {
      delete process.env["UMS_ALLOW_PLAINTEXT_TEST_CREDENTIAL_STORE"];
    } else {
      process.env["UMS_ALLOW_PLAINTEXT_TEST_CREDENTIAL_STORE"] =
        previousAllowPlaintext;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});
