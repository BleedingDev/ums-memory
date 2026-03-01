# Phase 3 Scheduling Latency Gate

Generated at: 2026-03-01T09:02:04.602Z
Iterations: 300
Volumes: 64, 128, 256

## Scheduling p95 Latency vs Volume
| volume | review_schedule_update p95 (ms) | review_schedule_clock p95 (ms) | review_set_rebalance p95 (ms) |
| ---: | ---: | ---: | ---: |
| 64 | 0.0505 | 1.0951 | 1.216 |
| 128 | 0.0433 | 1.807 | 1.9955 |
| 256 | 0.0224 | 3.0405 | 2.9012 |

## Guardrail Gates
| gate | status | details |
| --- | --- | --- |
| reviewScheduleUpdateNearConstant | pass | p95 ratio=2.2545 threshold<=6 |
| reviewScheduleClockNearConstant | pass | p95 ratio=2.7765 threshold<=6 |
| reviewSetRebalanceNearConstant | pass | p95 ratio=2.3859 threshold<=6 |
| reviewScheduleUpdateP95Threshold | pass | peak p95=0.0224ms threshold<=0.8ms |
| reviewScheduleClockP95Threshold | pass | peak p95=3.0405ms threshold<=3.8ms |
| reviewSetRebalanceP95Threshold | pass | peak p95=2.9012ms threshold<=4.5ms |

