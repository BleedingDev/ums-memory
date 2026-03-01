# Phase 3 Scheduling Latency Gate

Generated at: 2026-03-01T09:25:37.020Z
Iterations: 300
Volumes: 64, 128, 256

## Scheduling p95 Latency vs Volume
| volume | review_schedule_update p95 (ms) | review_schedule_clock p95 (ms) | review_set_rebalance p95 (ms) |
| ---: | ---: | ---: | ---: |
| 64 | 0.0192 | 0.5498 | 0.5729 |
| 128 | 0.0121 | 0.9228 | 1.0337 |
| 256 | 0.0382 | 2.8731 | 2.7261 |

## Guardrail Gates
| gate | status | details |
| --- | --- | --- |
| reviewScheduleUpdateNearConstant | pass | p95 ratio=3.157 threshold<=6 |
| reviewScheduleClockNearConstant | pass | p95 ratio=5.2257 threshold<=6 |
| reviewSetRebalanceNearConstant | pass | p95 ratio=4.7584 threshold<=6 |
| reviewScheduleUpdateP95Threshold | pass | peak p95=0.0382ms threshold<=0.8ms |
| reviewScheduleClockP95Threshold | pass | peak p95=2.8731ms threshold<=3.8ms |
| reviewSetRebalanceP95Threshold | pass | peak p95=2.7261ms threshold<=4.5ms |

