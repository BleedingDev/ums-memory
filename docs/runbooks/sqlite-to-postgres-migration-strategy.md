# SQLite to Postgres Migration Strategy

## Scope

This runbook defines a pragmatic path to add Postgres as a production-grade backend while preserving current SQLite behavior and deterministic replay guarantees.

In scope:

- Schema portability for the current enterprise SQLite model (`enterpriseSqliteSchemaVersion = 4`).
- Migration tooling approach for SQLite and Postgres parity.
- Dual-run verification and phased cutover.

Out of scope:

- Full implementation details for the pluggable storage adapter bead (`ums-memory-dd2.2`).
- Multi-region replication and DR automation (separate beads).

## Current Repo Baseline (Must Preserve)

- Canonical SQLite schema and migration artifacts live in:
  - `libs/shared/src/effect/storage/sqlite/enterprise-schema.ts`
  - `libs/shared/src/effect/storage/sqlite/migrations.ts`
  - `libs/shared/src/effect/storage/sqlite/storage-repository.ts`
  - `libs/shared/src/effect/storage/sqlite/snapshot-codec.ts`
- Migration ordering and deterministic SQL concatenation are already enforced by tests:
  - `tests/unit/enterprise-sqlite-schema-definition.test.ts`
  - `tests/unit/enterprise-sqlite-migrations.test.ts`
- FTS behavior currently depends on SQLite FTS5 (`memory_items_fts` + sync triggers).
- Idempotent write behavior depends on `storage_idempotency_ledger` and request-hash checks.
- New/touched backend migration code must follow strict TypeScript + Effect rules:
  - `docs/standards/strict-ts-effect-standard.md`

## Schema Portability Plan

### 1) Treat Current SQLite Schema as Source Contract

Use `enterprise-schema.ts` as the schema contract source, not ad hoc SQL diffs.

Portability target:

- Preserve table names, key shapes, uniqueness, foreign keys, and check constraints.
- Preserve append-only semantics for `audit_events`.
- Preserve idempotency semantics for `storage_idempotency_ledger`.
- Preserve tenant-scoped query/index patterns.

### 2) Portability Mapping (SQLite -> Postgres)

| Concern                | SQLite today                           | Postgres target                                | Portability action                                                               |
| ---------------------- | -------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------- |
| Primary keys / FKs     | Composite keys and tenant-prefixed FKs | Same composite PK/FK model                     | Keep key definitions identical to avoid app-level behavior drift                 |
| `STRICT` typing        | `CREATE TABLE ... STRICT`              | Native column types + explicit constraints     | Map to `text`, `bigint`, and explicit checks                                     |
| JSON validity          | `json_valid(...)` checks on text       | `jsonb` columns                                | Convert payload columns to `jsonb`; preserve shape checks where needed           |
| Partial unique indexes | Used for scope anchors                 | Native partial indexes                         | Port predicates directly (`WHERE scope_level = ...`)                             |
| Recursive constraints  | Trigger-based cycle checks             | Trigger/function checks or deferred validation | Recreate equivalent trigger logic in PL/pgSQL                                    |
| FTS                    | FTS5 virtual table + sync triggers     | `tsvector` + GIN index                         | Build Postgres search projection for `memory_items` and keep tenant filter first |
| Schema versioning      | `PRAGMA user_version`                  | Migration history table                        | Introduce Postgres migration version ledger aligned to SQLite versions           |

### 3) FTS5 Compatibility Strategy

- Replace `memory_items_fts` virtual-table behavior with a Postgres search representation (`tsvector` column or materialized projection table).
- Keep recall contract semantics stable by testing query equivalence on:
  - tokenized search hits
  - tenant filtering
  - deterministic ordering/tie-breaks
- Accept that tokenization internals differ; enforce compatibility at API contract level, not byte-for-byte engine internals.

### 4) Idempotency Ledger Portability

- Keep `(tenant_id, operation, idempotency_key)` uniqueness as the idempotency identity.
- Keep `request_hash_sha256` conflict behavior identical:
  - same key + same hash => replay accepted and returns prior response
  - same key + different hash => deterministic conflict
- Preserve replay-safe write/read behavior with contract tests shared across adapters.

## Migration Tooling Plan

### 1) Repository Structure Direction

