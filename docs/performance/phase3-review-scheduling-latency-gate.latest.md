# Phase 3 Scheduling Latency Gate

Generated at: 2026-03-01T04:47:37.274Z
Iterations: 300
Volumes: 64, 128, 256

## Scheduling p95 Latency vs Volume
| volume | review_schedule_update p95 (ms) | review_schedule_clock p95 (ms) | review_set_rebalance p95 (ms) |
| ---: | ---: | ---: | ---: |
| 64 | 0.0339 | 0.9296 | 1.0152 |
| 128 | 0.0132 | 0.9778 | 1.0747 |
| 256 | 0.0118 | 1.935 | 2.0012 |

## Guardrail Gates
| gate | status | details |
| --- | --- | --- |
| reviewScheduleUpdateNearConstant | pass | p95 ratio=2.8729 threshold<=4 |
| reviewScheduleClockNearConstant | pass | p95 ratio=2.0815 threshold<=4 |
| reviewSetRebalanceNearConstant | pass | p95 ratio=1.9712 threshold<=4 |
| reviewScheduleUpdateP95Threshold | pass | peak p95=0.0118ms threshold<=0.8ms |
| reviewScheduleClockP95Threshold | pass | peak p95=1.935ms threshold<=2.2ms |
| reviewSetRebalanceP95Threshold | pass | peak p95=2.0012ms threshold<=2.8ms |

