import exec from 'k6/execution';
import http from 'k6/http';
import { segmentAt } from './schedule.js';

export const SUMMARY_TREND_STATS = ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max', 'count'];

/**
 * Returns a function that stamps the VU's metric tags with the segment the test is in right now.
 * Called before each request, because one visit can straddle a ramp and a hold.
 * @param {import('./schedule.js').Segment[]} segments
 * @param {(segment: import('./schedule.js').Segment, elapsedSeconds: number) => Record<string, string>} [extra]
 */
export function segmentTagger(segments, extra) {
  return () => {
    const elapsed = (Date.now() - exec.scenario.startTime) / 1000;
    const segment = segmentAt(segments, elapsed);
    const tags = exec.vu.metrics.tags;
    tags.phase = segment.phase;
    tags.level = String(segment.level ?? segment.target);
    if (extra) {
      for (const [key, value] of Object.entries(extra(segment, elapsed))) {
        tags[key] = value;
      }
    }
  };
}

/**
 * Service-level thresholds. Sub-metrics listed here also make k6 report them in the end-of-test
 * summary, which is how per-level and per-step numbers get into summary.json.
 * @param {{sloP95Ms: number, sloErrorRate: number}} config
 * @param {string[]} groups Tag selectors such as "level:1000,phase:hold".
 */
export function serviceThresholds(config, groups) {
  const thresholds = {
    checks: ['rate>0.99'],
    visit_failed: [`rate<${config.sloErrorRate}`],
  };
  for (const group of groups) {
    thresholds[`http_req_duration{${group}}`] = [`p(95)<${config.sloP95Ms}`];
    thresholds[`http_req_failed{${group}}`] = [`rate<${config.sloErrorRate}`];
    for (const step of ['list_waves', 'get_entry', 'create_entry', 'confirm_entry']) {
      thresholds[`http_req_duration{${group},step:${step}}`] = [`p(95)<${config.sloP95Ms}`];
    }
  }
  return thresholds;
}

/**
 * Runs once before the load starts: refuses to begin against a target that is not up or a race
 * that is not seeded, and warns when there are fewer runners than VUs.
 * @param {{apiBase: string, raceId: string}} config
 * @param {{length: number}} runners
 * @param {number} maxVUs
 */
export function preflight(config, runners, maxVUs) {
  const health = http.get(`${config.apiBase}/healthz`, { tags: { step: 'preflight' } });
  if (health.status !== 200) {
    exec.test.abort(`Entry API is not healthy at ${config.apiBase} (status ${health.status})`);
  }
  const race = http.get(`${config.apiBase}/races/${config.raceId}`, { tags: { step: 'preflight' } });
  if (race.status !== 200) {
    exec.test.abort(`Race ${config.raceId} is not seeded (status ${race.status}); run tools/seed.mjs`);
  }
  if (runners.length < maxVUs) {
    console.warn(`${runners.length} runner tokens for up to ${maxVUs} VUs: some runners will be shared between VUs`);
  }
  return { startedAt: new Date().toISOString(), raceId: config.raceId, apiBase: config.apiBase };
}
