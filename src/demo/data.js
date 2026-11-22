/**
 * Deterministic demo dataset for the Canvas chart.
 *
 * ONLY the showcase page (and the accuracy tests) may import this module.
 * The collector must never import it: it reads the page's visible legend,
 * tooltip text and pixels instead.
 */

export const BASE_MS = Date.UTC(2024, 0, 1, 0, 0, 0);
export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;

export const SERIES = [
  { id: 's1', name: '边缘 A 区', color: '#2a78d6', colorDark: '#3987e5', cadence: { stepDays: 1, offsetHours: 0, label: '每日 00:00 UTC' } },
  { id: 's2', name: '边缘 B 区', color: '#eb6834', colorDark: '#d95926', cadence: { stepDays: 1, offsetHours: 0, label: '每日 00:00 UTC' } },
  { id: 's3', name: '边缘 C 区', color: '#1baf7a', colorDark: '#199e70', cadence: { stepDays: 1, offsetHours: 0, label: '每日 00:00 UTC' } },
  { id: 's4', name: '回源中心', color: '#6250d6', colorDark: '#9085e9', cadence: { stepDays: 2, offsetHours: 12, label: '每 2 天 12:00 UTC' } },
];

/** Days on which the daily series publish, inclusive. */
export const COVERAGE = { startDay: 0, endDay: 167, s4EndDay: 166.5 };

/** Intra-day samples, revealed by the page's 密集点 switch. */
export const DENSE = { startDay: 44, endDay: 47, stepHours: 2, appliesTo: ['s1', 's2', 's3'] };

/** `${day}:${seriesId}` — the cadence promises a value, the page has none. */
export const DAILY_GAPS = [
  [23, 's1'], [24, 's1'], [25, 's1'],
  [61, 's2'], [62, 's2'],
  [88, 's3'], [89, 's3'], [90, 's3'], [91, 's3'],
];

/** A whole day with no daily record at all: the line breaks for every daily series. */
export const BLACKOUT_DAYS = [132];

/** Genuine zero readings — must never be reported as missing. */
export const DAILY_ZEROS = [
  [101, 's3'],
  [140, 's2'],
];

export const OFFSET_GAPS = [60.5, 62.5];
export const OFFSET_ZEROS = [100.5];

/** Extra-sample gaps and one zero inside the dense run (hour slots per day). */
export const DENSE_GAPS = [
  [45, 4, 's2'],
  [46, 12, 's1'],
];
export const DENSE_ZEROS = [[46, 18, 's3']];

function rand01(seed) {
  let t = (seed + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), 1 | t);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function msForDay(day) {
  return BASE_MS + Math.round(day * DAY_MS);
}

export function dayForMs(ms) {
  return (ms - BASE_MS) / DAY_MS;
}

export function utcLabel(ms, { seconds = true } = {}) {
  const iso = new Date(ms).toISOString();
  return iso.slice(0, seconds ? 19 : 16).replace('T', ' ') + ' UTC';
}

export function isoDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function dailyValue(day, seriesId) {
  const n = rand01(day * 101 + seriesId.charCodeAt(1) * 7);
  switch (seriesId) {
    case 's1':
      return Math.round(44 + 18 * Math.sin(day / 9.3) + 8 * Math.sin(day / 2.9 + 0.9) + (n - 0.5) * 6);
    case 's2':
      return Math.round(59 + 15 * Math.cos(day / 12.4) + (n - 0.5) * 8);
    case 's3':
      return Math.round(27 + 10 * Math.sin(day / 5.2 + 2.1) + (n - 0.5) * 5);
    default:
      return null;
  }
}

function offsetValue(day) {
  const n = rand01(Math.round(day * 2) * 37 + 11);
  return Math.round(14 + 7 * Math.sin(day / 7.5 + 4.2) + (n - 0.5) * 4);
}

const gapSet = new Set(DAILY_GAPS.map(([d, k]) => `${d}:${k}`));
const zeroSet = new Set(DAILY_ZEROS.map(([d, k]) => `${d}:${k}`));
const blackoutSet = new Set(BLACKOUT_DAYS);
const denseGapSet = new Set(DENSE_GAPS.map(([d, h, k]) => `${d}:${h}:${k}`));
const denseZeroSet = new Set(DENSE_ZEROS.map(([d, h, k]) => `${d}:${h}:${k}`));

