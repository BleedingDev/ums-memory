# Phase 3 Scheduling Latency Gate

Generated at: 2026-03-01T04:59:11.759Z
Iterations: 300
Volumes: 64, 128, 256

## Scheduling p95 Latency vs Volume
| volume | review_schedule_update p95 (ms) | review_schedule_clock p95 (ms) | review_set_rebalance p95 (ms) |
| ---: | ---: | ---: | ---: |
| 64 | 0.0419 | 0.9635 | 1.0683 |
| 128 | 0.0149 | 1.1181 | 1.207 |
| 256 | 0.0307 | 2.1027 | 2.5941 |

## Guardrail Gates
| gate | status | details |
| --- | --- | --- |
| reviewScheduleUpdateNearConstant | pass | p95 ratio=2.8121 threshold<=6 |
| reviewScheduleClockNearConstant | pass | p95 ratio=2.1824 threshold<=6 |
| reviewSetRebalanceNearConstant | pass | p95 ratio=2.4283 threshold<=6 |
| reviewScheduleUpdateP95Threshold | pass | peak p95=0.0307ms threshold<=0.8ms |
| reviewScheduleClockP95Threshold | pass | peak p95=2.1027ms threshold<=3.8ms |
| reviewSetRebalanceP95Threshold | pass | peak p95=2.5941ms threshold<=4.5ms |

