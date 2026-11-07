export const shortId = (id: string | null | undefined) => (id ? id.slice(0, 8) : '—');

export const num = (n: number | null | undefined) => (n ?? 0).toLocaleString('en-US');

export function tokens(n: number | null | undefined) {
  const v = n ?? 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 10_000) return `${(v / 1000).toFixed(1)}k`;
  return num(v);
}

// 成本存微美元；没配单价时显示占位，不假装是 0 元
export const money = (micros: number | null | undefined) => (micros ? `$${(micros / 1e6).toFixed(micros < 10_000 ? 4 : 2)}` : '—');

const pad = (n: number) => String(n).padStart(2, '0');

export function clock(iso: string | null | undefined) {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function when(iso: string | null | undefined, now = new Date()) {
  if (!iso) return '—';
  const d = new Date(iso);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay ? hm : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`;
}

export function duration(start: string | null | undefined, end?: string | null, now = Date.now()) {
  if (!start) return '—';
  const ms = (end ? new Date(end).getTime() : now) - new Date(start).getTime();
  return seconds(ms / 1000);
}

export function seconds(s: number | null | undefined) {
  const v = s ?? 0;
  if (v < 60) return `${v.toFixed(1)}s`;
  const m = Math.floor(v / 60);
  return `${m}:${pad(Math.floor(v % 60))}`;
}

export function bytes(n: number | null | undefined) {
  if (n === null || n === undefined) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function parseJson<T>(json: string | null | undefined, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}
