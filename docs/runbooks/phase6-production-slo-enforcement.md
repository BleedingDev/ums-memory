# Phase 6 Production SLO Enforcement Runbook

## Purpose

Evaluate pilot KPI artifacts against explicit production SLO objectives with deterministic outputs suitable for release gates and handoff to `ums-memory-n4m.4`.

## Inputs

Required:

- One or more KPI dashboard JSON files (`pilot_kpi_dashboard.v1`) from `bun run pilot:dashboard`.

Optional:

- One tuning recommendation JSON file (`pilot_ranking_decay_tuning.v1`) from `bun run pilot:tune`.

Required CLI timestamp:

- `--evaluated-at` must be provided as RFC3339 to keep output deterministic.

## Command

```bash
bun run pilot:slo -- \
  --dashboard docs/reports/pilot-rollout/<pilot-id>-kpi-dashboard.json \
  --tuning docs/reports/pilot-rollout/<pilot-id>-ranking-decay-tuning.json \
  --evaluated-at 2026-03-02T18:30:00Z \
  --output docs/reports/pilot-rollout/<pilot-id>-production-slo-evaluation.json
```

Multiple dashboards:

```bash
bun run pilot:slo -- \
  --dashboard docs/reports/pilot-rollout/<pilot-id>-day-08-kpi-dashboard.json \
  --dashboard docs/reports/pilot-rollout/<pilot-id>-day-09-kpi-dashboard.json \
  --evaluated-at 2026-03-02T18:30:00Z \
  --compact
```

## SLO Objectives

Baseline thresholds (tightened when tuning guardrails are stricter):

- `successRate >= 0.995`
- `failureRate <= 0.005`
- `p95LatencyMs <= 250`
- `incidentsPer1kRequests <= 2`
- `recallFailureRate <= 0.04`
- `anomaliesPer1kRequests <= 4`
- `policyReviewRate <= 0.06`

## Output Contract

Schema version:

- `production_slo_evaluation.v1`

Top-level fields:

- `schemaVersion`
- `evaluatedAt`
- `inputs`
- `thresholds`
- `measurements`
- `verdict`
- `failedObjectives`
- `actionPlan`

Behavior:

- `verdict: "pass"` returns process exit code `0`.
- `verdict: "fail"` returns process exit code `2` for deterministic pipeline gating.

## Determinism Guarantees

- `--evaluated-at` is mandatory and normalized to ISO (`RFC3339` compatible).
- Dashboard source paths in `inputs.dashboardSources` are lexicographically sorted.
- Objective evaluation order, failed objective ordering, and action plan ordering are deterministic.
- Equivalent input sets produce byte-stable JSON output under identical arguments.

## Validation and Failure Behavior

- Fails fast on malformed dashboard JSON, schema mismatches, or missing required KPI fields.
- Fails fast on malformed tuning JSON, schema mismatches, or missing guardrail fields.
- Fails fast when derived KPI values are internally inconsistent (for example, rates not matching counts).

## Operational Notes

- Store resulting artifacts under `docs/reports/pilot-rollout/`.
- Use this output as a release gate attachment in decision logs and bead closure notes.
