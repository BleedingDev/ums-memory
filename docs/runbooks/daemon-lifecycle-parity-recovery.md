# Daemon Lifecycle Parity and Recovery Runbook

Date: 2026-03-07  
Owner: UMS daemon/runtime  
Bead: `ums-memory-c0j.11`

## Purpose

Define the operational lifecycle for the daemon-first CLI runtime and the recovery paths that must behave the same for solo and managed users.

## External Contract

The external CLI contract is identical in solo and managed mode:

- `ums install`
- `ums start`
- `ums stop`
- `ums restart`
- `ums status`
- `ums logs`
- `ums doctor`
- `ums sync`
- `ums uninstall`

Managed mode changes account enrollment and delivery policy only. It does not change command names or lifecycle semantics.

## Lifecycle Phases

### 1. Install

`ums install --config-file <path>`

- Validates `config.jsonc`.
- Creates daemon control files under `state.rootDir/daemon-control`.
- Registers supervisor assets for the current platform and applies the native registration command (`launchctl`, `systemctl --user`, or `schtasks`).
- Is idempotent on re-run and returns `already_installed` when the control plane already exists.

### 2. Start

`ums start --config-file <path>`

- Refuses to double-start when an active daemon PID is already present.
- Boots the API worker pair through the daemon control plane.
- Waits for ready status within the configured timeout.

### 3. Continuous Ingestion

`ums sync-daemon --config-file <path>`

- Runs collection, journaling, routing, and delivery on a loop.
- Serializes cycles behind the daemon sync lock.
- Reclaims stale lock files deterministically.
- Keeps collection checkpoints separate from per-target delivery checkpoints.

### 4. Restart

`ums restart --config-file <path>`

- Stops the active daemon PID.
- Starts a fresh process with the same config.
- Preserves the same state root, journal, checkpoints, and supervisor registration.

### 5. Stop

`ums stop --config-file <path>`

- Stops the active daemon PID.
- Fails closed with `DAEMON_NOT_RUNNING` when no live process exists.

### 6. Uninstall

`ums uninstall --config-file <path>`

- Stops the daemon if needed.
- Removes supervisor registration through the host supervisor and then deletes daemon control files.
- Leaves persisted memory state intact under the configured state root.

## Recovery Paths

### Source Failure

Symptoms:

- `ums status` shows delivery or source errors.
- `ums doctor` reports failing checks.

Actions:

1. Run `ums source list --config-file <path>` and inspect enabled bindings.
2. Disable the failing binding with `ums source disable`.
3. Re-run `ums sync` or `ums restart`.
4. Re-enable after the source is repaired with `ums source approve`.

### Stale Sync Lock

Symptoms:

- sync attempts stall or time out acquiring `state.rootDir/sync.lock`.

Actions:

1. Run `ums status`.
2. If no daemon PID is alive, rerun `ums sync` or `ums start`.
3. The daemon reclaims stale sync locks automatically when the owner PID is gone or the lock is older than the reclaim threshold.

### Partial Delivery / Restart Recovery

Symptoms:

- events were journaled but not acknowledged for one or more targets.

Actions:

1. Run `ums sync`.
2. Verify that delivery checkpoints advance without recollecting duplicate source events.
3. Confirm `ums status` clears the last delivery error after successful replay.

### Corrupt Config

Symptoms:

- `ums config validate` fails.
- `ums doctor` reports invalid config state.

Actions:

1. Run `ums config doctor --config-file <path>`.
2. If the file is rewritable and only non-canonical, run `ums config doctor --fix`.
3. If schema validation still fails, repair the config and rerun `ums install`.

### Safe Reset

Use only when operator review confirms that daemon control files are the problem rather than memory contents.

Actions:

1. `ums stop --config-file <path>`
2. `ums uninstall --config-file <path>`
3. Verify that the state root still contains journal/checkpoint/runtime state files.
4. `ums install --config-file <path>`
5. `ums start --config-file <path>`
6. `ums status --config-file <path>`

## Validation Matrix

The lifecycle suite is considered complete only when all of these remain green:

- CLI lifecycle test covering install/start/status/logs/doctor/restart/stop/uninstall
- daemon supervisor plan tests
- daemon credential tests
- daemon sync recovery tests
- runtime parity harness for legacy compat versus unified runtime path

## Notes

- Legacy `.ums-state.json` remains explicit compatibility-only input/output.
- Unified runtime state defaults to `.ums-runtime-state` plus companion `.sqlite` and materialized `.json` files.
- Managed accounts must keep credentials outside config via `credentialRef`.
