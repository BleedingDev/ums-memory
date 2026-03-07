# UMS Disaster-Recovery Game Day Automation Runbook (Compose-First)

## Objective and Scope

- Prove that UMS can be restored from backup with deterministic behavior using the current Docker Compose runtime.
- Automate one repeatable restore drill workflow for non-production game day validation.
- Keep implementation minimal: shell commands, cron, CI schedule, and existing `deploy/compose.yml`.
- This runbook assumes the current topology from `docs/runbooks/deploy-operations-compose-first.md`:
  - One `api` + one `worker`
  - Runtime state base rooted under `/var/lib/ums/.ums-runtime-state`
  - Legacy compatibility snapshot `/var/lib/ums/.ums-state.json` only when running explicit import/export tooling
  - Host port `8787` bound by compose (one active environment per host)
- Production recovery procedures remain in the compose operations runbook; this runbook focuses on automated drills.

## Prerequisites

- Docker Engine with Compose plugin (`docker compose`)
- Bun CLI available on host (`bun`; used for deterministic timestamp and payload checks)
- `bash`, `curl`, `awk`, `grep`, and one SHA-256 utility (`sha256sum` or `shasum`)
- At least one backup file at `backups/ums-state-*.json`

## RTO/RPO Targets and Pass-Fail Gates

Definitions:

- `RTO` (Recovery Time Objective): elapsed time from drill trigger to all validation checks passing.
- `RPO` (Recovery Point Objective): age of the backup used for restore at drill start.

Default targets for current compose-first stage:

- `RTO_TARGET_SECONDS=900` (15 minutes)
- `RPO_TARGET_SECONDS=86400` (24 hours)

Hard gates (drill fails if any gate fails):

| Gate ID | Requirement        | Pass Condition                                                                           |
| ------- | ------------------ | ---------------------------------------------------------------------------------------- |
| G1      | RPO                | `backup_age_seconds <= RPO_TARGET_SECONDS`                                               |
| G2      | Restore completion | Stack restored and healthy in compose status                                             |
| G3      | API health         | `GET /` returns `200` and valid service payload                                          |
| G4      | Metrics health     | `GET /metrics` returns `200` with required series                                        |
| G5      | Snapshot integrity | Restored runtime snapshot or explicit compatibility snapshot matches the backup artifact |
| G6      | Replay parity      | Deterministic replay check returns expected idempotent result                            |
| G7      | RTO                | `rto_seconds <= RTO_TARGET_SECONDS`                                                      |

## Automated Restore Drill Workflow

### Schedule

- Weekly scheduled drill on a dedicated drill/staging host (example: Monday 03:00 UTC).
- Additional manual trigger after high-risk deploys or backup/restore flow changes.

### Trigger Inputs

- `DRILL_ID` (default UTC timestamp)
- `PROJECT` (must be `ums-drill-*`)
- `BACKUP_FILE` (path to `ums-state-<timestamp>.json`)
- Optional overrides:
  - `RTO_TARGET_SECONDS`
  - `RPO_TARGET_SECONDS`
  - `API_READY_TIMEOUT_SECONDS` (default `120`)
  - `DRILL_KEEP_ENV_ON_FAILURE=1` to keep failed drill environment for debugging

### Workflow Steps

1. Initialize variables and enforce safety guard.
2. Resolve latest backup and compute `backup_age_seconds` (RPO gate).
3. Create isolated drill project/volume and perform restore using current compose flow.
4. Start compose services, wait for API readiness (bounded timeout), and verify container health.
5. Run deterministic validation checks (API, metrics, snapshot integrity, replay parity).
6. Measure `rto_seconds`, evaluate final pass/fail, and persist a status manifest.
7. If primary restore fails, retry once with previous backup; then persist artifacts and tear down (or retain for debugging on failure).

Command template (single-shell executor):

```bash
set -euo pipefail

export DRILL_ID="${DRILL_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"
PROJECT="${PROJECT:-ums-drill-${DRILL_ID}}"
[[ "$PROJECT" == ums-drill-* ]] || { echo "PROJECT must start with ums-drill-"; exit 2; }

RTO_TARGET_SECONDS="${RTO_TARGET_SECONDS:-900}"
RPO_TARGET_SECONDS="${RPO_TARGET_SECONDS:-86400}"
API_READY_TIMEOUT_SECONDS="${API_READY_TIMEOUT_SECONDS:-120}"

BACKUP_FILE="${BACKUP_FILE:-$(ls -1t backups/ums-state-*.json | head -n1)}"
FALLBACK_BACKUP_FILE="${FALLBACK_BACKUP_FILE:-$(ls -1t backups/ums-state-*.json | sed -n '2p')}"
export PROJECT RTO_TARGET_SECONDS RPO_TARGET_SECONDS API_READY_TIMEOUT_SECONDS BACKUP_FILE FALLBACK_BACKUP_FILE

./ops/run-dr-restore-drill.sh
```