Add a Postgres storage module alongside SQLite, not as a replacement:

- `libs/shared/src/effect/storage/postgres/*` (new)
- Keep `libs/shared/src/effect/storage/sqlite/*` unchanged during dual-run

Planned modules (parity with SQLite organization):

- `enterprise-schema.ts` (Postgres DDL metadata)
- `migrations.ts` (versioned migration list, same semantic versions as SQLite v1-v6+)
- `storage-repository.ts` (Postgres adapter implementing the same storage contract)
- `schema-integrity.ts` (Postgres drift assertion equivalent to `assertEnterpriseSqliteSchemaIntegrity`)

### 2) Deterministic Migration Authoring

Preserve current deterministic approach:

- Versioned migration definitions in TypeScript.
- Ordered statement lists with deterministic SQL concatenation.
- Validation that migration version ordering is strict and replay-safe.

Postgres addition:

- Maintain a migration history table (for example `storage_schema_migrations`) with applied version and checksum.
- Keep migration names aligned with SQLite names where semantics match:
  - v1 core schema
  - v2 search
  - v3 audit ledger
  - v4 idempotency ledger

### 3) TS + Effect Alignment

- Keep storage adapter boundaries in strict TypeScript + Effect modules.
- Introduce storage adapter interfaces as Effect services/layers so runtime can select SQLite or Postgres without domain logic forks.
- Reuse existing contract schemas and error unions from `libs/shared/src/effect/contracts` and `libs/shared/src/effect/errors.ts`.

### 4) Tooling Verification Gates

Before adapter cutover:

- Schema parity tests: expected objects exist, no unexpected drift.
- Migration replay tests: from empty -> latest, from partial versions -> latest, and no-op at latest.
- Contract parity tests: same request corpus against SQLite and Postgres adapters with normalized output comparison.

## Dual-Run Verification Path

### Step A: Baseline Snapshot + Backfill

- Export canonical SQLite snapshot using existing snapshot codec.
- Load Postgres with equivalent rows (excluding SQLite-specific FTS internal objects).
- Verify row counts and key distributions per table before live dual-run.

### Step B: Shadow Writes

- SQLite remains source of truth.
- For each storage write (`upsert`, `delete`), execute normal SQLite path and mirror the same request to Postgres.
- Record per-request compare result:
  - success parity
  - idempotency parity
  - conflict/error parity

### Step C: Shadow Reads (Compare-Only)

- Keep production responses from SQLite.
- Run sampled read/recall queries against Postgres in parallel.
- Compare normalized result digests (ordering + payload normalization) and log mismatches with tenant/store IDs.

### Step D: Canary Read Switch

- Enable Postgres reads for a small tenant allowlist while writes remain dual-written.
- Automatic fallback to SQLite when either threshold is breached for 5 consecutive minutes:
  - normalized read mismatch rate > `0.1%`
  - Postgres read p95 latency > `20%` above SQLite baseline for the same query family

### Step E: Primary Cutover

- Promote Postgres to primary reads/writes.
- Keep SQLite dual-write for rollback window.
- End dual-write only after all of these stability criteria are met:
  - 7 consecutive days with write mismatch rate <= `0.1%`
  - 7 consecutive days with read mismatch rate <= `0.1%`
  - 7 consecutive days with unexpected idempotency parity mismatches = `0`
  - no unresolved Sev1 incidents tied to storage parity

## Phased Rollout, Entry/Exit Criteria, and Risk Controls

