# Strict TypeScript + Effect Engineering Standard

## Purpose

Define enforceable engineering rules for all backend TypeScript and Effect work in `ums-memory`.
This standard is mandatory for new code and for all touched files in migration beads/PRs.

## Scope

- Applies to all new backend implementation code in `apps/**/*.ts` and `libs/**/*.ts`.
- Applies to touched migration surfaces, including compatibility entrypoints in `.mjs`/`.js`.
- Legacy runtime `.mjs`/`.js` files are permitted only as temporary shims until migrated.
- Applies to runtime services, contracts, errors, layer wiring, and adapter boundaries.
- Applies to local verification and CI verification before merge.

Migration note:

- The repository still contains legacy `.mjs` runtime modules.
- During migration, those modules are treated as compatibility shims.
- New business/domain logic MUST be added in strict TypeScript + Effect modules, not expanded in legacy files except for shim wiring.

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
- All changed TypeScript MUST pass `npm run quality:ts`.

Pass criteria:

- `npm run quality:ts` exits `0`.
- No diff disables strict compiler options.

### 2) Effect Service + Layer Boundaries (MUST)

- Business/runtime capabilities MUST be represented as explicit Effect services.
- Each service module MUST expose:
  - A typed service contract (service interface or `Effect.Service` definition).
  - A service tag/constructor.
  - At least one layer (`Layer.succeed`, `Layer.sync`, or equivalent) for runtime composition.
- Application/runtime entrypoints MUST compose dependencies through layers (for example `Layer.mergeAll` in runtime boundaries).
- Beads that touch legacy service-tag modules MUST either:
  - migrate touched services to the current target service pattern, or
  - document a scoped deferral in the bead/PR with follow-up bead ID.

Pass criteria:

- Every new or modified service file exports a typed service contract and layer.
- Runtime assembly files compose services with layers instead of ad-hoc injection.

### 2a) Legacy Shim Boundary (MUST)

- Legacy `.mjs`/`.js` entrypoints MAY remain only as compatibility shims while migration is in progress.
- Shim files MUST keep external contracts stable and delegate to typed internals or adapter boundaries.
- New domain behavior MUST NOT be implemented only in legacy shim modules unless explicitly approved as a temporary bridge with a follow-up migration bead.

Pass criteria:

- Touched legacy entrypoint files are wiring-focused (routing/adaptation), not a long-term home for new domain logic.
- Any temporary shim-only logic includes a follow-up bead reference in PR notes.

### 3) Schema Contracts at Boundaries (MUST)

- All ingress/egress payloads (API/CLI/service boundary inputs and outputs) MUST have Effect `Schema` definitions.
- Unknown payloads MUST be decoded/validated with `Schema.decodeUnknown*` or `Schema.validate*` helpers before use.
- Domain identifiers crossing boundaries SHOULD be schema-constrained IDs (for example branded/UUID schema types).
- Legacy `.mjs` compatibility shims MAY delegate boundary validation to existing legacy core paths during migration, but MUST NOT remove current validation behavior and MUST include a follow-up migration bead reference.

Pass criteria:

- New boundary payload shapes are defined in schema modules.
- No unvalidated `unknown` payload is cast directly to domain types in new TypeScript modules.
- Legacy shim deferrals are explicitly documented with follow-up migration bead IDs.

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
- `// @ts-ignore` or `// @ts-nocheck`.
- Raw payload trust at boundaries (casting/parsing unvalidated `unknown` into domain objects).
- Ad-hoc error creation (`new Error(...)`) for domain/service error channels where tagged errors are required.
- Bypassing quality gates (merging without passing `quality:ts`, `test`, `test:sfe`, and CI verify workflow checks).

Fail criteria:

- Any occurrence of forbidden patterns in touched files.
- Missing justification and follow-up bead for any temporary exception.

## Quality Gates and CI Workflow Contract

The project command contract is:

- `npm run quality:ts`
- `npm run test`
- `npm run test:sfe`
- `npm run ci:verify` (local aggregate: quality + tests + SFE + single-file build)

CI workflow contract:

- File: `.github/workflows/ci.yml`
- Job: `verify` (`Quality, Test, Build`)
- Required gates in order:
  1. `npm run quality:ts`
  2. `npm run test`
  3. `npm run test:sfe`
  4. `npm run build:sfe:single`

Pass criteria:

- Local `npm run ci:verify` succeeds before handoff when code changes are non-trivial.
- CI `verify` job is green on pull request.

## Migration Acceptance Checklist (Beads/PRs)

All items are required unless explicitly marked `N/A` with reason.

1. Strict TS compliance

- [ ] No strictness flags were relaxed.
- [ ] `npm run quality:ts` passed.

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

- [ ] `npm run test` passed.
- [ ] `npm run test:sfe` passed for affected flows.
- [ ] `npm run ci:verify` passed locally or CI proof attached.
- [ ] PR shows green `.github/workflows/ci.yml` `verify` job.

## Exception Process

- Exceptions are temporary and MUST include:
  - exact rule being waived,
  - reason and risk,
  - expiration condition,
  - follow-up bead ID.
- PRs without this exception block are non-compliant.
