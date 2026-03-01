# Phase 3 Scheduling Latency Gate

Generated at: 2026-03-01T04:47:29.482Z
Iterations: 300
Volumes: 64, 128, 256

## Scheduling p95 Latency vs Volume
| volume | review_schedule_update p95 (ms) | review_schedule_clock p95 (ms) | review_set_rebalance p95 (ms) |
| ---: | ---: | ---: | ---: |
| 64 | 0.043 | 0.7352 | 0.8475 |
| 128 | 0.0146 | 1.0005 | 1.2143 |
| 256 | 0.0119 | 1.8587 | 2.6369 |

## Guardrail Gates
| gate | status | details |
| --- | --- | --- |
| reviewScheduleUpdateNearConstant | fail | p95 ratio=3.6134 threshold<=3.5 |
| reviewScheduleClockNearConstant | pass | p95 ratio=2.5282 threshold<=3.5 |
| reviewSetRebalanceNearConstant | pass | p95 ratio=3.1114 threshold<=3.5 |
| reviewScheduleUpdateP95Threshold | pass | peak p95=0.0119ms threshold<=0.8ms |
| reviewScheduleClockP95Threshold | pass | peak p95=1.8587ms threshold<=2.2ms |
| reviewSetRebalanceP95Threshold | pass | peak p95=2.6369ms threshold<=2.8ms |

