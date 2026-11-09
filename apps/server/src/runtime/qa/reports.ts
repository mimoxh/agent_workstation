import { XMLParser } from 'fast-xml-parser';

export const MAX_CASES = 20000;
const MESSAGE_LIMIT = 4000;
const DETAIL_LIMIT = 8000;
const MAX_COVERAGE_FILES = 3000;

export interface ParsedCase { classname: string; name: string; status: 'passed' | 'failed' | 'error' | 'skipped'; durationMs: number; failureMessage: string | null; failureDetail: string | null }

export interface CoverageFile { path: string; lines: number | null; branches: number | null; functions: number | null }
export interface Coverage { lines: number | null; statements: number | null; branches: number | null; functions: number | null; files: CoverageFile[] }

// 报告是被测代码写的，按不可信处理：不展开实体，只解码 XML 预定义和数字引用
const NAMED: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const decode = (s: string) =>
  s.replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|(lt|gt|amp|quot|apos));/gi, (whole, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
    if (name) return NAMED[name.toLowerCase()] ?? whole;
    const code = dec ? Number(dec) : parseInt(hex ?? '', 16);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  textNodeName: '#text',
  processEntities: false,
  htmlEntities: false,
  parseTagValue: false,
  parseAttributeValue: false,
  isArray: (name) => name === 'testsuite' || name === 'testcase' || name === 'failure' || name === 'error',
});

type Node = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' ? decode(v) : '');
const isNode = (v: unknown): v is Node => typeof v === 'object' && v !== null;

function problemOf(raw: unknown): { message: string; detail: string } {
  const first = Array.isArray(raw) ? (raw[0] as unknown) : raw;
  if (!isNode(first)) {
    const text = str(first);
    return { message: text.split('\n').find((l) => l.trim()) ?? '', detail: text };
  }
  const text = str(first['#text']);
  const message = str(first.message) || str(first.type) || (text.split('\n').find((l) => l.trim()) ?? '');
  return { message, detail: text };
}

function readCase(tc: Node, suiteName: string): ParsedCase {
  const seconds = Number(str(tc.time));
  const base = { classname: str(tc.classname) || suiteName, name: str(tc.name) || '(unnamed)', durationMs: Number.isFinite(seconds) ? Math.round(seconds * 1000) : 0 };
  const problem = tc.failure !== undefined ? ('failed' as const) : tc.error !== undefined ? ('error' as const) : null;
  if (problem) {
    const p = problemOf(tc.failure ?? tc.error);
    return { ...base, status: problem, failureMessage: p.message.slice(0, MESSAGE_LIMIT), failureDetail: p.detail.slice(0, DETAIL_LIMIT) };
  }
  return { ...base, status: tc.skipped !== undefined ? 'skipped' : 'passed', failureMessage: null, failureDetail: null };
}

function walk(suite: Node, out: ParsedCase[]) {
  const name = str(suite.name);
  for (const tc of (suite.testcase as Node[] | undefined) ?? []) {
    if (out.length >= MAX_CASES) return;
    if (isNode(tc)) out.push(readCase(tc, name));
  }
  for (const child of (suite.testsuite as Node[] | undefined) ?? []) if (isNode(child)) walk(child, out);
}

export function parseJUnit(xml: string): ParsedCase[] {
  const doc = parser.parse(xml) as Node;
  const root = isNode(doc.testsuites) ? (doc.testsuites.testsuite as Node[] | undefined) : (doc.testsuite as Node[] | undefined);
  if (!root && !isNode(doc.testsuites)) throw new Error('不是 JUnit XML（缺少 testsuites / testsuite）');
  const out: ParsedCase[] = [];
  for (const s of root ?? []) if (isNode(s)) walk(s, out);
  return out;
}

const toPct = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const ratio = (hit: number, found: number) => (found > 0 ? Math.round((hit / found) * 10000) / 100 : null);

function relative(file: string, root: string) {
  const f = file.replace(/\\/g, '/');
  const r = root.replace(/\\/g, '/').replace(/\/+$/, '');
  return f.toLowerCase().startsWith(`${r.toLowerCase()}/`) ? f.slice(r.length + 1) : f;
}

interface SummaryEntry { lines?: { pct?: unknown }; statements?: { pct?: unknown }; branches?: { pct?: unknown }; functions?: { pct?: unknown } }

function parseSummary(content: string, root: string): Coverage {
  const doc = JSON.parse(content) as Record<string, SummaryEntry>;
  if (!doc.total) throw new Error('coverage-summary.json 缺少 total');
  const files = Object.entries(doc).filter(([k]) => k !== 'total').slice(0, MAX_COVERAGE_FILES).map(([k, v]) => ({ path: relative(k, root), lines: toPct(v.lines?.pct), branches: toPct(v.branches?.pct), functions: toPct(v.functions?.pct) }));
  return { lines: toPct(doc.total.lines?.pct), statements: toPct(doc.total.statements?.pct), branches: toPct(doc.total.branches?.pct), functions: toPct(doc.total.functions?.pct), files };
}

function parseLcov(content: string, root: string): Coverage {
  const files: CoverageFile[] = [];
  const total = { lf: 0, lh: 0, brf: 0, brh: 0, fnf: 0, fnh: 0 };
  let cur = { path: '', lf: 0, lh: 0, brf: 0, brh: 0, fnf: 0, fnh: 0 };
  for (const line of content.split('\n')) {
    const t = line.trim();
    if (t.startsWith('SF:')) cur = { path: relative(t.slice(3), root), lf: 0, lh: 0, brf: 0, brh: 0, fnf: 0, fnh: 0 };
    else if (t === 'end_of_record') {
      if (cur.path && files.length < MAX_COVERAGE_FILES) files.push({ path: cur.path, lines: ratio(cur.lh, cur.lf), branches: ratio(cur.brh, cur.brf), functions: ratio(cur.fnh, cur.fnf) });
      for (const k of ['lf', 'lh', 'brf', 'brh', 'fnf', 'fnh'] as const) total[k] += cur[k];
    } else {
      const m = /^(LF|LH|BRF|BRH|FNF|FNH):(\d+)$/.exec(t);
      if (m) cur[m[1]!.toLowerCase() as 'lf'] = Number(m[2]);
    }
  }
  if (files.length === 0) throw new Error('lcov 报告里没有文件记录');
  return { lines: ratio(total.lh, total.lf), statements: null, branches: ratio(total.brh, total.brf), functions: ratio(total.fnh, total.fnf), files };
}

export const parseCoverage = (content: string, root: string): Coverage => (content.trimStart().startsWith('{') ? parseSummary(content, root) : parseLcov(content, root));
