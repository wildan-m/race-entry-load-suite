# Race entry load suite

Load, spike, soak and breaking-point testing for the entry service of the Kestrel Bay Half Marathon:
a Firebase backend (Cloud Functions 2nd gen, Firestore, Firebase Authentication) that has to hold up
in the minutes after entries open. k6 drives runner visits with think time and real sign-in tokens,
every request is tagged with its step and load phase, and a report builder turns the raw k6 output
into a per-level verdict, per-step latency, business outcomes and a timeline chart.

The race, the 20,000 runners and every record the tools create are fictional test data.

## What is in here

| Folder | What it holds |
| --- | --- |
| `functions/` | The entry API under test: Express on a 2nd-gen HTTPS function. Wave listing, entry lookup, and a capacity-safe claim inside a Firestore transaction. |
| `tools/` | Seeding (race, waves, capacity buckets, test runners), token minting, the suite runner, and a contention probe. |
| `load/` | The k6 suites (`levels`, `spike`, `soak`, `breakpoint`) and the shared runner journey. |
| `report/` | Streams k6's JSON output into `report.md`, `report.html`, `report.json` and an SVG timeline. |
| `test/` | Unit tests for the report maths and helpers; integration tests that race real transactions on the Firestore emulator. |
| `docs/runs/` | The reports from the local runs below, as generated. |

## How the tests model opening day

- **A visit is a person.** Each iteration is one runner: open the wave list, think, check for an
  existing entry, claim a wave (falling back to the next wave with places left when it is full),
  confirm. The visit mix (enter 60%, check 30%, browse 10%) and the wave demand sit in
  `load/lib/choices.js`, to be replaced with the site's own analytics.
- **Users are not requests.** `levels`, `spike` and `soak` are closed-model: a fixed number of
  concurrent runners (`ramping-vus`). `breakpoint` is open-model: new visits per second
  (`ramping-arrival-rate`), aborted as soon as the objective breaks. Reports always show active
  users and requests per second side by side, and the breakpoint report checks concurrency against
  Little's law and counts dropped visits, which mark the load generator's limit rather than the
  service's.
- **Every request carries its phase.** k6 does not tag `ramping-vus` stages, so the scripts stamp
  `level`, `phase` (and `window` or `target_rate`) on each request. Ramps are left out of the tables.
- **Sign-in happens before the test.** `tools/mint-tokens.mjs` signs every runner in with a custom
  token up front, and the test refreshes tokens close to expiry, so Firebase Authentication's
  sign-in quotas are not what gets measured.
- **A full wave is not an error.** A 409 is a correct refusal and is counted as an outcome. A 503
  means the service shed the claim (Firestore contention, deadline or quota) and counts as a failure.
- **Contention is measured, not guessed.** Every claim response carries `X-Txn-Attempts`, the number
  of Firestore transaction attempts it took, and the report shows attempts per claim by level.
- **Percentiles are merged, never averaged.** Each p95 and p99 comes from one log-bucketed histogram
  over every request in the span (1% buckets), so a staging run with millions of requests is read in
  constant memory.

## What the local runs found

These runs use the local profile: the Firebase Emulator Suite on one laptop, at a twentieth of the
staging user counts. The emulators handle concurrent transactions far more slowly than Firestore
does, so the numbers describe the emulators. What they show is the suite finding the weak point and
naming it.

Stepped load, objective p95 under 1.5 s and under 1% failed ([full report](docs/runs/levels-local-2026-11-26/report.md)):

| Runners | Requests/s | p95, all steps | p95, wave list | p95, claim | Failed requests | Objective |
| --- | --- | --- | --- | --- | --- | --- |
| 50 | 112 | 7.0 ms | 4.5 ms | 8.3 ms | 0.00% | met |
| 125 | 179 | 716 ms | 257 ms | 15,971 ms | 1.01% | missed |
| 250 | 204 | 2,664 ms | 2,057 ms | 17,818 ms | 1.35% | missed |
| 500 | 120 | 5,846 ms | 5,562 ms | 21,742 ms | 2.15% | missed |

The claim was the first step to slow down: at 125 runners the wave list p95 was 257 ms while the
claim p95 was 16 s, and every failed request in the run was a claim shed with 503 after its
transaction aborted. Past 250 runners the whole emulator process queued.

To check the counter design on its own, `tools/contention-probe.mjs` fires simultaneous claims at a
single wave through the same claim code and retry limit as the API (5 rounds of 60 claims each):

