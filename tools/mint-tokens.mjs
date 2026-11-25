#!/usr/bin/env node
// Signs every test runner in before the load test and writes their ID and refresh tokens to
// load/.tokens/runners.json. Minting up front keeps Firebase Authentication's sign-in quotas out
// of the measurement: the test should find the limits of the entry service, not of the sign-in API.
//
//   node tools/mint-tokens.mjs --runners 600
//   FIREBASE_API_KEY=... node tools/mint-tokens.mjs --runners 12000 --project <staging-id> --allow-remote

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { runnerIdentity } from './race-data.mjs';
import { mapLimit, resolveTarget } from './target.mjs';

const target = resolveTarget(process.argv.slice(2), {
  runners: { type: 'string', default: '600' },
  concurrency: { type: 'string', default: '16' },
  out: { type: 'string' },
});

const runners = Number(target.values.runners);
const concurrency = Number(target.values.concurrency);
// The emulator accepts any key; a real project needs its Web API key.
const apiKey = target.remote ? process.env.FIREBASE_API_KEY : 'emulator-key';
if (!apiKey) {
  throw new Error('Set FIREBASE_API_KEY to the staging project Web API key');
}
const outFile = target.values.out ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'load', '.tokens', 'runners.json');

initializeApp({ projectId: target.projectId });
const auth = getAuth();
const started = Date.now();

const numbers = Array.from({ length: runners }, (_, i) => i + 1);
const minted = await mapLimit(numbers, concurrency, async (n) => {
  const { uid, displayName } = runnerIdentity(n);
  const customToken = await auth.createCustomToken(uid);
  const res = await fetch(`${target.authBase}/v1/accounts:signInWithCustomToken?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: customToken, returnSecureToken: true }),
  });
  if (!res.ok) {
    throw new Error(`Sign-in failed for ${uid}: ${res.status} ${await res.text()}`);
  }
  const body = await res.json();
  return {
    uid,
    displayName,
    idToken: body.idToken,
    refreshToken: body.refreshToken,
    // Refreshed by the test itself once it gets within five minutes of this.
    expiresAt: Date.now() + Number(body.expiresIn) * 1000,
  };
});

await mkdir(dirname(outFile), { recursive: true });
await writeFile(outFile, JSON.stringify({ projectId: target.projectId, mintedAt: new Date().toISOString(), runners: minted }));
console.log(`Minted ${minted.length} runner tokens for ${target.projectId} in ${((Date.now() - started) / 1000).toFixed(1)}s -> ${outFile}`);
