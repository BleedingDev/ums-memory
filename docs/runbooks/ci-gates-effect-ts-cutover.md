# CI Gates for Effect v4 + TS-Only Runtime Cutover

## Goal

Define enforceable CI contract for:

1. Effect v4 pin discipline,
2. strict TypeScript posture,
3. elimination of runtime `.js`/`.mjs` sources in `apps/**/src` and `libs/**/src`,
4. deterministic lean eval gates in both local release verification and GitHub CI.

## Required Gate Sequence

1. `bun run quality:ts`
2. `bun run test`
3. `bun run eval:lean`
4. `bun run test:sfe`
5. `bun run build:sfe:single`

The aggregate release command is `bun run ci:verify`, and it must keep the same
order as the GitHub Actions `verify` job in `.github/workflows/ci.yml`.

## Policy Checks to Enforce

1. Dependency pin check:
   - `package.json` must keep `dependencies.effect` on an exact `4.0.0-beta.x` pin.
   - `bun run validate:effect-beta-pin` must verify that `bun.lock` matches the same Effect v4 pin.
2. Compiler strictness check:
   - `tsconfig.base.json` must keep `allowJs: false`.
3. Runtime source extension check:
   - no `apps/**/src/**/*.mjs`
   - no `apps/**/src/**/*.js`
   - no `libs/**/src/**/*.mjs`
   - no `libs/**/src/**/*.js`
4. Lean eval contract check:
   - `package.json` must expose `eval:golden-replay`, `eval:adapter-conformance`, `eval:grounded-recall`, `eval:lean`, and `ci:verify`.
   - `eval:lean` must aggregate the three eval scripts with `&&` so the first regression stops the pipeline.
   - `ci:verify` and `.github/workflows/ci.yml` may not make `bun run eval:lean` optional via `|| true`, manual-only branches, or `continue-on-error`.

## Eval Regression Contract

`bun run eval:lean` is a required release gate, not an advisory report. The gate
fails with a non-zero exit code when any of the following regressions appear:

1. `scripts/eval-golden-replay.ts`
   - missing fixture coverage,
   - schema/decode failures,
   - fixture digest drift without fixture review.
2. `scripts/eval-adapter-conformance.ts`
   - supported adapter coverage gaps,
   - missing malformed or replay challenge cases,
   - replay normalization mismatches.
3. `scripts/eval-grounded-recall.ts`
   - recall or citation-integrity threshold regressions,
   - store or space isolation drift,
   - holdout misuse such as `tuningAllowed: true`.

All three scripts emit machine-readable JSON via `--json`. Contract tests for
this gate live in `tests/unit/eval-script-contracts.test.ts`, and all test
surfaces remain on Bun + Effect v4 using `@effect-native/bun-test`. Do not
introduce `node:test`, Vitest, or npm wrappers into this delivery path.

## Runtime Shim Policy

Runtime shim inventory is no longer transitional:

- `docs/migration/legacy-runtime-shim-inventory.v1.json` must remain empty.
- `validate:legacy-shims` fails when inventory contains entries.
- `validate:cutover` fails when inventory is non-empty or when any source imports legacy shim paths.

## Current Status

- `package.json` exposes `bun run eval:lean` and keeps it in `bun run ci:verify`.
- `.github/workflows/ci.yml` runs the same lean eval gate in the `verify` job.
- TS strictness and include policy are enforced.
- Legacy runtime shim policy is enforced as a zero-inventory invariant.
- Dataset growth stays governed by `docs/runbooks/eval-dataset-maintenance-policy.md`.

## Ownership and Escalation

- Runtime cutover gate ownership: backend/core.
- Eval dataset policy ownership: backend/core with owner review for corpus growth exceptions.
- Failing gate creates blocking bead before any further migration merge.
