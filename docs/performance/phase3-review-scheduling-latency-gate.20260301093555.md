# Phase 3 Scheduling Latency Gate

Generated at: 2026-03-01T09:35:55.641Z
Iterations: 300
Volumes: 64, 128, 256

## Scheduling p95 Latency vs Volume
| volume | review_schedule_update p95 (ms) | review_schedule_clock p95 (ms) | review_set_rebalance p95 (ms) |
| ---: | ---: | ---: | ---: |
| 64 | 0.021 | 0.5375 | 0.6074 |
| 128 | 0.0145 | 1.0608 | 1.4106 |
| 256 | 0.0313 | 2.252 | 2.7053 |

## Guardrail Gates
| gate | status | details |
| --- | --- | --- |
| reviewScheduleUpdateNearConstant | pass | p95 ratio=2.1586 threshold<=6 |
| reviewScheduleClockNearConstant | pass | p95 ratio=4.1898 threshold<=6 |
| reviewSetRebalanceNearConstant | pass | p95 ratio=4.4539 threshold<=6 |
| reviewScheduleUpdateP95Threshold | pass | peak p95=0.0313ms threshold<=0.8ms |
| reviewScheduleClockP95Threshold | pass | peak p95=2.252ms threshold<=3.8ms |
| reviewSetRebalanceP95Threshold | pass | peak p95=2.7053ms threshold<=4.5ms |

