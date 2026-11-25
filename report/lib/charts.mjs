// Static SVG timeline for the Markdown report: four small multiples on one shared time axis
// (users, throughput, p95 latency, failed requests), one series and one y-scale per panel.
// Colours carry their own dark-mode steps, picked up from prefers-color-scheme.

const WIDTH = 960;
const LEFT = 64;
const RIGHT = 24;
const TOP = 58;
const PANEL = 110;
const GAP = 34;
const BOTTOM = 44;
const MAX_POINTS = 900;

const STYLE = `
  .viz { --surface:#ffffff; --ink:#191919; --ink-2:#666666; --grid:#e7e7e7; --axis:#c2c2c2; --band:#f3f3f3; --series:#257de0; }
  @media (prefers-color-scheme: dark) {
    .viz { --surface:#191919; --ink:#efefef; --ink-2:#9c9c9c; --grid:#303030; --axis:#474747; --band:#232323; --series:#338ced; }
  }
  .viz text { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
  .bg { fill: var(--surface); }
  .band { fill: var(--band); }
  .band-label { fill: var(--ink-2); font-size: 11px; }
  .title { fill: var(--ink); font-size: 13px; font-weight: 600; }
  .tick { fill: var(--ink-2); font-size: 11px; font-variant-numeric: tabular-nums; }
  .grid { stroke: var(--grid); stroke-width: 1; }
  .axis { stroke: var(--axis); stroke-width: 1; }
  .line { fill: none; stroke: var(--series); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
  .area { fill: var(--series); fill-opacity: 0.1; stroke: none; }
`;

const PANELS = [
  { key: 'vus', title: 'Active virtual users (concurrent runners)', format: compact, area: true },
  { key: 'rps', title: 'Requests per second', format: compact },
  { key: 'p95', title: 'p95 latency, all steps (ms)', format: compact },
  { key: 'errorRate', title: 'Failed requests (%)', format: (v) => `${trim(v * 100)}%` },
];

/**
 * @param {{t: number, vus: number, rps: number, p95: number | null, errorRate: number | null}[]} timeline
 * @param {{title: string, bands?: {from: number, to: number, label: string}[]}} options
 * @returns {string}
 */
export function renderTimeline(timeline, { title, bands = [] }) {
  const points = downsample(timeline, MAX_POINTS);
  const tMax = Math.max(1, ...points.map((p) => p.t));
  const plotWidth = WIDTH - LEFT - RIGHT;
  const x = (t) => LEFT + (t / tMax) * plotWidth;
  const height = TOP + PANELS.length * (PANEL + GAP) - GAP + BOTTOM;
  const parts = [];

  parts.push(`<rect class="bg" x="0" y="0" width="${WIDTH}" height="${height}"/>`);
  for (const band of bands) {
    const x0 = x(Math.max(0, band.from));
    const x1 = x(Math.min(tMax, band.to));
    if (x1 - x0 < 1) continue;
    // Labels sit in their own strip above the first panel title, so they never collide with it.
    parts.push(`<rect class="band" x="${f(x0)}" y="26" width="${f(x1 - x0)}" height="${height - 26 - BOTTOM + 4}"/>`);
    parts.push(`<text class="band-label" x="${f((x0 + x1) / 2)}" y="18" text-anchor="middle">${esc(band.label)}</text>`);
  }

  PANELS.forEach((panel, i) => {
    const top = TOP + i * (PANEL + GAP);
    const bottom = top + PANEL;
    const values = points.map((p) => p[panel.key]).filter((v) => v !== null && v !== undefined);
    const ticks = niceTicks(Math.max(...values, panel.key === 'errorRate' ? 0.01 : 1));
    const yMax = ticks[ticks.length - 1];
    const y = (v) => bottom - (v / yMax) * PANEL;

    parts.push(`<text class="title" x="${LEFT}" y="${top - 10}">${esc(panel.title)}</text>`);
    for (const tick of ticks) {
      const yy = f(y(tick));
      parts.push(`<line class="${tick === 0 ? 'axis' : 'grid'}" x1="${LEFT}" x2="${WIDTH - RIGHT}" y1="${yy}" y2="${yy}"/>`);
      parts.push(`<text class="tick" x="${LEFT - 8}" y="${f(y(tick) + 4)}" text-anchor="end">${panel.format(tick)}</text>`);
    }

    const segments = pathSegments(points, panel.key, x, y);
    if (panel.area) {
      for (const seg of segments) {
        if (seg.length < 2) continue;
        const d = `M${f(seg[0][0])},${f(bottom)} ${seg.map(([px, py]) => `L${f(px)},${f(py)}`).join(' ')} L${f(seg[seg.length - 1][0])},${f(bottom)}Z`;
        parts.push(`<path class="area" d="${d}"/>`);
      }
    }
    for (const seg of segments) {
      const d = seg.map(([px, py], j) => `${j === 0 ? 'M' : 'L'}${f(px)},${f(py)}`).join(' ');
      parts.push(`<path class="line" d="${d}"/>`);
    }
  });

  const axisY = TOP + PANELS.length * (PANEL + GAP) - GAP;
  for (const t of timeTicks(tMax)) {
    parts.push(`<text class="tick" x="${f(x(t))}" y="${axisY + 18}" text-anchor="middle">${clock(t)}</text>`);
  }
  parts.push(`<text class="tick" x="${WIDTH - RIGHT}" y="${axisY + 36}" text-anchor="end">elapsed time (min:s)</text>`);

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" class="viz" viewBox="0 0 ${WIDTH} ${height}" width="${WIDTH}" height="${height}" role="img" aria-labelledby="t d">`,
    `<title id="t">${esc(title)}</title>`,
    `<desc id="d">Four panels over elapsed time: active virtual users, requests per second, p95 latency in milliseconds, and the share of failed requests. Shaded spans are the phases the report tables summarise.</desc>`,
    `<style>${STYLE}</style>`,
    ...parts,
    '</svg>',
  ].join('\n');
}

