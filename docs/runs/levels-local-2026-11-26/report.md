# Load levels report

Race `kbhm-2027`, profile `local`. Run from 2026-11-25T22:15:29.926Z to 2026-11-25T22:21:25.181Z (5.9 min), built from `metrics.json.gz`.

Service-level objective used below: p95 latency under 1,500 ms and under 1.00% of requests and visits failed.

> Local profile: the target is the Firebase Emulator Suite on one workstation, so these figures describe the emulators and the test rig, not production capacity. The same scripts run unchanged against a staging project.

## Verdict

- **Stable through 50 concurrent users.**
- First level over the objective: **125 users**, p95 716 ms, 1.01% failed requests, 3.08% failed visits.
- At the top level the rig held a median of 500 active users and 120 requests/s (40.0 visits/s).

## Timeline

![Active users, requests per second, p95 latency and failed requests over the run](charts/timeline.svg)

## Per level (hold phase)

| Span | Active users (median / max) | Requests/s | Visits/s | p50 | p95 | p99 | Failed requests | Failed visits | Objective |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 50 users | 50 / 50 | 112 | 36.0 | 3.6 ms | 7.0 ms | 14.6 ms | 0.00% | 0.00% | met |
| 125 users | 125 / 125 | 179 | 58.5 | 4.3 ms | 716 ms | 15,813 ms | 1.01% | 3.08% | **missed** |
| 250 users | 250 / 261 | 204 | 67.5 | 166 ms | 2,664 ms | 17,642 ms | 1.35% | 4.09% | **missed** |
| 500 users | 500 / 500 | 120 | 40.0 | 3,316 ms | 5,846 ms | 21,742 ms | 2.15% | 6.43% | **missed** |

### p95 latency by step

| Span | list_waves | get_entry | create_entry | confirm_entry |
| --- | --- | --- | --- | --- |
| 50 users | 4.5 ms | 5.2 ms | 8.3 ms | 5.0 ms |
| 125 users | 257 ms | 695 ms | 15,971 ms | 323 ms |
| 250 users | 2,057 ms | 2,717 ms | 17,818 ms | 1,669 ms |
| 500 users | 5,562 ms | 5,731 ms | 21,742 ms | 5,345 ms |

### Outcomes

| Span | Entries created | Already entered | Wave full (409) | Fell back to another wave | Shed (503) | Txn attempts per claim (mean / p95 / max) |
| --- | --- | --- | --- | --- | --- | --- |
| 50 users | 1,345 | 0 | 0 | 0 | 0 | 1.00 / 1 / 2 |
| 125 users | 1,984 | 0 | 0 | 0 | 107 | 1.03 / 1 / 5 |
| 250 users | 2,259 | 0 | 0 | 0 | 169 | 1.00 / 1 / 2 |
| 500 users | 1,245 | 0 | 0 | 0 | 158 | 1.01 / 1 / 5 |

## k6 thresholds

11 of 26 thresholds passed.

| Metric | Threshold |
| --- | --- |
| `http_req_failed{level:125,phase:hold}` | `rate<0.01` |
| `http_req_duration{level:125,phase:hold,step:create_entry}` | `p(95)<1500` |
| `http_req_duration{level:500,phase:hold}` | `p(95)<1500` |
| `http_req_failed{level:500,phase:hold}` | `rate<0.01` |
| `http_req_failed{level:250,phase:hold}` | `rate<0.01` |
| `http_req_duration{level:250,phase:hold,step:confirm_entry}` | `p(95)<1500` |
| `http_req_duration{level:250,phase:hold,step:get_entry}` | `p(95)<1500` |
| `http_req_duration{level:250,phase:hold,step:create_entry}` | `p(95)<1500` |
| `http_req_duration{level:500,phase:hold,step:create_entry}` | `p(95)<1500` |
| `http_req_duration{level:500,phase:hold,step:get_entry}` | `p(95)<1500` |
| `http_req_duration{level:250,phase:hold,step:list_waves}` | `p(95)<1500` |
| `visit_failed` | `rate<0.01` |
| `http_req_duration{level:500,phase:hold,step:list_waves}` | `p(95)<1500` |
| `http_req_duration{level:500,phase:hold,step:confirm_entry}` | `p(95)<1500` |
| `http_req_duration{level:250,phase:hold}` | `p(95)<1500` |

## Reading this report

- **Users are not requests.** A virtual user is one concurrent runner going through a visit with think time between steps. Requests per second is what those users generate; the two are reported side by side and never substituted for each other.
- **Percentiles are merged, not averaged.** Each p95 and p99 comes from one histogram over every request in the span (1% buckets).
- **A full wave is not an error.** A 409 "wave full" is the correct answer and is counted under outcomes, not failed requests. A 503 is the service shedding load and is counted as a failure.
- **Ramps are left out of the tables.** They mix two load levels; the timeline shows them, the tables cover only the steady spans.
