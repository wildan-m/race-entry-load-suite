import { SharedArray } from 'k6/data';
import exec from 'k6/execution';
import http from 'k6/http';
import { tokenRefreshes } from './metrics.js';

const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/**
 * Loads the minted runner tokens once and shares them read-only across all VUs.
 * Pass a function that calls open(): run inside the SharedArray callback, the file is read once
 * for the whole test instead of once per VU (20,000 tokens are about 17 MB).
 * @param {() => string} read
 */
export function loadRunners(read) {
  return new SharedArray('runners', () => {
    const parsed = JSON.parse(read());
    if (!Array.isArray(parsed.runners) || parsed.runners.length === 0) {
      throw new Error('No runners in the tokens file; run tools/mint-tokens.mjs first');
    }
    return parsed.runners;
  });
}

// Tokens this VU refreshed, by uid. Module state is per VU: each VU has its own runtime.
const refreshed = new Map();

/**
 * A VU is a slot of concurrency, not a person: each visit is the next runner in the pool, the way
 * a new person arrives when the previous one leaves. Once the pool has gone round, visits come
 * back as returning runners who already have an entry and only check it.
 * @param {{length: number, [index: number]: {uid: string, idToken: string, refreshToken: string, expiresAt: number}}} runners
 * @param {{secureTokenBase: string, apiKey: string}} config
 */
export function runnerForVisit(runners, config) {
  const runner = runners[exec.scenario.iterationInTest % runners.length];
  let session = refreshed.get(runner.uid) ?? runner;
  if (session.expiresAt - Date.now() < REFRESH_MARGIN_MS) {
    session = refresh(runner.uid, session.refreshToken, config);
    refreshed.set(runner.uid, session);
  }
  return session;
}

function refresh(uid, refreshToken, config) {
  const res = http.post(
    `${config.secureTokenBase}/v1/token?key=${encodeURIComponent(config.apiKey)}`,
    { grant_type: 'refresh_token', refresh_token: refreshToken },
    { tags: { step: 'token_refresh' } },
  );
  if (res.status !== 200) {
    throw new Error(`Token refresh failed for ${uid}: ${res.status}`);
  }
  const body = res.json();
  tokenRefreshes.add(1);
  return {
    uid,
    idToken: body.id_token,
    refreshToken: body.refresh_token,
    expiresAt: Date.now() + Number(body.expires_in) * 1000,
  };
}
