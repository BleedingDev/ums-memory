# Effect v4 Compatibility Matrix

Captured: March 3, 2026  
Target runtime: `effect@4.0.0-beta.25`

## Imported Surfaces in Repo

| API Surface          | Current Usage Areas                                                   | v4 Status                       | Migration Notes                                                            |
| -------------------- | --------------------------------------------------------------------- | ------------------------------- | -------------------------------------------------------------------------- |
| `Effect`             | app runtimes, shared services, tests                                  | Compatible baseline             | Keep effectful boundaries typed; avoid implicit any in migration wrappers. |
| `Layer`              | runtime composition and service layers                                | Compatible baseline             | Keep layered composition explicit in runtime assembly modules.             |
| `Context`            | service tags and provision                                            | Compatible baseline             | Preserve service-tag boundaries under `libs/shared/src/effect/services/*`. |
| `Schema`             | contracts, errors, boundary validation                                | Compatible baseline             | Validate all unknown inputs before boundary usage.                         |
| `ParseResult`        | validator/config helpers                                              | Compatible baseline             | Keep parse errors mapped through tagged domain errors.                     |
| `ManagedRuntime`     | `apps/api/src/service-runtime.mjs`, `apps/api/src/worker-runtime.mjs` | Needs focused runtime migration | Treat runtime boot loops as first migration hotspot for P1/P2 tasks.       |
| `Duration`           | worker/service runtime loops                                          | Compatible baseline             | Confirm scheduler semantics during TS cutover.                             |
| `Deferred` / `Fiber` | worker/service runtime shutdown flow                                  | Compatible baseline             | Validate interrupt/join behavior during runtime cutover.                   |
| `Clock`              | clock service abstraction                                             | Compatible baseline             | Preserve deterministic test layer behavior.                                |
| `Cause` / `Option`   | adapter-registry tests                                                | Compatible baseline             | Retain explicit assertions on typed error causes/options.                  |

## High-Risk Callsite Groups

1. Runtime bootstrapping (`ManagedRuntime`, long-lived fibers).
2. Legacy `.mjs` entrypoints importing shared effect services.
3. Boundary validator modules using `Schema` + `ParseResult`.

## Contract for Migration Beads

Each migration bead that touches Effect runtime boundaries must include:

1. Affected API surfaces from this matrix.
2. Explicit evidence that `bun run ci:verify` passed after change.
3. Note whether runtime behavior changed or was compatibility-preserving.

## Tracked Ownership

- `ManagedRuntime` runtime-entrypoint migration ownership:
  - `ums-memory-e2g.5` (`apps/api/src/service-runtime.mjs` -> `.ts`)
  - `ums-memory-e2g.6` (`apps/api/src/worker-runtime.mjs` -> `.ts`)
  - Both beads must update this matrix when entrypoints and runtime wiring are cut over.
