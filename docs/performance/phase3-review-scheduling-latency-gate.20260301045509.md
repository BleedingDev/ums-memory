# Phase 3 Scheduling Latency Gate

Generated at: 2026-03-01T04:55:09.140Z
Iterations: 300
Volumes: 64, 128, 256

## Scheduling p95 Latency vs Volume
| volume | review_schedule_update p95 (ms) | review_schedule_clock p95 (ms) | review_set_rebalance p95 (ms) |
| ---: | ---: | ---: | ---: |
| 64 | 0.0337 | 0.8 | 0.9747 |
| 128 | 0.0123 | 0.9818 | 1.043 |
| 256 | 0.0126 | 2.182 | 2.457 |

## Guardrail Gates
| gate | status | details |
| --- | --- | --- |
| reviewScheduleUpdateNearConstant | pass | p95 ratio=2.7398 threshold<=6 |
| reviewScheduleClockNearConstant | pass | p95 ratio=2.7275 threshold<=6 |
| reviewSetRebalanceNearConstant | pass | p95 ratio=2.5208 threshold<=6 |
| reviewScheduleUpdateP95Threshold | pass | peak p95=0.0126ms threshold<=0.8ms |
| reviewScheduleClockP95Threshold | pass | peak p95=2.182ms threshold<=3.8ms |
| reviewSetRebalanceP95Threshold | pass | peak p95=2.457ms threshold<=4.5ms |

