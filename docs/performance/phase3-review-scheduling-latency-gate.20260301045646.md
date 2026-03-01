# Phase 3 Scheduling Latency Gate

Generated at: 2026-03-01T04:56:46.178Z
Iterations: 300
Volumes: 64, 128, 256

## Scheduling p95 Latency vs Volume
| volume | review_schedule_update p95 (ms) | review_schedule_clock p95 (ms) | review_set_rebalance p95 (ms) |
| ---: | ---: | ---: | ---: |
| 64 | 0.0324 | 0.8414 | 0.8936 |
| 128 | 0.0121 | 1.0861 | 1.1372 |
| 256 | 0.0266 | 1.9216 | 2.4476 |

## Guardrail Gates
| gate | status | details |
| --- | --- | --- |
| reviewScheduleUpdateNearConstant | pass | p95 ratio=2.6777 threshold<=6 |
| reviewScheduleClockNearConstant | pass | p95 ratio=2.2838 threshold<=6 |
| reviewSetRebalanceNearConstant | pass | p95 ratio=2.739 threshold<=6 |
| reviewScheduleUpdateP95Threshold | pass | peak p95=0.0266ms threshold<=0.8ms |
| reviewScheduleClockP95Threshold | pass | peak p95=1.9216ms threshold<=3.8ms |
| reviewSetRebalanceP95Threshold | pass | peak p95=2.4476ms threshold<=4.5ms |