/** Splits a series at missing values so a gap in data is drawn as a gap. */
function pathSegments(points, key, x, y) {
  const segments = [];
  let current = [];
  for (const p of points) {
    const v = p[key];
    if (v === null || v === undefined) {
      if (current.length) segments.push(current);
      current = [];
      continue;
    }
    current.push([x(p.t), y(v)]);
  }
  if (current.length) segments.push(current);
  return segments;
}

/** Buckets a long timeline down to at most `max` points: peaks for users, latency and errors, mean for throughput. */
export function downsample(timeline, max) {
  if (timeline.length <= max) return timeline;
  const size = Math.ceil(timeline.length / max);
  const out = [];
  for (let i = 0; i < timeline.length; i += size) {
    const chunk = timeline.slice(i, i + size);
    const pick = (key, reduce) => {
      const vals = chunk.map((p) => p[key]).filter((v) => v !== null && v !== undefined);
      if (vals.length === 0) return null;
      return reduce === 'mean' ? vals.reduce((a, b) => a + b, 0) / vals.length : Math.max(...vals);
    };
    out.push({
      t: chunk[0].t,
      vus: pick('vus', 'max'),
      rps: pick('rps', 'mean'),
      p95: pick('p95', 'max'),
      errorRate: pick('errorRate', 'max'),
    });
  }
  return out;
}

/** Three or four clean ticks from zero: steps of 1, 2, 2.5 or 5 times a power of ten. */
export function niceTicks(max) {
  const rough = max / 3;
  const power = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * power).find((s) => s >= rough);
  const ticks = [];
  for (let v = 0; v < max + step * 0.999; v += step) ticks.push(Number(v.toPrecision(12)));
  return ticks;
}

function timeTicks(tMax) {
  const step = [15, 30, 60, 120, 300, 600, 900, 1800, 3600].find((s) => tMax / s <= 10) ?? 7200;
  const ticks = [];
  for (let t = 0; t <= tMax; t += step) ticks.push(t);
  return ticks;
}

function clock(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function compact(v) {
  if (v >= 10000) return `${trim(v / 1000)}K`;
  return v.toLocaleString('en-US', { maximumFractionDigits: v < 10 ? 2 : 0 });
}

function trim(v) {
  return Number(v.toFixed(2)).toString();
}

function f(v) {
  return Number(v.toFixed(1)).toString();
}

function esc(text) {
  return String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}
