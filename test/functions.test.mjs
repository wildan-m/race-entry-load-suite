import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FullBucketMemo, shuffle } from '../functions/src/entries.js';
import { HttpError, toResponse } from '../functions/src/errors.js';
import { requireId, ttlCache } from '../functions/src/races.js';
import { splitByShare } from '../tools/race-data.mjs';

test('toResponse maps Firestore overload codes to 503 with Retry-After and hides unknown errors', () => {
  assert.deepEqual(toResponse(new HttpError(409, 'wave_full')), { status: 409, body: { error: 'wave_full' }, headers: {}, unexpected: false });
  const contention = toResponse(Object.assign(new Error('aborted'), { code: 10 }));
  assert.equal(contention.status, 503);
  assert.equal(contention.body.error, 'contention');
  assert.equal(contention.headers['Retry-After'], '1');
  assert.equal(toResponse(Object.assign(new Error('x'), { code: 8 })).body.error, 'resource_exhausted');
  const unknown = toResponse(new Error('database password is hunter2'));
  assert.deepEqual(unknown.body, { error: 'internal' });
  assert.equal(unknown.unexpected, true);
});

test('requireId rejects path tricks and oversize ids before they reach a Firestore path', () => {
  assert.equal(requireId('kbhm-2027', 'invalid_race'), 'kbhm-2027');
  for (const bad of ['../races', 'a/b', '', 'x'.repeat(65), 42, null, undefined]) {
    assert.throws(() => requireId(bad, 'invalid_race'), (err) => err instanceof HttpError && err.status === 400);
  }
});

test('ttlCache shares one in-flight load between concurrent callers and expires after the TTL', async () => {
  let now = 0;
  let loads = 0;
  const cached = ttlCache(
    async (key) => {
      loads += 1;
      return `${key}-${loads}`;
    },
    { ttlMs: 1000, now: () => now },
  );
  const [a, b] = await Promise.all([cached('race'), cached('race')]);
  assert.equal(a, 'race-1');
  assert.equal(b, 'race-1');
  now = 999;
  assert.equal(await cached('race'), 'race-1');
  now = 1001;
  assert.equal(await cached('race'), 'race-2');
});

test('ttlCache does not keep a failed load', async () => {
  let calls = 0;
  const cached = ttlCache(
    async () => {
      calls += 1;
      if (calls === 1) throw new Error('unavailable');
      return 'ok';
    },
    { ttlMs: 60_000 },
  );
  await assert.rejects(cached('race'));
  assert.equal(await cached('race'), 'ok');
});

test('FullBucketMemo forgets a full bucket after its TTL, so a reset is picked up', () => {
  let now = 0;
  const memo = new FullBucketMemo({ ttlMs: 100, now: () => now });
  memo.add('kbhm/A', 3);
  assert.equal(memo.has('kbhm/A', 3), true);
  assert.equal(memo.has('kbhm/A', 4), false);
  now = 100;
  assert.equal(memo.has('kbhm/A', 3), false);
});

test('shuffle is a permutation', () => {
  const items = [0, 1, 2, 3, 4, 5, 6, 7];
  let seed = 1;
  const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  const out = shuffle(items, random);
  assert.deepEqual([...out].sort(), items);
  assert.deepEqual(items, [0, 1, 2, 3, 4, 5, 6, 7]);
});

test('splitByShare always adds up to the total', () => {
  assert.deepEqual(splitByShare(720, [0.15, 0.2, 0.2, 0.2, 0.15, 0.1]), [108, 144, 144, 144, 108, 72]);
  for (const total of [1, 7, 101, 999, 24_000]) {
    const parts = splitByShare(total, Array(8).fill(1 / 8));
    assert.equal(parts.reduce((a, b) => a + b, 0), total);
    assert.ok(Math.max(...parts) - Math.min(...parts) <= 1);
  }
});
