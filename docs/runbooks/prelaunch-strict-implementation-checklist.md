# Prelaunch Strict Implementation Checklist (No-Bullshit Execution Plan)

Date: 2026-03-05  
Owner: UMS backend platform  
Status: Draft execution checklist  
Applies to: prelaunch architecture hardening before first production release

## 1) Scope and Constraints

This checklist operationalizes the agreed architecture plan with strict task-level acceptance criteria.

Hard constraints:

- TypeScript + Effect only at service boundaries.
- No `zod` in adapter/API edge modules.
- Deterministic replay and idempotency are non-negotiable.
- One runtime architecture only (storage adapter selected backend), no divergent runtime behavior by mode.
- Federation is deferred until core reliability gates are proven.

Reference baselines:

- [NCM v1 Capability Contract](./ncm-v1-capability-contract.md)
- [Phase 0 Effect Schema Canonical Domain Model](./phase0-effect-schema-domain-model.md)
- [SQLite to Postgres Migration Strategy](./sqlite-to-postgres-migration-strategy.md)
- [Cross-Repo Memory Federation Model](./cross-repo-memory-federation-model.md)

## 2) Command Gate Catalog

Use these gate IDs in every task:

- `G0`: `bun run quality:ts`
- `G1`: `bun run test`
- `G2`: `bun run validate:ingestion`
- `G3`: `bun run bench:ums && bun run benchmark:ncm-hybrid`
- `G4`: `bun run test:sfe`
- `G5`: `bun run ci:verify`

Gate policy:

- Minimum merge gate for core/runtime changes: `G0 + G1`.
- Minimum merge gate for ingestion/adapter changes: `G0 + G1 + G2`.
- Minimum merge gate for release candidates: `G5`.

## 3) Task Dependency Graph

Execution order:

1. `P0-*`
2. `P1-*`
3. `P2-*` and `P3-*` can run in parallel after `P1-R3`
4. `P4-*` depends on `P2-*` and `P3-*`
5. `P5-*` depends on `P1-*` and `P4-*`
6. `P6-*` is blocked until `P1-*` through `P5-*` are stable

Blocking rule:

- No task may start if any declared dependency is incomplete.

## 4) Phase 0: Architecture Lock

### P0-A1 — Lock single-runtime architecture ADR

- Files:
  - `docs/adr/0008-single-runtime-storage-adapter-architecture.md` (new)
  - `docs/runbooks/phase1-phase2-backend-delivery-runbook.md` (update links and scope)
- Acceptance tests (files):
  - `apps/api/test/core.test.ts` operation list assertion remains valid.
- Command gates:
  - `G0`, `G1`
- Challenge checks:
  - Reject if ADR allows dual primary runtime paths.
  - Reject if ADR uses undefined terms like “temporary for now” without expiry owner/date.

### P0-A2 — Publish operation-to-persistence contract map

- Files:
  - `docs/runbooks/runtime-operation-persistence-map.md` (new)
  - `apps/api/src/runtime-service.ts` (link contract in comments/docblock)
- Acceptance tests (files):
  - `apps/api/test/server.test.ts` operation execution matrix still passes.
- Command gates:
  - `G0`, `G1`
- Challenge checks:
  - Reject if any operation is missing explicit deterministic persistence behavior.

## 5) Phase 1: Runtime Unification on Storage Adapter Path

### P1-R1 — Introduce explicit runtime persistence port

- Files:
  - `libs/shared/src/effect/services/runtime-persistence-service.ts` (new)
  - `libs/shared/src/effect/index.ts` (export wiring)
- Acceptance tests (files):
  - `tests/unit/runtime-persistence-service.test.ts` (new)
- Command gates:
  - `G0`, `G1`
- Challenge checks:
  - Reject if interface leaks backend-specific SQL types into domain runtime.

### P1-R2 — Implement SQLite runtime persistence adapter

- Files:
  - `libs/shared/src/effect/storage/sqlite/runtime-persistence-repository.ts` (new)
  - `libs/shared/src/effect/storage/sqlite/index.ts` (exports)
- Acceptance tests (files):
  - `tests/unit/sqlite-runtime-persistence-repository.test.ts` (new)
  - `apps/api/test/persistence.test.ts` (update)
- Command gates:
  - `G0`, `G1`
- Challenge checks:
  - Reject if deterministic ordering is implicit (all reads must define explicit sort order).

### P1-R3 — Route runtime-service through persistence port

- Files:
  - `apps/api/src/runtime-service.ts`
  - `libs/shared/src/effect/runtime-layer.ts`
- Acceptance tests (files):
  - `apps/api/test/server.test.ts`
  - `apps/api/test/default-shared-state.test.ts` (update semantics where needed)
- Command gates:
  - `G0`, `G1`, `G4`
- Challenge checks:
  - Reject if `executeOperationWithSharedState` remains in primary serving path.

