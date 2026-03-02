#!/usr/bin/env bash
set -euo pipefail

export DRILL_ID="${DRILL_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"
PROJECT="${PROJECT:-ums-drill-${DRILL_ID}}"
RTO_TARGET_SECONDS="${RTO_TARGET_SECONDS:-900}"
RPO_TARGET_SECONDS="${RPO_TARGET_SECONDS:-86400}"
API_READY_TIMEOUT_SECONDS="${API_READY_TIMEOUT_SECONDS:-120}"
KEEP_ENV_ON_FAILURE="${DRILL_KEEP_ENV_ON_FAILURE:-0}"
PRIMARY_BACKUP_FILE="${BACKUP_FILE:-}"
FALLBACK_BACKUP_FILE="${FALLBACK_BACKUP_FILE:-}"
BACKUP_FILE=""
VOLUME="${PROJECT}_ums_shared_state"
ARTIFACT_DIR="${ARTIFACT_DIR:-artifacts/dr-drills/${DRILL_ID}}"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1"
    exit 2
  fi
}

mkdir -p "${ARTIFACT_DIR}"
exec > >(tee -a "${ARTIFACT_DIR}/commands.log") 2>&1

require_command docker
require_command curl
require_command node
require_command awk
require_command grep
docker compose version >/dev/null 2>&1 || { echo "docker compose plugin is required"; exit 2; }

resolve_backup_candidates() {
  local discovered
  mapfile -t discovered < <(ls -1t backups/ums-state-*.json 2>/dev/null || true)
  if [[ -z "${PRIMARY_BACKUP_FILE}" ]]; then
    PRIMARY_BACKUP_FILE="${discovered[0]:-}"
  fi
  if [[ -z "${FALLBACK_BACKUP_FILE}" ]]; then
    FALLBACK_BACKUP_FILE="${discovered[1]:-}"
  fi
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
    return
  fi
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
    return
  fi
  node -e '
const fs = require("node:fs");
const crypto = require("node:crypto");
const body = fs.readFileSync(process.argv[1]);
process.stdout.write(crypto.createHash("sha256").update(body).digest("hex"));
' "$1"
}

START_TS="$(date +%s)"
BACKUP_AGE_SECONDS=0
BACKUP_SHA=""
RESTORED_SHA=""
STATUS="fail"
FAILURE_GATE="runtime_error"
ATTEMPTS_USED=0

write_manifest() {
  local end_ts rto_seconds
  end_ts="$(date +%s)"
  rto_seconds="$((end_ts - START_TS))"
  cat > "${ARTIFACT_DIR}/manifest.json" <<EOF
{"drillId":"${DRILL_ID}","project":"${PROJECT}","backupFile":"${BACKUP_FILE}","primaryBackupFile":"${PRIMARY_BACKUP_FILE}","fallbackBackupFile":"${FALLBACK_BACKUP_FILE}","attemptsUsed":${ATTEMPTS_USED},"rpoSeconds":${BACKUP_AGE_SECONDS},"rpoTargetSeconds":${RPO_TARGET_SECONDS},"rtoSeconds":${rto_seconds},"rtoTargetSeconds":${RTO_TARGET_SECONDS},"status":"${STATUS}","failureGate":"${FAILURE_GATE}"}
EOF
}

cleanup_stack() {
  docker compose -p "${PROJECT}" -f deploy/compose.yml down -v || true
}

capture_diagnostics() {
  local suffix="$1"
  docker compose -p "${PROJECT}" -f deploy/compose.yml ps > "${ARTIFACT_DIR}/compose-ps-${suffix}.txt" || true
  docker compose -p "${PROJECT}" -f deploy/compose.yml logs --tail=200 api worker \
    > "${ARTIFACT_DIR}/compose-logs-api-worker-${suffix}.txt" || true
}

wait_for_api_ready() {
  local start_ts now
  start_ts="$(date +%s)"
  while true; do
    if curl -fsS http://127.0.0.1:8787/ >/dev/null 2>&1; then
      return 0
    fi
    now="$(date +%s)"
    if (( now - start_ts >= API_READY_TIMEOUT_SECONDS )); then
      return 1
    fi
    sleep 2
  done
}