| Phase                             | Entry Criteria                                                       | Exit Criteria                                                                                                                                                                                                                         | Risk Controls                                                                                       |
| --------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 0. Design Lock                    | Current SQLite schema/migration baseline is green in CI              | This runbook approved and referenced from existing docs                                                                                                                                                                               | No code changes; explicit non-goals and rollback policy documented                                  |
| 1. Portability Foundation         | Phase 0 complete; adapter contract bead (`ums-memory-dd2.2`) started | Engine-agnostic storage contract and Postgres module scaffolding merged                                                                                                                                                               | Keep SQLite default path untouched; feature flag for Postgres disabled by default                   |
| 2. Postgres Schema + Migrations   | Portability mapping approved                                         | Postgres migrations reach semantic parity with SQLite v1-v6 (including identity runtime + provenance lineage tables); drift checks/tests pass; append-only `audit_events` and idempotency-ledger invariants validated in parity tests | Migration checksums + deterministic ordering tests; fail-fast on drift                              |
| 3. Backfill + Shadow Write        | Phase 2 complete                                                     | Snapshot/backfill successful; shadow write mismatch rate <= `0.1%` across 10,000+ writes; idempotency parity mismatches = `0`                                                                                                         | Per-request mismatch telemetry, idempotency conflict counters, kill switch to disable shadow writes |
| 4. Canary Reads                   | Shadow write stable                                                  | Canary tenants run on Postgres reads for 72h with read mismatch <= `0.1%`, p95 latency delta <= `20%`, and no Sev1 issues                                                                                                             | Tenant allowlist, auto-fallback on mismatch/error/latency thresholds                                |
| 5. Full Cutover + Rollback Window | Canary exit criteria met                                             | Postgres primary for all tenants; rollback window closes after 7-day stability window that meets Step E thresholds                                                                                                                    | Dual-write retention window, point-in-time backup, explicit rollback runbook and owner on-call      |

## Operational Go/No-Go Metrics

- Write parity mismatch rate <= `0.1%` over rolling windows of at least 10,000 writes.
- Read parity mismatch rate <= `0.1%` over rolling windows of at least 20,000 sampled reads.
- Unexpected idempotency parity failures (`same key, different hash`) = `0`.
- p95 latency delta <= `20%` and p99 latency delta <= `30%` versus SQLite baseline during canary.
- Audit append-only invariants and idempotency-ledger uniqueness checks remain green in parity CI.
- No unresolved schema drift alerts for latest migration version.

## Required Evidence Before Primary Cutover

The primary cutover owner must attach all of the following evidence to the go/no-go decision:

1. Latest green parity corpus output from `bun scripts/eval-storage-parity.ts --json`.
2. Latest green shadow dual-run telemetry sample from `/v1/storage_dualrun` showing:
   - `mismatchCount = 0` for the sampled request window
   - tenant/store traceability in `observability.tracePayload.storeId`
   - stable `requestDigest` values for replayed samples
3. One successful staging-like restore drill manifest from `artifacts/dr-drills/<DRILL_ID>/manifest.json` with:
   - `status = "pass"`
   - `failureGate = "none"`
   - `attemptsUsed <= 2`
4. One successful rollback rehearsal bundle from the staging host proving the prior revision can be redeployed against the preserved backup/state volume. The bundle must include:
   - `rollback-redeploy-check.txt` with:
     - the release-candidate git SHA
     - the prior git SHA used for rollback
     - the backup artifact basename restored during the rehearsal
   - `rollback-api-root.json` showing `ok = true`, `service = "ums-api"`, and `deterministic = true`
   - `rollback-metrics.prom` containing successful `doctor` and `export` metrics lines for the rolled-back revision
   - `rollback-compose-ps.txt`
   - `rollback-compose-logs-api-worker.txt`
   - one note stating the rollback command path used (`docker compose ... up --build -d --remove-orphans` after checking out the prior revision)
5. Linked artifact bundle:
   - `checksums.txt`
   - `compose-ps.txt`
   - `compose-logs-api-worker.txt`
   - `metrics.prom`
   - `replay-first.json`
   - `replay-second.json`

Cutover must not proceed if any required artifact is missing, stale, fails validation, or is tied to a different revision than the release candidate.

## Immediate Next Beads

1. `ums-memory-dd2.2`: implement pluggable storage adapter contracts (pre-req for runtime routing).
2. `ums-memory-dd2.3`: evaluate optional vector retrieval extension in [Optional Vector Retrieval Extension Evaluation](./vector-retrieval-extension-evaluation.md).
3. `ums-memory-dd2.4`: design controlled sharing in [Cross-Repo Memory Federation Model](./cross-repo-memory-federation-model.md).
4. `ums-memory-dd2.5`: define enterprise identity lifecycle and role sync contracts in [Enterprise SSO/SCIM Integration Plan](./enterprise-sso-scim-integration-plan.md).
5. Add Postgres schema + migration parity test suite mirroring SQLite migration tests.
6. Add dual-run telemetry fields (request hash, backend result digest, mismatch category) to storage operation logs.
