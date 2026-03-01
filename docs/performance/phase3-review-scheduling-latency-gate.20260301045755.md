# Phase 3 Scheduling Latency Gate

Generated at: 2026-03-01T04:57:55.357Z
Iterations: 300
Volumes: 64, 128, 256

## Scheduling p95 Latency vs Volume
| volume | review_schedule_update p95 (ms) | review_schedule_clock p95 (ms) | review_set_rebalance p95 (ms) |
| ---: | ---: | ---: | ---: |
| 64 | 0.0337 | 0.9003 | 0.9934 |
| 128 | 0.0146 | 0.984 | 1.055 |
| 256 | 0.0122 | 1.7374 | 1.9503 |

## Guardrail Gates
| gate | status | details |
| --- | --- | --- |
| reviewScheduleUpdateNearConstant | pass | p95 ratio=2.7623 threshold<=6 |
| reviewScheduleClockNearConstant | pass | p95 ratio=1.9298 threshold<=6 |
| reviewSetRebalanceNearConstant | pass | p95 ratio=1.9633 threshold<=6 |
| reviewScheduleUpdateP95Threshold | pass | peak p95=0.0122ms threshold<=0.8ms |
| reviewScheduleClockP95Threshold | pass | peak p95=1.7374ms threshold<=3.8ms |
| reviewSetRebalanceP95Threshold | pass | peak p95=1.9503ms threshold<=4.5ms |

