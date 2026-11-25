#!/usr/bin/env node
// Builds report.md, report.html, report.json and charts/timeline.svg from one k6 run directory
// (metrics.json.gz from --out json=..., and summary.json from --summary-export=...).
//
//   node report/build-report.mjs results/levels-local-2026-11-26T05-10 [--slo-p95 1500] [--slo-error 0.01]

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { createAggregator } from './lib/aggregate.mjs';
import { analyzeBreakpoint, analyzeLevels, analyzeSoak, analyzeSpike } from './lib/analyze.mjs';
import { renderTimeline } from './lib/charts.mjs';
import { markdownToHtml } from './lib/html.mjs';
import { readK6Json } from './lib/k6-json.mjs';
import { renderReport } from './lib/render.mjs';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'slo-p95': { type: 'string', default: '1500' },
    'slo-error': { type: 'string', default: '0.01' },
  },
});
const runDir = positionals[0];
if (!runDir) {
  console.error('usage: node report/build-report.mjs <run-dir> [--slo-p95 ms] [--slo-error rate]');
  process.exit(2);
}
const slo = { p95Ms: Number(values['slo-p95']), errorRate: Number(values['slo-error']) };

const source = ['metrics.json.gz', 'metrics.json'].find((name) => existsSync(join(runDir, name)));
if (!source) {
  throw new Error(`No metrics.json.gz or metrics.json in ${runDir}; run k6 with --out json=${runDir}/metrics.json.gz`);
}

const aggregator = createAggregator();
let tags = null;
for await (const entry of readK6Json(join(runDir, source))) {
  if (!tags && entry.type === 'Point' && entry.data?.tags?.suite) {
    const { suite, profile, race } = entry.data.tags;
    tags = { suite, profile, race };
  }
  aggregator.add(entry);
}
const run = aggregator.result();
if (!run.suite) {
  throw new Error('No suite tag on any point: was this run made with one of the scripts in load/?');
}

const analysis = {
  levels: () => analyzeLevels(run, slo),
  spike: () => analyzeSpike(run, slo),
  soak: () => analyzeSoak(run, slo),
  breakpoint: () => analyzeBreakpoint(run, slo),
}[run.suite]();

const bands = {
  levels: () => analysis.rows.map((r) => ({ from: r.startSec, to: r.endSec, label: `${r.users.toLocaleString('en-US')} users` })),
  spike: () => [analysis.baseline, analysis.spikeHold, analysis.recovery].filter(Boolean).map((g) => ({ from: g.startSec, to: g.endSec, label: g.tags.phase.replace('_', ' ') })),
  soak: () => [],
  breakpoint: () => [],
}[run.suite]();

const svg = renderTimeline(run.timeline, { title: `${run.suite} run timeline`, bands });
const markdown = renderReport({ run, analysis, slo, meta: { source, chart: 'charts/timeline.svg', tags, thresholds: await readThresholds(runDir) } });
await mkdir(join(runDir, 'charts'), { recursive: true });
await writeFile(join(runDir, 'charts', 'timeline.svg'), svg);
await writeFile(join(runDir, 'report.md'), markdown);
await writeFile(join(runDir, 'report.html'), markdownToHtml(markdown, { 'charts/timeline.svg': svg }));
await writeFile(join(runDir, 'report.json'), JSON.stringify({ suite: run.suite, tags, slo, startedAt: run.startedAt, endedAt: run.endedAt, analysis }, null, 2));
console.log(`Wrote ${join(runDir, 'report.md')}`);

async function readThresholds(dir) {
  const path = join(dir, 'summary.json');
  if (!existsSync(path)) return [];
  const summary = JSON.parse(await readFile(path, 'utf8'));
  // In --summary-export output a threshold maps to true when it was crossed (failed).
  return Object.entries(summary.metrics ?? {}).flatMap(([name, metric]) =>
    Object.entries(metric.thresholds ?? {}).map(([expression, failed]) => ({ name, expression, failed: failed === true })),
  );
}
