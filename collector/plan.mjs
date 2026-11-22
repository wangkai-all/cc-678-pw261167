/**
 * Cadence parsing from the page's *visible* sampling text.
 * Nothing here imports demo data; it only interprets text a reader can see.
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export function cadenceFromLabel(label) {
  const m = String(label || '').match(/每\s*(日|(\d+)\s*天)\s*(\d{1,2}):(\d{2})\s*UTC/);
  if (!m) return null;
  return {
    stepDays: m[2] ? Number(m[2]) : 1,
    offsetHours: Number(m[3]),
    offsetMinutes: Number(m[4]),
    label: String(label).trim(),
  };
}

export function parseDenseNote(text) {
  const m = String(text || '').match(
    /密集点已开启[：:](.+?)\s*在\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\s*(?:UTC)?\s*至\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\s*(?:UTC)?\s*每\s*(\d+)\s*小时/,
  );
  if (!m) return null;
  const names = m[1].split(/[、,，]/).map((s) => s.trim()).filter(Boolean);
  const parse = (s) => Date.parse(s.replace(' ', 'T') + ':00Z');
  return {
    names,
    fromMs: parse(m[2]),
    toMs: parse(m[3]),
    stepHours: Number(m[4]),
  };
}

/** The UTC midnight that anchors the page's cadence grid. */
export function anchorDayMs(coverageFromMs) {
  const d = new Date(coverageFromMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export function scheduledTimes({ cadence, coverage, fromMs, toMs }) {
  if (!cadence) return [];
  const anchor = anchorDayMs(coverage.fromMs) + cadence.offsetHours * HOUR_MS + cadence.offsetMinutes * 60_000;
  const step = cadence.stepDays * DAY_MS;
  const lo = Math.max(fromMs ?? coverage.fromMs, coverage.fromMs);
  const hi = Math.min(toMs ?? coverage.toMs, coverage.toMs);
  if (lo > hi) return [];
  const out = [];
  for (let k = Math.floor((lo - anchor) / step); ; k++) {
    const t = anchor + k * step;
    if (t > hi) break;
    if (t >= lo) out.push(t);
  }
  return out;
}

/** Extra intra-day sampling announced by the dense switch, when visible. */
export function denseTimes({ denseNote, seriesName, coverage, fromMs, toMs }) {
  if (!denseNote || !denseNote.names.includes(seriesName)) return [];
  const step = denseNote.stepHours * HOUR_MS;
  const lo = Math.max(fromMs ?? coverage.fromMs, coverage.fromMs);
  const hi = Math.min(toMs ?? coverage.toMs, coverage.toMs);
  const out = [];
  for (let t = denseNote.fromMs + step; t < denseNote.toMs; t += step) {
    if (t % DAY_MS === 0) continue;
    if (t >= lo && t <= hi) out.push(t);
  }
  return out;
}

export function targetsForSeries({ series, coverage, window, denseNote }) {
  const cadence = cadenceFromLabel(series.cadence);
  const times = new Set(scheduledTimes({ cadence, coverage, fromMs: window.fromMs, toMs: window.toMs }));
  for (const t of denseTimes({ denseNote, seriesName: series.name, coverage, fromMs: window.fromMs, toMs: window.toMs })) {
    times.add(t);
  }
  return [...times].sort((a, b) => a - b).map((ms) => ({
    seriesName: series.name,
    ms,
    scheduled: cadence ? scheduledTimes({ cadence, coverage, fromMs: ms, toMs: ms }).includes(ms) : false,
  }));
}