### P1-R4 — Route worker-runtime through persistence port

- Files:
  - `apps/api/src/worker-runtime.ts`
- Acceptance tests (files):
  - `apps/api/test/worker-runtime.test.ts`
- Command gates:
  - `G0`, `G1`
- Challenge checks:
  - Reject if worker behavior diverges from API runtime semantics for same operation request.

### P1-R5 — Keep shared JSON path as compatibility import/export only

- Files:
  - `apps/api/src/persistence.ts`
  - `scripts/import-legacy-shared-state.ts` (new)
  - `scripts/export-legacy-shared-state.ts` (new)
  - `docs/runbooks/deploy-operations-compose-first.md` (update)
- Acceptance tests (files):
  - `apps/api/test/persistence.test.ts`
  - `tests/integration/runtime-legacy-import-export.integration.test.ts` (new)
- Command gates:
  - `G0`, `G1`
- Challenge checks:
  - Reject if legacy JSON path is still default runtime for API/worker execution.

### P1-R6 — Deterministic parity harness old-vs-new runtime path

- Files:
  - `tests/integration/runtime-path-parity.integration.test.ts` (new)
  - `tests/fixtures/runtime-parity/*.json` (new corpus fixtures)
- Acceptance tests (files):
  - `tests/integration/runtime-path-parity.integration.test.ts`
- Command gates:
  - `G0`, `G1`
- Challenge checks:
  - Reject if any parity mismatch is waived without explicit approved exception.

## 6) Phase 2: Adapter Parity (cursor, opencode, vscode)

### P2-S1 — Harmonize source taxonomy and alias mapping

- Files:
  - `apps/ums/src/daemon-config.ts`
  - `apps/ums/src/daemon-sync.ts`
  - `apps/ums/src/index.ts`
  - `libs/shared/src/effect/contracts/services.ts` (verify mapping consistency)
- Acceptance tests (files):
  - `apps/cli/test/daemon-config.test.ts`
  - `apps/cli/test/daemon-sync.test.ts`
  - `tests/unit/effect-schema-domain-model-contract.test.ts`
- Command gates:
  - `G0`, `G1`, `G2`
- Challenge checks:
  - Reject if source aliasing can collapse distinct platforms into identical IDs without namespace protection.

### P2-S2 — Cursor adapter implementation

- Files:
  - `apps/ums/src/daemon-sync.ts`
  - `apps/ums/src/source-redaction.ts`
- Acceptance tests (files):
  - `apps/cli/test/daemon-sync.test.ts`
  - `apps/cli/test/source-redaction.test.ts`
- Command gates:
  - `G0`, `G1`, `G2`
- Challenge checks:
  - Reject if cursor checkpoints are not deterministic across replay.

### P2-S3 — OpenCode adapter implementation

- Files:
  - `apps/ums/src/daemon-sync.ts`
  - `apps/ums/src/source-redaction.ts`
- Acceptance tests (files):
  - `apps/cli/test/daemon-sync.test.ts`
  - `apps/cli/test/source-redaction.test.ts`
- Command gates:
  - `G0`, `G1`, `G2`
- Challenge checks:
  - Reject if partial transcript ingestion can produce duplicate semantic events on resume.

### P2-S4 — VS Code adapter implementation

- Files:
  - `apps/ums/src/daemon-sync.ts`
  - `apps/ums/src/source-redaction.ts`
- Acceptance tests (files):
  - `apps/cli/test/daemon-sync.test.ts`
  - `apps/cli/test/source-redaction.test.ts`
- Command gates:
  - `G0`, `G1`, `G2`
- Challenge checks:
  - Reject if metadata extraction relies on editor-specific unstable internal fields without fallback behavior.

### P2-S5 — Unified redaction and trust-boundary enforcement across adapters

- Files:
  - `apps/ums/src/daemon-sync.ts`
  - `apps/ums/src/source-redaction.ts`
- Acceptance tests (files):
  - `apps/cli/test/source-redaction.test.ts`
  - `apps/cli/test/daemon-sync.test.ts`
  - `tests/integration/multi-store-ingestion.integration.test.ts`
- Command gates:
  - `G0`, `G1`, `G2`
- Challenge checks:
  - Reject if any adapter bypasses shared redaction path.

## 7) Phase 3: ACE v2 (Context Hydrator + Reflector + Validator + Curator)

### P3-A1 — Extract context pack generation from monolithic core

- Files:
  - `apps/api/src/ace/context-pack.ts` (new)
  - `apps/api/src/core.ts` (wire-in, remove inline duplication)
- Acceptance tests (files):
  - `apps/api/test/core.test.ts` (context determinism assertions)
  - `tests/unit/context-pack.test.ts` (new)
- Command gates:
  - `G0`, `G1`
