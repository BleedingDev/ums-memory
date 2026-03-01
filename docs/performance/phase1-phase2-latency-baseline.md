# UMS Phase 1/2 Latency Baseline

Generated at: 2026-03-01T09:35:57.248Z
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
| ingest (ms) | 0.002 | 0.0058 | 0.6482 |
| replay (ms) | 0.001 | 0.0014 | 0.3174 |
| recall (ms) | 2.278 | 3.7457 | 8.6531 |
| recall payload bytes | 3615.5 | 3660.75 | 3675 |

## Per-Store Metrics
### Store: coding-agent

| metric | p50 | p95 | max |
| --- | ---: | ---: | ---: |
| ingest (ms) | 0.0035 | 0.0067 | 0.5109 |
| replay (ms) | 0.0009 | 0.0013 | 0.3174 |
| recall (ms) | 2.3208 | 4.0956 | 8.6531 |
| recall payload bytes | 3578 | 3635 | 3635 |

### Store: jira-history

| metric | p50 | p95 | max |
| --- | ---: | ---: | ---: |
| ingest (ms) | 0.0018 | 0.0023 | 0.6482 |
| replay (ms) | 0.0011 | 0.0014 | 0.0331 |
| recall (ms) | 2.125 | 3.3807 | 6.3224 |
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

