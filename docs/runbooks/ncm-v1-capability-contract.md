# NCM v1 Capability Contract and Non-Goals (bead `ums-memory-2i1.1`)

## Purpose

Define what UMS will ship as an implementable NCM-hybrid v1 contract, and what remains explicitly out of scope as research-only work.

## Product Contract (In Scope for NCM v1)

NCM v1 in UMS is a deterministic enterprise memory substrate with these capabilities:

1. Multi-scope memory retrieval and explainability:
   - common/project/job-role/user scope merge
   - deterministic ranking
   - explainability with provenance lineage
2. Provenance-first memory operations:
   - required provenance policy enforcement
   - provenance envelope and linkage persistence
   - deterministic provenance backfill for legacy records
   - provenance health counters/alerts
3. Enterprise identity runtime:
   - Better Auth SSO session boundary with tenant routing
   - SCIM `/Users` lifecycle with replay + stale-event rejection
   - SCIM `/Groups` reconciliation for role/project memberships
   - fail-closed cross-tenant authorization evaluation
   - deterministic identity audit event emission
4. Operational readiness baseline:
   - rollout runbook
   - replay-safe migration and regression gates

## Explicit Non-Goals (Research-Only, Not in NCM v1)

The following are out of scope for this release and are not promised by v1:

1. OpenTechLab transformer-side memory architecture components:
   - latent terrain memory modules
   - diffusion-style memory dynamics
   - decoder-side memory center integration
2. BioCortex “Digital Mirror” biochemical/hormonal or plant-network modulation layers.
3. Autonomous neuroscience-style adaptive memory dynamics beyond deterministic service behavior.
4. Production claims of equivalence with external research prototypes without dedicated parity benchmarks.

## Acceptance Metrics (Must Hold for NCM v1)

1. Determinism:
   - repeated identical write/retrieve flows produce stable outputs and replay semantics.
2. Tenant safety:
   - cross-tenant authorization requests are denied with zero mutation side effects.
3. Provenance coverage:
   - enterprise writes with required provenance policy either persist complete lineage or fail with typed contract errors.
4. Identity sync correctness:
   - SCIM stale events are rejected deterministically; matching cursor/hash events replay idempotently.
5. Auditability:
   - identity and provenance flows produce deterministic audit records suitable for compliance/export.

## Exit Criteria for `2i1.1`

- This document is approved as the authoritative v1 contract baseline.
- Downstream beads (`2i1.2+`) reference this scope as implementation boundary.
- Any work proposing OpenTechLab/BioCortex parity must create separate scoped beads with explicit benchmarks and non-v1 labeling.