| Wave counter | Claims | Aborted after 5 attempts | p50 | p95 | Attempts per claim |
| --- | --- | --- | --- | --- | --- |
| One document | 300 | 107 | 11.6 s | 19.4 s | 4.00 |
| 8 bucket documents | 300 | 0 | 3.0 s | 6.3 s | 2.02 |

Every claim on one wave writes the same document when the counter lives on the wave, so claims queue
behind each other. Firestore's documentation names frequent updates to a single document as a cause
of contention and latency, and says the sustainable rate depends on the workload, which is what a
load test is for. Splitting the capacity across bucket documents, each with its own cap, removes
most of the contention and still never oversells the wave.

Spike from 20 to 100 runners in 15 seconds ([full report](docs/runs/spike-local-2026-11-26/report.md)):
p95 went from 7.7 ms at baseline to 8.2 ms during the spike with no failed requests, 11 claims were
shed while the load dropped, and latency was back at baseline as soon as the recovery phase began.

## Running it

Requires Node 24, Java 21 or later for the Firestore emulator, and k6 v2.

```bash
npm install
npm --prefix functions install
npm run emulators                                # Auth, Firestore, Functions; UI on http://127.0.0.1:4000
npm run seed -- --runners 20000 --places 24000   # race, waves, buckets, test runners
npm run tokens -- --runners 20000                # sign every runner in ahead of the test
npm run load -- levels --dashboard               # live charts on http://127.0.0.1:5665
```

Each run writes its own folder under `results/`: the raw k6 output, `summary.json`, `report.md`,
`report.html`, `report.json` and `charts/timeline.svg`. Seed again before every run, because a
runner who already has an entry only checks it. Close the k6 dashboard tab before a run ends: k6
waits for open dashboard connections before it writes the summary. `npm run report -- results/<run>`
rebuilds a report with a different objective (`--slo-p95 800 --slo-error 0.005`).

The other suites run the same way: `npm run load -- spike`, `soak` or `breakpoint`.

### Against a staging project

```bash
node tools/seed.mjs --runners 12000 --places 14400 --project <staging-id> --allow-remote
FIREBASE_API_KEY=<web-api-key> node tools/mint-tokens.mjs --runners 12000 --project <staging-id> --allow-remote
PROFILE=staging \
API_BASE=https://europe-west2-<staging-id>.cloudfunctions.net/api \
FIREBASE_API_KEY=<web-api-key> \
npm run load -- levels
```

The staging profile steps through 1,000, 2,500, 5,000 and 10,000 runners with ten-minute ramps,
which keeps growth near Firestore's 500/50/5 guidance for new traffic. The tools refuse any project
other than the local one unless `--allow-remote` is passed: point them at a staging project, never at
production. At 10,000 runners the load generator needs a large machine of its own (or a distributed
k6 run); the breakpoint report's dropped visits show when the generator, not the service, is the
limit.

## Settings that matter under load

- `functions/src/index.js`: 80 concurrent requests per instance and at most 50 instances, a ceiling
  of about 4,000 requests in flight. Raise `minInstances` before entries open so the first runners do
  not wait on cold starts.
- The wave list is cached for 2 seconds per instance and sent with `Cache-Control: s-maxage=5`, so a
  CDN can absorb the opening burst; without the cache, every page view costs (waves x buckets) reads.
- `firestore.indexes.json` exempts `entries.createdAt` from indexing: a timestamp written at a high
  rate concentrates every index write on one key range.
- Entry documents use the id `<race>_<uid>`, so a retried or double-clicked claim lands on the same
  document instead of creating a second entry.
- `TXN_MAX_ATTEMPTS` (default 5) sets how long a contended claim retries before it is shed with 503.
- `firestore.rules` denies every client write; only the API, running with the Admin SDK, changes
  entries and counters.

## Tests

```bash
npm test                  # 26 unit tests
npm run test:integration  # starts the Firestore emulator, runs the transaction tests, stops it
```

The unit tests cover histogram accuracy (within 1% of exact quantiles on a long-tailed distribution),
span detection, the verdict and recovery rules, Little's law, chart output, load schedules, input
validation and caching. The integration tests race 120 claims for 40 places under both counter
designs and check the wave is never oversold, then send 10 simultaneous claims for one runner and
check exactly one entry is created.

## License

Proprietary, all rights reserved. The repository is public so the code can be read; using, copying
or distributing it needs written permission. See [LICENSE](LICENSE).
