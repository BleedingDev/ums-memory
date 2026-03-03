# UMS Container Deployment

These assets containerize the current API and worker runtimes with a shared on-disk state file.

## Runbook

For deterministic deploy and operations procedures (local, staging, production, backup/restore, incidents, observability), use:

- [UMS Deploy and Operations Runbook (Compose-First)](../docs/runbooks/deploy-operations-compose-first.md)

## Prerequisites

- Docker 24+ with Compose v2

## Build Images

Run from repository root:

```bash
docker build --target api -t ums-memory-api:local .
docker build --target worker -t ums-memory-worker:local .
```

API command in image:

```bash
node apps/api/src/server.mjs
```

Worker command in image:

```bash
node --import tsx apps/ums/src/index.ts worker
```

## Run With Docker Compose

Run from repository root:

```bash
docker compose -f deploy/compose.yml up --build -d
docker compose -f deploy/compose.yml ps
curl -sS http://127.0.0.1:8787/
docker compose -f deploy/compose.yml logs -f api worker
docker compose -f deploy/compose.yml down
```

Compose mounts one shared named volume at `/var/lib/ums` for both services, with `UMS_STATE_FILE=/var/lib/ums/.ums-state.json`.
Worker startup includes an API-readiness gate (`UMS_API_HOST` default `api`, `UMS_API_HEALTH_PATH` default `/`, `UMS_API_READY_TIMEOUT_MS` default `90000`) so the worker does not race shared-state initialization on fresh boots.
If you explicitly want a full data reset, run `docker compose -f deploy/compose.yml down -v` (destructive: removes the shared state volume).

## Shared-State Notes

- Current runtime is single-file shared state (`UMS_STATE_FILE`) with lock-file coordination.
- Keep one API and one worker process for this model.
- Worker healthcheck verifies an active worker process exists and that the shared-state directory is readable/writable.

## Scope

- This deployment package is intentionally Docker/Compose-first.
- Kubernetes manifests are intentionally omitted at this stage to avoid premature complexity.
