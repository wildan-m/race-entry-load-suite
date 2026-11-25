# Spike and recovery report

Race `kbhm-2027`, profile `local`. Run from 2026-11-25T22:24:23.961Z to 2026-11-25T22:31:39.093Z (7.3 min), built from `metrics.json.gz`.

Service-level objective used below: p95 latency under 1,500 ms and under 1.00% of requests and visits failed.

> Local profile: the target is the Firebase Emulator Suite on one workstation, so these figures describe the emulators and the test rig, not production capacity. The same scripts run unchanged against a staging project.

## Verdict

- Baseline p95 7.7 ms at 20 users; during the spike (100 users) p95 8.2 ms with 0.00% failed requests.
- **Back to baseline as soon as the load dropped**: the first 10 s of the recovery phase were already within 25% of baseline p95, with errors under the objective.
- Recovery phase overall: p95 7.6 ms, 0.00% failed requests.

## Timeline

![Active users, requests per second, p95 latency and failed requests over the run](charts/timeline.svg)

## Per phase

| Span | Active users (median / max) | Requests/s | Visits/s | p50 | p95 | p99 | Failed requests | Failed visits | Objective |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| warmup | 11 / 20 | 22.9 | 7.3 | 3.9 ms | 8.2 ms | 19.3 ms | 0.00% | 0.00% | - |
| baseline | 20 / 20 | 45.3 | 14.7 | 3.7 ms | 7.7 ms | 8.6 ms | 0.00% | 0.00% | - |
| spike | 62 / 100 | 135 | 42.5 | 3.3 ms | 7.2 ms | 8.7 ms | 0.00% | 0.00% | - |
| spike_hold | 100 / 100 | 215 | 69.9 | 3.3 ms | 8.2 ms | 357 ms | 0.00% | 0.00% | - |
| drop | 67 / 100 | 123 | 40.8 | 3.6 ms | 8.3 ms | 46.9 ms | 0.55% | 1.67% | - |
| recovery | 20 / 34 | 45.0 | 14.7 | 3.6 ms | 7.6 ms | 10.9 ms | 0.00% | 0.00% | - |
| ramp_down | 10 / 20 | 25.9 | 8.9 | 3.7 ms | 7.9 ms | 11.8 ms | 0.00% | 0.00% | - |

### p95 latency by step

| Span | list_waves | get_entry | create_entry | confirm_entry |
| --- | --- | --- | --- | --- |
| warmup | 8.1 ms | 4.8 ms | 9.6 ms | 4.5 ms |
| baseline | 6.6 ms | 4.1 ms | 8.5 ms | 4.2 ms |
| spike | 1.4 ms | 4.2 ms | 8.4 ms | 4.1 ms |
| spike_hold | 6.8 ms | 6.4 ms | 11.3 ms | 5.6 ms |
| drop | 6.0 ms | 4.7 ms | 20.5 ms | 4.7 ms |
| recovery | 6.2 ms | 4.6 ms | 8.8 ms | 4.8 ms |
| ramp_down | 6.8 ms | 5.2 ms | 9.5 ms | 4.7 ms |

### Outcomes

| Span | Entries created | Already entered | Wave full (409) | Fell back to another wave | Shed (503) | Txn attempts per claim (mean / p95 / max) |
| --- | --- | --- | --- | --- | --- | --- |
| warmup | 117 | 0 | 0 | 0 | 0 | 1.00 / 1 / 1 |
| baseline | 1,050 | 0 | 0 | 0 | 0 | 1.00 / 1 / 1 |
| spike | 370 | 0 | 0 | 0 | 0 | 1.00 / 1 / 1 |
| spike_hold | 2,496 | 0 | 0 | 0 | 0 | 1.00 / 1 / 2 |
| drop | 395 | 0 | 0 | 0 | 11 | 1.14 / 1 / 5 |
| recovery | 1,551 | 0 | 0 | 0 | 0 | 1.00 / 1 / 2 |
| ramp_down | 76 | 0 | 0 | 0 | 0 | 1.00 / 1 / 1 |

## k6 thresholds

20 of 20 thresholds passed.

## Reading this report

- **Users are not requests.** A virtual user is one concurrent runner going through a visit with think time between steps. Requests per second is what those users generate; the two are reported side by side and never substituted for each other.
- **Percentiles are merged, not averaged.** Each p95 and p99 comes from one histogram over every request in the span (1% buckets).
- **A full wave is not an error.** A 409 "wave full" is the correct answer and is counted under outcomes, not failed requests. A 503 is the service shedding load and is counted as a failure.
- **Ramps are left out of the tables.** They mix two load levels; the timeline shows them, the tables cover only the steady spans.
