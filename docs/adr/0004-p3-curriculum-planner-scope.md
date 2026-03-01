# ADR-0004: Phase P3 Curriculum Planner Scope from Memory Signals
Date: 2026-03-01
Status: Proposed

## Context
- PLAN.md Phase P3 defines the personalization/tutoring track with three bullets: `Learner profiles`, `Misconception tracking via feedback loops`, and `Memory-driven curriculum planning (spaced repetition, interests)`.
- Bead `ums-memory-d6q` defines the P3 umbrella, `ums-memory-d6q.3` defines the curriculum planner track, and `ums-memory-d6q.3.1` owns this ADR.
- ADR-0001 baseline constraints are inherited unchanged: backend-only (`B`), local-first (`L`), security defaults (`S`), deterministic/idempotent updates (`D`), bounded recall (`R`), and observability/auditability (`O`).

## Decision
- Implement P3 curriculum planning as backend services that transform memory signals into curriculum recommendations without any frontend delivery scope.
- For this ADR, memory signals include learner profile traits, misconception events, helpful/harmful feedback, outcomes, spaced-repetition schedule events, and evidence pointers to episodes.
- PLAN.md Phase P3 mapping:
  - `Learner profiles` -> profile resolver for learner identity, interests, and historical learning context.
  - `Misconception tracking via feedback loops` -> misconception signal processor that writes deterministic learner-state deltas.
  - `Memory-driven curriculum planning (spaced repetition, interests)` -> planner engine that ranks next learning steps from spaced-repetition windows and interest signals.
- All planner writes and reads must satisfy ADR-0001 constraints (`B/L/S/D/R/O`) as release requirements.

## Scope
- Curriculum planner ingestion APIs for memory signals (feedback, outcomes, misconception flags, interest updates, and spaced-repetition events).
- Deterministic planner state transitions that produce replay-safe curriculum deltas and recommendation snapshots per learner profile.
- Recommendation query endpoint that returns next-step curriculum items, evidence pointers, freshness metadata, and bounded payload metadata.
- Local-first persistence for planner state, signal history, and schedule artifacts with profile/tenant isolation and encryption defaults.
- Backend contract docs for upstream/downstream beads that consume planner outputs through API/CLI interfaces.

## Non-Goals
- Frontend tutoring dashboards, course builders, or any UI product surfaces; these are out of scope per ADR-0001 backend-only delivery.
- Client-side scheduling logic, personalization state managers, or browser/device caches for curriculum-planner decisions.
- Non-deterministic ranking pipelines that cannot be replayed from the same signal history.
- Cross-tenant profile blending or policy bypasses that violate ADR-0001 security defaults.

## Acceptance Criteria
1. Planner APIs accept memory signals and emit deterministic, idempotent curriculum deltas keyed by learner profile.
2. Curriculum recommendations are generated from spaced repetition, misconception history, and interests with evidence pointers to underlying episodes.
3. Planner persistence is local-first and encrypted by default, with profile/tenant isolation and audit logs for signal ingestion and recommendation generation.
4. Recall/query payloads enforce max-item and size/token budgets with explicit guardrail behavior when limits are exceeded.
5. Backend-only contracts are available for dependent P3 backend beads, and no frontend artifact is required to satisfy this bead.

## Backend Boundaries
- Public interfaces are backend API/CLI contracts only; no frontend runtime or client-side compute participates in planner decisions.
- Curriculum-planning services can read/write only through sanctioned backend repositories and must preserve provenance on every memory signal.
- Scheduling, ranking, and misconception updates execute in backend workers/services with deterministic replay semantics.
- Direct database access by frontend or external plugin code is prohibited; integration occurs through authenticated backend endpoints with ADR-0001 constraints (`B/L/S/D/R/O`) enforced.
