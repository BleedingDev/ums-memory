import assert from "node:assert/strict";
import test from "node:test";

import {
  EventIdSchema,
  ProjectIdSchema,
  RunIdSchema,
  TenantIdSchema,
} from "../../libs/shared/src/effect/contracts/ids.ts";
import {
  AdapterSessionEnvelopeSchema,
  DeterministicDedupeDecisionSchema,
  GroundedAnswerSchema,
  MemoryCandidateExtractionSchema,
  PersistedMemoryRecordSchema,
  RetrievalResponseSchema,
  SchemaEvolutionPolicySchema,
  SchemaVersionSchema,
} from "../../libs/shared/src/effect/contracts/services.ts";
import { decodeUnknownSync } from "../../libs/shared/src/effect/contracts/validators.ts";

const decodeTenantId = decodeUnknownSync(TenantIdSchema);
const decodeProjectId = decodeUnknownSync(ProjectIdSchema);
const decodeRunId = decodeUnknownSync(RunIdSchema);
const decodeEventId = decodeUnknownSync(EventIdSchema);

const decodeAdapterSessionEnvelope = decodeUnknownSync(
  AdapterSessionEnvelopeSchema
);
const decodeMemoryCandidateExtraction = decodeUnknownSync(
  MemoryCandidateExtractionSchema
);
const decodePersistedMemoryRecord = decodeUnknownSync(
  PersistedMemoryRecordSchema
);
const decodeDeterministicDedupeDecision = decodeUnknownSync(
  DeterministicDedupeDecisionSchema
);
const decodeGroundedAnswer = decodeUnknownSync(GroundedAnswerSchema);
const decodeRetrievalResponse = decodeUnknownSync(RetrievalResponseSchema);
const decodeSchemaVersion = decodeUnknownSync(SchemaVersionSchema);
const decodeSchemaEvolutionPolicy = decodeUnknownSync(
  SchemaEvolutionPolicySchema
);

test("ums-memory-y9m.2: canonical ID schemas decode tenant/project/run/event identifiers", () => {
  assert.equal(decodeTenantId("tenant-acme"), "tenant-acme");
  assert.equal(decodeProjectId("project-memory"), "project-memory");
  assert.equal(decodeRunId("run-shadow-001"), "run-shadow-001");
  assert.equal(decodeEventId("event-42"), "event-42");

  assert.throws(() => decodeTenantId(""), /ParseError|non-empty|length/i);
  assert.throws(
    () => decodeProjectId("   "),
    /ParseError|trim|leading or trailing whitespace/i
  );
});

test("ums-memory-y9m.3: adapter session envelope schema normalizes codex/claude/cursor/opencode/vscode payloads", () => {
  const decoded = decodeAdapterSessionEnvelope({
    tenantId: "tenant-1",
    spaceId: "workspace-1",
    source: "cursor",
    sessionId: "session-1",
    runId: "run-1",
    startedAt: "2026-03-04T00:00:00.000Z",
    endedAt: "2026-03-04T00:05:00.000Z",
    messages: [
      {
        eventId: "event-1",
        messageId: "message-1",
        role: "user",
        content: "Find memory dedupe regressions",
        createdAt: "2026-03-04T00:00:00.000Z",
        citations: [],
      },
      {
        eventId: "event-2",
        messageId: "message-2",
        role: "assistant",
        content: "Running schema validation now",
        createdAt: "2026-03-04T00:01:00.000Z",
        citations: ["evidence-1"],
      },
    ],
  });

  assert.equal(decoded.source, "cursor");
  assert.equal(decoded.messages.length, 2);
  assert.equal(decoded.messages[1]?.role, "assistant");

  assert.throws(
    () =>
      decodeAdapterSessionEnvelope({
        tenantId: "tenant-1",
        spaceId: "workspace-1",
        source: "cursor",
        sessionId: "session-1",
        runId: "run-1",
        startedAt: "2026-03-04T00:00:00.000Z",
        messages: [
          {
            eventId: "event-1",
            messageId: "message-1",
            role: "observer",
            content: "invalid role",
            createdAt: "2026-03-04T00:00:00.000Z",
            citations: [],
          },
        ],
      }),
    /ParseError|role/i
  );
});

test("ums-memory-y9m.4: memory candidate extraction and persisted memory record contracts decode valid payloads", () => {
  const extraction = decodeMemoryCandidateExtraction({
    extractionRunId: "run-17",
    spaceId: "workspace-2",
    candidateId: "candidate-22",
    statement: "Prefer deterministic dedupe reason ordering.",
    scope: "project",
    sourceEpisodeIds: ["evidence-1", "evidence-2"],
    extractedAtMillis: 1_746_000_000_000,
    provenance: {
      tenantId: "tenant-2",
      projectId: "project-2",
      sourceId: "source-codex",
    },
  });

  const persisted = decodePersistedMemoryRecord({
    spaceId: "workspace-2",
    memoryId: "memory-22",
    layer: "procedural",
    statement: "Document compatibility mode for schema evolution.",
    scope: "project",
    evidenceIds: ["evidence-1"],
    citations: [
      {
        citationId: "evidence-1",
        memoryId: "memory-22",
        startOffset: 0,
        endOffset: 45,
        quote: "Document compatibility mode for schema evolution.",
      },
    ],
    createdAtMillis: 1_746_000_000_000,
    updatedAtMillis: 1_746_000_000_500,
    version: 1,
  });

  assert.equal(extraction.extractionRunId, "run-17");
  assert.equal(persisted.citations.length, 1);
  assert.equal(persisted.version, 1);
});

