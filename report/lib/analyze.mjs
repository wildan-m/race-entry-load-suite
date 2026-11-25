// Turns aggregated groups into the answers each suite exists to give.

/**
 * @typedef {{p95Ms: number, errorRate: number}} Slo
 * @typedef {ReturnType<ReturnType<typeof import('./aggregate.mjs').createAggregator>['result']>} RunResult
 */

/** @param {RunResult['groups'][number]} group @param {Slo} slo */
export function meetsSlo(group, slo) {
  return (
    group.latency.p95 !== null &&
    group.latency.p95 <= slo.p95Ms &&
    group.errorRate <= slo.errorRate &&
    (group.visitFailedRate ?? 0) <= slo.errorRate
  );
}

/**
 * Hold phases only: ramps mix two load levels and would blur both.
 * "Stable through" is the highest level such that it and every level below it met the SLO.
 * @param {RunResult} run
 * @param {Slo} slo
 */
export function analyzeLevels(run, slo) {
  const rows = run.groups
    .filter((g) => g.tags.phase === 'hold')
    .sort((a, b) => Number(a.tags.level) - Number(b.tags.level))
    .map((g) => ({ ...g, users: Number(g.tags.level), ok: meetsSlo(g, slo) }));
  const firstFailing = rows.find((r) => !r.ok) ?? null;
  const passing = firstFailing ? rows.slice(0, rows.indexOf(firstFailing)) : rows;
  return { rows, stableThrough: passing.length ? passing[passing.length - 1].users : null, firstFailing };
}

/**
 * Recovery time: seconds from the start of the recovery phase until the trailing 10-second p95
 * is back within 25% (and at least 20 ms) of the baseline p95 and errors are back under the SLO.
 * @param {RunResult} run
 * @param {Slo} slo
 */
export function analyzeSpike(run, slo, { windowSeconds = 10 } = {}) {
  const byPhase = Object.fromEntries(run.groups.map((g) => [g.tags.phase, g]));
  const baseline = byPhase.baseline ?? null;
  const spikeHold = byPhase.spike_hold ?? null;
  const recovery = byPhase.recovery ?? null;
  let recoverySeconds = null;
  if (baseline && recovery && baseline.latency.p95 !== null) {
    const p95Limit = Math.max(baseline.latency.p95 * 1.25, baseline.latency.p95 + 20);
    const errorLimit = Math.max(slo.errorRate, baseline.errorRate * 2);
    const point = run
      .rolling(windowSeconds)
      .find((p) => p.t >= recovery.startSec && p.requests > 0 && p.p95 <= p95Limit && (p.errorRate ?? 0) <= errorLimit);
    recoverySeconds = point ? Math.max(0, point.t - recovery.startSec) : null;
  }
  return { baseline, spikeHold, recovery, recoverySeconds, phases: [...run.groups].sort((a, b) => a.startSec - b.startSec) };
}

/**
 * Drift: how far the last window's p95 moved from the first window's.
 * @param {RunResult} run
 * @param {Slo} slo
 */
export function analyzeSoak(run, slo) {
  const rows = run.groups
    .filter((g) => g.tags.window !== 'none')
    .sort((a, b) => a.tags.window.localeCompare(b.tags.window))
    .map((g) => ({ ...g, ok: meetsSlo(g, slo) }));
  const first = rows[0];
  const last = rows[rows.length - 1];
  const p95Drift = first && last && first.latency.p95 ? last.latency.p95 / first.latency.p95 - 1 : null;
  return { rows, p95Drift, windowsOverSlo: rows.filter((r) => !r.ok).length };
}

/**
 * Open model: the arrival rate is the input, concurrency the outcome. Little's law
 * (concurrent visits = arrival rate x mean visit time) is shown next to the measured VUs as a
 * consistency check on the rig.
 * @param {RunResult} run
 * @param {Slo} slo
 */
export function analyzeBreakpoint(run, slo) {
  const rows = [...run.groups]
    .sort((a, b) => Number(a.tags.target_rate) - Number(b.tags.target_rate))
    .map((g) => ({
      ...g,
      targetRate: Number(g.tags.target_rate),
      expectedConcurrency: g.visitDuration.mean !== null ? (g.visitsPerSec * g.visitDuration.mean) / 1000 : null,
      ok: meetsSlo(g, slo),
    }));
  const breaking = rows.find((r) => !r.ok) ?? null;
  const lastGood = breaking ? (rows[rows.indexOf(breaking) - 1] ?? null) : (rows[rows.length - 1] ?? null);
  const dropped = run.timeline.reduce((sum, p) => sum + p.dropped, 0);
  return { rows, breaking, lastGood, dropped };
}
