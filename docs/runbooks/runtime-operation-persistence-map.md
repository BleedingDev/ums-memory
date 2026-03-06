# Runtime Operation-to-Persistence Contract Map

Date: 2026-03-05  
Owner: UMS backend platform  
Bead: `ums-memory-223.2`  
Related ADR: [ADR-0008](../adr/0008-single-runtime-storage-adapter-architecture.md)

## Purpose
Define deterministic persistence semantics for every runtime operation so migration from legacy shared JSON state to storage-adapter-backed runtime can be validated without ambiguity.

## Source of Truth
Operation list was generated from `apps/api/src/core.ts` via `listOperations()`:

```bash
node --import tsx -e "import { listOperations } from './apps/api/src/core.ts'; console.log(JSON.stringify(listOperations(), null, 2));"
```

## Contract Semantics (Applies to Every Operation)
1. Scope key:
`(storeId, profile)` scope is the deterministic memory boundary for operation state transitions.
2. Deterministic identity:
Operation request digests and derived IDs must be stable for identical logical input.
3. Replay safety:
Replaying an identical request cannot duplicate net facts or produce divergent transitions.
4. Ordering:
Any persisted collection read must apply explicit deterministic ordering before scoring/selection.
5. Authorization and policy:
Policy and trust-boundary checks are fail-closed; deny paths must remain non-mutating except deterministic audit/log records.

## Operation Classification Matrix

Legend:
- `R`: read-only (no domain mutation)
- `W`: mutating (changes state/audit/control records)

| Operation | Class | Persistence contract |
| --- | --- | --- |
| `ingest` | W | Idempotent event ingestion with deterministic duplicate handling and stable event ordering. |
| `context` | R | Deterministic recall over persisted state with bounded outputs; no state mutation. |
| `reflect` | R | Deterministic candidate derivation from existing events; no active-memory mutation. |
| `validate` | R | Deterministic candidate evidence check; no state mutation. |
| `curate` | W | Deterministic procedural-memory delta application. |
| `shadow_write` | W | Upsert shadow candidate with deterministic identity and replay-safe noop path. |
| `replay_eval` | W | Persist replay evaluation and candidate replay status metadata. |
| `promote` | W | Promote candidate only when gate/freshness preconditions pass. |
| `demote` | W | Demote candidate with deterministic reason code trail. |
| `addweight` | W | Persist bounded weight adjustment and policy audit linkage. |
| `learner_profile_update` | W | Deterministic profile upsert with evidence linkage. |
| `identity_graph_update` | W | Deterministic identity-edge upsert with provenance/evidence constraints. |
| `misconception_update` | W | Deterministic misconception state transition with evidence constraints. |
| `curriculum_plan_update` | W | Deterministic curriculum plan upsert and conflict chronology handling. |
| `review_schedule_update` | W | Deterministic review schedule upsert with bounded metadata. |
| `policy_decision_update` | W | Deterministic policy decision upsert with reason/provenance auditability. |
| `pain_signal_ingest` | W | Deterministic explicit harmful-signal persistence. |
| `failure_signal_ingest` | W | Deterministic implicit failure-signal persistence. |
| `incident_escalation_signal` | W | Deterministic incident signal persistence and quarantine hooks. |
| `manual_quarantine_override` | W | Deterministic override control persistence with strict audit trail. |
| `curriculum_recommendation` | W | Deterministic recommendation generation and recommendation snapshot persistence. |
| `review_schedule_clock` | W | Deterministic review clock transitions and bounded archival tier updates. |
| `review_set_rebalance` | W | Deterministic active-set rebalance and archival tier projection updates. |
| `curate_guarded` | W | Guarded curation + quarantine + policy audit persistence. |
| `recall_authorization` | W | Deterministic authorization decision with policy audit event persistence. |
| `attribution_ranking_policy` | W | Deterministic per-space kill-switch policy update for advisory attribution nudges. |
| `tutor_degraded` | W | Deterministic degraded tutoring session record + policy audit persistence. |
| `policy_audit_export` | W | Deterministic export artifact generation plus export audit event persistence. |
| `memory_console_search` | R | Read-only console search over persisted state projections. |
| `memory_console_timeline` | R | Read-only timeline projection over persisted state. |
| `memory_console_provenance` | R | Read-only provenance projection over persisted links. |
| `memory_console_policy_audit` | R | Read-only policy-audit projection and filtering. |
| `memory_console_anomaly_alerts` | R | Read-only anomaly projection from persisted entities/signals. |
| `feedback` | W | Deterministic feedback event persistence with replay-safe idempotency. |
| `outcome` | W | Deterministic outcome persistence and linked reinforcement updates. |
| `shadow_attribution` | R | Read-only shadow scorer over traced outcomes and replay lineage with uncertainty-first output. |
| `attribution_report` | R | Read-only advisory report that ranks helpful/harmful attribution summaries without mutating memory. |
| `audit` | R | Deterministic health/audit checks over current persisted state. |
| `export` | R | Deterministic read-only export of state projections. |
| `doctor` | R | Read-only diagnostics and deterministic status reporting. |

## Migration Enforcement Requirements
1. Runtime unification must preserve this matrix exactly unless ADR-updated.
2. Any class change (`R` <-> `W`) requires:
- ADR update
- explicit replay parity test additions
- runbook update
3. Legacy shared JSON compatibility tooling cannot redefine operation class semantics.

## Validation Checklist
1. Operation inventory test asserts full list is still covered.
2. Replay parity suite proves deterministic equivalence across persistence backends.
3. CI quality gates pass:
- `npm run quality:ts`
- `npm run test`
