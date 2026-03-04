# Phase 0 Effect Schema Canonical Domain Model

## Purpose
Define and validate the canonical TypeScript + Effect Schema contracts for memory entities, adapter ingestion envelopes, dedupe artifacts, retrieval citations, and schema evolution.

## Scope
- Phase: `Lerim-Inspired TS Memory Phase 0`
- Epic: `ums-memory-y9m`
- Coverage: `SCH-01` through `SCH-10`

## SCH-01 Canonical Entity Inventory
- Canonical entities and invariants are defined in [`libs/shared/src/entities.ts`](../../libs/shared/src/entities.ts).
- Persisted/transit entities include episodes, working memory entries, procedural rules, anti-patterns, learner profiles, identity graph edges, misconceptions, curriculum plan items, review schedules, and personalization policy decisions.
- Deterministic identity, evidence linkage, and isolation invariants are validated by:
  - [`tests/unit/domain-entity-models.test.ts`](../../tests/unit/domain-entity-models.test.ts)
  - [`tests/unit/learner-profile-identity-graph-entities.test.ts`](../../tests/unit/learner-profile-identity-graph-entities.test.ts)

## SCH-02 Canonical IDs and Provenance Primitives
- Branded ID primitives are defined in [`libs/shared/src/effect/contracts/ids.ts`](../../libs/shared/src/effect/contracts/ids.ts).
- `tenant`, `project`, `role`, `user`, `agent`, `conversation`, `message`, `source`, `batch`, `run`, `event`, `space`, `profile`, `memory`, and `evidence` IDs are schema-validated and runtime-decoded through Effect Schema.
- Provenance envelope contracts are defined in [`libs/shared/src/effect/contracts/services.ts`](../../libs/shared/src/effect/contracts/services.ts) and validated by [`tests/unit/provenance-envelope-contract.test.ts`](../../tests/unit/provenance-envelope-contract.test.ts).
- Scope authorization boundary contract (`ScopeAuthorizationInputSchema`) is part of the canonical edge contract for storage and retrieval APIs.

## SCH-03 Normalized Adapter Session Envelope
- Normalized adapter envelopes are defined via:
  - `AdapterSourceSchema`
  - `AdapterSessionMessageSchema`
  - `AdapterSessionEnvelopeSchema`
- Supported sources are `codex-cli`, `claude-code`, `cursor`, `opencode`, and `vscode`.
- Contract decoding evidence is in [`tests/unit/effect-schema-domain-model-contract.test.ts`](../../tests/unit/effect-schema-domain-model-contract.test.ts).

## SCH-04 Memory Candidate and Persisted Memory Contracts
- Candidate extraction contract: `MemoryCandidateExtractionSchema`.
- Persisted memory contract: `PersistedMemoryRecordSchema`.
- Lifecycle candidate contract remains in `MemoryLifecycleCandidateSchema`.
- These contracts define required IDs, timestamps, versioning, and citation/provenance linkage.

## SCH-05 Deterministic Dedupe Decision Artifacts
- Dedupe decision contracts:
  - `DeterministicDedupeActionSchema` (`add` | `update` | `noop`)
  - `DeterministicDedupeReasonCodeSchema`
  - `DeterministicDedupeMetricEvidenceSchema`
  - `DeterministicDedupeDecisionSchema`
- `MemoryLifecycleShadowWriteResponseSchema` includes optional `dedupeDecision` evidence payload.

## SCH-06 Retrieval Hits and Grounded Citations
- Retrieval contracts include:
  - `RetrievalHitSchema`
  - `RetrievalExplainabilityHitSchema`
  - `GroundedAnswerCitationSchema`
  - `GroundedAnswerSchema`
- `RetrievalResponseSchema` can include a grounded answer with explicit citations.

## SCH-07 Schema Evolution and Compatibility
- Schema evolution metadata:
  - `SchemaVersionSchema`
  - `SchemaCompatibilityModeSchema` (`backward` | `forward` | `breaking`)
  - `SchemaEvolutionPolicySchema`
- Compatibility policy: forward/backward changes require decoder compatibility; breaking changes must ship with migration notes and explicit version bump.

## SCH-08 Decoder Corpus and Property Coverage
- Decoder invariants and malformed corpus validation are exercised in:
  - [`tests/unit/effect-schema-domain-model-contract.test.ts`](../../tests/unit/effect-schema-domain-model-contract.test.ts)
- Coverage includes repeatable decode behavior across valid corpus payloads and expected failure for malformed payloads.

## SCH-09 Schema-Only Boundary Enforcement
- Boundary policy is enforced by [`scripts/validate-schema-boundaries.ts`](../../scripts/validate-schema-boundaries.ts).
- The validator rejects:
  - `zod` imports in adapter/API edge modules.
  - direct `Schema.decodeUnknown*` calls at edge modules that bypass contract validators.
- Validation tests live in [`tests/unit/schema-boundaries-validation.test.ts`](../../tests/unit/schema-boundaries-validation.test.ts).

## SCH-10 Package Usage and Integration Examples
### Example: Normalize an adapter envelope
```ts
import { Schema } from "effect";
import { AdapterSessionEnvelopeSchema } from "../../libs/shared/src/effect/contracts/services.ts";

const decodeAdapterSessionEnvelope = Schema.decodeUnknownSync(
  AdapterSessionEnvelopeSchema
);

const envelope = decodeAdapterSessionEnvelope(input);
```

### Example: Decode deterministic dedupe decisions
```ts
import { decodeDeterministicDedupeDecision } from "../../libs/shared/src/effect/contracts/validators.ts";

const decision = decodeDeterministicDedupeDecision(input);
```

### Example: Enforce boundary policy in quality gate
```bash
npm run validate:schema-boundaries
```

## Exit Criteria Evidence
- Contracts: [`libs/shared/src/effect/contracts/services.ts`](../../libs/shared/src/effect/contracts/services.ts)
- Validators: [`libs/shared/src/effect/contracts/validators.ts`](../../libs/shared/src/effect/contracts/validators.ts)
- Tests: [`tests/unit/effect-schema-domain-model-contract.test.ts`](../../tests/unit/effect-schema-domain-model-contract.test.ts), [`tests/unit/schema-boundaries-validation.test.ts`](../../tests/unit/schema-boundaries-validation.test.ts)
- Gate: [`scripts/validate-schema-boundaries.ts`](../../scripts/validate-schema-boundaries.ts)