- Challenge checks:
  - Reject if context pack changes are not replay-deterministic for same snapshot/query.

### P3-A2 — Reflector upgrade with bounded candidate generation

- Files:
  - `apps/api/src/ace/reflector.ts` (new)
  - `apps/api/src/core.ts`
- Acceptance tests (files):
  - `apps/api/test/core.test.ts` (`reflect` determinism and bounded count)
- Command gates:
  - `G0`, `G1`
- Challenge checks:
  - Reject if candidate count can exceed configured deterministic bounds.

### P3-A3 — Validator upgrade (evidence depth, contradiction, freshness)

- Files:
  - `apps/api/src/ace/validator.ts` (new)
  - `apps/api/src/core.ts`
- Acceptance tests (files):
  - `apps/api/test/core.test.ts` (`validate` reason codes and evidence requirements)
  - `tests/unit/validator-rules.test.ts` (new)
- Command gates:
  - `G0`, `G1`
- Challenge checks:
  - Reject if validator accepts unsupported claims with no evidence links.

### P3-A4 — Curator strict guarded path enforcement

- Files:
  - `apps/api/src/core.ts`
- Acceptance tests (files):
  - `apps/api/test/core.test.ts` (`curate_guarded` required for active procedural mutation paths)
- Command gates:
  - `G0`, `G1`
- Challenge checks:
  - Reject if any path can mutate active procedural memory without guard enforcement.

### P3-A5 — Oscillation and replay-safe tie-break controls

- Files:
  - `apps/api/src/ace/curation-tiebreaks.ts` (new)
  - `apps/api/src/core.ts`
- Acceptance tests (files):
  - `tests/unit/curation-tiebreaks.test.ts` (new)
  - `apps/api/test/core.test.ts`
- Command gates:
  - `G0`, `G1`
- Challenge checks:
  - Reject if conflicting candidates produce nondeterministic winner selection.

## 8) Phase 4: Lean Eval Stack (Mandatory, Bounded Scope)

### P4-E1 — Golden replay regression corpus

- Files:
  - `tests/fixtures/eval/golden-replay/*.json` (new)
  - `scripts/eval-golden-replay.ts` (new)
- Acceptance tests (files):
  - `tests/integration/golden-replay.integration.test.ts` (new)
- Command gates:
  - `G0`, `G1`
- Challenge checks:
  - Reject if corpus can be modified without digest/version update review.

### P4-E2 — Adapter conformance corpus and checker

- Files:
  - `tests/fixtures/eval/adapter-conformance/*.json` (new)
  - `scripts/eval-adapter-conformance.ts` (new)
- Acceptance tests (files):
  - `tests/integration/adapter-conformance.integration.test.ts` (new)
- Command gates:
  - `G0`, `G1`, `G2`
- Challenge checks:
  - Reject if adapters pass without exercising malformed and replay cases.

### P4-E3 — Holdout grounded recall/citation set

- Files:
  - `tests/fixtures/eval/grounded-holdout/*.json` (new)
  - `scripts/eval-grounded-recall.ts` (new)
- Acceptance tests (files):
  - `tests/integration/grounded-recall.integration.test.ts` (new)
- Command gates:
  - `G0`, `G1`
- Challenge checks:
  - Reject if holdout is reused for tuning.

### P4-E4 — CI gate wiring for eval checks

- Files:
  - `package.json` (scripts)
  - `.github/workflows/*` (if present, update pipeline)
  - `docs/runbooks/ci-gates-effect-ts-cutover.md` (update)
- Acceptance tests (files):
  - `tests/unit/eval-script-contracts.test.ts` (new)
- Command gates:
  - `G5`
- Challenge checks:
  - Reject if eval commands are optional in release flow.

### P4-E5 — Dataset maintenance policy (keep it lean)

- Files:
  - `docs/runbooks/eval-dataset-maintenance-policy.md` (new)
- Acceptance tests (files):
  - `tests/unit/eval-dataset-policy.test.ts` (new static policy assertions)
- Command gates:
  - `G0`, `G1`
- Challenge checks:
  - Reject if policy allows unbounded corpus growth without owner review.

## 9) Phase 5: Postgres Adapter and Cutover

### P5-P1 — Postgres schema and migrations

- Files:
  - `libs/shared/src/effect/storage/postgres/migrations.ts` (new)
  - `libs/shared/src/effect/storage/postgres/schema.ts` (new)
- Acceptance tests (files):
  - `tests/unit/enterprise-postgres-migrations.test.ts` (new)
  - `tests/unit/enterprise-postgres-schema-definition.test.ts` (new)
- Command gates:
  - `G0`, `G1`
- Challenge checks:
  - Reject if schema parity with required SQLite contracts is undocumented or partial.

### P5-P2 — Postgres repository implementation

