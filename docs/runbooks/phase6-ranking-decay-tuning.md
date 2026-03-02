# Phase 6 Ranking and Decay Tuning Runbook

## Purpose
Generate deterministic ranking-weight and decay-policy recommendations from pilot rollout artifacts for bead `ums-memory-n4m.3`.

## Inputs
Required:
- One or more pilot summary JSON files (`pilot_rollout_report.v1`) from `npm run pilot:report`.

Optional:
- KPI dashboard JSON (`pilot_kpi_dashboard.v1`) from `npm run pilot:dashboard`.
- Operator feedback NDJSON (`feedback.ndjson`), one JSON object per line.

## Command
```bash
npm run pilot:tune -- \
  --input docs/reports/pilot-rollout/<pilot-id>-day-09-summary.json \
  --input docs/reports/pilot-rollout/<pilot-id>-day-10-summary.json \
  --dashboard docs/reports/pilot-rollout/<pilot-id>-kpi-dashboard.json \
  --feedback ops/pilot-rollout/<pilot-id>/feedback.ndjson \
  --output docs/reports/pilot-rollout/<pilot-id>-ranking-decay-tuning.json
```

Compact output:
```bash
npm run pilot:tune -- \
  --input docs/reports/pilot-rollout/<pilot-id>-final-summary.json \
  --compact
```

## Output Contract
Schema version:
- `pilot_ranking_decay_tuning.v1`

Top-level sections:
- `schemaVersion`
- `baseline`
- `observedMetrics`
- `recommendedRankingWeights`
- `recommendedDecayPolicy`
- `guardrails`
- `rationale`

## Heuristic Model
Recommendations are bounded deterministic heuristics over measured pilot signals:
- Failure pressure from `failureRate`.
- Latency pressure from `p95LatencyMs`.
- Recall pressure from recall-oriented per-operation failure rates.
- Anomaly pressure from summary anomaly histograms.
- Incident and feedback pressure from incident density, rollback actions, and high-severity feedback.

Effects:
- Ranking weights shift from semantic similarity toward reliability/safety/recency as pressure increases.
- Decay policy adjusts retention and stale windows within bounded ranges.
- Guardrails tighten with elevated pressure signals.

## Validation and Failure Behavior
- Fails fast on malformed summary JSON or schema mismatches.
- Fails fast on malformed dashboard JSON or schema mismatches.
- Feedback parsing is strict by default and rejects malformed entries.
- Output key ordering and values are stable for equivalent input content regardless of input file order.

## Operational Notes
- Commit tuning artifacts to `docs/reports/pilot-rollout/` together with pilot decision logs.
- Re-run tuning only after summary/dashboard artifacts are finalized to preserve reproducibility.
- Link the tuning artifact when closing `ums-memory-n4m.3`.
