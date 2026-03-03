# NCM Hybrid Rollout Plan and Risk Register (bead `ums-memory-2i1.8`)

## Scope

This rollout covers deterministic NCM-hybrid capabilities introduced in beads:

- `ums-memory-2i1.2` feedback ingestion for helpful/failure outcomes
- `ums-memory-2i1.3` deterministic decay/reheating policy evaluation
- `ums-memory-2i1.4` bounded operator manual weight tuning
- `ums-memory-2i1.5` baseline-vs-hybrid benchmark reporting
- `ums-memory-2i1.6` memory console signal feed for reinforcement lineage
- `ums-memory-2i1.7` tenant-level enterprise policy knobs

Non-goals remain defined in [ncm-v1-capability-contract.md](/Users/satan/Developer/ums-memory/docs/runbooks/ncm-v1-capability-contract.md).

## Rollout Stages

1. `stage_0_dark_launch`

- Deploy service code with tenant policy defaults set to disabled (`enableFeedbackIngestion=false`).
- Validate no behavior drift against current CASS-only behavior.
- Gate: zero unexpected mutation events in NCM telemetry.

2. `stage_1_canary_internal`

- Enable NCM knobs for one internal tenant and one project.
- Run deterministic replay validation on sampled feedback/outcome traffic.
- Gate: replay mismatch rate = 0, cross-tenant policy violations = 0.

3. `stage_2_limited_prod`

- Enable for <=10% tenants with high observability and fast rollback.
- Monitor weight drift and failure-heavy decay behavior for unstable memories.
- Gate: benchmark deltas remain within approved range from `benchmark:ncm-hybrid`.

4. `stage_3_general_availability`

- Enable by policy for all approved tenants.
- Keep opt-out kill switch (`enableFeedbackIngestion=false`, `failClosed=true`).
- Finalize operator runbook and on-call checklists.

## Safety Gates

Mandatory gates before each stage advance:

1. Determinism gate:

- identical inputs replay to identical transitions and weights.

2. Tenant safety gate:

- NCM policy knobs are tenant-bound and fail-closed on policy mismatch.

3. Provenance gate:

- feedback lineage in console includes user/agent/chat/source references when provided.

4. Operational gate:

- `npm run quality:ts`
- `npm run test`
- `npm run benchmark:ncm-hybrid`

## Rollback Strategy

1. Immediate rollback (soft):

- Disable per-tenant knobs:
  - `enableFeedbackIngestion=false`
  - `enableDeterministicDecayReheat=false`
  - `enableManualWeightTuning=false`

2. Hard fail-closed rollback:

- Set `failClosed=true` for affected tenants.
- Reject new NCM mutations while preserving historical state.

3. Verification after rollback:

- Re-run deterministic replay samples against pre-rollback snapshots.
- Confirm no additional NCM transitions were written after disable time.

## Risk Register

1. `RISK-NCM-001` Replay identity collisions

- Impact: duplicate feedback IDs with divergent payloads can corrupt reinforcement history.
- Mitigation: deterministic digest check and hard rejection on mismatch.
- Owner: Backend.

2. `RISK-NCM-002` Over-penalization on failure bursts

- Impact: aggressive decay may suppress useful memory too quickly.
- Mitigation: bounded penalties, operator override path, benchmark regression checks.
- Owner: Memory platform.

3. `RISK-NCM-003` Manual tuning abuse

- Impact: oversized human deltas can destabilize rankings.
- Mitigation: tenant policy max delta and role-gated operator controls.
- Owner: Security + platform.

4. `RISK-NCM-004` Missing lineage in console

- Impact: weak explainability/audit for enterprise incident review.
- Mitigation: provenance pointers included in signal feed; fail checks in tests.
- Owner: Platform observability.

5. `RISK-NCM-005` Scope creep into research parity claims

- Impact: incorrect expectation that v1 equals external neuroscience prototypes.
- Mitigation: explicit non-goals in NCM v1 contract and release notes.
- Owner: Product + architecture.

## Exit Criteria

- NCM benchmark report available and deterministic.
- Canary and limited rollout stages pass all gates without unresolved critical risks.
- Rollback path exercised and validated in staging.
- Risk register owners acknowledge controls and monitoring coverage.
