# Phase 3 Scheduling Latency Gate

Generated at: 2026-03-01T05:01:40.777Z
Iterations: 300
Volumes: 64, 128, 256

## Scheduling p95 Latency vs Volume
| volume | review_schedule_update p95 (ms) | review_schedule_clock p95 (ms) | review_set_rebalance p95 (ms) |
| ---: | ---: | ---: | ---: |
| 64 | 0.0295 | 0.6973 | 0.8448 |
| 128 | 0.0421 | 1.525 | 1.8037 |
| 256 | 0.0462 | 3.5729 | 3.7348 |

## Guardrail Gates
| gate | status | details |
| --- | --- | --- |
| reviewScheduleUpdateNearConstant | pass | p95 ratio=1.5661 threshold<=6 |
| reviewScheduleClockNearConstant | pass | p95 ratio=5.1239 threshold<=6 |
| reviewSetRebalanceNearConstant | pass | p95 ratio=4.4209 threshold<=6 |
| reviewScheduleUpdateP95Threshold | pass | peak p95=0.0462ms threshold<=0.8ms |
| reviewScheduleClockP95Threshold | pass | peak p95=3.5729ms threshold<=3.8ms |
| reviewSetRebalanceP95Threshold | pass | peak p95=3.7348ms threshold<=4.5ms |

