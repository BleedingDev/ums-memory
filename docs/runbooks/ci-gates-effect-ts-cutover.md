# CI Gates for Effect v4 + TS-Only Runtime Cutover

## Goal

Define enforceable CI contract for:

1. Effect v4 beta pin,
2. strict TypeScript posture,
3. elimination of runtime `.js`/`.mjs` sources in `apps/**/src` and `libs/**/src`.

## Required Gate Sequence

1. `npm run quality:ts`
2. `npm run test`
3. `npm run test:sfe`
4. `npm run build:sfe:single`

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

## Transitional Rule

If temporary shims are still present, the corresponding bead must stay open
and the shim validator must explicitly list each remaining shim with owner/task
linkage.

Until full shim removal lands, extension checks are staged and informational;
the authoritative enforcement remains `validate:legacy-shims` +
`validate:cutover` with bead linkage.

Current status (March 3, 2026):

- TS strictness and include policy can be enforced immediately.
- Effect beta pin check remains staged until the compatibility cutover (`ums-memory-cjd.5`) is merged.

## Ownership

- Runtime cutover gate ownership: backend/core.
- Failing gate creates blocking bead before any further migration merge.
