# Optional Vector Retrieval Extension Evaluation (bead `ums-memory-dd2.3`)

## Purpose

Evaluate an optional vector retrieval extension that improves semantic recall quality while preserving deterministic fallback behavior, tenant isolation, and strict TypeScript + Effect boundaries.

This is a design and rollout plan, not a full production implementation.

## Scope

In scope:

- Define where vector retrieval can augment the current lexical retrieval planner.
- Define deterministic fallback and failure behavior when vector systems are unavailable.
- Define strict contract boundaries for Effect services, errors, and schemas.
- Define rollout and go/no-go metrics before general availability.

Out of scope:

- Replacing lexical retrieval as the default serving path.
- Introducing mandatory cloud vector services for local-first deployments.
- Changing the existing common/project/job_role/user scope model.

## Current Baseline (Must Remain Stable)

Current deterministic retrieval behavior is implemented in:

- `libs/shared/src/effect/services/retrieval-service.ts`
- `libs/shared/src/effect/contracts/services.ts`
- `tests/unit/multi-scope-retrieval-planner.test.mjs`
- `tests/unit/determinism.test.mjs`

Baseline requirements:

- Lexical retrieval remains available in all environments.
- Existing retrieval contract payloads stay backward compatible.
- SQLite remains the source of truth for canonical memory items.

## Extension Goals

1. Improve recall for semantically similar but lexically different queries.
2. Keep deterministic ranking and replay behavior for the same snapshot and query.
3. Keep vector retrieval optional and feature-flagged per tenant/space.
4. Keep write paths resilient even when vector indexing is delayed or unhealthy.

## Proposed Architecture

### Read path

1. Run existing lexical retrieval planner (always).
2. If vector retrieval is optional and enabled, request nearest-neighbor candidates from vector index.
3. Merge lexical and vector candidates with deterministic scoring and tie-breakers.
4. Return results through the existing retrieval contract shape.

### Write path

1. Persist memory item through the canonical storage adapter first.
2. Emit vector indexing task asynchronously (non-blocking for source-of-truth writes).
3. If indexing fails, store structured failure telemetry and retry; do not fail the source write.

## Deterministic Fallback Contract

The deterministic fallback contract is mandatory:

- If vector retrieval is disabled, unavailable, unhealthy, or times out, serve lexical-only results.
- If vector search returns malformed payloads, ignore vector contribution and serve lexical-only results.
- Lexical-only output must remain byte-stable for identical snapshot, request, and ranking weights.
- Final merged ranking must be deterministic with fixed tie-break sequence:
  - `score` descending
  - `updatedAtMillis` descending
  - `memoryId` ascending

Timeout defaults for vector branch:

- soft timeout: 50 ms
- hard timeout: 100 ms
- on timeout, fallback to lexical and emit `retrieval.vector.fallback.timeout`

## Proposed Effect Service Contracts

New contracts should be introduced in strict TypeScript modules:

- `VectorEmbeddingService`
  - `embedQuery(query: string) => Effect<ReadonlyArray<number>, VectorEmbeddingError>`
  - `embedMemory(payload: IngestionMetadata) => Effect<ReadonlyArray<number>, VectorEmbeddingError>`
- `VectorIndexService`
  - `upsert(request) => Effect<void, VectorIndexWriteError>`
  - `remove(request) => Effect<void, VectorIndexWriteError>`
  - `search(request) => Effect<ReadonlyArray<VectorCandidate>, VectorIndexSearchError>`
- `VectorRetrievalPolicyService` (optional)
  - tenant/space feature gating and safety kill switch checks

Error taxonomy must use tagged errors and explicit context:

- `VectorEmbeddingError`
- `VectorIndexUnavailableError`
- `VectorIndexSearchError`
- `VectorIndexWriteError`

## Backend Options and Recommendation

| Option | Runtime fit | Determinism fit | Operational overhead | Notes |
| --- | --- | --- | --- | --- |
| SQLite extension (`sqlite-vec` style) | high for local-first | high | low | closest to current deployment model |
| Postgres `pgvector` | medium now, high after dd2.2 cutover | high | medium | aligns with future scale path |
| External vector service | low for first rollout | medium | high | adds network and control-plane complexity |

Recommendation:

- Pilot with local SQLite vector extension semantics first.
- Keep Postgres `pgvector` path as the scale-up target once Postgres adapter rollout is stable.
- Do not require external vector infrastructure in initial enterprise rollout.

## Replay and Evaluation Gates

Vector branch must pass replay evaluation before serving traffic:

- historical replay corpus and canary replay set
- regression checks:
  - no increase in policy violations
  - no deterministic replay mismatches
  - no significant p95 latency regression beyond threshold

Required thresholds for go decision:

- semantic recall improvement >= 8% on replay benchmark set
- deterministic mismatch rate == 0 on lexical-only fallback checks
- p95 latency delta <= 15% vs lexical baseline
- fallback success rate >= 99.9%

## Rollout Plan

| Phase | Goal | Exit criteria |
| --- | --- | --- |
| 0. Contract lock | Freeze service/error/schema contracts | Runbook approved and referenced from standards |
| 1. Shadow index | Build and maintain vector index off serving path | index freshness and write durability metrics stable |
| 2. Shadow retrieval | Compare merged ranking offline against lexical baseline | replay gates pass and determinism checks green |
| 3. Canary serving | Enable vector merge for small tenant allowlist | no Sev1 incidents, latency within target, policy parity maintained |
| 4. Controlled expansion | expand enablement gradually | sustained SLA and quality metrics over 14 days |

## Operational Metrics

Track at minimum:

- `retrieval.vector.enabled_requests`
- `retrieval.vector.fallback_requests`
- `retrieval.vector.search_latency_ms`
- `retrieval.vector.index_staleness_seconds`
- `retrieval.vector.merge_mismatch_count`
- `retrieval.vector.policy_violation_delta`

All metrics must be segmented by tenant and space.

## Explicit Non-Goals

- No mandatory Kubernetes dependency for the vector path.
- No replacement of deterministic lexical retrieval guarantees.
- No bypass of policy enforcement or tenant isolation checks.
- No automatic promotion of vector-only memories without replay evaluation.