/** All points at least one series publishes, sorted by time. */
export function buildData({ dense = false } = {}) {
  const points = [];
  const push = (ms, values, meta = {}) => {
    const clean = Object.fromEntries(Object.entries(values).filter(([, v]) => v != null));
    if (Object.keys(clean).length === 0) return;
    points.push({ ms, day: dayForMs(ms), values: clean, ...meta });
  };

  for (let day = COVERAGE.startDay; day <= COVERAGE.endDay; day++) {
    if (blackoutSet.has(day)) continue;
    const values = {};
    for (const s of SERIES) {
      if (s.id === 's4') continue;
      const key = `${day}:${s.id}`;
      values[s.id] = zeroSet.has(key) ? 0 : gapSet.has(key) ? null : dailyValue(day, s.id);
    }
    push(msForDay(day), values, { daily: true });
  }

  // 回源中心 keeps its own two-day cadence at 12:00 UTC.
  for (let day = 0.5; day <= COVERAGE.s4EndDay + 1e-9; day += 2) {
    if (OFFSET_GAPS.some((g) => Math.abs(g - day) < 1e-9)) continue;
    const zero = OFFSET_ZEROS.some((z) => Math.abs(z - day) < 1e-9);
    push(msForDay(day), { s4: zero ? 0 : offsetValue(day) }, { offset: true });
  }

  if (dense) {
    const stepMs = DENSE.stepHours * HOUR_MS;
    const from = msForDay(DENSE.startDay);
    const to = msForDay(DENSE.endDay);
    for (let ms = from + stepMs; ms < to; ms += stepMs) {
      if (ms % DAY_MS === 0) continue; // the daily sample already covers midnight
      const day = Math.floor(dayForMs(ms));
      const hour = Math.round((dayForMs(ms) - day) * 24);
      const values = {};
      for (const s of SERIES) {
        if (!DENSE.appliesTo.includes(s.id)) continue;
        const key = `${day}:${hour}:${s.id}`;
        values[s.id] = denseZeroSet.has(key)
          ? 0
          : denseGapSet.has(key)
            ? null
            : Math.round(
                dailyValue(day, s.id) +
                  ((dailyValue(day + 1, s.id) - dailyValue(day, s.id)) * hour) / 24 +
                  (rand01(ms / HOUR_MS + s.id.charCodeAt(1)) - 0.5) * 5,
              );
      }
      push(ms, values, { dense: true });
    }
  }

  points.sort((a, b) => a.ms - b.ms);
  // Records sharing an exact timestamp are presented by the page as one point:
  // the tooltip lists every visible series at that time (无记录 where absent).
  const merged = [];
  for (const p of points) {
    const prev = merged[merged.length - 1];
    if (prev && prev.ms === p.ms) {
      prev.values = { ...prev.values, ...p.values };
      prev.dense = prev.dense || p.dense;
      prev.offset = prev.offset || p.offset;
      prev.daily = prev.daily || p.daily;
    } else {
      merged.push({ ...p, values: { ...p.values } });
    }
  }
  return {
    points: merged,
    minMs: merged[0].ms,
    maxMs: merged[merged.length - 1].ms,
  };
}

/** Scheduled publication times for one series (visible cadence, not extras). */
export function scheduleTimes(seriesId, { dense = false, fromMs = -Infinity, toMs = Infinity } = {}) {
  const s = SERIES.find((x) => x.id === seriesId);
  if (!s) return [];
  const anchor = BASE_MS + s.cadence.offsetHours * HOUR_MS;
  const step = s.cadence.stepDays * DAY_MS;
  const coverageEnd = msForDay(seriesId === 's4' ? COVERAGE.s4EndDay : COVERAGE.endDay);
  const lo = Math.max(fromMs, BASE_MS);
  const hi = Math.min(toMs, coverageEnd);
  const out = [];
  if (lo <= hi) {
    for (let k = Math.max(0, Math.ceil((lo - anchor) / step)); ; k++) {
      const t = anchor + k * step;
      if (t > hi) break;
      if (t >= lo) out.push(t);
    }
  }
  if (dense && DENSE.appliesTo.includes(seriesId)) {
    const from = msForDay(DENSE.startDay);
    const to = msForDay(DENSE.endDay);
    const stepMs = DENSE.stepHours * HOUR_MS;
    for (let t = from + stepMs; t < to; t += stepMs) {
      if (t % DAY_MS === 0) continue;
      if (t >= lo && t <= hi && !out.includes(t)) out.push(t);
    }
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

/** Test-only ground truth, including emulated missing cells. */
export function groundTruth({ dense = false, fromMs = -Infinity, toMs = Infinity } = {}) {
  const { points } = buildData({ dense });
  const confirmed = [];
  for (const p of points) {
    if (p.ms < fromMs || p.ms > toMs) continue;
    for (const s of SERIES) {
      const v = p.values[s.id];
      if (v == null) continue;
      confirmed.push({
        seriesId: s.id,
        seriesName: s.name,
        ms: p.ms,
        value: v,
        kind: v === 0 ? 'zero' : p.dense ? 'dense' : 'value',
      });
    }
  }
  const missing = [];
  const byMs = new Map();
  for (const p of points) {
    const cur = byMs.get(p.ms) || {};
    byMs.set(p.ms, { ...cur, ...p.values });
  }
  for (const s of SERIES) {
    for (const ms of scheduleTimes(s.id, { dense, fromMs, toMs })) {
      const row = byMs.get(ms);
      if (row && row[s.id] != null) continue;
      missing.push({ seriesId: s.id, seriesName: s.name, ms, reason: row ? 'tooltip-null' : 'no-point' });
    }
  }
  return { confirmed, missing };
}
