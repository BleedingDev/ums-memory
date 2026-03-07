# ADR-0009: Tiered Credit Assignment Safety Envelope

Date: 2026-03-06
Status: Accepted

## Context

UMS already defines replay-gated promotion and demotion semantics, bounded recall, explainability, and provenance-first memory operations. The new credit-assignment track needs a decision record before implementation starts, because raw attribution signals can create false confidence, cross-tenant leakage risk, non-deterministic behavior, and premature automation pressure.

This ADR locks the tiered credit-assignment decision boundary for downstream work under epic `ums-memory-jny`.

## Decision

UMS adopts a tiered credit-assignment model with an advisory-first safety envelope:

1. Stable trace identifiers:
   Every `context` response must emit deterministic `packId` and per-item `usageId` values so downstream outcomes can reference the exact memory pack and surfaced items that were available to the agent.
2. Evidence tiers:
   Credit-assignment evidence is classified into three tiers:
   - Tier 1 `observational`: traced memory usage linked to downstream outcomes.
   - Tier 2 `deterministic_replay`: bounded replay and ablation evidence using deterministic evaluation packs.
   - Tier 3 `randomized_canary`: interventional live evidence with explicit kill-switch control.
3. Advisory-only launch posture:
   Tier 1 and Tier 2 evidence may inform dashboards, human review, and bounded offline ranking experiments, but they cannot directly promote, demote, or delete active memory.
4. Automation ceiling:
   Tier 3 evidence may justify bounded retrieval-ranking nudges only. Credit-assignment evidence alone must not directly mutate procedural memory state.
5. Deterministic and bounded scoring:
   Credit-assignment computation must remain replay-safe, top-k bounded, and deterministic for identical inputs. Exhaustive combinatorial attribution is out of scope.
6. Confidence and sparse-data handling:
   All attribution outputs must include evidence tier, effect size, confidence, support count, and reason codes. Sparse or ambiguous data must degrade to `no-op` or low-confidence advisory output rather than force a score.
7. Safety and policy override:
   Tenant isolation, policy violations, harmful feedback, and safety regressions override positive attribution signals.
8. Privacy-default tracing:
   Fine-grained usage traces must be minimum-necessary, same-tenant only, retention-bounded, and protected by per-space or per-tenant disable and kill-switch controls.
9. Rare-memory protection:
   Low observed utility is not sufficient to prune rare, high-severity, or operator-pinned memory. Such memory requires stronger evidence or explicit operator action.

Constraint tags used in mappings:

- `B`: backend-only
- `L`: local-first
- `S`: security defaults
- `D`: deterministic + idempotent updates
- `R`: bounded recall + guardrails
- `O`: observability/auditability

## Scope

In scope:

- `packId` and `usageId` contract semantics for context-generation surfaces.
- Outcome linkage semantics for tool, test, artifact, and result traces.
- Shadow-only attribution scoring with uncertainty-first outputs.
- Calibration suites with negative controls, delayed outcomes, and synergy checks.
- Read-only attribution reporting.
- Retrieval-ranking nudges behind kill switches after stronger evidence thresholds.

Out of scope:

- Direct attribution-driven promotion, demotion, or deletion of active memory.
- Cross-tenant attribution joins or shared usage-trace pools.
- Unbounded or exhaustive Shapley-style combinatorial scoring.
- Frontend admin consoles or policy-editing UI.
- Production claims of causal truth from observational evidence alone.

## Acceptance Criteria

1. Contract completeness:
   All attribution-related contracts expose evidence tier, confidence, support count, and lineage references.
2. Deterministic replay safety:
   Identical traced inputs produce stable attribution outputs and stable no-op behavior on sparse data.
3. Mutation guardrail:
   No runtime path uses attribution alone to promote, demote, or delete memory.
4. Privacy and tenancy:
   Usage-trace retention, same-tenant joins, and kill-switch controls are specified before rollout.
5. Calibration evidence:
   Negative-control, synergy, delayed-outcome, and safety-regression cases are required before advisory runtime integration.
6. Rollback readiness:
   Any runtime ranking use of attribution remains bounded, kill-switch controlled, and easy to disable without data migration.

## Consequences

Positive:

- Preserves replay-eval as the primary promotion and demotion gate.
- Gives downstream attribution beads a clear implementation boundary.
- Converts attribution into a measurable advisory signal instead of an implicit automation shortcut.
- Protects security, privacy, and rare-memory retention from metric overreach.

Costs:

- Adds instrumentation, lineage, and calibration work before runtime integration.
- Slows direct automation in exchange for safer rollout.
- Requires ongoing operator review and observability for attribution quality.

## Required Follow-ups

- Emit deterministic `packId` and `usageId` values from context surfaces.
- Persist outcome linkage for traced usage.
- Implement shadow-only attribution scoring.
- Add calibration suite and negative controls.
- Define privacy, retention, and tenant-isolation rules for usage traces.
- Publish read-only attribution reporting.
- Gate attribution to bounded ranking nudges behind kill switches.
