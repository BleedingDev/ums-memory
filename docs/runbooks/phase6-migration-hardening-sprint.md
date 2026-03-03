# Phase 6 Migration Hardening Sprint

## Purpose

`ums-memory-n4m.5` originally hardened the migration path before final cutover (`ums-memory-n4m.6`) by enforcing a strict inventory of legacy runtime compatibility shims.

This prevents hidden debt growth while strict TypeScript + Effect migration finishes.

## Inventory Contract

Inventory file:

- `docs/migration/legacy-runtime-shim-inventory.v1.json`

Required fields per entry:

- `path`: repository-relative path of the shim.
- `kind`: `runtime_entrypoint` or `legacy_shared_contract`.
- `followUpBeadId`: bead that removes/migrates the shim.
- `notes`: short reason for temporary retention.

Current post-cutover state:

- inventory must be empty (`entries: []`).

## Validation Gate

Command:

```bash
npm run validate:legacy-shims
```

The validator (`scripts/validate-legacy-runtime-shims.ts`) fails if any of the following occur:

- inventory contains any shim entries (post-cutover invariant),
- new legacy runtime shim file exists but is missing from inventory,
- inventory references a shim that no longer exists on disk,
- duplicate inventory paths exist,
- `followUpBeadId` is missing or invalid,
- inventory entries are not sorted by path.

The command is wired into `npm run quality:ts`, which means `npm run ci:verify` also enforces it.

## Operator Workflow

1. Do not add runtime shim files in cutover-complete branches.
2. Keep `docs/migration/legacy-runtime-shim-inventory.v1.json` empty.
3. If an emergency shim appears, open a blocking bead immediately and remove it in the same migration window.
4. Run:

```bash
npm run validate:legacy-shims
npm run quality:ts
```

5. Document the deferral risk and removal plan in the bead update/PR notes.

## Exit Criteria for `ums-memory-n4m.5`

- Inventory exists and remains empty after cutover.
- Validation gate is automated and part of quality pipeline.
- Unit tests cover pass and fail edge cases of validator behavior.
