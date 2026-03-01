# ADR-0006: Phase P3 Personalization Safety and Policy Controls Scope
Date: 2026-03-01
Status: Proposed

## Context
- PLAN.md Phase P3 defines personalization/tutoring around learner profiles, misconception tracking via feedback loops, and memory-driven curriculum planning (spaced repetition, interests).
- Epic `ums-memory-d6q.5` (task `ums-memory-d6q.5.1` under umbrella `ums-memory-d6q`) adds Personalization Safety and Policy Controls for that phase area.
- ADR-0001 constraints are inherited without modification: backend-only (`B`), local-first (`L`), security defaults (`S`), deterministic/idempotent updates (`D`), bounded recall (`R`), and observability/auditability (`O`).

## Decision
- Phase P3 safety/policy controls are backend-only guardrails that enforce trust boundaries, privacy controls, and anti-overfitting safeguards across learner profile, misconception, and curriculum services.
- This ADR maps PLAN.md Phase P3 drivers into implementable backend scope, non-goals, acceptance criteria, and backend boundaries for `ums-memory-d6q`, `ums-memory-d6q.5`, and `ums-memory-d6q.5.1`.

## Scope Mapping from PLAN.md P3
| PLAN.md P3 driver | P3-05 safety/policy scope | ADR-0001 constraints inherited |
| --- | --- | --- |
| Learner profiles | Enforce profile/tenant isolation, consent-aware attributes, and redaction policies on profile writes and reads. | `B,L,S,D` |
| Misconception tracking via feedback loops | Validate feedback provenance, block poisoning patterns, and record policy decisions with audit outcomes. | `B,S,D,O` |
| Memory-driven curriculum planning (spaced repetition, interests) | Apply anti-overfitting safeguards (minimum evidence, freshness checks, bounded recommendation set) before serving guidance. | `B,R,S,D,O` |

## In Scope
- Backend policy evaluation for personalization requests using explicit trust boundaries and cross-space allowlist checks.
- Privacy controls for learner profile and misconception signals, including redaction, tenant/profile isolation, and least-privilege service access.
- Anti-overfitting safeguards for curriculum personalization, including minimum evidence thresholds, recency/decay gates, and contradiction checks before recommendations are emitted.
- Deterministic, replay-safe policy outcomes stored with provenance and audit logs for every personalization decision path.
- Backend API/CLI/MCP contract notes that publish policy result codes and deny reasons for downstream backend consumers.

## Non-Goals
- Any UI product surfaces, tutor dashboards, or client-side policy state handling are out of scope per ADR-0001.
- Human-in-the-loop policy editing UIs and visual policy designers are not part of this bead.
- Replacing deterministic policy logic with opaque or non-replayable model heuristics is not allowed.
- New cloud-only dependencies that break local-first operation are not part of this phase scope.

## Acceptance Criteria
1. Personalization calls for learner profile, misconception, and curriculum flows pass through backend-only policy gates that enforce trust boundaries and privacy controls.
2. Policy decisions are deterministic/idempotent, replay-safe, and auditable, with provenance attached to allow/deny outcomes.
3. Curriculum recommendations apply anti-overfitting safeguards and bounded recall limits before response emission.
4. Cross-tenant/profile leakage checks fail closed by default, consistent with ADR-0001 security defaults.
5. Contract documentation and ADR references explicitly include `ums-memory-d6q`, `ums-memory-d6q.5`, and `ums-memory-d6q.5.1`.

## Backend Boundaries
- Entry points are backend API/CLI/MCP endpoints only; no frontend runtime execution paths are introduced.
- Policy control services may read/write only through sanctioned backend repositories and indexes, never direct frontend or ad-hoc client persistence paths.
- Personalization state remains local-first and encrypted at rest with tenant/profile-scoped keys.
- Every policy mutation and enforcement decision emits observable audit events to satisfy `O` constraints.
- Any extension beyond these boundaries requires a new ADR; default behavior remains deny-by-default at backend boundaries.
