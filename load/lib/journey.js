import { check, sleep } from 'k6';
import http from 'k6/http';
import {
  claimsShed,
  entriesCreated,
  entriesExisting,
  txnAttempts,
  visitDuration,
  visitFailed,
  waveFallback,
  waveFull,
} from './metrics.js';
import { pickWeighted, preferenceOrder, VISIT_MIX } from './choices.js';

const LIST_OK = http.expectedStatuses(200);
// 404 is how the API says "not entered yet": a normal answer, not a failed request.
const ENTRY_OK = http.expectedStatuses(200, 404);
// 409 "wave full" is a correct refusal; 503 is the service shedding load and stays a failure.
const CLAIM_OK = http.expectedStatuses(200, 201, 409);

/**
 * One runner visit. Every request is tagged with its step, so the report can give per-step
 * latency instead of one blended number.
 * @param {{config: ReturnType<typeof import('./config.js').loadConfig>, session: {idToken: string}, beforeStep?: () => void, random?: () => number}} ctx
 */
export function runnerVisit({ config, session, beforeStep = () => {}, random = Math.random }) {
  const started = Date.now();
  const visit = pickWeighted(VISIT_MIX, random);
  const base = `${config.apiBase}/races/${config.raceId}`;
  const auth = { authorization: `Bearer ${session.idToken}` };
  let ok = false;

  try {
    beforeStep();
    const listing = http.get(base, { tags: { step: 'list_waves' }, responseCallback: LIST_OK });
    if (!check(listing, { 'list_waves returns the waves': (r) => r.status === 200 && Array.isArray(r.json('waves')) })) {
      return;
    }
    think(config, 2, 6, random);
    if (visit === 'browse') {
      ok = true;
      return;
    }

    beforeStep();
    const entry = http.get(`${base}/entry`, { headers: auth, tags: { step: 'get_entry' }, responseCallback: ENTRY_OK });
    if (!check(entry, { 'get_entry answers 200 or 404': (r) => r.status === 200 || r.status === 404 })) {
      return;
    }
    think(config, 1, 3, random);
    if (visit === 'check' || entry.status === 200) {
      ok = true;
      return;
    }

    const claimed = claimWithFallback({ config, base, auth, waves: listing.json('waves'), beforeStep, random });
    if (claimed === 'shed' || claimed === 'error') {
      return;
    }
    if (claimed === 'entered') {
      think(config, 1, 2, random);
      beforeStep();
      const confirm = http.get(`${base}/entry`, { headers: auth, tags: { step: 'confirm_entry' }, responseCallback: LIST_OK });
      if (!check(confirm, { 'confirm_entry shows the entry': (r) => r.status === 200 })) {
        return;
      }
    }
    ok = true;
  } finally {
    visitDuration.add(Date.now() - started, { visit });
    visitFailed.add(!ok, { visit });
  }
}

/**
 * Claims the runner's preferred wave, falling back to the next wave with places left when the
 * service answers 409. Waves shown as full in the listing are skipped, as a person would.
 * @returns {'entered' | 'sold_out' | 'shed' | 'error'}
 */
function claimWithFallback({ config, base, auth, waves, beforeStep, random }) {
  const order = preferenceOrder(waves, random);
  const headers = { ...auth, 'content-type': 'application/json' };
  for (let i = 0; i < Math.min(order.length, 3); i += 1) {
    if (i > 0) {
      waveFallback.add(1);
      think(config, 0.5, 1.5, random);
    }
    beforeStep();
    const res = http.post(`${base}/entry`, JSON.stringify({ waveId: order[i] }), {
      headers,
      tags: { step: 'create_entry' },
      responseCallback: CLAIM_OK,
    });
    const attempts = Number(res.headers['X-Txn-Attempts']);
    if (attempts > 0) {
      txnAttempts.add(attempts);
    }
    if (res.status === 201) {
      entriesCreated.add(1);
      return 'entered';
    }
    if (res.status === 200) {
      entriesExisting.add(1);
      return 'entered';
    }
    if (res.status === 409) {
      waveFull.add(1);
      continue;
    }
    if (res.status === 503) {
      claimsShed.add(1);
      return 'shed';
    }
    check(res, { 'create_entry answers 200, 201 or 409': () => false });
    return 'error';
  }
  return 'sold_out';
}

function think(config, minSeconds, maxSeconds, random) {
  sleep((minSeconds + random() * (maxSeconds - minSeconds)) * config.thinkScale);
}
