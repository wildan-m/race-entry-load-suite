// Pure decision helpers for the runner journey. No k6 imports, so they run under node --test too.

// What runners do on opening day. Most come to enter; some come back to check they are in;
// a few only look at the waves. Replace these shares with the site's own analytics before a run.
export const VISIT_MIX = [
  ['enter', 0.6],
  ['check', 0.3],
  ['browse', 0.1],
];

// First-choice wave demand. Wave A is the most wanted but holds only 15% of the places, so it fills first.
export const WAVE_DEMAND = [
  ['A', 30],
  ['B', 25],
  ['C', 20],
  ['D', 12],
  ['E', 8],
  ['F', 5],
];

/**
 * First choice by demand weight among waves the listing shows with places left, then the rest
 * of those waves in start order.
 * @param {{id: string, remaining: number}[]} waves
 * @param {() => number} random
 * @returns {string[]}
 */
export function preferenceOrder(waves, random = Math.random) {
  const open = waves.filter((w) => w.remaining > 0).map((w) => w.id);
  if (open.length === 0) return [];
  const weighted = WAVE_DEMAND.filter(([id]) => open.includes(id));
  const first = weighted.length > 0 ? pickWeighted(weighted, random) : open[0];
  return [first, ...open.filter((id) => id !== first)];
}

/**
 * @template T
 * @param {[T, number][]} options
 * @param {() => number} random
 * @returns {T}
 */
export function pickWeighted(options, random = Math.random) {
  const total = options.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = random() * total;
  for (const [value, weight] of options) {
    roll -= weight;
    if (roll < 0) return value;
  }
  return options[options.length - 1][0];
}
