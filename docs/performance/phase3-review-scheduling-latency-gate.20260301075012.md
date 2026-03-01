# Phase 3 Scheduling Latency Gate

Generated at: 2026-03-01T07:50:12.883Z
Iterations: 300
Volumes: 64, 128, 256

## Scheduling p95 Latency vs Volume
| volume | review_schedule_update p95 (ms) | review_schedule_clock p95 (ms) | review_set_rebalance p95 (ms) |
| ---: | ---: | ---: | ---: |
| 64 | 0.0332 | 0.7815 | 0.9107 |
| 128 | 0.017 | 1.255 | 1.8666 |
| 256 | 0.0193 | 2.3467 | 2.41 |

## Guardrail Gates
| gate | status | details |
| --- | --- | --- |
| reviewScheduleUpdateNearConstant | pass | p95 ratio=1.9529 threshold<=6 |
| reviewScheduleClockNearConstant | pass | p95 ratio=3.0028 threshold<=6 |
| reviewSetRebalanceNearConstant | pass | p95 ratio=2.6463 threshold<=6 |
| reviewScheduleUpdateP95Threshold | pass | peak p95=0.0193ms threshold<=0.8ms |
| reviewScheduleClockP95Threshold | pass | peak p95=2.3467ms threshold<=3.8ms |
| reviewSetRebalanceP95Threshold | pass | peak p95=2.41ms threshold<=4.5ms |

