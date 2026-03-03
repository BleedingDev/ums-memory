# Phase 6 Cutover: Deprecate Legacy Runtime Paths

## Purpose

`ums-memory-n4m.6` finalizes Phase 6 cutover controls by preventing new operational dependencies on legacy runtime shims while strict TypeScript + Effect architecture becomes the default implementation surface.

## Gates

### 1) Legacy Shim Inventory

- Command: `npm run validate:legacy-shims`
- Source of truth: `docs/migration/legacy-runtime-shim-inventory.v1.json`

This gate ensures shim count/path drift is explicit and tracked with follow-up beads.

### 2) Legacy Runtime Cutover Guard

- Command: `npm run validate:cutover`
- Script: `scripts/validate-legacy-runtime-cutover.ts`

This gate enforces:

- strict TypeScript files in `apps/**` and `libs/**` must not import legacy runtime shim paths,
- non-TS importer surfaces (scripts/tests/benchmarks and legacy `.mjs` files) are also rejected when importing shim paths,
- any detected shim import edge is treated as migration debt and fails the gate.

The gate fails on any violation and is wired into `npm run quality:ts`.

## Operational Workflow

1. Do not add new runtime shim imports in any source surface.
2. Migrate production behavior to strict TS + Effect modules first.
3. Keep shim usage traceable in `docs/migration/legacy-runtime-shim-inventory.v1.json` until inventory reaches zero.
4. Run:

```bash
npm run validate:legacy-shims
npm run validate:cutover
npm run quality:ts
```

5. Include migration/removal context in bead update notes for any temporary exceptions.

## Exit Criteria

- `validate:legacy-shims` passes.
- `validate:cutover` passes.
- `quality:ts`, `test`, `test:sfe`, and `ci:verify` pass.
- No strict TS production file imports legacy runtime shim paths.
