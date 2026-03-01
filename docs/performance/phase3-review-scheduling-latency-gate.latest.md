# Phase 3 Scheduling Latency Gate

Generated at: 2026-03-01T11:18:59.212Z
Iterations: 300
Volumes: 64, 128, 256

## Scheduling p95 Latency vs Volume
| volume | review_schedule_update p95 (ms) | review_schedule_clock p95 (ms) | review_set_rebalance p95 (ms) |
| ---: | ---: | ---: | ---: |
| 64 | 0.0191 | 0.5041 | 0.5764 |
| 128 | 0.0214 | 1.211 | 1.2866 |
| 256 | 0.0164 | 2.2534 | 2.4527 |

## Guardrail Gates
| gate | status | details |
| --- | --- | --- |
| reviewScheduleUpdateNearConstant | pass | p95 ratio=1.3049 threshold<=6 |
| reviewScheduleClockNearConstant | pass | p95 ratio=4.4701 threshold<=6 |
| reviewSetRebalanceNearConstant | pass | p95 ratio=4.2552 threshold<=6 |
| reviewScheduleUpdateP95Threshold | pass | peak p95=0.0164ms threshold<=0.8ms |
| reviewScheduleClockP95Threshold | pass | peak p95=2.2534ms threshold<=3.8ms |
| reviewSetRebalanceP95Threshold | pass | peak p95=2.4527ms threshold<=4.5ms |

