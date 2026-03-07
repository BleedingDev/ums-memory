import assert from "node:assert/strict";

import { test } from "@effect-native/bun-test";

import { classifyStorageDualRunMismatchReason } from "../../apps/api/src/storage-dualrun.ts";

test("ums-memory-onf.4: storage dual-run mismatch classifier detects version-only divergence", () => {
  const reason = classifyStorageDualRunMismatchReason(
    {
      accepted: true,
      memoryId: "memory-a",
      spaceId: "tenant-a",
      persistedAtMillis: 1700000000100,
      version: 1,
    },
    {
      accepted: true,
      memoryId: "memory-a",
      spaceId: "tenant-a",
      persistedAtMillis: 1700000000200,
      version: 2,
    }
  );

  assert.equal(reason, "version_field_divergence");
});

test("ums-memory-onf.4: storage dual-run mismatch classifier detects operation result divergence", () => {
  const reason = classifyStorageDualRunMismatchReason(
    {
      _tag: "StorageNotFoundError",
      spaceId: "tenant-a",
      memoryId: "missing-memory",
    },
    {
      _tag: "StorageConflictError",
      spaceId: "tenant-a",
      memoryId: "missing-memory",
    }
  );

  assert.equal(reason, "operation_result_mismatch");
});

test("ums-memory-onf.4: storage dual-run mismatch classifier detects snapshot state divergence", () => {
  const reason = classifyStorageDualRunMismatchReason(
    {
      memories: [
        {
          layer: "working",
          memoryId: "memory-a",
          payload: { title: "left" },
          spaceId: "tenant-a",
          version: 1,
        },
      ],
      idempotencyLedger: [],
    },
    {
      memories: [
        {
          layer: "working",
          memoryId: "memory-a",
          payload: { title: "right" },
          spaceId: "tenant-a",
          version: 1,
        },
      ],
      idempotencyLedger: [],
    }
  );

  assert.equal(reason, "snapshot_state_mismatch");
});
