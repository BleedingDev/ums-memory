# Phase 6 KPI Dashboard Operations

## Purpose
Generate deterministic pilot KPI dashboard artifacts for Phase 6 from one or more pilot rollout summary reports, with optional operator feedback overlays.

## Input Artifacts
- One or more pilot summary JSON files from `npm run pilot:report`.
- Optional feedback NDJSON files (`feedback.ndjson`), one JSON object per line.

Expected summary schema version:
- `pilot_rollout_report.v1`

Expected feedback minimum fields per entry:
- `timestamp` (RFC3339)
- `category`
- `severity`
- optional `action` (defaults to `none`)

## Command
```bash
npm run pilot:dashboard -- \
  --input docs/reports/pilot-rollout/<pilot-id>-day-01-summary.json \
  --input docs/reports/pilot-rollout/<pilot-id>-day-02-summary.json \
  --feedback ops/pilot-rollout/<pilot-id>/feedback.ndjson \
  --output docs/reports/pilot-rollout/<pilot-id>-kpi-dashboard.json
```

Compact output:
```bash
npm run pilot:dashboard -- \
  --input docs/reports/pilot-rollout/<pilot-id>-final-summary.json \
  --output docs/reports/pilot-rollout/<pilot-id>-kpi-dashboard.json \
  --compact
```

Compatibility mode (skip malformed feedback lines/records):
```bash
npm run pilot:dashboard -- \
  --input docs/reports/pilot-rollout/<pilot-id>-final-summary.json \
  --feedback ops/pilot-rollout/<pilot-id>/feedback.ndjson \
  --allow-invalid
```

## Output Schema
The dashboard JSON is emitted to stdout and optionally written via `--output`.

Top-level sections:
- `schemaVersion`
- `adoption`
- `quality`
- `usefulness`
- `incidentRate`
- `recallQuality`
- `telemetryWindow`

Quality latency semantics:
- `quality.p95LatencyMs` is a conservative max-day p95 across provided summaries.
- `quality.p95LatencyEstimateMs` is a sample-weighted estimate from summary-level p95 values.

## Determinism Guarantees
- Histogram/slice keys are sorted lexicographically.
- Aggregation is order-independent across summary file order and feedback record order.
- Time windows are computed with deterministic min/max timestamp merges.

## Validation and Failure Behavior
- Fails fast when required summary fields are missing, malformed, or inconsistent.
- Fails fast on malformed feedback by default.
- With `--allow-invalid`, malformed feedback lines/records are skipped and counted under `usefulness.invalidFeedbackCount`.

## Operational Notes
- Keep dashboard artifacts in `docs/reports/pilot-rollout/` and commit with pilot decision logs.
- Use the same summary set across reruns to preserve deterministic outputs.
