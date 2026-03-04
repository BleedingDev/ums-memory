# UMS Deploy and Operations Runbook (Compose-First)

## Scope

- Current deployment target is Docker + Docker Compose only.
- Kubernetes manifests are intentionally out of scope for this architecture.
- Runtime topology is one `api` service + one `worker` service sharing one state file.
- This runbook assumes one environment per host because `deploy/compose.yml` binds host port `8787`.
- For automated game day restore drills, see [UMS Disaster-Recovery Game Day Automation Runbook](./disaster-recovery-game-day-automation.md).

## Runtime Contract

1. Compose asset: `deploy/compose.yml`.
2. API service endpoint: `GET /` on port `8787`.
3. Observability endpoint: `GET /metrics` on port `8787` (requires auth header).
4. Shared state file: `UMS_STATE_FILE=/var/lib/ums/.ums-state.json`.
5. Shared volume name pattern: `<project>_ums_shared_state` (for example `ums-prod_ums_shared_state`).

## Environment Variables (Current Compose)

| Variable                    | Service         | Current value in `deploy/compose.yml` |
| --------------------------- | --------------- | ------------------------------------- |
| `UMS_API_HOST`              | `api`           | `0.0.0.0`                             |
| `UMS_API_PORT`              | `api`           | `8787`                                |
| `UMS_STATE_FILE`            | `api`, `worker` | `/var/lib/ums/.ums-state.json`        |
| `UMS_STATE_LOCK_TIMEOUT_MS` | `api`           | `8000`                                |
| `UMS_STATE_LOCK_RETRY_MS`   | `api`           | `25`                                  |
| `UMS_API_AUTH_REQUIRED`     | `api`           | `true`                                |
| `UMS_API_AUTH_TOKENS`       | `api`           | `${UMS_API_AUTH_TOKENS:?required}`    |
| `UMS_API_HOST`              | `worker`        | `api`                                 |
| `UMS_API_PORT`              | `worker`        | `8787`                                |
| `UMS_API_HEALTH_PATH`       | `worker`        | `/`                                   |
| `UMS_API_READY_TIMEOUT_MS`  | `worker`        | `90000`                               |

## Local Deploy

Run from repository root:

```bash
export UMS_API_AUTH_TOKENS="<configured-shared-api-token>"
docker compose -f deploy/compose.yml up --build -d
docker compose -f deploy/compose.yml ps
curl -fsS http://127.0.0.1:8787/
curl -fsS -H "Authorization: Bearer ${UMS_API_AUTH_TOKENS}" http://127.0.0.1:8787/metrics | head -n 20
docker compose -f deploy/compose.yml logs --tail=100 api worker
```

Stop services:

```bash
docker compose -f deploy/compose.yml down
```

Destructive reset (includes volume removal):

```bash
docker compose -f deploy/compose.yml down -v
```

## Staging Deploy

Run on the staging host from a checked-out repo revision:

```bash
export PROJECT=ums-staging
export UMS_API_AUTH_TOKENS="<configured-shared-api-token>"
docker compose -p "$PROJECT" -f deploy/compose.yml up --build -d --remove-orphans
docker compose -p "$PROJECT" -f deploy/compose.yml ps
curl -fsS http://127.0.0.1:8787/
curl -fsS -H "Authorization: Bearer ${UMS_API_AUTH_TOKENS}" http://127.0.0.1:8787/metrics | head -n 20
```

Staging rollback to prior revision:

1. Check out the prior git revision on the host.
2. Re-run the same `docker compose ... up --build -d --remove-orphans` command.

## Production Deploy

Run on the production host:

1. Create a state backup (use the backup procedure below).
2. Deploy the new revision:

```bash
export PROJECT=ums-prod
export UMS_API_AUTH_TOKENS="<configured-shared-api-token>"
docker compose -p "$PROJECT" -f deploy/compose.yml up --build -d --remove-orphans
docker compose -p "$PROJECT" -f deploy/compose.yml ps
curl -fsS http://127.0.0.1:8787/
curl -fsS -H "Authorization: Bearer ${UMS_API_AUTH_TOKENS}" http://127.0.0.1:8787/metrics | head -n 20
docker compose -p "$PROJECT" -f deploy/compose.yml logs --tail=100 api worker
```

3. If validation fails, restore the backup and redeploy the last known-good revision.

## Backup Procedure

Use this for staging or production by setting `PROJECT`:

