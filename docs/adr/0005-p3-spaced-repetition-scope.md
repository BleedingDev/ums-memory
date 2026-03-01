# ADR-0005: Phase P3 Spaced Repetition / Review Scheduling Scope
Date: 2026-03-01
Status: Proposed

## Context
- PLAN.md Phase P3 defines personalization/tutoring around `Learner profiles`, `Misconception tracking via feedback loops`, and `Memory-driven curriculum planning (spaced repetition, interests)`.
- This ADR maps the Spaced Repetition / Review Scheduling slice for bead lineage `ums-memory-d6q` -> `ums-memory-d6q.4` -> `ums-memory-d6q.4.1`.
- ADR-0001 remains the governing baseline. This ADR inherits its backend constraints: backend-only (`B`), local-first (`L`), security defaults (`S`), deterministic/idempotent updates (`D`), bounded recall (`R`), and observability/auditability (`O`).

## Decision
- Scope P3-04 to backend services that compute spaced repetition plans and review scheduling queues from learner state and outcome feedback.
- Keep all scheduling decisions replay-safe and evidence-linked so downstream P3 services can reason about why a review was scheduled.
- Treat this ADR as the boundary contract for backend implementation and test planning under `ums-memory-d6q.4.1`.

## In Scope
- Spaced Repetition scheduler services that compute next-review intervals, due windows, and priority tiers from learner history, misconceptions, and outcomes.
- Review Scheduling APIs/CLI handlers that create and update deterministic review queue entries for each learner profile and tenant.
- Backend ingestion of misconception and correction signals so schedule updates are driven by `Misconception tracking via feedback loops`.
- Local-first storage for schedule snapshots, replay-safe deltas, and audit events that link each schedule mutation back to evidence episodes.
- Curriculum hooks that expose schedule recommendations as backend outputs for `Memory-driven curriculum planning (spaced repetition, interests)`.

## Non-goals
- No frontend screens, calendar widgets, notification UIs, or client-side learning dashboards; these remain out of scope per ADR-0001 backend-only delivery.
- No browser-side queue computation, caching, or scheduling heuristics; scheduling logic runs only in backend services.
- No non-deterministic model writes that cannot be reproduced from event history and deterministic deltas.
- No cross-tenant schedule reads/writes without explicit scope and provenance checks.

## Acceptance Criteria
1. Scheduler write paths are deterministic and idempotent: replaying the same event stream yields the same Spaced Repetition and Review Scheduling outcomes.
2. Review queue read/query endpoints remain backend-only and return bounded payloads with explicit pagination/token-size guardrails inherited from ADR-0001 (`R`).
3. Every schedule mutation stores provenance (source event IDs, learner profile key, tenant scope, timestamp) and emits audit records for operational tracing (`O`).
4. Security defaults from ADR-0001 (`S`) are enforced for schedule data: redaction boundaries, profile/tenant isolation, and least-privilege service access.
5. API/CLI backend contracts reference bead lineage `ums-memory-d6q`, `ums-memory-d6q.4`, and `ums-memory-d6q.4.1` for implementation traceability.

## Backend Boundaries
- Public entry points are backend APIs/CLI commands only; no direct frontend or plugin execution path may mutate review schedules.
- Identity/profile services may provide inputs, but review scheduling ownership stays in backend scheduler services, not UI orchestrators.
- Downstream consumers can read scheduler outputs via sanctioned backend contracts; direct database coupling by frontend code is prohibited.
- Operational controls (replay, audit, drift checks) execute in backend runtime processes and must remain local-first compatible.
