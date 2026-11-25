// Runs real concurrent Firestore transactions against the emulator:
//   npm run test:integration   (starts the Firestore emulator, runs this file, stops it)
// The invariants are the ones a load test must never break: a wave is never oversold, and a
// runner never gets two entries, however many claims arrive at once.

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { after, before, test } from 'node:test';

const skip = !process.env.FIRESTORE_EMULATOR_HOST && 'FIRESTORE_EMULATOR_HOST is not set (run through npm run test:integration)';

// Use the functions package's own firebase-admin, so FieldValue and the Firestore client match.
const requireFromFunctions = createRequire(new URL('../../functions/package.json', import.meta.url));
const { initializeApp, deleteApp } = requireFromFunctions('firebase-admin/app');
const { getFirestore } = requireFromFunctions('firebase-admin/firestore');
const { claimPlace } = await import('../../functions/src/entries.js');

const RUN = `it-${Date.now().toString(36)}`;
let app;
let db;

before(async () => {
  if (skip) return;
  app = initializeApp({ projectId: 'kestrel-bay-entries' }, RUN);
  db = getFirestore(app);
});

after(async () => {
  if (skip) return;
  for (const mode of ['single', 'partitioned']) {
    const raceId = `${RUN}-${mode}`;
    const entries = await db.collection('entries').where('raceId', '==', raceId).get();
    await Promise.all(entries.docs.map((d) => d.ref.delete()));
    await db.recursiveDelete(db.doc(`races/${raceId}`));
  }
  await deleteApp(app);
});

async function seedRace(mode, capacity, buckets) {
  const raceId = `${RUN}-${mode}`;
  const race = { counterMode: mode, bucketsPerWave: buckets };
  const waveRef = db.doc(`races/${raceId}/waves/A`);
  await db.doc(`races/${raceId}`).set(race);
  if (mode === 'partitioned') {
    await waveRef.set({ capacity });
    await Promise.all(
      Array.from({ length: buckets }, (_, b) => waveRef.collection('buckets').doc(String(b)).set({ capacity: capacity / buckets, claimed: 0 })),
    );
  } else {
    await waveRef.set({ capacity, claimed: 0 });
  }
  return { raceId, race, waveRef };
}

async function claimedTotal(mode, waveRef) {
  if (mode === 'single') return (await waveRef.get()).get('claimed');
  const buckets = await waveRef.collection('buckets').get();
  for (const b of buckets.docs) {
    assert.ok(b.get('claimed') <= b.get('capacity'), `bucket ${b.id} oversold`);
  }
  return buckets.docs.reduce((sum, b) => sum + b.get('claimed'), 0);
}

for (const mode of ['single', 'partitioned']) {
  test(`${mode}: 120 runners racing for 40 places never oversell the wave`, { skip }, async () => {
    const { raceId, race, waveRef } = await seedRace(mode, 40, mode === 'partitioned' ? 4 : 1);
    const settled = await Promise.allSettled(
      Array.from({ length: 120 }, (_, i) =>
        claimPlace(db, race, { raceId, uid: `it-runner-${i}`, waveId: 'A', displayName: `Test Runner ${i}` }, { maxAttempts: 25 }),
      ),
    );
    const outcomes = settled.filter((s) => s.status === 'fulfilled').map((s) => s.value.outcome.status);
    const failures = settled.filter((s) => s.status === 'rejected');
    const created = outcomes.filter((s) => s === 'created').length;
    const entries = await db.collection('entries').where('raceId', '==', raceId).count().get();

    assert.ok(created <= 40, `created ${created} > capacity`);
    assert.equal(entries.data().count, created);
    assert.equal(await claimedTotal(mode, waveRef), created);
    // Contention may shed some claims (the API answers those with 503), but none may be lost or doubled.
    assert.equal(created + outcomes.filter((s) => s === 'full').length + failures.length, 120);
    if (failures.length === 0) assert.equal(created, 40);
  });

  test(`${mode}: ten simultaneous claims by one runner create one entry`, { skip }, async () => {
    const raceId = `${RUN}-${mode}`;
    const race = (await db.doc(`races/${raceId}`).get()).data();
    const waveRef = db.doc(`races/${raceId}/waves/A`);
    // Free capacity so this test does not depend on the previous one's leftovers.
    if (mode === 'single') await waveRef.update({ capacity: 1000 });
    else await Promise.all((await waveRef.collection('buckets').get()).docs.map((d) => d.ref.update({ capacity: 1000 })));
    const before = await claimedTotal(mode, waveRef);

    const results = await Promise.all(
      Array.from({ length: 10 }, () => claimPlace(db, race, { raceId, uid: 'it-double-clicker', waveId: 'A', displayName: null }, { maxAttempts: 25 })),
    );
    const statuses = results.map((r) => r.outcome.status);
    assert.equal(statuses.filter((s) => s === 'created').length, 1);
    assert.equal(statuses.filter((s) => s === 'existing').length, 9);
    assert.equal((await claimedTotal(mode, waveRef)) - before, 1);
  });
}