on_exit() {
  local rc="$1"
  if [[ "$rc" -eq 0 ]]; then
    STATUS="pass"
    FAILURE_GATE="none"
  else
    capture_diagnostics "failure-final"
  fi
  write_manifest
  if [[ "$rc" -eq 0 || "${KEEP_ENV_ON_FAILURE}" != "1" ]]; then
    cleanup_stack
  fi
  trap - EXIT
  exit "$rc"
}

trap 'on_exit $?' EXIT

run_restore_attempt() {
  local attempt="$1"
  local candidate_backup="$2"
  local backup_mtime

  ATTEMPTS_USED="${attempt}"
  BACKUP_FILE="${candidate_backup}"

  [[ -n "${BACKUP_FILE}" && -f "${BACKUP_FILE}" ]] || { echo "Backup file not found: ${BACKUP_FILE}"; return 1; }
  [[ -s "${BACKUP_FILE}" ]] || { echo "Backup file is empty: ${BACKUP_FILE}"; return 1; }

  backup_mtime="$(
    node -e 'console.log(Math.floor(require("node:fs").statSync(process.argv[1]).mtimeMs / 1000));' \
      "${BACKUP_FILE}"
  )"
  BACKUP_AGE_SECONDS="$((START_TS - backup_mtime))"
  if [[ "${BACKUP_AGE_SECONDS}" -gt "${RPO_TARGET_SECONDS}" ]]; then
    FAILURE_GATE="G1_RPO"
    echo "RPO gate failed: backup_age_seconds=${BACKUP_AGE_SECONDS}"
    return 1
  fi

  cleanup_stack
  docker volume create "${VOLUME}" >/dev/null
  docker run --rm \
    -v "${VOLUME}:/var/lib/ums" \
    -v "${PWD}:/workspace" \
    ums-memory-api:local \
    sh -ec "cp /workspace/${BACKUP_FILE} /var/lib/ums/.ums-state.json; rm -f /var/lib/ums/.ums-state.json.lock"

  docker compose -p "${PROJECT}" -f deploy/compose.yml up -d
  docker compose -p "${PROJECT}" -f deploy/compose.yml ps | tee "${ARTIFACT_DIR}/compose-ps.txt"

  if ! wait_for_api_ready; then
    FAILURE_GATE="G2_RESTORE_HEALTH"
    echo "Services did not become ready before timeout (${API_READY_TIMEOUT_SECONDS}s)"
    return 1
  fi

  if ! curl -fsS http://127.0.0.1:8787/ > "${ARTIFACT_DIR}/api-root.json"; then
    FAILURE_GATE="G3_API_HEALTH"
    return 1
  fi
  if ! node -e '
const fs = require("node:fs");
const root = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (root.ok !== true || root.service !== "ums-api" || root.deterministic !== true) process.exit(1);
' "${ARTIFACT_DIR}/api-root.json"; then
    FAILURE_GATE="G3_API_HEALTH"
    return 1
  fi

  if ! curl -fsS -X POST http://127.0.0.1:8787/v1/doctor \
    -H 'content-type: application/json' \
    -d '{"storeId":"coding-agent"}' >/dev/null; then
    FAILURE_GATE="G4_METRICS"
    return 1
  fi
  if ! curl -fsS -X POST http://127.0.0.1:8787/v1/export \
    -H 'content-type: application/json' \
    -d '{"storeId":"coding-agent","format":"playbook"}' >/dev/null; then
    FAILURE_GATE="G4_METRICS"
    return 1
  fi
  if ! curl -fsS http://127.0.0.1:8787/metrics > "${ARTIFACT_DIR}/metrics.prom"; then
    FAILURE_GATE="G4_METRICS"
    return 1
  fi
  if ! (
    grep -q '^ums_api_operation_requests_total' "${ARTIFACT_DIR}/metrics.prom" &&
      grep -q '^ums_api_operation_latency_ms_count' "${ARTIFACT_DIR}/metrics.prom" &&
      grep -q 'operation="doctor",result="success"' "${ARTIFACT_DIR}/metrics.prom" &&
      grep -q 'operation="export",result="success"' "${ARTIFACT_DIR}/metrics.prom"
  ); then
    FAILURE_GATE="G4_METRICS"
    return 1
  fi

  BACKUP_SHA="$(sha256_file "${BACKUP_FILE}")"
  RESTORED_SHA="$(
    docker run --rm -v "${VOLUME}:/var/lib/ums" ums-memory-api:local \
      node -e '
