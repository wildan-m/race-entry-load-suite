// Fictional race and wave layout. Every person and record the tools create is test data.

export const RACE_NAME = 'Kestrel Bay Half Marathon 2027';

/** The same race twice, once per counter design, so both can be measured on one deployment. */
export const RACES = [
  { id: 'kbhm-2027', counterMode: 'partitioned', bucketsPerWave: 8 },
  { id: 'kbhm-2027-single', counterMode: 'single', bucketsPerWave: 1 },
];

/**
 * Share of the total places each wave gets. Wave A is deliberately smaller than its demand
 * (see load/lib/journey.js), so it sells out mid-test and the fallback path gets exercised.
 */
export const WAVES = [
  { id: 'A', label: 'Wave A - sub 1:30', startTime: '08:00', share: 0.15 },
  { id: 'B', label: 'Wave B - 1:30 to 1:45', startTime: '08:10', share: 0.2 },
  { id: 'C', label: 'Wave C - 1:45 to 2:00', startTime: '08:20', share: 0.2 },
  { id: 'D', label: 'Wave D - 2:00 to 2:15', startTime: '08:30', share: 0.2 },
  { id: 'E', label: 'Wave E - 2:15 to 2:30', startTime: '08:40', share: 0.15 },
  { id: 'F', label: 'Wave F - 2:30 and over', startTime: '08:50', share: 0.1 },
];

/**
 * Splits a total into integer parts by share, handing the rounding remainder to the largest
 * fractional parts so the parts always add up to the total.
 * @param {number} total
 * @param {number[]} shares
 * @returns {number[]}
 */
export function splitByShare(total, shares) {
  const raw = shares.map((share) => total * share);
  const parts = raw.map(Math.floor);
  let remainder = total - parts.reduce((a, b) => a + b, 0);
  const byFraction = raw.map((value, i) => ({ i, fraction: value - Math.floor(value) })).sort((a, b) => b.fraction - a.fraction);
  for (const { i } of byFraction) {
    if (remainder <= 0) break;
    parts[i] += 1;
    remainder -= 1;
  }
  return parts;
}

/** @param {number} n 1-based runner number */
export function runnerIdentity(n) {
  return {
    uid: `runner-${String(n).padStart(5, '0')}`,
    email: `runner${n}@kestrelbay-run.test`,
    displayName: `Test Runner ${n}`,
  };
}
