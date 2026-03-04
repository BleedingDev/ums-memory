# Phase 3 Domain SLO + Rejection Validation Summary (2026-03-04)

## Misconception (`d6q.2.9` / validation `d6q.2.6`)

- Success and p95 targets documented: `>=99.9%`, `<=250ms`.
- Metrics checklist mapped:
  - `misconception_signal_requests_total{action}`
  - `misconception_signal_latency_ms`
  - `misconception_guardrail_reject_total{reason}`
  - `misconception_replay_mismatch_total`
  - `misconception_decay_applied_total`
  - `misconception_retrieval_freshness_ms`
- Guardrail rejection semantics covered by API tests for malformed payload, missing evidence pointers, and deterministic replay parity.

## Curriculum (`d6q.3.9` / validation `d6q.3.6`)

- Success and p95 targets documented: `>=99.9%`, `<=300ms`.
- Metrics checklist mapped:
  - `curriculum_plan_requests_total{action}`
  - `curriculum_plan_latency_ms`
  - `curriculum_guardrail_reject_total{reason}`
  - `curriculum_replay_mismatch_total`
  - `curriculum_recommendation_drift_total`
- Guardrail rejection and positive path observability covered in API deterministic contract tests.

## Review Scheduling (`d6q.4.9` / validation `d6q.4.6`)

- Success and p95 targets documented: `>=99.9%`, `<=250ms`.
- Metrics checklist mapped:
  - `review_schedule_mutation_requests_total{action}`
  - `review_schedule_mutation_latency_ms`
  - `review_schedule_guardrail_reject_total{reason}`
  - `review_schedule_replay_mismatch_total`
  - `review_schedule_provenance_missing_total`
- Scheduling benchmark artifacts:
  - `docs/performance/phase3-review-scheduling-latency-gate.latest.json`
  - `docs/performance/phase3-review-scheduling-latency-gate.latest.md`

## Personalization Policy (`d6q.5.9` / validation `d6q.5.6`)

- Success and p95 targets documented: `>=99.95%`, `<=150ms`.
- Metrics checklist mapped:
  - `personalization_policy_requests_total{decision}`
  - `personalization_policy_eval_latency_ms`
  - `personalization_policy_reject_total{reason}`
  - `personalization_policy_replay_mismatch_total`
  - `personalization_allowlist_deny_total`
  - `personalization_overfit_block_total`
- Policy incident and replay artifacts:
  - `docs/reports/phase3/policy-audit-export-sample-2026-03-04.ndjson`
  - `docs/reports/phase3/policy-incident-checklist-2026-03-04.md`
  - `docs/reports/phase3/policy-replay-transcript-2026-03-04.md`
