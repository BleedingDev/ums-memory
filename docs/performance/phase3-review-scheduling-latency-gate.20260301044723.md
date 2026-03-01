# Phase 3 Scheduling Latency Gate

Generated at: 2026-03-01T04:47:23.752Z
Iterations: 300
Volumes: 64, 128, 256

## Scheduling p95 Latency vs Volume
| volume | review_schedule_update p95 (ms) | review_schedule_clock p95 (ms) | review_set_rebalance p95 (ms) |
| ---: | ---: | ---: | ---: |
| 64 | 0.028 | 0.7137 | 0.7591 |
| 128 | 0.0126 | 0.9957 | 1.1028 |
| 256 | 0.0122 | 2.088 | 1.9226 |

## Guardrail Gates
| gate | status | details |
| --- | --- | --- |
| reviewScheduleUpdateNearConstant | pass | p95 ratio=2.2951 threshold<=3.5 |
| reviewScheduleClockNearConstant | pass | p95 ratio=2.9256 threshold<=3.5 |
| reviewSetRebalanceNearConstant | pass | p95 ratio=2.5327 threshold<=3.5 |
| reviewScheduleUpdateP95Threshold | pass | peak p95=0.0122ms threshold<=0.8ms |
| reviewScheduleClockP95Threshold | pass | peak p95=2.088ms threshold<=2.2ms |
| reviewSetRebalanceP95Threshold | pass | peak p95=1.9226ms threshold<=2.8ms |

