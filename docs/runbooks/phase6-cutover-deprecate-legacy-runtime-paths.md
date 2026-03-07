# Phase 6 Cutover: Deprecate Legacy Runtime Paths

## Purpose

`ums-memory-n4m.6` finalizes Phase 6 cutover controls by preventing new operational dependencies on legacy runtime shims while strict TypeScript + Effect architecture becomes the default implementation surface.

## Gates

### 1) Legacy Shim Inventory

- Command: `bun run validate:legacy-shims`
- Source of truth: `docs/migration/legacy-runtime-shim-inventory.v1.json`

This gate now enforces post-cutover state: inventory must stay empty (`entries: []`).

### 2) Legacy Runtime Cutover Guard

- Command: `bun run validate:cutover`
- Script: `scripts/validate-legacy-runtime-cutover.ts`

This gate enforces:

- strict TypeScript importer surfaces (`apps`, `libs`, `scripts`, `tests`, `benchmarks`) must not import legacy runtime shim paths,
- any detected shim import edge is treated as migration debt and fails the gate,
- a non-empty legacy shim inventory fails immediately (post-cutover invariant).

The gate fails on any violation and is wired into `bun run quality:ts`.

## Operational Workflow

1. Do not add new runtime shim imports in any source surface.
2. Migrate production behavior to strict TS + Effect modules first.
3. Keep `docs/migration/legacy-runtime-shim-inventory.v1.json` empty; adding shim entries is a cutover regression.
4. Run:

```bash
bun run validate:legacy-shims
bun run validate:cutover
bun run quality:ts
```

5. Include migration/removal context in bead update notes for any temporary exceptions.

## Exit Criteria

- `validate:legacy-shims` passes.
- `validate:cutover` passes.
- `quality:ts`, `test`, `test:sfe`, and `ci:verify` pass.
- No strict TS source file imports legacy runtime shim paths.
- Legacy runtime shim inventory remains empty.
