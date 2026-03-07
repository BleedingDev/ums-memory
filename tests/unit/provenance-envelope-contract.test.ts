import assert from "node:assert/strict";

import { test } from "@effect-native/bun-test";
import { Schema } from "effect";

import {
  IngestionRequestSchema,
  ProvenanceEnvelopeSchema,
} from "../../libs/shared/src/effect/contracts/services.ts";

test("provenance envelope schema accepts canonical tenant/project/user/agent lineage payload", () => {
  const decode = Schema.decodeUnknownSync(ProvenanceEnvelopeSchema);

  const decoded = decode({
    tenantId: "tenant-alpha",
    projectId: "project-memory",
    roleId: "role-backend",
    userId: "user-42",
    agentId: "agent-codex",
    conversationId: "chat-1001",
    messageId: "msg-2002",
    sourceId: "source-codex-cli",
    batchId: "batch-3003",
  });

  assert.equal(decoded.tenantId, "tenant-alpha");
  assert.equal(decoded.projectId, "project-memory");
  assert.equal(decoded.userId, "user-42");
  assert.equal(decoded.agentId, "agent-codex");
  assert.equal(decoded.conversationId, "chat-1001");
});

test("provenance envelope schema rejects payload without tenantId", () => {
  const decode = Schema.decodeUnknownSync(ProvenanceEnvelopeSchema);

  assert.throws(
    () =>
      decode({
        projectId: "project-memory",
        userId: "user-42",
      }),
    /ParseError|missing/i
  );
});

test("ingestion request schema accepts request-level and record-level provenance envelope", () => {
  const decode = Schema.decodeUnknownSync(IngestionRequestSchema as any);

  const decoded = decode({
    source: "codex-cli",
    idempotencyKey: "idem-provenance-001",
    occurredAtMillis: 1_745_000_000_000,
    provenance: {
      tenantId: "tenant-alpha",
      projectId: "project-memory",
      roleId: "role-backend",
      userId: "user-42",
      agentId: "agent-codex",
      conversationId: "chat-1001",
      sourceId: "source-codex-cli",
      batchId: "batch-3003",
    },
    records: [
      {
        recordId: "evidence-1",
        content: "provenance-aware memory payload",
        metadata: {},
        provenance: {
          tenantId: "tenant-alpha",
          messageId: "msg-2002",
          sourceId: "source-codex-cli",
        },
      },
    ],
  });
  assert.equal(decoded.records.length, 1);
  assert.equal(decoded.records[0]?.provenance?.tenantId, "tenant-alpha");
  assert.equal(decoded.provenance?.agentId, "agent-codex");
});
