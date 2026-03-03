# Effect v4 Beta Rollback Playbook

## Scope

Rollback path when `effect@4.0.0-beta.25` causes regressions in correctness, determinism, or runtime SLO behavior.

## Trigger Conditions

Execute rollback when any of the following is true after a beta bump or related migration:

1. `npm run ci:verify` fails in previously green baseline without intentional breaking changes.
2. Determinism tests regress (idempotency/replay behavior changes unexpectedly).
3. Runtime error rate or latency exceeds production guardrails after deployment.

## Rollback Procedure

1. Freeze merges affecting Effect/runtime migration beads.
2. Revert the Effect pin to last known-good version commit.
3. Re-run:
   - `npm run quality:ts`
   - `npm run test`
   - `npm run test:sfe`
   - `npm run build:sfe:single`
4. Deploy reverted build artifact.
5. Open incident bead documenting:
   - failing symptom,
   - impacted surfaces,
   - next mitigation owner.

## Fast Recovery Targets

- Restore green `ci:verify` within one incident response window.
- Preserve deterministic behavior and prior data-format compatibility.
- Keep rollback commit minimal: dependency pin and only required compatibility fixes.

## Post-Incident Actions

1. Add/update compatibility notes in `docs/reports/effect-v4-compatibility-matrix.md`.
2. Add a follow-up bead for root cause and forward fix.
3. Update `docs/runbooks/effect-version-availability.md` if dist-tags changed.
