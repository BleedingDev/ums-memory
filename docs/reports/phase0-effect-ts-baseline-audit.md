# Phase 0 Effect + TypeScript Baseline Audit

Captured: March 3, 2026

Companion artifact: `docs/reports/phase0-effect-ts-baseline-audit.json`

## 1) `effect` npm reality

- Command: `npm view effect version dist-tags --json`
- Result:
  - `latest`: `3.19.19`
  - `beta`: `4.0.0-beta.25`
- Migration target for strict cutover: `effect@4.0.0-beta.25`

## 2) `apps/libs` source inventory (`*/src`)

- Scope: `apps/**/src` and `libs/**/src`
- Counts:
  - `apps`: `0` TypeScript, `11` JS/MJS
  - `libs`: `31` TypeScript, `9` JS/MJS
  - Total source files in scope: `51`
  - Total TypeScript: `31`
  - Total JS/MJS: `20`

Runtime mismatch is concentrated in app entrypoints/runtime modules (`apps/*/src/*.mjs`) and legacy shared core (`libs/shared/src/*.js`).

## 3) tsconfig gap baseline

- `tsconfig.base.json`
  - `"allowJs": true`
  - `"checkJs": false`
- `apps/api/tsconfig.json`, `apps/cli/tsconfig.json`, `apps/ums/tsconfig.json`
  - `include` is `["**/*.mjs"]` only
- `libs/shared/tsconfig.json`
  - includes both `src/**/*.js` and `src/**/*.ts`

## 4) Immediate blockers before strict TS-only runtime

1. `allowJs` must move from `true` to `false`.
2. app tsconfig include patterns must switch from `.mjs` to `.ts`.
3. `libs/shared` strict scope must remove `src/**/*.js` includes.
