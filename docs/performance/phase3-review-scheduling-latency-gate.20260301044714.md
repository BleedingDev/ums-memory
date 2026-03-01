# Phase 3 Scheduling Latency Gate

Generated at: 2026-03-01T04:47:14.091Z
Iterations: 300
Volumes: 64, 128, 256

## Scheduling p95 Latency vs Volume
| volume | review_schedule_update p95 (ms) | review_schedule_clock p95 (ms) | review_set_rebalance p95 (ms) |
| ---: | ---: | ---: | ---: |
| 64 | 0.037 | 0.8181 | 0.9742 |
| 128 | 0.0142 | 1.2508 | 1.2515 |
| 256 | 0.0122 | 1.7785 | 2.3004 |

## Guardrail Gates
| gate | status | details |
| --- | --- | --- |
| reviewScheduleUpdateNearConstant | fail | p95 ratio=3.0328 threshold<=2.2 |
| reviewScheduleClockNearConstant | pass | p95 ratio=2.1739 threshold<=2.2 |
| reviewSetRebalanceNearConstant | fail | p95 ratio=2.3613 threshold<=2.2 |
| reviewScheduleUpdateP95Threshold | pass | peak p95=0.0122ms threshold<=0.8ms |
| reviewScheduleClockP95Threshold | fail | peak p95=1.7785ms threshold<=1.2ms |
| reviewSetRebalanceP95Threshold | fail | peak p95=2.3004ms threshold<=1.2ms |

