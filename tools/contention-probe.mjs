#!/usr/bin/env node
// Reproduces the wave-counter hotspot in isolation: fires N simultaneous claims at one wave,
// once with a single counter document and once with the counter split into buckets, using the
// same claimPlace code and transaction retry limit as the entry API. Throwaway races are created
// and deleted, so it can run against a seeded database without touching the real race.
//
//   node tools/contention-probe.mjs --claims 60 --buckets 8 --rounds 5
//
// Rounds alternate the two designs and are pooled, because one burst on the emulator varies a lot.

import { createRequire } from 'node:module';
import { resolveTarget } from './target.mjs';

const target = resolveTarget(process.argv.slice(2), {
  claims: { type: 'string', default: '60' },
  buckets: { type: 'string', default: '8' },
  'max-attempts': { type: 'string', default: '5' },
  rounds: { type: 'string', default: '5' },
});
const claims = Number(target.values.claims);
const buckets = Number(target.values.buckets);
const maxAttempts = Number(target.values['max-attempts']);
const rounds = Number(target.values.rounds);

// The functions package's own firebase-admin, so FieldValue and the Firestore client match.
const requireFromFunctions = createRequire(new URL('../functions/package.json', import.meta.url));
const { initializeApp } = requireFromFunctions('firebase-admin/app');
const { getFirestore } = requireFromFunctions('firebase-admin/firestore');
const { claimPlace } = await import('../functions/src/entries.js');

const db = getFirestore(initializeApp({ projectId: target.projectId }, 'contention-probe'));
const pooled = { single: [], partitioned: [] };
for (let round = 0; round < rounds; round += 1) {
  for (const mode of ['single', 'partitioned']) {
    pooled[mode].push(await probe(mode));
  }
}
console.table(Object.entries(pooled).map(([mode, results]) => summarize(mode, results)));
process.exit(0);

function summarize(mode, results) {
  const latencies = results.flatMap((r) => r.latencies).sort((a, b) => a - b);
  const attempts = results.flatMap((r) => r.attempts);
  const pick = (q) => latencies[Math.min(latencies.length - 1, Math.ceil(q * latencies.length) - 1)];
  const walls = results.map((r) => r.wallMs).sort((a, b) => a - b);
  return {
    counter: mode === 'partitioned' ? `${buckets} buckets` : 'single document',
    rounds: results.length,
    claims: latencies.length,
    created: results.reduce((sum, r) => sum + r.created, 0),
    aborted: results.reduce((sum, r) => sum + r.aborted, 0),
    'p50 ms': pick(0.5),
    'p95 ms': pick(0.95),
    'burst wall ms (median)': walls[Math.floor(walls.length / 2)],
    'attempts (mean)': Number((attempts.reduce((a, b) => a + b, 0) / attempts.length).toFixed(2)),
  };
}

async function probe(mode) {
  const raceId = `probe-${mode}-${Date.now().toString(36)}`;
  const bucketCount = mode === 'partitioned' ? buckets : 1;
  const capacity = claims * 2;
  const waveRef = db.doc(`races/${raceId}/waves/A`);
  await db.doc(`races/${raceId}`).set({ counterMode: mode, bucketsPerWave: bucketCount });
  if (mode === 'partitioned') {
    await waveRef.set({ capacity });
    await Promise.all(
      Array.from({ length: bucketCount }, (_, b) => waveRef.collection('buckets').doc(String(b)).set({ capacity: Math.ceil(capacity / bucketCount), claimed: 0 })),
    );
  } else {
    await waveRef.set({ capacity, claimed: 0 });
  }

  const race = { counterMode: mode, bucketsPerWave: bucketCount };
  const latencies = [];
  const attempts = [];
  let aborted = 0;
  const started = Date.now();
  await Promise.all(
    Array.from({ length: claims }, async (_, i) => {
      const t = Date.now();
      try {
        const result = await claimPlace(db, race, { raceId, uid: `probe-runner-${i}`, waveId: 'A', displayName: null }, { maxAttempts });
        attempts.push(result.attempts);
      } catch (err) {
        // gRPC 10 (ABORTED) after the last attempt is what the API turns into a 503.
        if (err?.code !== 10) throw err;
        aborted += 1;
        attempts.push(err.txnAttempts ?? maxAttempts);
      }
      latencies.push(Date.now() - t);
    }),
  );
  const wallMs = Date.now() - started;

  const entries = await db.collection('entries').where('raceId', '==', raceId).get();
  await Promise.all(entries.docs.map((d) => d.ref.delete()));
  await db.recursiveDelete(db.doc(`races/${raceId}`));

  return { latencies, attempts, aborted, created: entries.size, wallMs };
}