test("ums-memory-y9m.5: deterministic dedupe artifacts enforce action/reason/metric evidence contracts", () => {
  const decoded = decodeDeterministicDedupeDecision({
    action: "update",
    reasonCodes: ["SEMANTIC_SUPERSET", "RECENCY_PREFERENCE"],
    metricEvidence: {
      lexicalSimilarity: 0.74,
      semanticSimilarity: 0.89,
      recencyDeltaMillis: 9_000,
      confidenceDelta: 0.14,
    },
    targetMemoryId: "memory-42",
  });

  assert.equal(decoded.action, "update");
  assert.equal(decoded.reasonCodes.length, 2);
  assert.equal(decoded.metricEvidence.semanticSimilarity, 0.89);

  assert.throws(
    () =>
      decodeDeterministicDedupeDecision({
        action: "update",
        reasonCodes: ["UNKNOWN_REASON"],
        metricEvidence: {
          lexicalSimilarity: 0.6,
          semanticSimilarity: 0.6,
          recencyDeltaMillis: 0,
          confidenceDelta: 0,
        },
      }),
    /ParseError|reason/i
  );
});

test("ums-memory-y9m.6: grounded answer schema enforces citation ranges and retrieval response grounding", () => {
  const groundedAnswer = decodeGroundedAnswer({
    answer: "Use schema-boundary validation before API deployment.",
    citations: [
      {
        citationId: "evidence-99",
        memoryId: "memory-99",
        sourceId: "source-vscode",
        startOffset: 0,
        endOffset: 24,
        quote: "Use schema-boundary validation",
      },
    ],
  });

  const retrieval = decodeRetrievalResponse({
    hits: [
      {
        memoryId: "memory-99",
        layer: "procedural",
        score: 0.93,
        excerpt: "Use schema-boundary validation before API deployment.",
      },
    ],
    totalHits: 1,
    nextCursor: null,
    actionablePack: {
      do: ["Run schema boundary checks before release."],
      dont: ["Bypass runtime decoders at API edges."],
      examples: ["Call contract decoders from effect/contracts/validators."],
      risks: ["Cross-tenant contamination from unchecked payloads."],
      sources: [
        {
          memoryId: "memory-99",
          excerpt: "Use schema-boundary validation before API deployment.",
          metadata: {
            score: 0.93,
            layer: "procedural",
          },
        },
      ],
      warnings: ["Validate backward compatibility for contract bumps."],
    },
    groundedAnswer,
  });

  assert.equal(retrieval.groundedAnswer?.citations.length, 1);
  assert.equal(retrieval.groundedAnswer?.citations[0]?.memoryId, "memory-99");
});

test("ums-memory-y9m.7: schema versioning strategy enforces explicit compatibility metadata", () => {
  const version = decodeSchemaVersion({
    major: 1,
    minor: 2,
    patch: 3,
  });
  assert.deepEqual(version, { major: 1, minor: 2, patch: 3 });

  const policy = decodeSchemaEvolutionPolicy({
    contract: "AdapterSessionEnvelope",
    version,
    compatibilityMode: "backward",
    migrationNotes: "Added optional metadata field.",
    effectiveFrom: "2026-03-04T00:00:00.000Z",
  });
  assert.equal(policy.compatibilityMode, "backward");

  assert.throws(
    () =>
      decodeSchemaEvolutionPolicy({
        contract: "AdapterSessionEnvelope",
        version,
        compatibilityMode: "unsupported",
        effectiveFrom: "2026-03-04T00:00:00.000Z",
      }),
    /ParseError|compatibility/i
  );
});

test("ums-memory-y9m.8: corpus-based decoder invariants remain deterministic across repeated decodes", () => {
  const adapterCorpus: readonly unknown[] = [
    {
      tenantId: "tenant-corpus",
      spaceId: "space-corpus",
      source: "codex-cli",
      sessionId: "session-corpus-1",
      runId: "run-corpus-1",
      startedAt: "2026-03-04T02:00:00.000Z",
      messages: [
        {
          eventId: "event-corpus-1",
          messageId: "message-corpus-1",
          role: "user",
          content: "Need canonical schema docs.",
          createdAt: "2026-03-04T02:00:00.000Z",
          citations: [],
        },
      ],
    },
    {
      tenantId: "tenant-corpus",
      spaceId: "space-corpus",
      source: "vscode",
      sessionId: "session-corpus-2",
      runId: "run-corpus-2",
      startedAt: "2026-03-04T02:10:00.000Z",
      messages: [
        {
          eventId: "event-corpus-2",
          messageId: "message-corpus-2",
          role: "assistant",
          content: "Grounded answer citations are now required.",
          createdAt: "2026-03-04T02:10:00.000Z",
          citations: ["evidence-corpus-1"],
        },
      ],
    },
  ];

  for (const payload of adapterCorpus) {
    const firstDecode = decodeAdapterSessionEnvelope(payload);
    const secondDecode = decodeAdapterSessionEnvelope(payload);
    assert.deepEqual(secondDecode, firstDecode);
  }

  const malformedCorpus: readonly unknown[] = [
    {
      tenantId: "tenant-corpus",
      spaceId: "space-corpus",
      source: "codex-cli",
      sessionId: "session-corpus-1",
      runId: "run-corpus-1",
      startedAt: "2026-03-04T02:00:00.000Z",
      messages: [
        {
          eventId: "event-corpus-1",
          messageId: "message-corpus-1",
          role: "user",
          content: "",
          createdAt: "2026-03-04T02:00:00.000Z",
          citations: [],
        },
      ],
    },
  ];

  for (const payload of malformedCorpus) {
    assert.throws(
      () => decodeAdapterSessionEnvelope(payload),
      /ParseError|non-empty|content/i
    );
  }
});
