# Phase 3 Scheduling Latency Gate

Generated at: 2026-03-01T04:51:33.897Z
Iterations: 300
Volumes: 64, 128, 256

## Scheduling p95 Latency vs Volume
| volume | review_schedule_update p95 (ms) | review_schedule_clock p95 (ms) | review_set_rebalance p95 (ms) |
| ---: | ---: | ---: | ---: |
| 64 | 0.0395 | 0.9356 | 1.0628 |
| 128 | 0.0147 | 0.9727 | 1.0522 |
| 256 | 0.0124 | 1.947 | 2.3222 |

## Guardrail Gates
| gate | status | details |
| --- | --- | --- |
| reviewScheduleUpdateNearConstant | pass | p95 ratio=3.1855 threshold<=4 |
| reviewScheduleClockNearConstant | pass | p95 ratio=2.081 threshold<=4 |
| reviewSetRebalanceNearConstant | pass | p95 ratio=2.207 threshold<=4 |
| reviewScheduleUpdateP95Threshold | pass | peak p95=0.0124ms threshold<=0.8ms |
| reviewScheduleClockP95Threshold | pass | peak p95=1.947ms threshold<=3.8ms |
| reviewSetRebalanceP95Threshold | pass | peak p95=2.3222ms threshold<=4.5ms |

