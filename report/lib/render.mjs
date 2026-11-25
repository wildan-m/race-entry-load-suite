// Markdown report. Every number in it comes from the run's own k6 output; nothing is typed in.

const STEPS = ['list_waves', 'get_entry', 'create_entry', 'confirm_entry'];

const ms = (v) => (v === null || v === undefined ? '-' : v >= 100 ? `${Math.round(v).toLocaleString('en-US')} ms` : `${v.toFixed(1)} ms`);
const pct = (v) => (v === null || v === undefined ? '-' : `${(v * 100).toFixed(v > 0 && v < 0.001 ? 3 : 2)}%`);
const int = (v) => (v === null || v === undefined ? '-' : Math.round(v).toLocaleString('en-US'));
const rate = (v) => (v === null || v === undefined ? '-' : v >= 100 ? Math.round(v).toLocaleString('en-US') : v.toFixed(1));
const mark = (ok) => (ok ? 'met' : '**missed**');

/**
 * @param {{run: any, analysis: any, slo: {p95Ms: number, errorRate: number}, meta: {source: string, chart: string, thresholds: {name: string, expression: string, failed: boolean}[]}}} input
 */
export function renderReport({ run, analysis, slo, meta }) {
  const out = [];
  const profile = meta.tags?.profile ?? 'unknown';
  out.push(`# ${title(run.suite)}`);
  out.push('');
  out.push(
    `Race \`${meta.tags?.race ?? '?'}\`, profile \`${profile}\`. Run from ${run.startedAt} to ${run.endedAt} ` +
      `(${(run.durationSeconds / 60).toFixed(1)} min), built from \`${meta.source}\`.`,
  );
  out.push('');
  out.push(`Service-level objective used below: p95 latency under ${int(slo.p95Ms)} ms and under ${pct(slo.errorRate)} of requests and visits failed.`);
  if (profile === 'local') {
    out.push('');
    out.push(
      '> Local profile: the target is the Firebase Emulator Suite on one workstation, so these figures describe the ' +
        'emulators and the test rig, not production capacity. The same scripts run unchanged against a staging project.',
    );
  }
  out.push('');
  out.push('## Verdict');
  out.push('');
  out.push(...verdict(run.suite, analysis, slo));
  out.push('');
  out.push('## Timeline');
  out.push('');
  out.push(`![Active users, requests per second, p95 latency and failed requests over the run](${meta.chart})`);
  out.push('');
  out.push(...tables(run.suite, analysis));
  out.push('');
  out.push('## k6 thresholds');
  out.push('');
  if (meta.thresholds.length === 0) {
    out.push('No summary.json next to the metrics file, so threshold results are not shown.');
  } else {
    const failed = meta.thresholds.filter((t) => t.failed);
    out.push(`${meta.thresholds.length - failed.length} of ${meta.thresholds.length} thresholds passed.`);
    if (failed.length) {
      out.push('');
      out.push('| Metric | Threshold |');
      out.push('| --- | --- |');
      for (const t of failed) out.push(`| \`${t.name}\` | \`${t.expression}\` |`);
    }
  }
  out.push('');
  out.push('## Reading this report');
  out.push('');
  out.push(
    '- **Users are not requests.** A virtual user is one concurrent runner going through a visit with think time between steps. ' +
      'Requests per second is what those users generate; the two are reported side by side and never substituted for each other.',
  );
  out.push('- **Percentiles are merged, not averaged.** Each p95 and p99 comes from one histogram over every request in the span (1% buckets).');
  out.push('- **A full wave is not an error.** A 409 "wave full" is the correct answer and is counted under outcomes, not failed requests. A 503 is the service shedding load and is counted as a failure.');
  out.push('- **Ramps are left out of the tables.** They mix two load levels; the timeline shows them, the tables cover only the steady spans.');
  return `${out.join('\n')}\n`;
}

function title(suite) {
  return (
    {
      levels: 'Load levels report',
      spike: 'Spike and recovery report',
      soak: 'Soak report',
      breakpoint: 'Breaking point report',
    }[suite] ?? 'Load test report'
  );
}

