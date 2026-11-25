import { initializeApp } from 'firebase-admin/app';
import { setGlobalOptions } from 'firebase-functions';
import { onRequest } from 'firebase-functions/https';
import { createApp } from './app.js';

initializeApp();

// Instance shape is part of what a load test measures, so every value here is deliberate.
setGlobalOptions({
  region: 'europe-west2',
  memory: '512MiB',
  cpu: 1,
  timeoutSeconds: 30,
  // Requests one instance serves at once before Cloud Run adds another instance.
  concurrency: 80,
  // Hard ceiling on scale-out; at 80 per instance this caps the service near 4,000 in-flight requests.
  maxInstances: 50,
  // Raise before entry opens so the first wave of runners does not pay for cold starts.
  minInstances: 0,
});

export const api = onRequest({ invoker: 'public' }, createApp());
