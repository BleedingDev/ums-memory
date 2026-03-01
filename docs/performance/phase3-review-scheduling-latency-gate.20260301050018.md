# Phase 3 Scheduling Latency Gate

Generated at: 2026-03-01T05:00:18.522Z
Iterations: 300
Volumes: 64, 128, 256

## Scheduling p95 Latency vs Volume
| volume | review_schedule_update p95 (ms) | review_schedule_clock p95 (ms) | review_set_rebalance p95 (ms) |
| ---: | ---: | ---: | ---: |
| 64 | 0.0405 | 0.942 | 0.9554 |
| 128 | 0.014 | 1.019 | 1.2749 |
| 256 | 0.0125 | 1.8641 | 2.7426 |

## Guardrail Gates
| gate | status | details |
| --- | --- | --- |
| reviewScheduleUpdateNearConstant | pass | p95 ratio=3.24 threshold<=6 |
| reviewScheduleClockNearConstant | pass | p95 ratio=1.9789 threshold<=6 |
| reviewSetRebalanceNearConstant | pass | p95 ratio=2.8706 threshold<=6 |
| reviewScheduleUpdateP95Threshold | pass | peak p95=0.0125ms threshold<=0.8ms |
| reviewScheduleClockP95Threshold | pass | peak p95=1.8641ms threshold<=3.8ms |
| reviewSetRebalanceP95Threshold | pass | peak p95=2.7426ms threshold<=4.5ms |