function verdict(suite, a, slo) {
  if (suite === 'levels') {
    const lines = [];
    if (a.stableThrough === null) {
      lines.push(`- No level met the objective; the lowest level (${int(a.rows[0]?.users)} users) already missed it.`);
    } else if (!a.firstFailing) {
      lines.push(`- **Every level met the objective, up to ${int(a.stableThrough)} concurrent users.**`);
    } else {
      lines.push(`- **Stable through ${int(a.stableThrough)} concurrent users.**`);
    }
    if (a.firstFailing) {
      const r = a.firstFailing;
      lines.push(
        `- First level over the objective: **${int(r.users)} users**, p95 ${ms(r.latency.p95)}, ` +
          `${pct(r.errorRate)} failed requests, ${pct(r.visitFailedRate)} failed visits.`,
      );
    }
    const peak = a.rows[a.rows.length - 1];
    if (peak) {
      lines.push(
        `- At the top level the rig held a median of ${int(peak.vus.median)} active users and ${rate(peak.rps)} requests/s ` +
          `(${rate(peak.visitsPerSec)} visits/s).`,
      );
    }
    return lines;
  }
  if (suite === 'spike') {
    const lines = [];
    if (a.baseline && a.spikeHold) {
      lines.push(
        `- Baseline p95 ${ms(a.baseline.latency.p95)} at ${int(a.baseline.vus.median)} users; during the spike ` +
          `(${int(a.spikeHold.vus.median)} users) p95 ${ms(a.spikeHold.latency.p95)} with ${pct(a.spikeHold.errorRate)} failed requests.`,
      );
    }
    lines.push(
      a.recoverySeconds === null
        ? '- **Did not recover** to baseline latency within the recovery phase.'
        : a.recoverySeconds === 0
          ? '- **Back to baseline as soon as the load dropped**: the first 10 s of the recovery phase were already within 25% of baseline p95, with errors under the objective.'
          : `- **Recovered in ${int(a.recoverySeconds)} s** after the drop (trailing 10 s p95 back within 25% of baseline, errors under the objective).`,
    );
    if (a.recovery) {
      lines.push(`- Recovery phase overall: p95 ${ms(a.recovery.latency.p95)}, ${pct(a.recovery.errorRate)} failed requests.`);
    }
    return lines;
  }
  if (suite === 'soak') {
    const lines = [
      `- ${a.rows.length} windows; ${a.windowsOverSlo === 0 ? 'none' : int(a.windowsOverSlo)} over the objective.`,
    ];
    if (a.p95Drift !== null) {
      lines.push(`- p95 moved **${a.p95Drift >= 0 ? '+' : ''}${(a.p95Drift * 100).toFixed(1)}%** from the first window to the last.`);
    }
    return lines;
  }
  if (suite === 'breakpoint') {
    const lines = [];
    if (a.breaking) {
      lines.push(
        `- **Broke at about ${int(a.breaking.targetRate)} new visits/s** (p95 ${ms(a.breaking.latency.p95)}, ${pct(a.breaking.errorRate)} failed requests, ` +
          `${int(a.breaking.vus.median)} concurrent users).`,
      );
      if (a.lastGood) lines.push(`- Last rate inside the objective: ${int(a.lastGood.targetRate)} visits/s with ${int(a.lastGood.vus.median)} concurrent users.`);
    } else if (a.lastGood) {
      lines.push(`- Did not break: the objective held up to the top of the climb, ${int(a.lastGood.targetRate)} visits/s.`);
    }
    lines.push(
      a.dropped > 0
        ? `- ${int(a.dropped)} visits were dropped because the rig ran out of VUs: past that point the limit is the load generator, not the service.`
        : '- No dropped visits: the load generator kept up with the target rate throughout.',
    );
    return lines;
  }
  return ['- Unknown suite.'];
}

function tables(suite, a) {
  const out = [];
  const rows = suite === 'spike' ? a.phases : a.rows;
  const label = {
    levels: (r) => `${int(r.users)} users`,
    spike: (r) => r.tags.phase,
    soak: (r) => r.tags.window,
    breakpoint: (r) => `${int(r.targetRate)} visits/s`,
  }[suite];
  if (!rows || rows.length === 0 || !label) return ['No steady spans found in this run.'];

  out.push(`## ${suite === 'levels' ? 'Per level (hold phase)' : suite === 'spike' ? 'Per phase' : suite === 'soak' ? 'Per window' : 'Per target rate'}`);
  out.push('');
  const extra = suite === 'breakpoint' ? ' Expected users (Little) |' : '';
  out.push(`| Span | Active users (median / max) | Requests/s | Visits/s | p50 | p95 | p99 | Failed requests | Failed visits |${extra} Objective |`);
  out.push(`| --- | --- | --- | --- | --- | --- | --- | --- | --- |${suite === 'breakpoint' ? ' --- |' : ''} --- |`);
  for (const r of rows) {
    const ok = r.ok ?? null;
    const little = suite === 'breakpoint' ? ` ${int(r.expectedConcurrency)} |` : '';
    out.push(
      `| ${label(r)} | ${int(r.vus.median)} / ${int(r.vus.max)} | ${rate(r.rps)} | ${rate(r.visitsPerSec)} | ${ms(r.latency.p50)} | ${ms(r.latency.p95)} | ${ms(r.latency.p99)} | ${pct(r.errorRate)} | ${pct(r.visitFailedRate)} |${little} ${ok === null ? '-' : mark(ok)} |`,
    );
  }
  out.push('');
  out.push('### p95 latency by step');
  out.push('');
  out.push(`| Span | ${STEPS.join(' | ')} |`);
  out.push(`| --- | ${STEPS.map(() => '---').join(' | ')} |`);
  for (const r of rows) {
    out.push(`| ${label(r)} | ${STEPS.map((s) => ms(r.steps[s]?.p95 ?? null)).join(' | ')} |`);
  }
  out.push('');
  out.push('### Outcomes');
  out.push('');
  out.push('| Span | Entries created | Already entered | Wave full (409) | Fell back to another wave | Shed (503) | Txn attempts per claim (mean / p95 / max) |');
  out.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const r of rows) {
    const t = r.txnAttempts;
    out.push(
      `| ${label(r)} | ${int(r.counters.entries_created)} | ${int(r.counters.entries_existing)} | ${int(r.counters.wave_full)} | ${int(r.counters.wave_fallback)} | ${int(r.counters.claims_shed)} | ${t.count ? `${t.mean.toFixed(2)} / ${t.p95.toFixed(0)} / ${t.max.toFixed(0)}` : '-'} |`,
    );
  }
  return out;
}
