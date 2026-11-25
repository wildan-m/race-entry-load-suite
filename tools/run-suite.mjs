#!/usr/bin/env node
// Runs one k6 suite into its own results directory and builds the report from it.
//
//   node tools/run-suite.mjs levels
//   node tools/run-suite.mjs spike --dashboard          live charts on http://127.0.0.1:5665
//   PROFILE=staging API_BASE=... FIREBASE_API_KEY=... node tools/run-suite.mjs levels -- --tag run=rc2
//
// Everything after "--" goes to k6. PROFILE, RACE_ID, LEVELS and the other load/lib/config.js
// settings are read from the environment by the k6 scripts themselves.

import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SUITES = ['levels', 'spike', 'soak', 'breakpoint'];
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const separator = process.argv.indexOf('--');
const own = separator === -1 ? process.argv.slice(2) : process.argv.slice(2, separator);
const k6Extra = separator === -1 ? [] : process.argv.slice(separator + 1);
const suite = own.find((arg) => !arg.startsWith('--'));
const dashboard = own.includes('--dashboard');
if (!SUITES.includes(suite)) {
  console.error(`usage: node tools/run-suite.mjs <${SUITES.join('|')}> [--dashboard] [-- <k6 args>]`);
  process.exit(2);
}

const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
const runName = [suite, process.env.PROFILE ?? 'local', process.env.RACE_ID ?? 'kbhm-2027', stamp].join('_');
const runDir = join(root, 'results', runName);
await mkdir(runDir, { recursive: true });

const env = { ...process.env };
if (dashboard) {
  env.K6_WEB_DASHBOARD = 'true';
  env.K6_WEB_DASHBOARD_EXPORT = join(runDir, 'dashboard.html');
}

const k6Args = [
  'run',
  '--summary-export',
  join(runDir, 'summary.json'),
  '--out',
  `json=${join(runDir, 'metrics.json.gz')}`,
  ...k6Extra,
  join(root, 'load', `${suite}.js`),
];
console.log(`k6 ${k6Args.join(' ')}`);
const k6Exit = await run('k6', k6Args, env);
// 99 means thresholds were crossed: the run itself is valid and still gets a report.
if (k6Exit !== 0 && k6Exit !== 99) {
  console.error(`k6 exited with ${k6Exit}; no report built`);
  process.exit(k6Exit);
}
await run(process.execPath, [join(root, 'report', 'build-report.mjs'), runDir], process.env);
console.log(`Results: ${runDir}`);
process.exit(k6Exit);

function run(command, args, childEnv) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', env: childEnv, cwd: root });
    child.on('error', reject);
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}
