# UMS Phase 1/2 Latency Baseline

Generated at: 2026-02-28T19:51:52.567Z
Implementation: ./apps/api/src/ums/engine.mjs#createUmsEngine

## Workload
- events: 2000
- queries: 300
- recall maxItems: 10
- recall tokenBudget: 220

## Metrics
| metric | p50 | p95 | max |
| --- | ---: | ---: | ---: |
| ingest (ms) | 0.0014 | 0.0026 | 0.5814 |
| replay (ms) | 0.0008 | 0.0015 | 0.2905 |
| recall (ms) | 2.2131 | 5.5164 | 6.3195 |
| recall payload bytes | 3262 | 3310 | 3310 |

## Guardrail Gates
| gate | status |
| --- | --- |
| ingestP95WithinThreshold | pass |
| replayP95WithinThreshold | pass |
| recallP95WithinThreshold | pass |
| recallPayloadMaxWithinThreshold | pass |
| replayCapturedAllDuplicates | pass |