- Files:
  - `libs/shared/src/effect/storage/postgres/storage-repository.ts` (new)
  - `libs/shared/src/effect/storage/postgres/index.ts` (new)
- Acceptance tests (files):
  - `tests/unit/storage-service-postgres-repository.test.ts` (new)
- Command gates:
  - `G0`, `G1`
- Challenge checks:
  - Reject if repository behavior is not contract-compatible with SQLite responses.

### P5-P3 — Adapter registry and runtime selection for Postgres

- Files:
  - `libs/shared/src/effect/storage/adapter-registry.ts`
  - `libs/shared/src/effect/services/storage-service.ts`
- Acceptance tests (files):
  - `libs/shared/src/effect/storage/adapter-registry.test.ts`
- Command gates:
  - `G0`, `G1`
- Challenge checks:
  - Reject if runtime backend selection is ambiguous or unsafe by default.

### P5-P4 — SQLite vs Postgres parity corpus runner

- Files:
  - `scripts/eval-storage-parity.ts` (new)
  - `tests/integration/storage-adapter-parity.integration.test.ts` (new)
- Acceptance tests (files):
  - `tests/integration/storage-adapter-parity.integration.test.ts`
- Command gates:
  - `G0`, `G1`, `G3`
- Challenge checks:
  - Reject if mismatches are accepted without typed reason code and approved waiver.

### P5-P5 — Shadow dual-run comparator and telemetry

- Files:
  - `apps/api/src/storage-dualrun.ts` (new)
  - `apps/api/src/server.ts` (wire feature flag)
- Acceptance tests (files):
  - `apps/api/test/server.test.ts` dual-run mismatch behavior
  - `tests/integration/storage-dualrun-telemetry.integration.test.ts` (new)
- Command gates:
  - `G0`, `G1`, `G3`
- Challenge checks:
  - Reject if telemetry omits tenant/store identifiers for mismatch triage.

### P5-P6 — Cutover and rollback playbooks finalized

- Files:
  - `docs/runbooks/sqlite-to-postgres-migration-strategy.md` (final update)
  - `docs/runbooks/deploy-operations-compose-first.md` (runtime backend ops)
- Acceptance tests (files):
  - `tests/integration/postgres-cutover-drill.integration.test.ts` (new scripted dry run)
- Command gates:
  - `G5`
- Challenge checks:
  - Reject if rollback has not been exercised in staging-like environment.

## 10) Phase 6: Federation (Deferred Gate)

This phase is blocked by default and must not start until all prerequisites pass.

### P6-F0 — Federation start gate decision

- Files:
  - `docs/runbooks/federation-go-no-go-decision.md` (new)
- Acceptance tests (files):
  - `tests/unit/federation-start-gate.test.ts` (new policy gate assertions)
- Command gates:
  - `G0`, `G1`
- Challenge checks:
  - Reject if prerequisites for `P1` through `P5` are not complete and stable.

### P6-F1 — Read-only shadow federation evaluation

- Files:
  - `apps/api/src/federation/shadow-evaluator.ts` (new)
  - `docs/runbooks/cross-repo-memory-federation-model.md` (implementation appendix)
- Acceptance tests (files):
  - `tests/integration/federation-shadow-eval.integration.test.ts` (new)
- Command gates:
  - `G0`, `G1`
- Challenge checks:
  - Reject if any write/mutation side effects exist in shadow mode.

### P6-F2 — Controlled canary (allowlisted spaces only)

- Files:
  - `apps/api/src/federation/canary-routing.ts` (new)
- Acceptance tests (files):
  - `tests/integration/federation-canary-policy.integration.test.ts` (new)
- Command gates:
  - `G0`, `G1`, `G3`
- Challenge checks:
  - Reject if deny reason codes are incomplete or nondeterministic.

### P6-F3 — General enablement gate

- Files:
  - `docs/runbooks/cross-repo-memory-federation-model.md` (GA criteria section update)
- Acceptance tests (files):
  - `tests/integration/federation-ga-readiness.integration.test.ts` (new)
- Command gates:
  - `G5`
- Challenge checks:
  - Reject if any cross-tenant path exists, directly or indirectly.

## 11) Cross-Phase Anti-Bullshit Rules

Every task must satisfy these:

- No merge without linked acceptance tests.
- No merge without declared gate IDs and executed command evidence.
- No merge that increases complexity without measurable quality or safety gain.
- No “temporary” exception without owner, expiry, and removal task ID.
- No deterministic mismatch waivers without documented blast radius and rollback.

## 12) Session Completion Checklist (per implementation session)

1. Claim task and mark in-progress.
2. Implement only scoped files.
3. Run task command gates.
4. Update/add acceptance tests.
5. Run full required gates (`G0/G1` minimum).
6. Close task status with evidence links.
7. `git pull --rebase && bd sync && git push`.
8. Confirm branch is up to date with remote.
