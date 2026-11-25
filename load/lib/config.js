// Target and load settings per profile. "local" runs against the Firebase emulators at a
// twentieth of the staging user counts; "staging" is the full 1,000 / 2,500 / 5,000 / 10,000 plan.
// Any value can be overridden from the environment, e.g. LEVELS=1000,2500 HOLD_SECONDS=600.

const PROFILES = {
  local: {
    apiBase: 'http://127.0.0.1:5001/kestrel-bay-entries/europe-west2/api',
    secureTokenBase: 'http://127.0.0.1:9099/securetoken.googleapis.com',
    apiKey: 'emulator-key',
    levels: [50, 125, 250, 500],
    rampSeconds: 20,
    holdSeconds: 60,
    thinkScale: 0.2,
    peakUsers: 500,
    soakMinutes: 10,
    soakWindowMinutes: 2,
    breakpointMaxRate: 120,
    breakpointMinutes: 6,
    breakpointMaxVUs: 600,
  },
  staging: {
    apiBase: null,
    secureTokenBase: 'https://securetoken.googleapis.com',
    apiKey: null,
    levels: [1000, 2500, 5000, 10000],
    // Ten-minute ramps keep growth near Firestore's 500/50/5 guidance (start under 500 ops/s,
    // then at most +50% every 5 minutes); a faster ramp measures key-range splitting, not the app.
    rampSeconds: 600,
    holdSeconds: 600,
    thinkScale: 1,
    peakUsers: 10000,
    soakMinutes: 120,
    soakWindowMinutes: 10,
    breakpointMaxRate: 1500,
    breakpointMinutes: 40,
    breakpointMaxVUs: 12000,
  },
};

/**
 * @param {Record<string, string | undefined>} env k6's __ENV
 */
export function loadConfig(env) {
  const profile = env.PROFILE ?? 'local';
  const base = PROFILES[profile];
  if (!base) {
    throw new Error(`Unknown PROFILE "${profile}". Use one of: ${Object.keys(PROFILES).join(', ')}`);
  }
  const config = {
    profile,
    raceId: env.RACE_ID ?? 'kbhm-2027',
    tokensFile: env.TOKENS_FILE ?? './.tokens/runners.json',
    apiBase: env.API_BASE ?? base.apiBase,
    secureTokenBase: env.SECURE_TOKEN_BASE ?? base.secureTokenBase,
    apiKey: env.FIREBASE_API_KEY ?? base.apiKey,
    levels: env.LEVELS ? env.LEVELS.split(',').map(Number) : base.levels,
    rampSeconds: num(env.RAMP_SECONDS, base.rampSeconds),
    holdSeconds: num(env.HOLD_SECONDS, base.holdSeconds),
    thinkScale: num(env.THINK_SCALE, base.thinkScale),
    peakUsers: num(env.PEAK_USERS, base.peakUsers),
    soakMinutes: num(env.SOAK_MINUTES, base.soakMinutes),
    soakWindowMinutes: num(env.SOAK_WINDOW_MINUTES, base.soakWindowMinutes),
    breakpointMaxRate: num(env.BREAKPOINT_MAX_RATE, base.breakpointMaxRate),
    breakpointMinutes: num(env.BREAKPOINT_MINUTES, base.breakpointMinutes),
    breakpointMaxVUs: num(env.BREAKPOINT_MAX_VUS, base.breakpointMaxVUs),
    sloP95Ms: num(env.SLO_P95_MS, 1500),
    sloErrorRate: num(env.SLO_ERROR_RATE, 0.01),
  };
  if (!config.apiBase) throw new Error('Set API_BASE to the entry API base URL');
  if (!config.apiKey) throw new Error('Set FIREBASE_API_KEY so expiring tokens can be refreshed');
  if (config.levels.some((n) => !Number.isInteger(n) || n < 1)) throw new Error('LEVELS must be positive integers');
  return config;
}

function num(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`Not a number: ${value}`);
  return n;
}
