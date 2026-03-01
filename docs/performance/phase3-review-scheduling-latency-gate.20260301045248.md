# Phase 3 Scheduling Latency Gate

Generated at: 2026-03-01T04:52:48.344Z
Iterations: 300
Volumes: 64, 128, 256

## Scheduling p95 Latency vs Volume
| volume | review_schedule_update p95 (ms) | review_schedule_clock p95 (ms) | review_set_rebalance p95 (ms) |
| ---: | ---: | ---: | ---: |
| 64 | 0.0417 | 0.9235 | 1.1018 |
| 128 | 0.0408 | 1.7626 | 2.035 |
| 256 | 0.0126 | 2.0583 | 2.3205 |

## Guardrail Gates
| gate | status | details |
| --- | --- | --- |
| reviewScheduleUpdateNearConstant | pass | p95 ratio=3.3095 threshold<=4 |
| reviewScheduleClockNearConstant | pass | p95 ratio=2.2288 threshold<=4 |
| reviewSetRebalanceNearConstant | pass | p95 ratio=2.1061 threshold<=4 |
| reviewScheduleUpdateP95Threshold | pass | peak p95=0.0126ms threshold<=0.8ms |
| reviewScheduleClockP95Threshold | pass | peak p95=2.0583ms threshold<=3.8ms |
| reviewSetRebalanceP95Threshold | pass | peak p95=2.3205ms threshold<=4.5ms |

