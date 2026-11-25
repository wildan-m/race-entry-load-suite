// Sustained load: a steady user count for a long time, tagged in fixed windows, so slow drift
// (latency creeping up, memory pressure, token refresh, growing collections) shows up window by window.

import { loadConfig } from './lib/config.js';
import { loadRunners, runnerForVisit } from './lib/identity.js';
import { runnerVisit } from './lib/journey.js';
import { preflight, segmentTagger, serviceThresholds, SUMMARY_TREND_STATS } from './lib/run.js';
import { buildSchedule } from './lib/schedule.js';

const config = loadConfig(__ENV);
const runners = loadRunners(() => open(config.tokensFile));
const users = Number(__ENV.SOAK_USERS ?? Math.round(config.peakUsers / 2));
const rampSeconds = 60;
const plan = buildSchedule([
  { phase: 'ramp', seconds: rampSeconds, target: users, level: users },
  { phase: 'soak', seconds: config.soakMinutes * 60, target: users, level: users },
  { phase: 'ramp_down', seconds: 15, target: 0, level: 0 },
]);
const windowSeconds = config.soakWindowMinutes * 60;

export const options = {
  scenarios: {
    soak: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: plan.stages,
      gracefulRampDown: '15s',
      gracefulStop: '30s',
    },
  },
  thresholds: serviceThresholds(config, ['phase:soak']),
  summaryTrendStats: SUMMARY_TREND_STATS,
  tags: { suite: 'soak', profile: config.profile, race: config.raceId },
};

const tagSegment = segmentTagger(plan.segments, (segment, elapsed) => ({
  window: segment.phase === 'soak' ? `w${String(Math.floor((elapsed - rampSeconds) / windowSeconds) + 1).padStart(2, '0')}` : 'none',
}));

export function setup() {
  return preflight(config, runners, users);
}

export default function () {
  runnerVisit({ config, session: runnerForVisit(runners, config), beforeStep: tagSegment });
}
