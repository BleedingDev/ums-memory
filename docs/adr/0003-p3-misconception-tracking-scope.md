# ADR-0003: Phase P3 Misconception Tracking and Feedback Signals Scope
Date: 2026-03-01
Status: Proposed

## Context
- PLAN.md Phase P3 includes "Misconception tracking via feedback loops" as core personalization/tutoring scope and pairs it with memory-driven curriculum planning.
- PLAN.md section 5.3 defines feedback as a "pain signal" with explicit correction events ("this is wrong", harmful marks, human rewrites) and implicit runtime outcomes (test failures, regressions, repeated ticket reopenings).
- Bead lineage for this decision is `ums-memory-d6q` (P3 umbrella) -> `ums-memory-d6q.2` (Misconception Tracking and Feedback Signals epic) -> `ums-memory-d6q.2.1` (scope + ADR mapping task).
- ADR-0001 already fixed mandatory constraints (backend-only, local-first, security defaults, deterministic/idempotent updates, bounded recall, observability/auditability). This ADR inherits those constraints without exceptions.

## Decision
- Limit Misconception Tracking and Feedback Signals to backend services, storage contracts, and deterministic signal-processing flows.
- Normalize explicit and implicit feedback into replay-safe misconception deltas that can drive curriculum planning, spaced repetition sequencing, and corrective recall selection.
- Keep the scope map in this ADR as the implementation boundary for `ums-memory-d6q.2` and downstream beads that consume misconception state.

## In Scope
- Backend ingestion contracts for explicit feedback signals (harmful marks, "this is wrong", human rewrites/corrections) and implicit outcome signals (test failures, regressions, repeated reopenings).
- Deterministic misconception lifecycle updates: harmful-weight increments, anti-pattern inversion triggers, and decay acceleration of stale advice.
- Evidence-linked misconception records joining learner profile references, episode provenance, correction history, and freshness metadata.
- Backend query APIs/CLI returning bounded misconception summaries plus evidence pointers for memory-driven curriculum planning and spaced repetition.
- Audit and observability instrumentation for each feedback-to-misconception transition so policy outcomes are measurable and reviewable.

## Out of Scope
- Frontend tutoring experiences, dashboard visualizations, browser workflows, or client-side state managers for misconception capture or rendering.
- Any nondeterministic mutation path that cannot be replayed as idempotent deltas.
- Cross-tenant/profile retrieval that bypasses redaction, isolation, or least-privilege controls.
- Direct datastore coupling by external consumers; integrations must use backend API/CLI contracts only.

## Acceptance Criteria
1. Backend API/CLI entry points accept explicit and implicit feedback signals, store provenance, and emit deterministic misconception delta events.
2. Misconception state transitions support harmful-weight updates, anti-pattern inversion, and decay acceleration exclusively through replay-safe/idempotent writes inherited from ADR-0001.
3. Misconception retrieval for tutoring/curriculum use cases is bounded, evidence-backed, and annotated with freshness/conflict metadata compatible with recall guardrails.
4. All write/read paths enforce profile/tenant isolation, redaction defaults, and auditable traces for feedback policy outcomes.
5. Implementation artifacts for this scope retain bead traceability to `ums-memory-d6q`, `ums-memory-d6q.2`, and `ums-memory-d6q.2.1`.

## Backend Boundaries
- Delivery is backend-only and inherits ADR-0001 constraint tags (`B,L,S,D,R,O`) as release gates.
- Public interfaces are backend API/CLI contracts for ingest, feedback mark/update, misconception retrieval, and curriculum-signal export.
- Persistence is local-first with deterministic mutation logs and provenance indexes; no frontend compute is required for misconception transitions.
- Learner profile and identity graph integrations occur only through backend contracts, not direct client/database access.
