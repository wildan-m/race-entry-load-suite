// Open-model breaking point: visits start at a rising rate regardless of how fast the service
// answers, the way real arrivals do. Concurrency is then an outcome (arrival rate x visit length),
// and the test aborts as soon as the service-level thresholds break; the rate at that moment is
// the breaking point. dropped_iterations above zero means the load generator ran out of VUs,
// which is a limit of the test rig, not of the service.

import { loadConfig } from './lib/config.js';
import { loadRunners, runnerForVisit } from './lib/identity.js';
import { runnerVisit } from './lib/journey.js';
import { preflight, segmentTagger, SUMMARY_TREND_STATS } from './lib/run.js';
import { buildSchedule } from './lib/schedule.js';

const config = loadConfig(__ENV);
const runners = loadRunners(() => open(config.tokensFile));
const rampSeconds = config.breakpointMinutes * 60;
const plan = buildSchedule([{ phase: 'climb', seconds: rampSeconds, target: config.breakpointMaxRate, level: config.breakpointMaxRate }]);

export const options = {
  scenarios: {
    breakpoint: {
      executor: 'ramping-arrival-rate',
      startRate: 1,
      timeUnit: '1s',
      preAllocatedVUs: Math.min(config.breakpointMaxVUs, 200),
      maxVUs: config.breakpointMaxVUs,
      stages: plan.stages,
    },
  },
  thresholds: {
    http_req_failed: [{ threshold: `rate<${Math.max(config.sloErrorRate, 0.05)}`, abortOnFail: true, delayAbortEval: '30s' }],
    'http_req_duration{step:create_entry}': [{ threshold: `p(95)<${config.sloP95Ms * 2}`, abortOnFail: true, delayAbortEval: '30s' }],
    'http_req_duration{step:list_waves}': [{ threshold: `p(95)<${config.sloP95Ms * 2}`, abortOnFail: true, delayAbortEval: '30s' }],
  },
  summaryTrendStats: SUMMARY_TREND_STATS,
  tags: { suite: 'breakpoint', profile: config.profile, race: config.raceId },
};

// The target arrival rate at each moment in 40 steps, so the report can line rate up with latency
// without one tag value per second.
const rateStep = Math.max(1, Math.round(config.breakpointMaxRate / 40));
const tagSegment = segmentTagger(plan.segments, (_segment, elapsed) => {
  const rate = 1 + ((config.breakpointMaxRate - 1) * Math.min(elapsed, rampSeconds)) / rampSeconds;
  return { target_rate: String(Math.max(rateStep, Math.round(rate / rateStep) * rateStep)) };
});

export function setup() {
  return preflight(config, runners, config.breakpointMaxVUs);
}

export default function () {
  runnerVisit({ config, session: runnerForVisit(runners, config), beforeStep: tagSegment });
}
