# Phase 3 Scheduling Latency Gate

Generated at: 2026-03-01T04:54:18.092Z
Iterations: 300
Volumes: 64, 128, 256

## Scheduling p95 Latency vs Volume
| volume | review_schedule_update p95 (ms) | review_schedule_clock p95 (ms) | review_set_rebalance p95 (ms) |
| ---: | ---: | ---: | ---: |
| 64 | 0.0329 | 0.7893 | 0.978 |
| 128 | 0.032 | 1.5522 | 1.7815 |
| 256 | 0.012 | 1.8334 | 2.5358 |

## Guardrail Gates
| gate | status | details |
| --- | --- | --- |
| reviewScheduleUpdateNearConstant | pass | p95 ratio=2.7417 threshold<=6 |
| reviewScheduleClockNearConstant | pass | p95 ratio=2.3228 threshold<=6 |
| reviewSetRebalanceNearConstant | pass | p95 ratio=2.5928 threshold<=6 |
| reviewScheduleUpdateP95Threshold | pass | peak p95=0.012ms threshold<=0.8ms |
| reviewScheduleClockP95Threshold | pass | peak p95=1.8334ms threshold<=3.8ms |
| reviewSetRebalanceP95Threshold | pass | peak p95=2.5358ms threshold<=4.5ms |

