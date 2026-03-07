# ADR-0007: Phase 0 Governance and Architecture Baseline

Date: 2026-03-04
Status: Accepted

## Context

Phase 0 (`ums-memory-0d2`) defines governance, licensing, tenancy, and architecture constraints required before deeper implementation phases. Without an explicit baseline, downstream epics risk inconsistent scope interpretation, weak clean-room discipline, and avoidable tenant/security regressions.

## Decision

Phase 0 governance baseline constraints are mandatory for all later phases:

1. Backend-only scope for policy-critical paths:
   No frontend screens or policy UIs are required for phase completion.
2. Clean-room licensing discipline:
   External implementations are behavior references only; implementation remains independent TypeScript + Effect.
3. Security defaults:
   Tenant isolation, deny-by-default policy checks, redaction, and signed auditability are release blockers.
4. Deterministic/idempotent operations:
   Ingestion, curation, replay-eval, and retrieval paths must remain replay-safe.
5. Bounded recall and observability:
   Recall limits and explainability signals are mandatory.

Governance scope map:

- `ums-memory-0d2.1`: scope matrix by operating mode
- `ums-memory-0d2.2`: licensing and clean-room decision record
- `ums-memory-0d2.3`: data classification and residency policy
- `ums-memory-0d2.4`: threat model for ingest/retrieval/optimization
- `ums-memory-0d2.5`: topology and environment boundaries
- `ums-memory-0d2.6`: tenancy identity hierarchy
- `ums-memory-0d2.7`: ownership and runbook responsibilities
- `ums-memory-0d2.8`: acceptance criteria catalog
- `ums-memory-0d2.9`: ADR bundle and architecture review checklist
- `ums-memory-0d2.10`: go/no-go sign-off gate

## Scope

In scope:

- Governance baseline artifacts and decision records required for Phase 0 closeout.
- Policy guardrails and architecture constraints that gate downstream implementation.
- Explicit mapping from governance decisions to bead execution scope.

Out of scope per ADR-0001 backend-only delivery:

- Frontend workflow screens.
- Client-side policy editing UX.
- Non-critical visual dashboards.

## Consequences

- Phase 0 has a deterministic and auditable definition of done.
- Downstream phases inherit one shared interpretation of clean-room, tenancy, and security defaults.
- Release decisions become objective through explicit go/no-go criteria and assigned remediation ownership.
