# CI Gates for Effect v4 + TS-Only Runtime Cutover

## Goal

Define enforceable CI contract for:

1. Effect v4 beta pin,
2. strict TypeScript posture,
3. elimination of runtime `.js`/`.mjs` sources in `apps/**/src` and `libs/**/src`.

## Required Gate Sequence

1. `bun run quality:ts`
2. `bun run test`
3. `bun run test:sfe`
4. `bun run build:sfe:single`

## Policy Checks to Enforce

1. Dependency pin check:
   - `package.json` must contain `effect: 4.0.0-beta.25` once bead `ums-memory-cjd.5` is merged.
2. Compiler strictness check:
   - `tsconfig.base.json` must keep `allowJs: false`.
3. Runtime source extension check:
   - no `apps/**/src/**/*.mjs`
   - no `apps/**/src/**/*.js`
   - no `libs/**/src/**/*.mjs`
   - no `libs/**/src/**/*.js`

## Runtime Shim Policy

Runtime shim inventory is no longer transitional:

- `docs/migration/legacy-runtime-shim-inventory.v1.json` must remain empty.
- `validate:legacy-shims` fails when inventory contains entries.
- `validate:cutover` fails when inventory is non-empty or when any source imports legacy shim paths.

Current status (March 3, 2026):

- TS strictness and include policy are enforced.
- Legacy runtime shim policy is enforced as zero-inventory invariant.
- Effect beta pin check remains staged until the compatibility cutover (`ums-memory-cjd.5`) is merged.

## Ownership

- Runtime cutover gate ownership: backend/core.
- Failing gate creates blocking bead before any further migration merge.
