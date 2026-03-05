# ADR-0008: Single Runtime Architecture with Storage-Adapter Backend Selection
Date: 2026-03-05
Status: Accepted

## Context
Prelaunch planning identified a structural risk: UMS runtime behavior currently depends on a shared JSON state execution path for API/worker request handling, while enterprise-grade storage contracts already exist in the Effect storage layer. Keeping both as primary runtime paths increases complexity, makes determinism harder to reason about, and creates avoidable behavior drift.

This ADR resolves prelaunch architecture direction for bead `ums-memory-223.1`.

## Decision
UMS adopts one runtime architecture:

1. Single runtime semantics:
All operations execute against one persistence contract, regardless of deployment mode.
2. Backend selection via storage adapter:
Backend differs only by adapter (`sqlite` local/single-node, `postgres` scale path), not by separate runtime logic.
3. Shared JSON path is compatibility-only:
Legacy shared JSON state remains import/export tooling and cannot remain a primary serving path.
4. Determinism and replay safety are mandatory:
Adapter differences must not change operation-level deterministic outcomes.
5. Effect boundary discipline:
Boundary contracts remain TypeScript + Effect schema validated; no Zod edge-model introduction.

## Scope
In scope:
- Runtime routing and persistence architecture used by API/worker operation execution.
- Adapter-based backend selection (`sqlite`, `postgres`) under one runtime contract.
- Deterministic parity validation between legacy behavior and unified path during migration.

Out of scope:
- Federation enablement work.
- New frontend workflows.
- Research parity claims beyond existing NCM v1 constraints.

## Consequences
Positive:
- Lower long-term complexity from one serving architecture.
- Cleaner deterministic reasoning and replay parity enforcement.
- Clear local-to-scale backend evolution path through adapters.

Costs:
- Migration cost is paid before launch.
- Requires explicit parity harnesses and operational cutover discipline.
- Requires retiring hidden dependencies on shared JSON lockfile behavior.

## Alternatives Considered
1. Keep current dual primary paths (shared JSON + adapter path):
Rejected due to complexity and deterministic drift risk.
2. Delay unification until post-launch:
Rejected; prelaunch window is the least risky time to pay migration cost.
3. Force Postgres-only immediately:
Rejected; SQLite remains valuable for local-first and controlled single-node deployments.

## Required Follow-ups
- `ums-memory-223.2`: publish operation-to-persistence contract map.
- `ums-memory-2dc.*`: runtime unification tasks and parity harness.
- Update phase runbook references to include this ADR and the operation map.