## Deterministic Validation Checks

Run all checks against the restored drill stack.

### 1) API Health Check

```bash
curl -fsS http://127.0.0.1:8787/ > "${ARTIFACT_DIR}/api-root.json"
bun -e '
import { readFileSync } from "node:fs";
const root = JSON.parse(readFileSync(process.argv[1], "utf8"));
if (root.ok !== true || root.service !== "ums-api" || root.deterministic !== true) process.exit(1);
' "${ARTIFACT_DIR}/api-root.json"
```

Pass criteria:

- HTTP `200`
- Response includes `ok=true`, `service="ums-api"`, and `deterministic=true`

### 2) Metrics Check

```bash
curl -fsS -X POST http://127.0.0.1:8787/v1/doctor -H 'content-type: application/json' -d '{"storeId":"coding-agent"}' >/dev/null
curl -fsS -X POST http://127.0.0.1:8787/v1/export -H 'content-type: application/json' -d '{"storeId":"coding-agent","format":"playbook"}' >/dev/null
curl -fsS http://127.0.0.1:8787/metrics > "${ARTIFACT_DIR}/metrics.prom"
grep -q '^ums_api_operation_requests_total' "${ARTIFACT_DIR}/metrics.prom"
grep -q '^ums_api_operation_latency_ms_count' "${ARTIFACT_DIR}/metrics.prom"
grep -q 'operation="doctor",result="success"' "${ARTIFACT_DIR}/metrics.prom"
grep -q 'operation="export",result="success"' "${ARTIFACT_DIR}/metrics.prom"
```

Pass criteria:

- HTTP `200` from `/metrics`
- Prometheus payload includes request and latency series
- Successful operation series exists for `doctor` and `export`

### 3) Snapshot Integrity Check

```bash
sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
    return
  fi
  shasum -a 256 "$1" | awk '{print $1}'
}

BACKUP_SHA="$(sha256_file "${BACKUP_FILE}")"
RESTORED_SHA="$(
  docker run --rm -v "${VOLUME}:/var/lib/ums" ums-memory-api:local \
    sh -ec 'test -s /var/lib/ums/.ums-state.json; sha256sum /var/lib/ums/.ums-state.json' \
    | awk "{print \$1}"
)"
[[ "${BACKUP_SHA}" == "${RESTORED_SHA}" ]]

docker run --rm -v "${VOLUME}:/var/lib/ums" ums-memory-api:local \
  bun -e 'import { readFileSync } from "node:fs"; JSON.parse(readFileSync("/var/lib/ums/.ums-state.json","utf8"));'
```

Pass criteria:

- Runtime restore succeeds, and when an explicit legacy compatibility snapshot is part of the drill it exists and is non-empty
- SHA-256 hash matches backup file hash
- JSON parse succeeds

### 4) Replay Parity Check

```bash
cat > "${ARTIFACT_DIR}/replay-payload.json" <<'JSON'
{
  "storeId": "drill-replay-store",
  "events": [
    {
      "eventId": "__DRILL_EVENT_ID__",
      "type": "note",
      "source": "dr-game-day",
      "content": "Replay parity probe event",
      "timestamp": "2026-01-01T00:00:00.000Z"
    }
  ]
}
JSON

bun -e '
import { readFileSync, writeFileSync } from "node:fs";
const p = process.argv[1];
const payload = JSON.parse(readFileSync(p, "utf8"));
payload.events[0].eventId = `drill-${process.env.DRILL_ID}-replay-event`;
writeFileSync(p, JSON.stringify(payload));
' "${ARTIFACT_DIR}/replay-payload.json"

curl -fsS -X POST http://127.0.0.1:8787/v1/ingest \
  -H 'content-type: application/json' \
  --data-binary @"${ARTIFACT_DIR}/replay-payload.json" \
  > "${ARTIFACT_DIR}/replay-first.json"

curl -fsS -X POST http://127.0.0.1:8787/v1/ingest \
  -H 'content-type: application/json' \
  --data-binary @"${ARTIFACT_DIR}/replay-payload.json" \
  > "${ARTIFACT_DIR}/replay-second.json"

bun -e '
import { readFileSync } from "node:fs";
const first = JSON.parse(readFileSync(process.argv[1], "utf8"));
const second = JSON.parse(readFileSync(process.argv[2], "utf8"));
if (first.data.accepted !== 1 || first.data.duplicates !== 0) process.exit(1);
if (second.data.accepted !== 0 || second.data.duplicates !== 1) process.exit(1);
if (first.data.ledgerDigest !== second.data.ledgerDigest) process.exit(1);
' "${ARTIFACT_DIR}/replay-first.json" "${ARTIFACT_DIR}/replay-second.json"
```

