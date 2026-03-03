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

## Current Runtime State

Migration cutover is landed:

1. Runtime scripts execute `.ts` entrypoints through `tsx`.
2. Build targets compile from `.ts` entrypoints.
3. Legacy runtime shim usage is validated and tracked by `validate:legacy-shims` and `validate:cutover`.
