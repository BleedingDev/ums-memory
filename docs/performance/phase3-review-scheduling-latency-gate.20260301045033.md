# Phase 3 Scheduling Latency Gate

Generated at: 2026-03-01T04:50:33.098Z
Iterations: 300
Volumes: 64, 128, 256

## Scheduling p95 Latency vs Volume
| volume | review_schedule_update p95 (ms) | review_schedule_clock p95 (ms) | review_set_rebalance p95 (ms) |
| ---: | ---: | ---: | ---: |
| 64 | 0.0193 | 0.5659 | 0.5855 |
| 128 | 0.0134 | 1.0564 | 1.1905 |
| 256 | 0.0129 | 1.8028 | 2.2146 |

## Guardrail Gates
| gate | status | details |
| --- | --- | --- |
| reviewScheduleUpdateNearConstant | pass | p95 ratio=1.4961 threshold<=4 |
| reviewScheduleClockNearConstant | pass | p95 ratio=3.1857 threshold<=4 |
| reviewSetRebalanceNearConstant | pass | p95 ratio=3.7824 threshold<=4 |
| reviewScheduleUpdateP95Threshold | pass | peak p95=0.0129ms threshold<=0.8ms |
| reviewScheduleClockP95Threshold | pass | peak p95=1.8028ms threshold<=3.8ms |
| reviewSetRebalanceP95Threshold | pass | peak p95=2.2146ms threshold<=4.5ms |

