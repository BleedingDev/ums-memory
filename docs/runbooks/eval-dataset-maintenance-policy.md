# Lean Eval Dataset Maintenance Policy

## Purpose

Keep the P4 eval corpora lean, deterministic, and reviewable so
`ums-memory-jny.4` stays a binary CI gate and `ums-memory-jny.5` prevents
unbounded scope creep.

## Scope

This policy governs the bounded eval assets below:

- `tests/fixtures/eval/golden-replay/*.json`
- `tests/fixtures/eval/adapter-conformance/*.json`
- `tests/fixtures/eval/grounded-holdout/*.json`
- `scripts/eval-golden-replay.ts`
- `scripts/eval-adapter-conformance.ts`
- `scripts/eval-grounded-recall.ts`
- `tests/unit/eval-script-contracts.test.ts`
- `tests/unit/eval-dataset-policy.test.ts`

## Lean Corpus Budgets

1. Golden replay corpus
   - Keep one canonical fixture per regression family.
   - Default ceiling: 10 fixtures total.
   - Net-new fixtures must replace weaker coverage or carry explicit owner review.
2. Adapter conformance corpus
   - Keep one replay fixture per supported adapter.
   - Keep the malformed challenge floor, including `malformed-empty-content` and
     `malformed-unsupported-source`.
   - Expand only when the supported adapter list or adapter contract changes.
3. Grounded holdout corpus
   - Keep at most 5 holdout cases.
   - Every holdout fixture must declare `usage.split: "holdout"` and
     `tuningAllowed: false`.
   - Holdout text may not be reused for prompt tuning, model tuning, or
     synthetic fixture generation.

Any change that adds more than 3 net-new fixtures across the full eval surface
requires owner review before merge.

## Change Control

Every dataset change must include:

1. a linked bead ID,
2. the owner responsible for reviewing the corpus delta,
3. the regression class or contract gap the new fixture covers,
4. focused evidence from `bun run eval:lean`,
5. updates to static contracts when budgets, fixture classes, or policy text change.

Do not add placeholder fixtures “just in case.” If a case is not tied to an
active regression, supported adapter change, or grounded citation gap, reject it.

## Holdout Isolation

Grounded holdout data is sealed from tuning:

- `tuningAllowed: false` is mandatory for every holdout fixture.
- Holdout prompts, answers, and citations stay out of prompt libraries, tuning
  corpora, and synthetic seed generators.
- Any proposal to relax holdout isolation is an automatic rejection until a new
  blocking bead and owner-approved policy revision exist.

## Determinism Rules

Eval fixtures must remain deterministic:

- no live network calls,
- no wall-clock or timezone-sensitive assertions,
- no random sampling without a fixed seed recorded in the fixture,
- stable fixture IDs, newline-normalized JSON, and explicit review for digest changes,
- no optional release gates or `|| true` fallbacks around eval commands.

All contract tests on this path run with Bun and `@effect-native/bun-test`
against the Effect v4 toolchain. Do not introduce `node:test`, Vitest, or npm
wrappers into the eval contract path.

## CI Gate Impact

`bun run eval:lean` is mandatory in `bun run ci:verify` and in the GitHub
Actions `verify` job. This verify job is the release gate. No npm wrappers, alternate task runners, or manual-only
branches may bypass the `verify` job. A dataset change is blocked when it
causes any of the following:

- golden replay digest drift,
- supported adapter coverage loss,
- malformed/replay challenge erosion,
- grounded recall or citation-integrity regression,
- holdout isolation violations.

## Audit Trail

For each accepted corpus change, record the following in the bead, PR, or both:

- affected fixture IDs,
- owner reviewer,
- reason for addition, removal, or digest update,
- whether the change stayed within the lean corpus budgets.

## Rejection Rules

Reject the change immediately if it:

- allows unbounded corpus growth without owner review,
- marks a holdout fixture with `tuningAllowed: true`,
- adds live or nondeterministic data sources,
- makes eval execution optional in release flow,
- adds adapter variants without a supported-adapter contract change.