const fs = require("node:fs");
const crypto = require("node:crypto");
const statePath = "/var/lib/ums/.ums-state.json";
const body = fs.readFileSync(statePath);
JSON.parse(body.toString("utf8"));
process.stdout.write(crypto.createHash("sha256").update(body).digest("hex"));
'
  )"
  if [[ "${BACKUP_SHA}" != "${RESTORED_SHA}" ]]; then
    FAILURE_GATE="G5_HASH_MISMATCH"
    return 1
  fi

  cat > "${ARTIFACT_DIR}/replay-payload.json" <<JSON
{"storeId":"drill-replay-store","events":[{"eventId":"drill-${DRILL_ID}-replay-event","type":"note","source":"dr-game-day","content":"Replay parity probe event","timestamp":"2026-01-01T00:00:00.000Z"}]}
JSON
  if ! curl -fsS -X POST http://127.0.0.1:8787/v1/ingest \
    -H 'content-type: application/json' \
    --data-binary @"${ARTIFACT_DIR}/replay-payload.json" \
    > "${ARTIFACT_DIR}/replay-first.json"; then
    FAILURE_GATE="G6_REPLAY_PARITY"
    return 1
  fi
  if ! curl -fsS -X POST http://127.0.0.1:8787/v1/ingest \
    -H 'content-type: application/json' \
    --data-binary @"${ARTIFACT_DIR}/replay-payload.json" \
    > "${ARTIFACT_DIR}/replay-second.json"; then
    FAILURE_GATE="G6_REPLAY_PARITY"
    return 1
  fi
  if ! node -e '
const fs = require("node:fs");
const first = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const second = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (first.data.accepted !== 1 || first.data.duplicates !== 0) process.exit(1);
if (second.data.accepted !== 0 || second.data.duplicates !== 1) process.exit(1);
if (first.data.ledgerDigest !== second.data.ledgerDigest) process.exit(1);
' "${ARTIFACT_DIR}/replay-first.json" "${ARTIFACT_DIR}/replay-second.json"; then
    FAILURE_GATE="G6_REPLAY_PARITY"
    return 1
  fi

  return 0
}

[[ "$PROJECT" == ums-drill-* ]] || { echo "PROJECT must start with ums-drill-"; exit 2; }
resolve_backup_candidates
[[ -n "${PRIMARY_BACKUP_FILE}" ]] || { echo "Backup file not found"; exit 2; }
[[ "${PRIMARY_BACKUP_FILE}" == "${FALLBACK_BACKUP_FILE}" ]] && FALLBACK_BACKUP_FILE=""

echo "Building API image for drill checks..."
docker compose -p "${PROJECT}" -f deploy/compose.yml build api

if ! run_restore_attempt 1 "${PRIMARY_BACKUP_FILE}"; then
  capture_diagnostics "attempt1-failure"
  if [[ -n "${FALLBACK_BACKUP_FILE}" && -f "${FALLBACK_BACKUP_FILE}" ]]; then
    echo "Retrying drill with fallback backup: ${FALLBACK_BACKUP_FILE}"
    if ! run_restore_attempt 2 "${FALLBACK_BACKUP_FILE}"; then
      capture_diagnostics "attempt2-failure"
      exit 1
    fi
  else
    echo "No fallback backup available for retry."
    exit 1
  fi
fi

END_TS="$(date +%s)"
RTO_SECONDS="$((END_TS - START_TS))"
if [[ "${RTO_SECONDS}" -gt "${RTO_TARGET_SECONDS}" ]]; then
  FAILURE_GATE="G7_RTO"
  echo "RTO gate failed: rto_seconds=${RTO_SECONDS}"
  exit 1
fi

docker compose -p "${PROJECT}" -f deploy/compose.yml logs --tail=200 api worker \
  > "${ARTIFACT_DIR}/compose-logs-api-worker.txt"
docker compose -p "${PROJECT}" -f deploy/compose.yml ps > "${ARTIFACT_DIR}/compose-ps.txt"
cat > "${ARTIFACT_DIR}/checksums.txt" <<EOF
backup_sha256=${BACKUP_SHA}
restored_sha256=${RESTORED_SHA}
EOF

STATUS="pass"
