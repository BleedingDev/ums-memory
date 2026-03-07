# Effect v4 Beta Policy

## Decision

Effective March 3, 2026, `ums-memory` adopts the Effect v4 beta track as
the target runtime policy.

- registry snapshot:
  - `latest`: `3.19.19`
  - `beta`: `4.0.0-beta.25`
- Platform target: exact pin `effect@4.0.0-beta.25`.
- Transitional state: runtime dependency stays on the current stable line
  until migration bead `ums-memory-cjd.5` is merged with green gates.

## Rules

1. `package.json` must switch `dependencies.effect` to the approved v4 beta
   pin only in cutover bead `ums-memory-cjd.5` (with green gates in the same
   change).
2. New code must target v4-compatible APIs only.
3. Any future beta bump must be a dedicated bead with:
   - compatibility check summary,
   - `ci:verify` evidence,
   - rollback note update.

## Enforcement

- Source of truth:
  - `package.json` dependency pin.
  - `docs/runbooks/effect-version-availability.md` for registry snapshot evidence.
  - `docs/reports/effect-v4-compatibility-matrix.md` for API-level compatibility notes.
- CI contract is defined in `docs/runbooks/ci-gates-effect-ts-cutover.md`.
