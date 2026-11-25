// Load shapes as explicit segments, so every request can carry the phase it ran in. k6 does not
// tag ramping-vus stages itself; without these tags a report cannot tell a ramp from a hold.

/**
 * @typedef {{phase: string, seconds: number, target: number, level?: number}} SegmentSpec
 * @typedef {SegmentSpec & {start: number, end: number}} Segment
 */

/**
 * @param {SegmentSpec[]} specs
 * @returns {{segments: Segment[], stages: {duration: string, target: number}[], totalSeconds: number}}
 */
export function buildSchedule(specs) {
  let t = 0;
  const segments = specs.map((spec) => {
    const segment = { ...spec, start: t, end: t + spec.seconds };
    t += spec.seconds;
    return segment;
  });
  return {
    segments,
    stages: segments.map((s) => ({ duration: `${s.seconds}s`, target: s.target })),
    totalSeconds: t,
  };
}

/**
 * Ramp to each level, hold it, then step up to the next.
 * @param {number[]} levels
 * @param {number} rampSeconds
 * @param {number} holdSeconds
 */
export function staircase(levels, rampSeconds, holdSeconds) {
  const specs = levels.flatMap((level) => [
    { phase: 'ramp', seconds: rampSeconds, target: level, level },
    { phase: 'hold', seconds: holdSeconds, target: level, level },
  ]);
  specs.push({ phase: 'ramp_down', seconds: Math.min(30, rampSeconds), target: 0, level: 0 });
  return buildSchedule(specs);
}

/**
 * Baseline, a sudden spike, then the same baseline again to measure recovery.
 * @param {number} peak
 * @param {{baselineShare?: number, baselineSeconds?: number, spikeRampSeconds?: number, spikeHoldSeconds?: number, recoverySeconds?: number}} [shape]
 */
export function spike(peak, shape = {}) {
  const {
    baselineShare = 0.2,
    baselineSeconds = 120,
    spikeRampSeconds = 15,
    spikeHoldSeconds = 60,
    recoverySeconds = 180,
  } = shape;
  const baseline = Math.max(1, Math.round(peak * baselineShare));
  return buildSchedule([
    { phase: 'warmup', seconds: 30, target: baseline, level: baseline },
    { phase: 'baseline', seconds: baselineSeconds, target: baseline, level: baseline },
    { phase: 'spike', seconds: spikeRampSeconds, target: peak, level: peak },
    { phase: 'spike_hold', seconds: spikeHoldSeconds, target: peak, level: peak },
    { phase: 'drop', seconds: spikeRampSeconds, target: baseline, level: baseline },
    { phase: 'recovery', seconds: recoverySeconds, target: baseline, level: baseline },
    { phase: 'ramp_down', seconds: 15, target: 0, level: 0 },
  ]);
}

/**
 * @param {Segment[]} segments
 * @param {number} elapsedSeconds
 * @returns {Segment}
 */
export function segmentAt(segments, elapsedSeconds) {
  for (const segment of segments) {
    if (elapsedSeconds < segment.end) return segment;
  }
  return segments[segments.length - 1];
}
