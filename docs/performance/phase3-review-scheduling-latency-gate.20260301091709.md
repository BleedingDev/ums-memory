# Phase 3 Scheduling Latency Gate

Generated at: 2026-03-01T09:17:09.000Z
Iterations: 300
Volumes: 64, 128, 256

## Scheduling p95 Latency vs Volume
| volume | review_schedule_update p95 (ms) | review_schedule_clock p95 (ms) | review_set_rebalance p95 (ms) |
| ---: | ---: | ---: | ---: |
| 64 | 0.0657 | 1.2201 | 1.3642 |
| 128 | 0.0442 | 1.6154 | 2.086 |
| 256 | 0.0371 | 3.0962 | 3.8852 |

## Guardrail Gates
| gate | status | details |
| --- | --- | --- |
| reviewScheduleUpdateNearConstant | pass | p95 ratio=1.7709 threshold<=6 |
| reviewScheduleClockNearConstant | pass | p95 ratio=2.5377 threshold<=6 |
| reviewSetRebalanceNearConstant | pass | p95 ratio=2.848 threshold<=6 |
| reviewScheduleUpdateP95Threshold | pass | peak p95=0.0371ms threshold<=0.8ms |
| reviewScheduleClockP95Threshold | pass | peak p95=3.0962ms threshold<=3.8ms |
| reviewSetRebalanceP95Threshold | pass | peak p95=3.8852ms threshold<=4.5ms |

