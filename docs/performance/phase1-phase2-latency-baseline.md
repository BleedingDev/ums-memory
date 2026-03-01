# UMS Phase 1/2 Latency Baseline

Generated at: 2026-03-01T04:59:13.306Z
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
| ingest (ms) | 0.0016 | 0.006 | 0.7358 |
| replay (ms) | 0.0009 | 0.0029 | 0.4997 |
| recall (ms) | 2.2008 | 3.1205 | 5.8766 |
| recall payload bytes | 3615.5 | 3660.75 | 3675 |

## Per-Store Metrics
### Store: coding-agent

| metric | p50 | p95 | max |
| --- | ---: | ---: | ---: |
| ingest (ms) | 0.0022 | 0.0076 | 0.7358 |
| replay (ms) | 0.0009 | 0.0033 | 0.2676 |
| recall (ms) | 2.2512 | 3.208 | 5.6241 |
| recall payload bytes | 3578 | 3635 | 3635 |

### Store: jira-history

| metric | p50 | p95 | max |
| --- | ---: | ---: | ---: |
| ingest (ms) | 0.0015 | 0.0018 | 0.0377 |
| replay (ms) | 0.001 | 0.001 | 0.4997 |
| recall (ms) | 2.1037 | 2.7072 | 5.8766 |
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

