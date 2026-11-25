import assert from 'node:assert/strict';
import { test } from 'node:test';
import { downsample, niceTicks, renderTimeline } from '../report/lib/charts.mjs';
import { pickWeighted, preferenceOrder, WAVE_DEMAND } from '../load/lib/choices.js';
import { buildSchedule, segmentAt, spike, staircase } from '../load/lib/schedule.js';

test('staircase ramps and holds each level, then ramps down, with stages k6 can run', () => {
  const plan = staircase([1000, 2500], 600, 600);
  assert.deepEqual(
    plan.segments.map((s) => [s.phase, s.level, s.start, s.end]),
    [
      ['ramp', 1000, 0, 600],
      ['hold', 1000, 600, 1200],
      ['ramp', 2500, 1200, 1800],
      ['hold', 2500, 1800, 2400],
      ['ramp_down', 0, 2400, 2430],
    ],
  );
  assert.deepEqual(plan.stages[1], { duration: '600s', target: 1000 });
  assert.equal(plan.totalSeconds, 2430);
});

test('segmentAt finds the segment for any elapsed time and clamps past the end', () => {
  const { segments } = buildSchedule([
    { phase: 'a', seconds: 10, target: 1 },
    { phase: 'b', seconds: 5, target: 2 },
  ]);
  assert.equal(segmentAt(segments, 0).phase, 'a');
  assert.equal(segmentAt(segments, 9.99).phase, 'a');
  assert.equal(segmentAt(segments, 10).phase, 'b');
  assert.equal(segmentAt(segments, 99).phase, 'b');
});

test('spike keeps the same baseline before and after the peak', () => {
  const plan = spike(1000);
  const byPhase = Object.fromEntries(plan.segments.map((s) => [s.phase, s.target]));
  assert.equal(byPhase.baseline, 200);
  assert.equal(byPhase.recovery, 200);
  assert.equal(byPhase.spike_hold, 1000);
});

test('preferenceOrder never offers a wave the listing shows as full', () => {
  const waves = [
    { id: 'A', remaining: 0 },
    { id: 'B', remaining: 3 },
    { id: 'C', remaining: 9 },
  ];
  for (const roll of [0, 0.3, 0.6, 0.99]) {
    const order = preferenceOrder(waves, () => roll);
    assert.ok(!order.includes('A'));
    assert.deepEqual([...order].sort(), ['B', 'C']);
  }
  assert.deepEqual(preferenceOrder([{ id: 'A', remaining: 0 }]), []);
});

test('pickWeighted follows the weights', () => {
  assert.equal(pickWeighted(WAVE_DEMAND, () => 0), 'A');
  assert.equal(pickWeighted(WAVE_DEMAND, () => 0.999), 'F');
  // A has 30 of 100: rolls below 0.3 pick A, the next 25 pick B.
  assert.equal(pickWeighted(WAVE_DEMAND, () => 0.29), 'A');
  assert.equal(pickWeighted(WAVE_DEMAND, () => 0.31), 'B');
});

test('niceTicks starts at zero and covers the maximum in clean steps', () => {
  assert.deepEqual(niceTicks(100), [0, 50, 100]);
  assert.deepEqual(niceTicks(230), [0, 100, 200, 300]);
  assert.deepEqual(niceTicks(0.01), [0, 0.005, 0.01]);
  const t = niceTicks(9_700);
  assert.equal(t[0], 0);
  assert.ok(t[t.length - 1] >= 9_700);
});

test('downsample keeps peaks for users and latency', () => {
  const timeline = Array.from({ length: 2000 }, (_, t) => ({ t, vus: t === 1234 ? 999 : 10, rps: 5, p95: t === 777 ? 4000 : 50, errorRate: 0 }));
  const small = downsample(timeline, 500);
  assert.ok(small.length <= 500);
  assert.equal(Math.max(...small.map((p) => p.vus)), 999);
  assert.equal(Math.max(...small.map((p) => p.p95)), 4000);
});

test('renderTimeline draws one path per panel, breaks lines at gaps, and never emits NaN', () => {
  const timeline = Array.from({ length: 60 }, (_, t) => ({ t, vus: t, rps: t * 2, p95: t === 30 ? null : 20, errorRate: 0 }));
  const svg = renderTimeline(timeline, { title: 'Run <1>', bands: [{ from: 10, to: 20, label: '10 users' }] });
  assert.ok(svg.startsWith('<svg'));
  assert.ok(!svg.includes('NaN'));
  assert.ok(svg.includes('Run &lt;1&gt;'));
  // vus area + vus line + rps line + two p95 segments around the gap + error line.
  assert.equal((svg.match(/class="line"/g) ?? []).length, 5);
});
