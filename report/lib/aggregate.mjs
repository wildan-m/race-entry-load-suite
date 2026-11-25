import { LogHistogram } from './histogram.mjs';

// The tags each suite is broken down by. The scenario scripts stamp them on every request.
export const GROUP_TAGS = {
  levels: ['level', 'phase'],
  spike: ['phase'],
  soak: ['window'],
  breakpoint: ['target_rate'],
};

export const COUNTERS = ['entries_created', 'entries_existing', 'wave_full', 'wave_fallback', 'claims_shed', 'token_refreshes'];

/**
 * Folds k6 JSON output points into a per-second timeline and per-group statistics.
 * Everything is streamed: memory grows with test duration and tag combinations, not with
 * the number of requests.
 */
export function createAggregator() {
  let suite = null;
  let firstMs = Infinity;
  let lastMs = -Infinity;
  /** @type {Map<number, ReturnType<typeof newSecond>>} */
  const seconds = new Map();
  /** @type {Map<string, ReturnType<typeof newGroup>>} */
  const groups = new Map();

  const secondAt = (sec) => {
    let s = seconds.get(sec);
    if (!s) {
      s = newSecond();
      seconds.set(sec, s);
    }
    return s;
  };

  const groupFor = (tags) => {
    const names = GROUP_TAGS[suite] ?? [];
    if (names.length === 0) return null;
    const values = names.map((name) => tags[name]);
    if (values.some((v) => v === undefined)) return null;
    const key = values.join('|');
    let g = groups.get(key);
    if (!g) {
      g = newGroup(Object.fromEntries(names.map((name, i) => [name, values[i]])));
      groups.set(key, g);
    }
    return g;
  };

  return {
    /** @param {{type: string, metric: string, data: {time: string, value: number, tags?: Record<string, string>}}} entry */
    add(entry) {
      if (entry.type !== 'Point') return;
      const { metric, data } = entry;
      const tags = data.tags ?? {};
      // Preflight and setup traffic is not part of the load.
      if (tags.step === 'preflight' || tags.group === '::setup' || tags.group === '::teardown') return;
      suite ??= tags.suite ?? null;

      const ms = Date.parse(data.time);
      const s = secondAt(Math.floor(ms / 1000));
      const value = data.value;
      if (ms < firstMs) firstMs = ms;
      if (ms > lastMs) lastMs = ms;

      if (metric === 'vus') {
        s.vus = Math.max(s.vus ?? 0, value);
        return;
      }
      if (metric === 'dropped_iterations') {
        s.dropped += value;
        return;
      }

      const g = groupFor(tags);
      switch (metric) {
        case 'http_reqs':
          s.reqs += value;
          if (g) {
            g.reqs += value;
            const sec = Math.floor(ms / 1000);
            g.perSecond.set(sec, (g.perSecond.get(sec) ?? 0) + value);
          }
          break;
        case 'http_req_failed':
          s.failed += value;
          if (g) {
            g.failed += value;
            stepOf(g, tags.step).failed += value;
          }
          break;
        case 'http_req_duration':
          s.duration.add(value);
          if (g) {
            g.duration.add(value);
            const step = stepOf(g, tags.step);
            step.count += 1;
            step.duration.add(value);
          }
          break;
        case 'iterations':
          s.visits += value;
          if (g) g.visits += value;
          break;
        case 'visit_failed':
          if (g) g.visitsFailed += value;
          break;
        case 'visit_duration':
          if (g) g.visitDuration.add(value);
          break;
        case 'txn_attempts':
          if (g) g.txnAttempts.add(value);
          break;
        default:
          if (g && COUNTERS.includes(metric)) g.counters[metric] += value;
      }
    },

    result() {
      return summarize({ suite, firstMs, lastMs, seconds, groups });
    },
  };
}

function newSecond() {
  return { vus: null, reqs: 0, failed: 0, visits: 0, dropped: 0, duration: new LogHistogram() };
}

function newGroup(tags) {
  return {
    tags,
    /** @type {Map<number, number>} requests completed per second */
    perSecond: new Map(),
    reqs: 0,
    failed: 0,
    visits: 0,
    visitsFailed: 0,
    duration: new LogHistogram(),
    visitDuration: new LogHistogram(),
    txnAttempts: new LogHistogram({ precision: 0.01, floor: 0.5 }),
    /** @type {Map<string, {count: number, failed: number, duration: LogHistogram}>} */
    steps: new Map(),
    counters: Object.fromEntries(COUNTERS.map((name) => [name, 0])),
  };
}

