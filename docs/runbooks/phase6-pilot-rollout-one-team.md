# Phase 6 Pilot Rollout Runbook (One Team, One Project)

## Purpose
Run a controlled UMS pilot for one team and one project, produce deterministic rollout artifacts, and create data that directly unblocks:
- `ums-memory-n4m.2` (adoption and quality KPI dashboards)
- `ums-memory-n4m.3` (ranking and decay tuning)

## Pilot Scope (fill before start)
- Pilot ID: `pilot-<team>-<project>-<YYYYMMDD>`
- Team: `<team-name>`
- Project: `<project-name>`
- Environments: `staging` then `production` (team/project scoped only)
- Pilot Duration: `10 business days`
- Owner: `<DRI name>`
- Backstop On-Call: `<secondary owner>`

## Deterministic Artifacts
Create these artifacts exactly once per pilot day:
- Telemetry stream: `ops/pilot-rollout/<pilot-id>/telemetry.ndjson`
- Operator feedback: `ops/pilot-rollout/<pilot-id>/feedback.ndjson`
- Daily summary report: `docs/reports/pilot-rollout/<pilot-id>-day-<NN>-summary.json`
- Final summary report: `docs/reports/pilot-rollout/<pilot-id>-final-summary.json`
- Rollout decision log: `docs/reports/pilot-rollout/<pilot-id>-decision-log.md`

All artifacts are append-only, committed to git, and sorted/normalized before aggregation.

## Phase Plan

### Phase 0: Preflight (T-5 to T-1 days)
Actions:
1. Confirm team/project scoping in service config (no cross-team traffic).
2. Enable telemetry capture for pilot events only.
3. Run replay check on a fixed synthetic dataset.
4. Dry-run rollback command in staging.

Exit Criteria:
1. Replay determinism check passes (`stateDigest` stable over 3 runs).
2. Telemetry ingest path writes valid NDJSON.
3. Rollback command completes in staging in under 10 minutes.

Rollback Trigger:
1. Any failed preflight check.

### Phase 1: Shadow Mode (Day 1-2)
Actions:
1. Mirror production requests to UMS (read-only effect, no user-visible response changes).
2. Generate end-of-day summary with `npm run pilot:report`.
3. Review failure code histogram and unknown operation labels.

Exit Criteria:
1. `requestVolume >= 200` mirrored requests/day.
2. `failureRate <= 0.5%`.
3. `p95LatencyMs <= 250`.
4. `UNKNOWN_FAILURE` count is `0`.

Rollback Trigger:
1. `failureRate > 1.0%` for any 2-hour window.
2. `p95LatencyMs > 400` for any 2-hour window.

### Phase 2: Controlled Activation (Day 3-7)
Actions:
1. Day 3: enable UMS for 25% of pilot team traffic.
2. Day 4-5: increase to 50% if criteria hold.
3. Day 6-7: increase to 100% for pilot team/project only.
4. Collect operator feedback after each ramp step.

Exit Criteria at each ramp:
1. Success rate `>= 99.5%` during previous 24 hours.
2. No Sev1/Sev2 incidents attributed to UMS.
3. Failure histogram dominated by known/transient codes only.
4. No trust-boundary or policy-violation anomalies.

Rollback Trigger:
1. Any Sev1/Sev2 incident with UMS as probable root cause.
2. Policy anomaly count exceeds `5` per hour.
3. Repeated unknown failure code appears (`>= 3` events in 30 minutes).

### Phase 3: Stabilization and Exit (Day 8-10)
Actions:
1. Hold at 100% pilot-team coverage.
2. Run final summary generation from complete telemetry set.
3. Publish decision log and tuning recommendations.

Exit Criteria:
1. All global success criteria met for 3 consecutive days.
2. Final summary committed and linked to bead closure.
3. Dashboard and tuning inputs handed off (see Handoff section).

Rollback Trigger:
1. Any global success criterion violated for 2 consecutive days.

## Global Success Criteria
Pilot is considered successful only if all items are true:
1. Total `requestVolume >= 2000`.
2. `successRate >= 99.5%`.
3. `failureRate <= 0.5%`.
4. `p95LatencyMs <= 250`.
5. `UNKNOWN_FAILURE` histogram bucket equals `0`.
6. No unresolved policy/trust-boundary anomalies at pilot end.

## Fallback / Rollback Procedure
When a rollback trigger fires:
1. Freeze ramp changes and announce rollback in incident channel.
2. Disable UMS for pilot scope using config toggle:
   - `UMS_PILOT_ENABLED=false`
   - `UMS_PILOT_TEAM=<team-name>`
   - `UMS_PILOT_PROJECT=<project-name>`
3. Redeploy service and confirm toggle state in runtime config endpoint.
4. Verify fallback behavior on 5 representative requests.
5. Generate rollback incident summary from telemetry in the previous 60 minutes.
6. Keep telemetry collection active for root-cause analysis.

Rollback completion criteria:
1. Pilot-scoped requests served by baseline path only.
2. Error rate returns to pre-pilot baseline within 30 minutes.
3. Incident note + artifact links recorded in decision log.

## Feedback Collection Schema

### Telemetry Event Schema (NDJSON or JSON array)
Each event must contain:
```json
{
  "timestamp": "2026-03-02T18:35:00.000Z",
  "team": "team-alpha",
  "project": "project-x",
  "operation": "context",
  "status": "ok",
  "latencyMs": 123,
  "failureCode": null,
  "policyDecision": "allow",
  "anomalyType": null,
  "requestId": "req-123",
  "metadata": {
    "environment": "production",
    "pilotPhase": "phase2"
  }
}
```

Required fields:
- `timestamp`, `team`, `project`, `operation`, and one outcome indicator (`success`, `ok`, `status`, or `result`)
- latency (`latencyMs` or equivalent)

Recommended fields:
- `failureCode`, `policyDecision`, `anomalyType`, `requestId`, `metadata.pilotPhase`

### Operator Feedback Schema (`feedback.ndjson`)
```json
{
  "timestamp": "2026-03-02T19:00:00.000Z",
  "team": "team-alpha",
  "project": "project-x",
  "pilotPhase": "phase2",
  "category": "quality|latency|ux|policy|incident",
  "severity": "low|medium|high",
  "summary": "Short issue summary",
  "details": "What happened and impact",
  "linkedRequestIds": ["req-123", "req-456"],
  "action": "none|monitor|rollback|hotfix"
}
```

## Reporting Commands
Daily report:
```bash
npm run pilot:report -- \
  --input ops/pilot-rollout/<pilot-id>/telemetry.ndjson \
  --output docs/reports/pilot-rollout/<pilot-id>-day-<NN>-summary.json
```

Final report:
```bash
npm run pilot:report -- \
  --input ops/pilot-rollout/<pilot-id>/telemetry.ndjson \
  --output docs/reports/pilot-rollout/<pilot-id>-final-summary.json
```

## Handoff to n4m.2 and n4m.3
- For `n4m.2` dashboards:
  - Use `requestVolume`, `successRate`, `failureRate`, `p95LatencyMs`, `operationHistogram`, `failureCodeHistogram`, `policyDecisionHistogram`, and `anomalyHistogram`.
- For `n4m.3` tuning:
  - Use per-operation failure and latency distributions plus anomaly/policy slices and linked feedback categories.

Attach final summary + decision log links when closing `ums-memory-n4m.1`.
