# Federation Go/No-Go Decision

Date: 2026-03-08  
Owner: UMS backend platform  
Status: blocked by default until prerequisites are green

## Purpose

Freeze the explicit start gate for federation work so `ums-memory-6nq.1` stays deny-by-default until the runtime, eval, and Postgres hardening tracks are stable.

## Blocking Status

- Federation remains **NO-GO** by default.
- No engineer or agent may promote federation from shadow review into serving behavior until this artifact records a `GO`.
- A missing prerequisite, missing command gate, or unstable blind review result forces `NO-GO`.

## Prerequisite Matrix

| Phase                      | Bead / artifact    | Required state before `GO`                                                  |
| -------------------------- | ------------------ | --------------------------------------------------------------------------- |
| Phase 1/2 runtime baseline | `ums-memory-thq`   | Closed with `G0` and `G1` green                                             |
| Lean eval stack            | `ums-memory-jny`   | Closed with `bun run eval:lean` green and CI gate wired                     |
| Postgres cutover path      | `ums-memory-onf`   | Closed with parity, dual-run telemetry, and rollback playbooks green        |
| Federation start gate      | `ums-memory-6nq.1` | This artifact reviewed and `tests/unit/federation-start-gate.test.ts` green |

## Required Command Gates

- `G0` — `bun run quality:ts`
- `G1` — `bun run test`
- `G5` — `bun run ci:verify`

`GO` requires all three command gates to be green on the same branch tip that closes the prerequisite beads.

## Machine-Check Rules

- `ums-memory-thq`, `ums-memory-jny`, and `ums-memory-onf` must all be closed.
- `bun run quality:ts`, `bun run test`, and `bun run ci:verify` must pass without waivers.
- Federation must stay read-only and deny-by-default until `tests/integration/federation-shadow-eval.integration.test.ts`, `tests/integration/federation-canary-policy.integration.test.ts`, and `tests/integration/federation-ga-readiness.integration.test.ts` are green.
- Cross-tenant federation remains forbidden even after `GO`.

## No-Go Conditions

- Any prerequisite bead is open or re-opened.
- Any quality gate fails or requires `|| true`.
- Any blind review finds cross-tenant leakage, nondeterministic deny reason codes, or a write path in shadow mode.
- Any artifact claims staged evidence that does not exist.

## Go Decision Record

Record the decision in this exact format:

```text
Decision: GO|NO-GO
ReviewedAt: <ISO-8601 timestamp>
ReviewedBy: <owner>
Prerequisites: thq=<status>, jny=<status>, onf=<status>
Gates: G0=<pass|fail>, G1=<pass|fail>, G5=<pass|fail>
Notes: <short reason>
```

## Current Decision

```text
Decision: NO-GO
ReviewedAt: 2026-03-08T00:00:00.000Z
ReviewedBy: UMS backend platform
Prerequisites: thq=open, jny=open, onf=open
Gates: G0=unknown, G1=unknown, G5=unknown
Notes: Federation is blocked until the core runtime, eval, and Postgres tracks are closed and stable.
```
