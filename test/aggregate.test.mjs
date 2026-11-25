import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activeSpan, createAggregator } from '../report/lib/aggregate.mjs';
import { analyzeBreakpoint, analyzeLevels, analyzeSpike } from '../report/lib/analyze.mjs';

const T0 = Date.parse('2026-11-26T05:00:00.000Z');

function point(metric, second, value, tags) {
  return { type: 'Point', metric, data: { time: new Date(T0 + second * 1000 + 100).toISOString(), value, tags } };
}

/** One request with its duration, failure flag and the tags the scenario scripts stamp. */
function request(agg, second, duration, { failed = 0, step = 'list_waves', ...tags }) {
  const t = { suite: 'levels', step, ...tags };
  agg.add(point('http_reqs', second, 1, t));
  agg.add(point('http_req_duration', second, duration, t));
  agg.add(point('http_req_failed', second, failed, t));
}

test('levels: hold spans are summarised per level, ramps are left out, and the verdict finds the first level over the objective', () => {
  const agg = createAggregator();
  // Ramp 0-9 s, hold at 10 users 10-29 s, ramp 30-39 s, hold at 20 users 40-59 s.
  for (let s = 0; s < 60; s += 1) {
    const level = s < 30 ? '10' : '20';
    const phase = s < 10 || (s >= 30 && s < 40) ? 'ramp' : 'hold';
    agg.add(point('vus', s, level === '10' ? 10 : 20, { suite: 'levels' }));
    for (let i = 0; i < (level === '10' ? 5 : 10); i += 1) {
      // The 20-user level is slow and fails 1 request in 10.
      const slow = level === '20';
      request(agg, s, slow ? 2000 + i : 100 + i, { level, phase, failed: slow && i === 0 ? 1 : 0, step: i % 2 ? 'get_entry' : 'create_entry' });
    }
    agg.add(point('iterations', s, 1, { suite: 'levels', level, phase }));
  }
  const run = agg.result();
  assert.equal(run.suite, 'levels');
  const a = analyzeLevels(run, { p95Ms: 1500, errorRate: 0.01 });
  assert.deepEqual(a.rows.map((r) => r.users), [10, 20]);
  const [low, high] = a.rows;
  assert.equal(low.requests, 100);
  assert.equal(low.errorRate, 0);
  assert.ok(low.latency.p95 >= 103 && low.latency.p95 <= 105);
  assert.equal(low.vus.median, 10);
  assert.ok(Math.abs(low.rps - 100 / 19) < 0.5, `rps ${low.rps}`);
  assert.equal(high.errorRate, 0.1);
  assert.equal(a.stableThrough, 10);
  assert.equal(a.firstFailing.users, 20);
  assert.ok(high.steps.create_entry.p95 > 1900);
});

test('preflight and setup points are not counted as load', () => {
  const agg = createAggregator();
  agg.add(point('http_reqs', 0, 1, { suite: 'levels', step: 'preflight', group: '::setup' }));
  request(agg, 1, 50, { level: '5', phase: 'hold' });
  const run = agg.result();
  assert.equal(run.groups.length, 1);
  assert.equal(run.groups[0].requests, 1);
});

test('spike: recovery time is measured from the start of the recovery phase on a trailing window', () => {
  const agg = createAggregator();
  const phaseAt = (s) => (s < 30 ? 'baseline' : s < 40 ? 'spike_hold' : 'recovery');
  for (let s = 0; s < 80; s += 1) {
    const phase = phaseAt(s);
    // Latency stays high for the first 15 s of recovery, then returns to the baseline.
    const latency = phase === 'baseline' ? 100 : phase === 'spike_hold' ? 3000 : s < 55 ? 2500 : 100;
    for (let i = 0; i < 20; i += 1) {
      const t = { suite: 'spike', phase, step: 'list_waves' };
      agg.add(point('http_reqs', s, 1, t));
      agg.add(point('http_req_duration', s, latency, t));
      agg.add(point('http_req_failed', s, 0, t));
    }
  }
  const a = analyzeSpike(agg.result(), { p95Ms: 1500, errorRate: 0.01 });
  // Slow seconds end at 54; a 10 s trailing window is clean from second 64, 24 s into recovery.
  assert.ok(a.recoverySeconds >= 23 && a.recoverySeconds <= 25, `recovery ${a.recoverySeconds}`);
  assert.ok(a.spikeHold.latency.p95 > 2900);
});

test('spike: a run that never settles reports no recovery time', () => {
  const agg = createAggregator();
  for (let s = 0; s < 40; s += 1) {
    const phase = s < 20 ? 'baseline' : 'recovery';
    const t = { suite: 'spike', phase, step: 'list_waves' };
    agg.add(point('http_reqs', s, 1, t));
    agg.add(point('http_req_duration', s, phase === 'baseline' ? 100 : 900, t));
    agg.add(point('http_req_failed', s, 0, t));
  }
  assert.equal(analyzeSpike(agg.result(), { p95Ms: 1500, errorRate: 0.01 }).recoverySeconds, null);
});

test('breakpoint: rates are ordered numerically, the breaking rate is found, and dropped visits are totalled', () => {
  const agg = createAggregator();
  for (let s = 0; s < 30; s += 1) {
    const rate = String(5 * (Math.floor(s / 10) + 1)); // 5, 10, 15 visits/s
    const latency = rate === '15' ? 4000 : 200;
    const t = { suite: 'breakpoint', target_rate: rate, step: 'create_entry' };
    for (let i = 0; i < Number(rate); i += 1) {
      agg.add(point('http_reqs', s, 1, t));
      agg.add(point('http_req_duration', s, latency, t));
      agg.add(point('http_req_failed', s, 0, t));
      agg.add(point('iterations', s, 1, t));
      agg.add(point('visit_duration', s, 2000, t));
    }
    if (rate === '15') agg.add(point('dropped_iterations', s, 2, { suite: 'breakpoint' }));
  }
  const a = analyzeBreakpoint(agg.result(), { p95Ms: 1500, errorRate: 0.01 });
  assert.deepEqual(a.rows.map((r) => r.targetRate), [5, 10, 15]);
  assert.equal(a.breaking.targetRate, 15);
  assert.equal(a.lastGood.targetRate, 10);
  assert.equal(a.dropped, 20);
  // Little's law: about 10 visits/s x 2 s per visit = 20 concurrent visits.
  assert.ok(Math.abs(a.rows[1].expectedConcurrency - 20) < 3, `little ${a.rows[1].expectedConcurrency}`);
});

test('activeSpan drops straggler seconds at either end of a phase', () => {
  // 100 requests a second for seconds 10-19, then a slow claim landing at second 35.
  const perSecond = new Map([[8, 2], ...Array.from({ length: 10 }, (_, i) => [10 + i, 100]), [35, 1]]);
  assert.deepEqual(activeSpan(perSecond), { from: 10, to: 19, requests: 1000 });
});
