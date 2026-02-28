# UMS Phase 1/2 Latency Baseline

Generated at: 2026-02-28T20:00:46.467Z
Implementation: ./apps/api/src/ums/engine.mjs#createUmsEngine

## Workload
- events: 2000
- queries: 300
- recall maxItems: 10
- recall tokenBudget: 220

## Metrics
| metric | p50 | p95 | max |
| --- | ---: | ---: | ---: |
| ingest (ms) | 0.0016 | 0.006 | 0.4764 |
| replay (ms) | 0.0008 | 0.0017 | 0.2465 |
| recall (ms) | 2.2458 | 5.1999 | 10.2494 |
| recall payload bytes | 3262 | 3310 | 3310 |

## Guardrail Gates
| gate | status |
| --- | --- |
| ingestP95WithinThreshold | pass |
| replayP95WithinThreshold | pass |
| recallP95WithinThreshold | pass |
| recallPayloadMaxWithinThreshold | pass |
| replayCapturedAllDuplicates | pass |

