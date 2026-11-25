// Stepped load: ramp to each user level, hold it, step up. Answers "how does the service behave at
// 1,000, 2,500, 5,000 and 10,000 concurrent runners", with every request tagged by level and phase.
//
//   k6 run load/levels.js                            local profile (50/125/250/500)
//   PROFILE=staging API_BASE=... FIREBASE_API_KEY=... k6 run load/levels.js

import { loadConfig } from './lib/config.js';
import { loadRunners, runnerForVisit } from './lib/identity.js';
import { runnerVisit } from './lib/journey.js';
import { preflight, segmentTagger, serviceThresholds, SUMMARY_TREND_STATS } from './lib/run.js';
import { staircase } from './lib/schedule.js';

const config = loadConfig(__ENV);
const runners = loadRunners(() => open(config.tokensFile));
const plan = staircase(config.levels, config.rampSeconds, config.holdSeconds);

export const options = {
  scenarios: {
    levels: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: plan.stages,
      gracefulRampDown: '30s',
      gracefulStop: '30s',
    },
  },
  thresholds: serviceThresholds(config, config.levels.map((level) => `level:${level},phase:hold`)),
  summaryTrendStats: SUMMARY_TREND_STATS,
  tags: { suite: 'levels', profile: config.profile, race: config.raceId },
};

const tagSegment = segmentTagger(plan.segments);

export function setup() {
  return preflight(config, runners, Math.max(...config.levels));
}

export default function () {
  runnerVisit({ config, session: runnerForVisit(runners, config), beforeStep: tagSegment });
}
