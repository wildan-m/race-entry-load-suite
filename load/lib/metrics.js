import { Counter, Rate, Trend } from 'k6/metrics';

// Business outcomes. A 409 "wave full" is a correct answer, not an error, so it is counted here
// and kept out of http_req_failed.
export const entriesCreated = new Counter('entries_created');
export const entriesExisting = new Counter('entries_existing');
export const waveFull = new Counter('wave_full');
export const waveFallback = new Counter('wave_fallback');

// Requests the service shed with 503 (Firestore contention, deadline or quota).
export const claimsShed = new Counter('claims_shed');

// Firestore transaction attempts per claim, read from the X-Txn-Attempts response header.
// Anything above 1 is contention on the wave or bucket counter.
export const txnAttempts = new Trend('txn_attempts');

// One runner's whole visit, think time included; and whether it ended the way it should.
export const visitDuration = new Trend('visit_duration', true);
export const visitFailed = new Rate('visit_failed');

export const tokenRefreshes = new Counter('token_refreshes');
