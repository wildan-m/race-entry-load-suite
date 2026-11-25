import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LogHistogram } from '../report/lib/histogram.mjs';

// Deterministic pseudo-random source, so a failure reproduces.
function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function exactQuantile(sorted, q) {
  return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)];
}

test('quantiles stay within 1% of the exact nearest-rank value on a long-tailed distribution', () => {
  const random = lcg(42);
  const h = new LogHistogram();
  const values = [];
  for (let i = 0; i < 50_000; i += 1) {
    // Log-normal-ish latencies between roughly 2 ms and 4 s.
    const v = Math.exp(1.5 + 2.2 * (random() + random() + random() - 1.5));
    values.push(v);
    h.add(v);
  }
  values.sort((a, b) => a - b);
  for (const q of [0.5, 0.9, 0.95, 0.99, 0.999]) {
    const exact = exactQuantile(values, q);
    const estimate = h.quantile(q);
    assert.ok(Math.abs(estimate - exact) / exact < 0.01, `q=${q}: ${estimate} vs ${exact}`);
  }
});

test('p0 and p100 are the true minimum and maximum', () => {
  const h = new LogHistogram();
  [12.5, 3.25, 870, 41].forEach((v) => h.add(v));
  assert.equal(h.quantile(0), 3.25);
  assert.equal(h.quantile(1), 870);
  assert.equal(h.count, 4);
  assert.equal(h.mean, (12.5 + 3.25 + 870 + 41) / 4);
});

test('merging two histograms equals adding every value to one', () => {
  const random = lcg(7);
  const a = new LogHistogram();
  const b = new LogHistogram();
  const all = new LogHistogram();
  for (let i = 0; i < 5000; i += 1) {
    const v = random() * 500;
    (i % 2 ? a : b).add(v);
    all.add(v);
  }
  a.merge(b);
  for (const q of [0.5, 0.95, 0.99]) assert.equal(a.quantile(q), all.quantile(q));
  assert.equal(a.count, all.count);
});

test('an empty histogram has no quantiles, and invalid values are ignored', () => {
  const h = new LogHistogram();
  assert.equal(h.quantile(0.95), null);
  assert.equal(h.mean, null);
  h.add(Number.NaN);
  h.add(-1);
  assert.equal(h.count, 0);
});

test('values below the floor and identical values are reported exactly', () => {
  const h = new LogHistogram();
  for (let i = 0; i < 10; i += 1) h.add(1);
  assert.equal(h.quantile(0.95), 1);
  const tiny = new LogHistogram();
  tiny.add(0);
  tiny.add(0.001);
  assert.equal(tiny.quantile(0.5), 0.001);
});
