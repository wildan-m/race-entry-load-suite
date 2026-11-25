import { HttpError } from './errors.js';

export const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Validates a path or body identifier before it reaches a Firestore path.
 * @param {unknown} value
 * @param {string} code Error code to return when the value is not a usable id.
 * @returns {string}
 */
export function requireId(value, code) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new HttpError(400, code);
  }
  return value;
}

/**
 * Reads a race, its waves and how many places each wave has left.
 * In partitioned mode the remaining count is the sum over the wave's capacity buckets.
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} raceId
 */
export async function readRaceView(db, raceId) {
  const raceRef = db.doc(`races/${raceId}`);
  const [raceSnap, wavesSnap] = await Promise.all([
    raceRef.get(),
    raceRef.collection('waves').orderBy('startTime').get(),
  ]);
  if (!raceSnap.exists) {
    throw new HttpError(404, 'unknown_race');
  }
  const race = raceSnap.data();
  const partitioned = race.counterMode === 'partitioned';

  let claimedByWave = new Map();
  if (partitioned) {
    const bucketRefs = wavesSnap.docs.flatMap((wave) =>
      bucketIndexes(race.bucketsPerWave).map((i) => wave.ref.collection('buckets').doc(String(i))),
    );
    const buckets = bucketRefs.length > 0 ? await db.getAll(...bucketRefs) : [];
    claimedByWave = buckets.reduce((acc, bucket) => {
      const waveId = bucket.ref.parent.parent.id;
      acc.set(waveId, (acc.get(waveId) ?? 0) + (bucket.get('claimed') ?? 0));
      return acc;
    }, new Map());
  }

  return {
    race: {
      id: raceSnap.id,
      name: race.name,
      startsAt: race.startsAt,
      entryOpensAt: race.entryOpensAt,
    },
    waves: wavesSnap.docs.map((wave) => {
      const { label, startTime, capacity } = wave.data();
      const claimed = partitioned ? (claimedByWave.get(wave.id) ?? 0) : (wave.get('claimed') ?? 0);
      return { id: wave.id, label, startTime, capacity, remaining: Math.max(0, capacity - claimed) };
    }),
  };
}

/**
 * @param {number} count
 * @returns {number[]}
 */
export function bucketIndexes(count) {
  return Array.from({ length: count }, (_, i) => i);
}

/**
 * Reads the race settings a claim needs (counter mode and bucket count).
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} raceId
 */
export async function readRaceSettings(db, raceId) {
  const snap = await db.doc(`races/${raceId}`).get();
  if (!snap.exists) {
    throw new HttpError(404, 'unknown_race');
  }
  const { counterMode = 'single', bucketsPerWave = 1 } = snap.data();
  return { counterMode, bucketsPerWave };
}

/**
 * Per-instance cache keyed by id. Every runner opens the wave list first, so without it the
 * listing alone costs (waves x buckets) document reads per page view.
 * @template T
 * @param {(key: string) => Promise<T>} load
 * @param {{ttlMs: number, now?: () => number}} options
 * @returns {(key: string) => Promise<T>}
 */
export function ttlCache(load, { ttlMs, now = Date.now }) {
  /** @type {Map<string, {expiresAt: number, value: Promise<T>}>} */
  const cache = new Map();
  return async (key) => {
    const hit = cache.get(key);
    if (hit && hit.expiresAt > now()) {
      return hit.value;
    }
    // Store the promise, so concurrent misses on one instance share a single read.
    const value = load(key);
    cache.set(key, { expiresAt: now() + ttlMs, value });
    try {
      return await value;
    } catch (err) {
      cache.delete(key);
      throw err;
    }
  };
}
