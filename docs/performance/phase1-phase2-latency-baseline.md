# UMS Phase 1/2 Latency Baseline

Generated at: 2026-02-28T19:59:44.437Z
Implementation: ./apps/api/src/ums/engine.mjs#createUmsEngine

## Workload
- events: 2000
- queries: 300
- recall maxItems: 10
- recall tokenBudget: 220

## Metrics
| metric | p50 | p95 | max |
| --- | ---: | ---: | ---: |
| ingest (ms) | 0.0033 | 0.0064 | 2.6395 |
| replay (ms) | 0.0008 | 0.0027 | 0.4056 |
| recall (ms) | 2.3682 | 5.2605 | 9.5122 |
| recall payload bytes | 3262 | 3310 | 3310 |

## Guardrail Gates
| gate | status |
| --- | --- |
| ingestP95WithinThreshold | pass |
| replayP95WithinThreshold | pass |
| recallP95WithinThreshold | pass |
| recallPayloadMaxWithinThreshold | pass |
| replayCapturedAllDuplicates | pass |

