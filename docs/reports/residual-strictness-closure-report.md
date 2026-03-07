# Residual Strictness Closure Report

Date: March 3, 2026
Scope: `ums-memory-bnn` (`bnn.3`, `bnn.4`, `bnn.5`, `bnn.6`)

## Objective

Document post-cutover strictness evidence for:

- runtime TS suppression policy,
- legacy runtime shim/cutover policy,
- TypeScript project graph coverage,
- quality gate alignment updates.

## Evidence Snapshot

### 1) Runtime JS/MJS source inventory

Command:

```bash
rg --files apps libs | rg '/src/.*\.(js|mjs)$' | wc -l
```

Result:

- `0`

### 2) Suppression allowlist + shim inventory are empty

Command:

```bash
bun -e "import { readFileSync } from 'node:fs'; const a = JSON.parse(readFileSync('docs/migration/runtime-ts-suppression-allowlist.v1.json','utf8')); const b = JSON.parse(readFileSync('docs/migration/legacy-runtime-shim-inventory.v1.json','utf8')); console.log(JSON.stringify({ suppressionEntries: a.entries.length, legacyShimEntries: b.entries.length }, null, 2));"
```

Result:

```json
{
  "suppressionEntries": 0,
  "legacyShimEntries": 0
}
```

### 3) Validators pass with post-cutover invariants

Commands:

```bash
bun run validate:runtime-ts-suppressions
bun run validate:legacy-shims
bun run validate:cutover
```

Results:

- `runtime ts-suppression validation passed (0 allowlisted suppression file(s)).`
- `Legacy runtime shim validation passed (0 shims, inventory 0).`
- `Legacy runtime cutover validation passed (0 legacy import edges).`

### 4) TS project graph coverage

Root project references (`tsconfig.json`):

- `./libs/shared`
- `./apps/api`
- `./apps/cli`
- `./apps/ums`
- `./apps/api/test`
- `./apps/api/bench`
- `./apps/cli/test`
- `./scripts`
- `./tests`
- `./benchmarks`

## Delivered Changes

- Tightened runtime suppression validator:
  - runtime-path-only allowlist entries,
  - duplicate allowlist path detection,
  - sorted allowlist enforcement.
- Retired stale `.mjs` assumptions in cutover validators:
  - TS-family import resolution only,
  - non-empty legacy shim inventory is now a hard failure.
- Hardened shim validator:
  - post-cutover invariant requires empty shim inventory.
- Updated cutover/hardening runbooks to reflect zero-shim post-cutover policy.
- Expanded formatting gate coverage to include `apps/libs/scripts/tests/benchmarks`.
- Lint gate aligned to `apps/libs/scripts` strict profile under Ultracite + oxlint.

## Residual Risk Register

The full workspace strict typecheck (`bun run typecheck`) still reports a large
existing backlog in:

- `scripts/**/*.ts`,
- `apps/**/test/**/*.ts`,
- `tests/**/*.ts`,
- `benchmarks/**/*.ts`.

This report does not claim that backlog is resolved. It confirms that strictness
guardrails, cutover invariants, and drift-detection gates are now explicit and
enforced for runtime migration controls.
