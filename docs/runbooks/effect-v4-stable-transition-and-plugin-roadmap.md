# Effect v4 Stable Transition + Upgrade Cadence + Typed Plugin Roadmap

Generated: 2026-03-04
Related beads: `ums-memory-bmd.5`, `ums-memory-bmd.6`, `ums-memory-bmd.7`

## 1) Effect v4 Beta -> Stable Transition Plan

### Readiness criteria

- Stable `effect` v4 release is published and documented upstream.
- Full repository gates are green on current pin:
  - `npm run quality:ts`
  - `npm run ci:verify`
- No runtime TS suppressions and no legacy runtime shim inventory entries.
- Deterministic API/CLI contract suites remain green (`test:api`, `test:ums`, `test:sfe`).

### Migration steps

1. Update pin from `4.0.0-beta.25` to stable v4 in `package.json`.
2. Keep `scripts/validate-effect-beta-pin.ts` policy semantics, but switch it to enforce approved stable range.
3. Run full gate:
   - `npm run quality:ts`
   - `npm run ci:verify`
4. Produce delta report:
   - changed public types
   - runtime behavior diffs
   - deterministic hash regressions (if any)
5. Merge only with all gates green and report attached to PR.

### Rollback path

- If any contract or determinism regression appears after pin change:
  1. revert dependency pin commit;
  2. rerun `npm run ci:verify`;
  3. reopen transition bead with exact failing commands and diff pointers.

## 2) Dependency + Compatibility Upgrade Cadence

### Cadence policy

- Weekly:
  - check patch-level updates for build/test infra and toolchain.
- Bi-weekly:
  - review minor-version updates of runtime and validation tooling.
- Monthly:
  - planned dependency refresh branch with full compatibility pass.

### Mandatory gates per upgrade PR

- `npm run quality:ts`
- `npm run ci:verify`
- strict JSON and tsconfig policy validation must remain green
- no new `.js`/`.mjs` source files in guarded directories (`validate:no-legacy-js-sources`)

### Release safety checkpoints

- Before merge:
  - green CI on clean branch.
- After merge:
  - re-run `ci:verify` on default branch.
- Incident rollback:
  - immediate revert and postmortem issue with failing objective + command output.

## 3) Future Typed Plugin Ecosystem Contract Model

### Design goals

- All plugin boundaries are explicit TypeScript contracts.
- Fail-closed behavior is default for plugin execution paths.
- Deterministic replay semantics are preserved when plugin hooks are enabled.

### Contract shape guidelines

- Define plugin request/response types in shared contract modules under `libs/shared/src/effect/contracts`.
- Use tagged error contracts for plugin failures and strict narrowing in callers.
- Require deterministic metadata in plugin results:
  - `decision`
  - `reasonCode`
  - `trace`/`audit` fields as needed by current operation contracts.

### Runtime integration rules

- Plugins must be wired via Effect services/layers, not ad-hoc dynamic imports in operation handlers.
- Unknown plugin outcomes must map to explicit contract errors.
- Policy-sensitive hooks must keep audit trail emission deterministic.

### Onboarding checklist for a new plugin point

1. Add shared contract types + schema/decoder path.
2. Add operation-level contract tests (positive + fail-closed + replay-safe).
3. Add integration coverage for API/CLI parity where relevant.
4. Add runbook note describing rollout/rollback behavior.
