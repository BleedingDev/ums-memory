# TS Runtime Execution Strategy

## Decision (Target State)

Use TypeScript entrypoints for all runtime surfaces under `apps/**/src` and `libs/**/src`.

Runtime strategy by environment:

1. Local developer runtime/tests:
   - `tsx` execution for TypeScript entrypoints.
2. Production/distribution binaries:
   - Bun compile from TypeScript entrypoints (`bun build --compile ... <entry>.ts`).
3. CI quality gates:
   - `tsc -b` strict project references for static guarantees.

## Entrypoint Targets

- API service: `apps/api/src/server.ts`
- CLI: `apps/cli/src/index.ts`
- Single runtime: `apps/ums/src/index.ts`
- Benchmarks and tests should shift to `.ts` entrypoints under their existing folders.

## Compatibility During Cutover

Until full migration is complete:

1. Existing `.mjs` entrypoints remain temporary shims only.
2. New domain logic is implemented in `.ts` modules.
3. Shim removal is tracked by migration beads and validated by CI gate policy.

Current state note (March 3, 2026):

- Runtime scripts still execute `.mjs` entrypoints.
- This runbook defines the required end-state and migration direction, not the already-landed runtime state.
