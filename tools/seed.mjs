#!/usr/bin/env node
// Seeds the race, its waves and the test runners, and clears every entry from earlier runs, so
// each load test starts from the same state.
//
//   node tools/seed.mjs --runners 600            local emulators (default)
//   node tools/seed.mjs --runners 12000 --places 14400 --project <staging-id> --allow-remote

import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { RACE_NAME, RACES, runnerIdentity, splitByShare, WAVES } from './race-data.mjs';
import { resolveTarget } from './target.mjs';

const target = resolveTarget(process.argv.slice(2), {
  runners: { type: 'string', default: '600' },
  places: { type: 'string' },
});

const runners = Number(target.values.runners);
// More places than runners overall, so the race never sells out; wave A still does.
const places = Number(target.values.places ?? Math.round(runners * 1.2));
if (!Number.isInteger(runners) || runners < 1 || !Number.isInteger(places) || places < WAVES.length) {
  throw new Error('--runners and --places must be positive integers');
}

initializeApp({ projectId: target.projectId });
const db = getFirestore();
const auth = getAuth();

await clearEntries();
const layout = await writeRaces();
const created = await writeRunners();

console.log(
  JSON.stringify(
    { projectId: target.projectId, remote: target.remote, races: RACES.map((r) => r.id), places, runners: created, waves: layout },
    null,
    2,
  ),
);

async function clearEntries() {
  const writer = db.bulkWriter();
  for (const race of RACES) {
    const entries = await db.collection('entries').where('raceId', '==', race.id).select().get();
    entries.docs.forEach((doc) => writer.delete(doc.ref));
    await db.recursiveDelete(db.doc(`races/${race.id}`), writer);
  }
  await writer.close();
}

async function writeRaces() {
  const capacities = splitByShare(places, WAVES.map((w) => w.share));
  const batch = db.batch();
  for (const race of RACES) {
    const raceRef = db.doc(`races/${race.id}`);
    batch.set(raceRef, {
      name: RACE_NAME,
      startsAt: '2027-04-18T08:00:00+01:00',
      entryOpensAt: '2026-12-01T09:00:00Z',
      counterMode: race.counterMode,
      bucketsPerWave: race.bucketsPerWave,
    });
    WAVES.forEach((wave, i) => {
      const waveRef = raceRef.collection('waves').doc(wave.id);
      const capacity = capacities[i];
      if (race.counterMode === 'partitioned') {
        batch.set(waveRef, { label: wave.label, startTime: wave.startTime, capacity });
        const perBucket = splitByShare(capacity, Array(race.bucketsPerWave).fill(1 / race.bucketsPerWave));
        perBucket.forEach((bucketCapacity, b) => {
          batch.set(waveRef.collection('buckets').doc(String(b)), { capacity: bucketCapacity, claimed: 0 });
        });
      } else {
        batch.set(waveRef, { label: wave.label, startTime: wave.startTime, capacity, claimed: 0 });
      }
    });
  }
  await batch.commit();
  return WAVES.map((wave, i) => ({ id: wave.id, capacity: capacities[i] }));
}

async function writeRunners() {
  if (!target.remote) {
    // The Auth emulator has a reset endpoint; it keeps repeated seeds from colliding on uids.
    const res = await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/emulator/v1/projects/${target.projectId}/accounts`, {
      method: 'DELETE',
    });
    if (!res.ok) throw new Error(`Auth emulator reset failed: ${res.status}`);
  }
  let created = 0;
  for (let start = 1; start <= runners; start += 1000) {
    const users = [];
    for (let n = start; n < Math.min(start + 1000, runners + 1); n += 1) {
      users.push({ ...runnerIdentity(n), emailVerified: true });
    }
    const result = await auth.importUsers(users);
    // On a real project, runners left from an earlier seed come back as uid-exists errors.
    const unexpected = result.errors.filter((e) => e.error.code !== 'auth/uid-already-exists');
    if (unexpected.length > 0) {
      throw new Error(`importUsers failed for ${unexpected.length} runners: ${unexpected[0].error.message}`);
    }
    created += users.length;
  }
  return created;
}