function stepOf(group, step = 'other') {
  let s = group.steps.get(step);
  if (!s) {
    s = { count: 0, failed: 0, duration: new LogHistogram() };
    group.steps.set(step, s);
  }
  return s;
}

/**
 * The seconds a group was really running. A request is tagged with the phase it started in but
 * lands when it finishes, so a slow request can arrive well into the next phase; seconds with
 * under a tenth of the group's typical traffic at either end are those stragglers, not the span.
 * @param {Map<number, number>} perSecond
 */
export function activeSpan(perSecond) {
  const secs = [...perSecond.keys()].sort((a, b) => a - b);
  const counts = secs.map((s) => perSecond.get(s));
  const typical = median(counts) ?? 0;
  const busy = (i) => counts[i] >= typical * 0.1;
  let first = 0;
  let last = secs.length - 1;
  while (first < last && !busy(first)) first += 1;
  while (last > first && !busy(last)) last -= 1;
  let requests = 0;
  for (let i = first; i <= last; i += 1) requests += counts[i];
  return { from: secs[first], to: secs[last], requests };
}

function latency(h) {
  return { p50: h.quantile(0.5), p95: h.quantile(0.95), p99: h.quantile(0.99), max: h.count ? h.max : null, mean: h.mean, count: h.count };
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function summarize({ suite, firstMs, lastMs, seconds, groups }) {
  const secs = [...seconds.keys()].sort((a, b) => a - b);
  const t0 = secs[0] ?? 0;

  // k6 emits the VU gauge about once a second; carry the last value over seconds it skipped.
  let lastVus = 0;
  const timeline = secs.map((sec) => {
    const s = seconds.get(sec);
    if (s.vus !== null) lastVus = s.vus;
    return {
      t: sec - t0,
      vus: lastVus,
      rps: s.reqs,
      p95: s.duration.quantile(0.95),
      errorRate: s.reqs > 0 ? s.failed / s.reqs : null,
      visits: s.visits,
      dropped: s.dropped,
    };
  });

  const groupResults = [...groups.values()]
    .filter((g) => g.reqs > 0)
    .map((g) => {
      const span = activeSpan(g.perSecond);
      const startSec = span.from - t0;
      const endSec = span.to + 1 - t0;
      const windowSeconds = Math.max(1, endSec - startSec);
      const inWindow = timeline.filter((p) => p.t >= startSec && p.t < endSec);
      return {
        tags: g.tags,
        startSec,
        endSec,
        requests: g.reqs,
        failed: g.failed,
        errorRate: g.failed / g.reqs,
        rps: span.requests / windowSeconds,
        visits: g.visits,
        visitsPerSec: (g.visits * (span.requests / g.reqs)) / windowSeconds,
        visitFailedRate: g.visits > 0 ? g.visitsFailed / g.visits : null,
        vus: { median: median(inWindow.map((p) => p.vus)), max: inWindow.length ? Math.max(...inWindow.map((p) => p.vus)) : null },
        dropped: inWindow.reduce((sum, p) => sum + p.dropped, 0),
        latency: latency(g.duration),
        visitDuration: latency(g.visitDuration),
        txnAttempts: latency(g.txnAttempts),
        steps: Object.fromEntries(
          [...g.steps.entries()].map(([name, s]) => [name, { ...latency(s.duration), errorRate: s.count ? s.failed / s.count : null }]),
        ),
        counters: g.counters,
      };
    });

  return {
    suite,
    startedAt: Number.isFinite(firstMs) ? new Date(firstMs).toISOString() : null,
    endedAt: Number.isFinite(lastMs) ? new Date(lastMs).toISOString() : null,
    durationSeconds: Number.isFinite(firstMs) ? (lastMs - firstMs) / 1000 : 0,
    timeline,
    groups: groupResults,
    /**
     * p95 and error rate over a trailing window ending at each second, merged from the
     * per-second histograms (never by averaging per-second percentiles).
     * @param {number} windowSeconds
     */
    rolling(windowSeconds) {
      return secs.map((sec, i) => {
        const merged = new LogHistogram();
        let reqs = 0;
        let failed = 0;
        for (let j = i; j >= 0 && secs[j] > sec - windowSeconds; j -= 1) {
          const s = seconds.get(secs[j]);
          merged.merge(s.duration);
          reqs += s.reqs;
          failed += s.failed;
        }
        return { t: sec - t0, p95: merged.quantile(0.95), errorRate: reqs > 0 ? failed / reqs : null, requests: reqs };
      });
    },
  };
}
