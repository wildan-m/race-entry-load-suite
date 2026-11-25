import express from 'express';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import * as logger from 'firebase-functions/logger';
import { requireUser } from './auth.js';
import { claimPlace, FullBucketMemo, readEntry } from './entries.js';
import { HttpError, toResponse } from './errors.js';
import { readRaceSettings, readRaceView, requireId, ttlCache } from './races.js';

/**
 * Entry API for one race weekend.
 *
 *   GET  /races/:raceId         wave list with places left (cached briefly per instance)
 *   GET  /races/:raceId/entry   the signed-in runner's entry, or 404
 *   POST /races/:raceId/entry   claim a place in a wave; idempotent per runner
 *
 * @param {{db?: FirebaseFirestore.Firestore, auth?: Parameters<typeof requireUser>[0], maxAttempts?: number}} [deps]
 */
export function createApp(deps = {}) {
  const db = deps.db ?? getFirestore();
  const auth = deps.auth ?? getAuth();
  const maxAttempts = deps.maxAttempts ?? Number(process.env.TXN_MAX_ATTEMPTS ?? 5);
  const raceViews = ttlCache((raceId) => readRaceView(db, raceId), { ttlMs: 2000 });
  const raceSettings = ttlCache((raceId) => readRaceSettings(db, raceId), { ttlMs: 30_000 });
  const fullBuckets = new FullBucketMemo();
  const signedIn = requireUser(auth);

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2kb' }));

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/races/:raceId', async (req, res) => {
    const view = await raceViews(requireId(req.params.raceId, 'invalid_race'));
    // Lets a CDN absorb the listing burst; the per-instance cache covers direct hits.
    res.set('Cache-Control', 'public, max-age=2, s-maxage=5').json(view);
  });

  app.get('/races/:raceId/entry', signedIn, async (req, res) => {
    const raceId = requireId(req.params.raceId, 'invalid_race');
    const entry = await readEntry(db, raceId, req.user.uid);
    if (!entry) {
      throw new HttpError(404, 'not_entered');
    }
    res.set('Cache-Control', 'private, no-store').json({ entry });
  });

  app.post('/races/:raceId/entry', signedIn, async (req, res) => {
    const raceId = requireId(req.params.raceId, 'invalid_race');
    const waveId = requireId(req.body?.waveId, 'invalid_wave');
    const { outcome, attempts } = await claimPlace(
      db,
      await raceSettings(raceId),
      { raceId, uid: req.user.uid, waveId, displayName: req.user.name ?? null },
      { maxAttempts, fullBuckets },
    );
    // Transaction attempts per claim: the load test reads this header to measure contention.
    res.set('X-Txn-Attempts', String(attempts)).set('Cache-Control', 'private, no-store');
    if (outcome.status === 'full') {
      throw new HttpError(409, 'wave_full');
    }
    res.status(outcome.status === 'created' ? 201 : 200).json({ status: outcome.status, entry: outcome.entry });
  });

  app.use((_req, _res) => {
    throw new HttpError(404, 'not_found');
  });

  // Express 5 forwards rejected promises from async handlers here.
  app.use((err, req, res, _next) => {
    const response = toResponse(err);
    if (response.unexpected) {
      logger.error('request failed', { method: req.method, path: req.path, message: err?.message });
    } else if (response.status === 503) {
      logger.warn('request shed', { method: req.method, path: req.path, error: response.body.error });
    }
    if (typeof err?.txnAttempts === 'number') res.set('X-Txn-Attempts', String(err.txnAttempts));
    res.status(response.status).set(response.headers).json(response.body);
  });

  return app;
}
