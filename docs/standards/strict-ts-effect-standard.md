# Strict TypeScript + Effect Engineering Standard

## Purpose

Define enforceable engineering rules for all backend TypeScript and Effect work in `ums-memory`.
This standard is mandatory for new code and for all touched files in migration beads/PRs.

## Scope

- Applies to all new backend implementation code in `apps/**/*.ts` and `libs/**/*.ts`.
- Applies to runtime services, contracts, errors, layer wiring, and adapter boundaries.
- Applies to local verification and CI verification before merge.

### 0) Effect Runtime Version Policy (MUST)

- Runtime policy target is the Effect v4 beta track (`4.0.0-beta.25`).
- Runtime dependency pin MUST remain on the approved v4 beta track and is validated by `validate:effect-beta-pin`.
- New work MUST target v4-compatible APIs and avoid introducing v3-only patterns.

Pass criteria:

- `docs/runbooks/effect-version-availability.md` and `docs/reports/effect-v4-compatibility-matrix.md` are current.
- `validate:effect-beta-pin` passes in local and CI quality gates.

### 0a) Bun-Only Runtime and Test Policy (MUST)

- Repository package/runtime commands MUST use Bun.
- Tests MUST run through `bun test`.
- Effect-oriented tests MUST import the test surface from `@effect-native/bun-test`.
- `node:test`, `node --test`, Vitest, Jest, and Mocha MUST NOT be introduced in repo-local sources, scripts, or standards docs.

Pass criteria:

- `package.json` declares Bun as the package manager/runtime contract.
- Test files import `@effect-native/bun-test` rather than `bun:test` directly.
- Repo-local standards/runbooks do not instruct contributors to use Node-based or alternate test runners.

## Mandatory Patterns

### 1) TypeScript Strictness (MUST)

- `tsconfig.base.json` strictness flags MUST remain enabled:
  - `"strict": true`
  - `"noUncheckedIndexedAccess": true`
  - `"exactOptionalPropertyTypes": true`
  - `"noImplicitOverride": true`
  - `"useUnknownInCatchVariables": true`
  - `"noPropertyAccessFromIndexSignature": true`
  - `"noImplicitReturns": true`
  - `"noFallthroughCasesInSwitch": true`
- No child `tsconfig` may relax these settings for production code.
- All changed TypeScript MUST pass `bun run quality:ts`.

Pass criteria:

- `bun run quality:ts` exits `0`.
- No diff disables strict compiler options.

### 2) Effect Service + Layer Boundaries (MUST)

- Business/runtime capabilities MUST be represented as explicit Effect services.
- Each service module MUST expose:
  - A typed service contract (service interface or `Effect.Service` definition).
  - A service tag/constructor.
  - At least one layer (`Layer.succeed`, `Layer.sync`, or equivalent) for runtime composition.
- Application/runtime entrypoints MUST compose dependencies through layers (for example `Layer.mergeAll` in runtime boundaries).
- Pass criteria:
  - Every new or modified service file exports a typed service contract and layer.
  - Runtime assembly files compose services with layers instead of ad-hoc injection.

### 2a) TS-Only Runtime Source Policy (MUST)

- Runtime source in `apps/**/src` and `libs/**/src` MUST converge to TypeScript-only modules (`.ts`).
- New runtime files in `apps/**/src` and `libs/**/src` MUST NOT be introduced as `.js` or `.mjs`.
- Runtime shim inventory MUST remain at zero unless an explicit migration exception is approved.

Pass criteria:

- No new `.js`/`.mjs` runtime source files added under `apps/**/src` or `libs/**/src`.
- `validate:legacy-shims` passes with zero inventory entries.

### 3) Schema Contracts at Boundaries (MUST)

- All ingress/egress payloads (API/CLI/service boundary inputs and outputs) MUST have Effect `Schema` definitions.
- Unknown payloads MUST be decoded/validated with `Schema.decodeUnknown*` or `Schema.validate*` helpers before use.
- Domain identifiers crossing boundaries SHOULD be schema-constrained IDs (for example branded/UUID schema types).

Pass criteria:

- New boundary payload shapes are defined in schema modules.
- No unvalidated `unknown` payload is cast directly to domain types in new TypeScript modules.

### 4) Tagged Error Taxonomy (MUST)

- Domain/service errors MUST be modeled with `Schema.TaggedError`.
- Error types MUST be specific to failure mode (for example `StorageConflictError`, not generic `BadRequestError`).
- Each error payload MUST include `message` plus minimum context fields needed for diagnosis (IDs/query/action keys).
- Each service MUST export a typed error union used by its effect signatures.

Pass criteria:

- New/modified service errors are `Schema.TaggedError` classes.
- Effect signatures expose precise error unions (not `unknown`/`Error` catch-all types).

## Forbidden Patterns (MUST NOT)

- `any` in production TypeScript (`apps/**/*.ts`, `libs/**/*.ts`), except third-party typing shims with explicit justification comment.
- TypeScript suppression directives in source comments.
- Raw payload trust at boundaries (casting/parsing unvalidated `unknown` into domain objects).
- Ad-hoc error creation (`new Error(...)`) for domain/service error channels where tagged errors are required.
- Bypassing quality gates (merging without passing `quality:ts`, `test`, `test:sfe`, and CI verify workflow checks).

Fail criteria:

- Any occurrence of forbidden patterns in touched files.
- Missing justification and follow-up bead for any temporary exception.

## Quality Gates and CI Workflow Contract

The project command contract is:

- `bun run quality:ts`
- `bun run validate:legacy-shims`
- `bun run validate:cutover`
- `bun run test`
- `bun run eval:lean`
- `bun run test:sfe`
- `bun run ci:verify` (local aggregate: quality + tests + SFE + single-file build)

CI workflow contract:

- File: `.github/workflows/ci.yml`
- Job: `verify` (`Quality, Test, Build`)
- Required gates in order:
  1. `bun run quality:ts`
  2. `bun run test`
  3. `bun run eval:lean`
  4. `bun run test:sfe`
  5. `bun run build:sfe:single`

Pass criteria:

- Local `bun run ci:verify` succeeds before handoff when code changes are non-trivial.
- CI `verify` job is green on pull request.

## Migration Acceptance Checklist (Beads/PRs)

All items are required unless explicitly marked `N/A` with reason.

1. Strict TS compliance

- [ ] No strictness flags were relaxed.
- [ ] `bun run quality:ts` passed.
- [ ] `bun run validate:tsconfig-policy` passed.
- [ ] `bun run validate:effect-beta-pin` passed.
- [ ] `bun run validate:legacy-shims` passed.
- [ ] `bun run validate:cutover` passed.

2. Effect service/layer compliance

- [ ] Every new/modified service exports a typed contract + layer.
- [ ] Runtime wiring uses layer composition.
- [ ] Legacy pattern deferrals (if any) include a follow-up bead ID.

3. Schema contract compliance

- [ ] New boundary payloads have schema definitions.
- [ ] Unknown inputs are decoded/validated before use.

4. Tagged error compliance

- [ ] New failure modes use `Schema.TaggedError`.
- [ ] Service error unions were updated for new tags.

5. Test and CI contract compliance

- [ ] `bun run test` passed.
- [ ] `bun run eval:lean` passed.
- [ ] `bun run test:sfe` passed for affected flows.
- [ ] `bun run ci:verify` passed locally or CI proof attached.
- [ ] PR shows green `.github/workflows/ci.yml` `verify` job.

## Exception Process

- Exceptions are temporary and MUST include:
  - exact rule being waived,
  - reason and risk,
  - expiration condition,
  - follow-up bead ID.
- PRs without this exception block are non-compliant.
