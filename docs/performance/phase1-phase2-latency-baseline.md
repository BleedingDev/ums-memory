# UMS Phase 1/2 Latency Baseline

Generated at: 2026-03-01T04:57:56.921Z
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
| ingest (ms) | 0.0015 | 0.0055 | 0.6101 |
| replay (ms) | 0.0009 | 0.0012 | 0.2745 |
| recall (ms) | 2.1826 | 3.9477 | 6.3168 |
| recall payload bytes | 3615.5 | 3660.75 | 3675 |

## Per-Store Metrics
### Store: coding-agent

| metric | p50 | p95 | max |
| --- | ---: | ---: | ---: |
| ingest (ms) | 0.0017 | 0.0073 | 0.4974 |
| replay (ms) | 0.0009 | 0.0018 | 0.2745 |
| recall (ms) | 2.2249 | 4.2183 | 6.3168 |
| recall payload bytes | 3578 | 3635 | 3635 |

### Store: jira-history

| metric | p50 | p95 | max |
| --- | ---: | ---: | ---: |
| ingest (ms) | 0.0015 | 0.0019 | 0.6101 |
| replay (ms) | 0.001 | 0.0011 | 0.014 |
| recall (ms) | 2.069 | 3.492 | 5.8105 |
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

