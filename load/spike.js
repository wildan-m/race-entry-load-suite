// Sudden surge: hold a baseline, jump to the peak in 15 seconds (the minute entry opens), hold it,
// drop back, and keep the baseline running to see whether latency and errors return to normal.

import { loadConfig } from './lib/config.js';
import { loadRunners, runnerForVisit } from './lib/identity.js';
import { runnerVisit } from './lib/journey.js';
import { preflight, segmentTagger, serviceThresholds, SUMMARY_TREND_STATS } from './lib/run.js';
import { spike } from './lib/schedule.js';

const config = loadConfig(__ENV);
const runners = loadRunners(() => open(config.tokensFile));
const plan = spike(config.peakUsers);

export const options = {
  scenarios: {
    spike: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: plan.stages,
      gracefulRampDown: '15s',
      gracefulStop: '30s',
    },
  },
  thresholds: serviceThresholds(config, ['phase:baseline', 'phase:spike_hold', 'phase:recovery']),
  summaryTrendStats: SUMMARY_TREND_STATS,
  tags: { suite: 'spike', profile: config.profile, race: config.raceId },
};

const tagSegment = segmentTagger(plan.segments);

export function setup() {
  return preflight(config, runners, config.peakUsers);
}

export default function () {
  runnerVisit({ config, session: runnerForVisit(runners, config), beforeStep: tagSegment });
}
