export const BASE_MS = Date.UTC(2024, 0, 1, 0, 0, 0);
export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;

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

export function isoDateTime(ms) {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

export function parseUtcLabel(text) {
  const m = String(text || '').match(/(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  const [, y, mo, d, h = '0', mi = '0', s = '0'] = m;
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
}

export function fmtNumber(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 10) / 10);
}
