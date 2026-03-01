# UMS Phase 1/2 Latency Baseline

Generated at: 2026-03-01T04:51:35.721Z
Implementation: ./apps/api/src/ums/engine.mjs#createUmsEngine

## Workload
- stores: coding-agent, jira-history
- events per store: 2000
- queries per store: 300
- recall maxItems: 10
- recall tokenBudget: 220

## Aggregated Metrics
| metric | p50 | p95 | max |
| --- | ---: | ---: | ---: |
| ingest (ms) | 0.0016 | 0.0053 | 0.5393 |
| replay (ms) | 0.0012 | 0.0027 | 0.5868 |
| recall (ms) | 2.3493 | 5.161 | 13.1954 |
| recall payload bytes | 3615.5 | 3660.75 | 3675 |

## Per-Store Metrics
### Store: coding-agent

| metric | p50 | p95 | max |
| --- | ---: | ---: | ---: |
| ingest (ms) | 0.0022 | 0.0065 | 0.5393 |
| replay (ms) | 0.0021 | 0.0027 | 0.3949 |
| recall (ms) | 2.428 | 5.3076 | 9.4583 |
| recall payload bytes | 3578 | 3635 | 3635 |

### Store: jira-history

| metric | p50 | p95 | max |
| --- | ---: | ---: | ---: |
| ingest (ms) | 0.0015 | 0.0019 | 0.0587 |
| replay (ms) | 0.001 | 0.0027 | 0.5868 |
| recall (ms) | 2.2281 | 4.7549 | 13.1954 |
| recall payload bytes | 3620 | 3675 | 3675 |

## Aggregated Guardrail Gates
| gate | status |
| --- | --- |
| ingestP95WithinThreshold | pass |
| replayP95WithinThreshold | pass |
| recallP95WithinThreshold | pass |
| recallPayloadMaxWithinThreshold | pass |
| replayCapturedAllDuplicates | pass |

## Per-Store Guardrail Gates
| store | gate | status |
| --- | --- | --- |
| coding-agent | ingestP95WithinThreshold | pass |
| coding-agent | replayP95WithinThreshold | pass |
| coding-agent | recallP95WithinThreshold | pass |
| coding-agent | recallPayloadMaxWithinThreshold | pass |
| coding-agent | replayCapturedAllDuplicates | pass |
| jira-history | ingestP95WithinThreshold | pass |
| jira-history | replayP95WithinThreshold | pass |
| jira-history | recallP95WithinThreshold | pass |
| jira-history | recallPayloadMaxWithinThreshold | pass |
| jira-history | replayCapturedAllDuplicates | pass |