Pass criteria:

- First ingest accepts event; second identical ingest is duplicate
- `ledgerDigest` is unchanged between first and second request
- Confirms deterministic replay-safe behavior on restored state

### 5) Final RTO Gate and Manifest

```bash
END_TS="$(date +%s)"
RTO_SECONDS="$((END_TS - START_TS))"
[[ "${RTO_SECONDS}" -le "${RTO_TARGET_SECONDS}" ]] || { echo "RTO gate failed"; exit 1; }

docker compose -p "${PROJECT}" -f deploy/compose.yml logs --tail=200 api worker \
  > "${ARTIFACT_DIR}/compose-logs-api-worker.txt"

cat > "${ARTIFACT_DIR}/checksums.txt" <<EOF
backup_sha256=${BACKUP_SHA}
restored_sha256=${RESTORED_SHA}
EOF

cat > "${ARTIFACT_DIR}/manifest.json" <<EOF
{"drillId":"${DRILL_ID}","project":"${PROJECT}","backupFile":"${BACKUP_FILE}","rpoSeconds":${BACKUP_AGE_SECONDS},"rpoTargetSeconds":${RPO_TARGET_SECONDS},"rtoSeconds":${RTO_SECONDS},"rtoTargetSeconds":${RTO_TARGET_SECONDS},"status":"pass"}
EOF
```

## Failure Handling, Escalation, and Rollback

If any gate fails:

1. Mark drill result `FAIL` and capture artifacts before teardown.
2. Capture immediate diagnostics:
   - `docker compose -p "$PROJECT" -f deploy/compose.yml ps`
   - `docker compose -p "$PROJECT" -f deploy/compose.yml logs --tail=200 api worker`
3. Retry once with the previous known-good backup (`ls -1t backups/ums-state-*.json | sed -n '2p'`).
4. If retry fails, escalate:
   - Primary: backend on-call / incident commander
   - Secondary: platform owner for compose host/runtime issues
   - Include failing gate IDs, timestamps, and artifact path

The provided `ops/run-dr-restore-drill.sh` entrypoint implements these failure handling rules directly, including readiness wait, diagnostics capture, and one fallback retry attempt.

Rollback policy:

- Drill automation must only run on `ums-drill-*` projects.
- On failure, rollback is environment cleanup:
  - `docker compose -p "$PROJECT" -f deploy/compose.yml down -v`
- To inspect a failed drill before cleanup, set `DRILL_KEEP_ENV_ON_FAILURE=1`.
- For real incident recovery of staging/production, use restore procedure in `docs/runbooks/deploy-operations-compose-first.md`.

## Evidence Artifacts Per Drill

Store under `artifacts/dr-drills/<DRILL_ID>/` (or mirrored object storage path):

- `manifest.json` with `drillId`, backup metadata, gate statuses, `rtoSeconds`, `rpoSeconds`, final status
- `compose-ps.txt`
- `compose-logs-api-worker.txt`
- `api-root.json`
- `metrics.prom`
- `replay-payload.json`
- `replay-first.json`
- `replay-second.json`
- `checksums.txt` (`backup_sha256`, `restored_sha256`)
- `commands.log` (full command output transcript)

## Minimum Automation Hooks (No Overengineering)

Use one shell entrypoint (commands above) plus one scheduler.

Cron template (host-based):

```cron
0 3 * * 1 cd /opt/ums-memory && DRILL_ID="$(date -u +\%Y\%m\%dT\%H\%M\%SZ)" PROJECT="ums-drill-${DRILL_ID}" BACKUP_FILE="$(ls -1t backups/ums-state-*.json | head -n1)" ./ops/run-dr-restore-drill.sh >> /var/log/ums-dr-drill.log 2>&1
```

CI template (scheduled/manual):

```bash
# Example CI step command
set -euo pipefail
export DRILL_ID="${DRILL_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"
export PROJECT="ums-drill-${DRILL_ID}"
export BACKUP_FILE="$(ls -1t backups/ums-state-*.json | head -n1)"
./ops/run-dr-restore-drill.sh
```

Keep hooks limited to:

- Scheduler trigger (cron or CI)
- Environment variable injection
- One deterministic shell command sequence in `ops/run-dr-restore-drill.sh` (provided in this repository)