```bash
export PROJECT=ums-prod
export VOLUME="${PROJECT}_ums_shared_state"
export BACKUP_DIR="$PWD/backups"
export TS="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BACKUP_DIR"

docker compose -p "$PROJECT" -f deploy/compose.yml stop worker
docker run --rm \
  -v "${VOLUME}:/var/lib/ums" \
  -v "${BACKUP_DIR}:/backup" \
  ums-memory-api:local \
  sh -ec "test -f /var/lib/ums/.ums-state.json; cp /var/lib/ums/.ums-state.json /backup/ums-state-${TS}.json"
docker compose -p "$PROJECT" -f deploy/compose.yml start worker
ls -lh "$BACKUP_DIR/ums-state-${TS}.json"
```

Backup success criteria:

1. Backup file exists and is non-empty.
2. Services return to healthy state in `docker compose ... ps`.
3. For first-time bootstrap with no existing state file, skip pre-deploy backup and create a baseline backup immediately after deployment validation.

## Restore Procedure

Use only during controlled recovery:

```bash
export PROJECT=ums-prod
export VOLUME="${PROJECT}_ums_shared_state"
export BACKUP_DIR="$PWD/backups"
export BACKUP_FILE="ums-state-<timestamp>.json"
export UMS_API_AUTH_TOKENS="<configured-shared-api-token>"

docker compose -p "$PROJECT" -f deploy/compose.yml down
docker run --rm \
  -v "${VOLUME}:/var/lib/ums" \
  -v "${BACKUP_DIR}:/backup" \
  ums-memory-api:local \
  sh -ec "cp /backup/${BACKUP_FILE} /var/lib/ums/.ums-state.json; rm -f /var/lib/ums/.ums-state.json.lock"
docker compose -p "$PROJECT" -f deploy/compose.yml up -d
docker compose -p "$PROJECT" -f deploy/compose.yml ps
curl -fsS http://127.0.0.1:8787/
curl -fsS -H "Authorization: Bearer ${UMS_API_AUTH_TOKENS}" http://127.0.0.1:8787/metrics | head -n 20
```

Restore success criteria:

1. `api` and `worker` are healthy in compose status.
2. `GET /` returns `200`.
3. `GET /metrics` returns `200` and Prometheus-formatted payload when called with the configured auth token.

## Incident Response

### 1) Triage (always first)

```bash
export PROJECT=ums-prod
export UMS_API_AUTH_TOKENS="<configured-shared-api-token>"
docker compose -p "$PROJECT" -f deploy/compose.yml ps
docker compose -p "$PROJECT" -f deploy/compose.yml logs --since=15m api worker
curl -fsS http://127.0.0.1:8787/ || true
curl -fsS -H "Authorization: Bearer ${UMS_API_AUTH_TOKENS}" http://127.0.0.1:8787/metrics | head -n 20 || true
```

### 2) Containment

1. If state-write contention or repeated `STATE_LOCK_TIMEOUT` errors are observed, stop background mutations first:

```bash
docker compose -p "$PROJECT" -f deploy/compose.yml stop worker
```

2. Keep API up for read/diagnostic traffic where possible.

### 3) Recovery Playbooks

1. API unhealthy or not responding:
   - `docker compose -p "$PROJECT" -f deploy/compose.yml restart api`
   - Re-check `GET /` and authenticated `GET /metrics`.
2. Worker crash-loop or startup timeout waiting for API:
   - Confirm API `GET /` is `200`.
   - `docker compose -p "$PROJECT" -f deploy/compose.yml restart worker`
3. `STATE_FILE_CORRUPT` errors:
   - Stop stack.
   - Restore latest known-good backup.
   - Start stack and re-validate endpoints.

### 4) Exit Criteria

1. `api` and `worker` healthy.
2. `GET /` and authenticated `GET /metrics` stable for 15 minutes.
3. Incident log includes timeline, root cause, and recovery commands executed.

## Observability Endpoints

1. `GET /`
   - Purpose: API liveliness and route inventory.
   - Expected: `200` JSON payload with `service`, `version`, and operation list.
2. `GET /metrics`
   - Purpose: Prometheus scrape endpoint.
   - Expected: `200` with content type `text/plain; version=0.0.4; charset=utf-8`.
   - Authentication: provide `Authorization: Bearer <UMS_API_AUTH_TOKENS>` or `x-ums-api-key`.
   - Key series exposed by current runtime include:
     - `ums_api_operation_requests_total`
     - `ums_api_operation_latency_ms_bucket`
     - `ums_api_operation_latency_ms_count`
     - `ums_api_operation_latency_ms_sum`

Example checks:

```bash
curl -fsS -H "Authorization: Bearer ${UMS_API_AUTH_TOKENS}" http://127.0.0.1:8787/metrics | grep '^ums_api_operation_requests_total'
curl -fsS -H "Authorization: Bearer ${UMS_API_AUTH_TOKENS}" http://127.0.0.1:8787/metrics | grep '^ums_api_operation_latency_ms_count'
```
