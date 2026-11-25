import { FieldValue } from 'firebase-admin/firestore';
import { HttpError } from './errors.js';
import { bucketIndexes } from './races.js';

/**
 * @typedef {{raceId: string, uid: string, waveId: string, bucket: number | null, displayName: string | null}} EntryInput
 * @typedef {{status: 'created' | 'existing', entry: Record<string, unknown>} | {status: 'full'}} ClaimOutcome
 */

/**
 * One entry per runner per race, so the document id is derived rather than generated:
 * a retried request lands on the same document instead of creating a duplicate.
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} raceId
 * @param {string} uid
 */
export function entryRef(db, raceId, uid) {
  return db.doc(`entries/${raceId}_${uid}`);
}

/**
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} raceId
 * @param {string} uid
 */
export async function readEntry(db, raceId, uid) {
  const snap = await entryRef(db, raceId, uid).get();
  return snap.exists ? serializeEntry(snap.data()) : null;
}

/**
 * Claims a place in a wave without ever exceeding its capacity.
 *
 * single:      one counter on the wave document. Every claim for the wave writes the same
 *              document, so claims serialise on it and contend under load.
 * partitioned: capacity is split across N bucket documents and a claim tries buckets in random
 *              order. Contention drops by roughly N, and the per-bucket cap still guarantees the
 *              wave total is never exceeded.
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {{counterMode: string, bucketsPerWave?: number}} race
 * @param {Omit<EntryInput, 'bucket'>} input
 * @param {{maxAttempts?: number, random?: () => number, fullBuckets?: FullBucketMemo}} [options]
 * @returns {Promise<{outcome: ClaimOutcome, attempts: number}>}
 */
export async function claimPlace(db, race, input, options = {}) {
  const { maxAttempts = 5, random = Math.random, fullBuckets = new FullBucketMemo() } = options;
  const counter = { attempts: 0 };
  try {
    return await claimWithCounter(db, race, input, { maxAttempts, random, fullBuckets }, counter);
  } catch (err) {
    // Shed claims are the contended ones; keep their attempt count for the X-Txn-Attempts header.
    if (err && typeof err === 'object') err.txnAttempts = counter.attempts;
    throw err;
  }
}

async function claimWithCounter(db, race, input, { maxAttempts, random, fullBuckets }, counter) {
  if (race.counterMode !== 'partitioned') {
    const waveRef = db.doc(`races/${input.raceId}/waves/${input.waveId}`);
    const outcome = await db.runTransaction(
      (tx) => claimInTransaction(tx, counter, entryRef(db, input.raceId, input.uid), waveRef, { ...input, bucket: null }),
      { maxAttempts },
    );
    return { outcome, attempts: counter.attempts };
  }

  const waveKey = `${input.raceId}/${input.waveId}`;
  const order = shuffle(bucketIndexes(race.bucketsPerWave ?? 1), random);
  // Buckets this instance has already seen full go last instead of being skipped,
  // so a reset between test runs is picked up without a restart.
  order.sort((a, b) => Number(fullBuckets.has(waveKey, a)) - Number(fullBuckets.has(waveKey, b)));

  for (const bucket of order) {
    const bucketRef = db.doc(`races/${input.raceId}/waves/${input.waveId}/buckets/${bucket}`);
    const outcome = await db.runTransaction(
      (tx) => claimInTransaction(tx, counter, entryRef(db, input.raceId, input.uid), bucketRef, { ...input, bucket }),
      { maxAttempts },
    );
    if (outcome.status !== 'full') {
      return { outcome, attempts: counter.attempts };
    }
    fullBuckets.add(waveKey, bucket);
  }
  return { outcome: { status: 'full' }, attempts: counter.attempts };
}

/**
 * @param {FirebaseFirestore.Transaction} tx
 * @param {{attempts: number}} counter Counts transaction attempts, so callers can report contention.
 * @param {FirebaseFirestore.DocumentReference} ref Entry document.
 * @param {FirebaseFirestore.DocumentReference} counterRef Wave or bucket document holding capacity and claimed.
 * @param {EntryInput} input
 * @returns {Promise<ClaimOutcome>}
 */
async function claimInTransaction(tx, counter, ref, counterRef, input) {
  counter.attempts += 1;
  const [entrySnap, counterSnap] = await tx.getAll(ref, counterRef);
  if (entrySnap.exists) {
    return { status: 'existing', entry: serializeEntry(entrySnap.data()) };
  }
  if (!counterSnap.exists) {
    throw new HttpError(404, 'unknown_wave');
  }
  const capacity = counterSnap.get('capacity') ?? 0;
  const claimed = counterSnap.get('claimed') ?? 0;
  if (claimed >= capacity) {
    return { status: 'full' };
  }
  const entry = { ...input, createdAt: FieldValue.serverTimestamp() };
  tx.create(ref, entry);
  tx.update(counterRef, { claimed: FieldValue.increment(1) });
  return { status: 'created', entry: serializeEntry({ ...input, createdAt: null }) };
}

/**
 * Remembers which buckets this instance found full. Capacity only ever goes down during an entry
 * window, so a full bucket stays full; the TTL covers resets between test runs.
 */
export class FullBucketMemo {
  /** @param {{ttlMs?: number, now?: () => number}} [options] */
  constructor({ ttlMs = 30_000, now = Date.now } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
    /** @type {Map<string, number>} */
    this.expiry = new Map();
  }

  /** @param {string} waveKey @param {number} bucket */
  add(waveKey, bucket) {
    this.expiry.set(`${waveKey}#${bucket}`, this.now() + this.ttlMs);
  }

  /** @param {string} waveKey @param {number} bucket */
  has(waveKey, bucket) {
    const key = `${waveKey}#${bucket}`;
    const expiresAt = this.expiry.get(key);
    if (expiresAt === undefined) {
      return false;
    }
    if (expiresAt <= this.now()) {
      this.expiry.delete(key);
      return false;
    }
    return true;
  }
}

/**
 * Fisher-Yates shuffle, with the random source injectable for tests.
 * @template T
 * @param {T[]} items
 * @param {() => number} random
 * @returns {T[]}
 */
export function shuffle(items, random) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** @param {Record<string, unknown>} data */
function serializeEntry(data) {
  const createdAt = data.createdAt;
  return {
    raceId: data.raceId,
    waveId: data.waveId,
    bucket: data.bucket ?? null,
    displayName: data.displayName ?? null,
    createdAt: createdAt && typeof createdAt === 'object' && 'toDate' in createdAt ? createdAt.toDate().toISOString() : null,
  };
}
