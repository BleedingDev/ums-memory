# UMS Phase 1/2 Backend Delivery Runbook

## Purpose
Operational runbook for delivering Phase 1 and Phase 2 epics under shared backend constraints:
- no frontend work
- backend-only interfaces
- local-first operation
- security defaults enabled by default

This runbook is paired with [ADR-0001](../adr/0001-phase1-phase2-baseline-constraints.md).
For source-domain partitioning, see [Multi-Store Source Ingestion](./multi-store-source-ingestion.md).

## Engineering Standards

All backend beads in this runbook must comply with the strict TypeScript + Effect standard for new and touched migration code.
Legacy `.mjs` entrypoints are allowed only as compatibility shims until migrated:
[Strict TypeScript + Effect Engineering Standard](../standards/strict-ts-effect-standard.md).

## Mandatory Delivery Boundaries
1. `No frontend`
No pages, visual components, design systems, or browser-only artifacts are part of this runbook.
2. `Backend-only surfaces`
Delivery targets are API/CLI/MCP/services/storage/connectors/ops commands.
3. `Local-first`
Core ingest, recall, replay, and audit behavior must run without a remote dependency.
4. `Security-default posture`
PII/secret redaction, tenant/profile isolation, trust boundaries, and auditability are default-on.
5. `Deterministic + replay-safe`
Same inputs produce the same state, and replays do not duplicate facts.
6. `Bounded recall`
Recall outputs must remain inside strict item/token/size budgets and enforce guardrails.

## Epic Execution Flow (Phase 1 then Phase 2)
1. Confirm epic scope in ADR mapping before coding.
2. Lock entity/invariant contracts first, then repository/index contracts.
3. Implement API/CLI contract handlers.
4. Implement core service behavior.
5. Validate guardrails and failure paths.
6. Run unit tests, integration tests, and benchmarks.
7. Record benchmark report in `docs/performance/`.

## Quality Gates
Every epic must pass these checks before close:
1. Deterministic behavior check:
State digest and recall ordering remain stable across repeat runs.
2. Idempotent ingestion check:
Replay of identical events yields zero net new records.
3. Bounded recall check:
`maxItems`, token budget, and payload byte limits are enforced.
4. Guardrails check:
Unsafe instruction content is filtered by default, secret values are redacted.
5. Latency check:
Ingest/replay/recall p95 latency stays below configured thresholds.

Automation mapping:
1. CI-enforced checks:
Determinism/idempotency/bounded-recall/guardrail regressions are covered by `npm run test` and `npm run test:sfe`.
Reference suites:
- determinism: `tests/unit/determinism.test.mjs`
- idempotency: `tests/unit/idempotent-ingestion.test.mjs`
- bounded recall + guardrails: `tests/unit/recall-bounds-guardrails.test.mjs`
- API/CLI/SFE contract behavior: `apps/api/test/*.test.mjs`, `apps/cli/test/*.test.mjs`, `apps/*/test/*.sfe.test.mjs`
2. Operational benchmark checks:
Latency SLO validation uses benchmark reports from `node benchmarks/ums-latency-benchmark.mjs` and is reviewed as part of release hardening.
Reference baseline and threshold evidence in `docs/performance/phase1-phase2-latency-baseline.md`.

## Test and Benchmark Commands (Node Built-in Tooling)
1. Run unit + integration tests:
```bash
node --test tests/unit/*.test.mjs tests/integration/*.test.mjs
```
2. Run benchmark harness and write reports:
```bash
node benchmarks/ums-latency-benchmark.mjs
```
3. Optional: run tests/benchmarks against an alternate implementation module:
```bash
UMS_IMPL_MODULE=./apps/api/src/ums/engine.mjs UMS_IMPL_EXPORT=createUmsEngine node --test tests/unit/*.test.mjs tests/integration/*.test.mjs
UMS_IMPL_MODULE=./apps/api/src/ums/engine.mjs UMS_IMPL_EXPORT=createUmsEngine node benchmarks/ums-latency-benchmark.mjs
```

## CI Quality Gates

The GitHub Actions workflow at `.github/workflows/ci.yml` runs on both push and pull request and fails fast on regressions in:

1. TypeScript quality:
   `npm run quality:ts`
2. Tests:
   `npm run test`
3. SFE runtime tests:
   `npm run test:sfe`
4. Deterministic single-file build:
   `npm run build:sfe:single`

Local equivalent:

```bash
npm run ci:verify
```

## Failure Response
1. Determinism/idempotency failure:
Pause merge, capture repro event set, and compare state digests before/after replay.
2. Guardrail failure:
Block rollout, patch sanitization/filtering defaults, re-run full tests.
3. Latency regression:
Tune indexes/caching/batch behavior; regenerate report and compare with prior baseline.
4. Scope violation (frontend drift):
Move UI work to separate non-Phase1/2 beads and keep backend bead focused.
