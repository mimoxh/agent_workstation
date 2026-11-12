// 测试工作台的纯逻辑：用例身份、错误聚类、不稳定判定、基线对比、发布结论、缺陷状态机

export type QaCaseStatus = 'passed' | 'failed' | 'error' | 'skipped';
export type QaRunStatus = 'queued' | 'running' | 'passed' | 'failed' | 'error' | 'canceled' | 'interrupted';

export const isFailing = (s: string | null | undefined) => s === 'failed' || s === 'error';

function hash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}

export const caseKey = (suiteId: string, classname: string, name: string) => hash(`${suiteId}\0${classname}\0${name}`);

// 只取错误的第一行，抹掉每次都变的部分（数字、地址、哈希、路径），同一个根因才能聚到一起
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

export function normalizeError(message: string | null | undefined): string {
  const line = (message ?? '').replace(ANSI, '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  return line
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
    .replace(/0x[0-9a-f]+/gi, '<addr>')
    .replace(/\b[0-9a-f]{12,64}\b/gi, '<hash>')
    .replace(/(?:[A-Za-z]:)?[\\/][^\s:'"`)]*[\\/][^\s:'"`)]+/g, '<path>')
    .replace(/\d+(?:\.\d+)?/g, '#')
    .slice(0, 300);
}

export const errorFingerprint = (message: string | null | undefined) => {
  const n = normalizeError(message);
  return n ? hash(n) : '';
};

export interface CaseSample { commitSha: string | null; status: string }
export interface Flakiness { flaky: boolean; sameCommit: boolean; flips: number; flipRate: number; runs: number }

export const FLAKY_WINDOW = 20;
const FLAKY_MIN_RUNS = 5;
const FLAKY_MIN_FLIPS = 3;
const FLAKY_FLIP_RATE = 0.3;

// samples 按时间正序。同一提交结果不一致最可信；翻转率只在样本够多时才算数，一次回归不是不稳定
export function flakiness(samples: CaseSample[]): Flakiness {
  const seen = samples.filter((s) => s.status !== 'skipped').slice(-FLAKY_WINDOW);
  const byCommit = new Map<string, Set<boolean>>();
  for (const s of seen) {
    if (!s.commitSha) continue;
    byCommit.set(s.commitSha, (byCommit.get(s.commitSha) ?? new Set()).add(isFailing(s.status)));
  }
  const sameCommit = [...byCommit.values()].some((v) => v.size > 1);
  let flips = 0;
  for (let i = 1; i < seen.length; i++) {
    if (isFailing(seen[i]!.status) !== isFailing(seen[i - 1]!.status)) flips += 1;
  }
  const flipRate = seen.length > 1 ? flips / (seen.length - 1) : 0;
  const unstable = seen.length >= FLAKY_MIN_RUNS && flips >= FLAKY_MIN_FLIPS && flipRate >= FLAKY_FLIP_RATE;
  return { flaky: sameCommit || unstable, sameCommit, flips, flipRate, runs: seen.length };
}

export interface CompareCase { caseKey: string; status: string }
export interface RunComparison { newFailures: string[]; fixed: string[]; stillFailing: string[]; added: string[]; removed: string[] }

export function compareRuns(current: CompareCase[], baseline: CompareCase[]): RunComparison {
  const base = new Map(baseline.map((c) => [c.caseKey, c.status]));
  const cur = new Set(current.map((c) => c.caseKey));
  const out: RunComparison = { newFailures: [], fixed: [], stillFailing: [], added: [], removed: baseline.filter((c) => !cur.has(c.caseKey)).map((c) => c.caseKey) };
  for (const c of current) {
    const before = base.get(c.caseKey);
    if (before === undefined) out.added.push(c.caseKey);
    if (isFailing(c.status)) (isFailing(before) ? out.stillFailing : out.newFailures).push(c.caseKey);
    else if (c.status === 'passed' && isFailing(before)) out.fixed.push(c.caseKey);
  }
  return out;
}

export interface VerdictCriteria { minPassRate: number; minCoverage: number | null; blockSeverities: string[] }
export const DEFAULT_CRITERIA: VerdictCriteria = { minPassRate: 1, minCoverage: null, blockSeverities: ['p0', 'p1'] };

export interface VerdictInput {
  runs: { suite: string; status: string; passed: number; failed: number; commitSha: string | null }[];
  openBugs: { severity: string }[];
  flaky: number;
  coverage: number | null;
  manual?: { failed: number; pending: number } | undefined;
  criteria?: Partial<VerdictCriteria> | undefined;
}
export type VerdictLevel = 'ready' | 'risk' | 'blocked' | 'unknown';
export interface VerdictReason { level: 'block' | 'risk'; text: string }
export interface Verdict { level: VerdictLevel; passRate: number | null; reasons: VerdictReason[] }

const pct = (v: number) => `${(v * 100).toFixed(v === 1 ? 0 : 1)}%`;

// failed 已扣除隔离用例；结论只陈述事实，签字由人来
export function computeVerdict(input: VerdictInput): Verdict {
  const c = { ...DEFAULT_CRITERIA, ...input.criteria };
  if (input.runs.length === 0) return { level: 'unknown', passRate: null, reasons: [{ level: 'risk', text: '还没有可用的测试结果' }] };
  const reasons: VerdictReason[] = [];
  const broken = input.runs.filter((r) => r.status !== 'passed' && r.status !== 'failed');
  for (const r of broken) reasons.push({ level: 'block', text: `套件「${r.suite}」没有跑完` });
  const passed = input.runs.reduce((n, r) => n + r.passed, 0);
  const failed = input.runs.reduce((n, r) => n + r.failed, 0);
  const passRate = passed + failed > 0 ? passed / (passed + failed) : null;
  if (passRate !== null && passRate < c.minPassRate) reasons.push({ level: 'block', text: `通过率 ${pct(passRate)}，低于准出线 ${pct(c.minPassRate)}（${failed} 个失败）` });
  for (const severity of c.blockSeverities) {
    const n = input.openBugs.filter((b) => b.severity === severity).length;
    if (n > 0) reasons.push({ level: 'block', text: `${n} 个未关闭的 ${severity.toUpperCase()} 缺陷` });
  }
  if ((input.manual?.failed ?? 0) > 0) reasons.push({ level: 'block', text: `${input.manual!.failed} 条手工用例未通过` });
  if ((input.manual?.pending ?? 0) > 0) reasons.push({ level: 'risk', text: `${input.manual!.pending} 条手工用例还没执行` });
  if (c.minCoverage !== null) {
    if (input.coverage === null) reasons.push({ level: 'risk', text: '没有覆盖率数据' });
    else if (input.coverage < c.minCoverage) reasons.push({ level: 'risk', text: `行覆盖率 ${input.coverage.toFixed(1)}%，低于 ${c.minCoverage}%` });
  }
  if (input.flaky > 0) reasons.push({ level: 'risk', text: `${input.flaky} 个不稳定用例未隔离` });
  if (new Set(input.runs.map((r) => r.commitSha)).size > 1) reasons.push({ level: 'risk', text: '各套件的结果来自不同提交' });
  const level: VerdictLevel = reasons.some((r) => r.level === 'block') ? 'blocked' : reasons.length > 0 ? 'risk' : 'ready';
  return { level, passRate, reasons };
}

export const BUG_STATUSES = ['draft', 'open', 'fixing', 'verifying', 'verified', 'reopened', 'wontfix'] as const;
export type BugStatus = (typeof BUG_STATUSES)[number];
export type BugEvent = 'confirm' | 'dispatch' | 'dev_done' | 'verify_pass' | 'verify_fail' | 'reject' | 'reopen';

const BUG_FLOW: Record<BugStatus, Partial<Record<BugEvent, BugStatus>>> = {
  draft: { confirm: 'open', reject: 'wontfix' },
  open: { dispatch: 'fixing', reject: 'wontfix' },
  fixing: { dev_done: 'verifying', verify_fail: 'reopened', reject: 'wontfix' },
  verifying: { verify_pass: 'verified', verify_fail: 'reopened' },
  reopened: { dispatch: 'fixing', reject: 'wontfix' },
  verified: { reopen: 'reopened' },
  wontfix: { reopen: 'reopened' },
};

export const bugTransition = (status: string, event: BugEvent): BugStatus | null => BUG_FLOW[status as BugStatus]?.[event] ?? null;
export const isBugOpen = (status: string) => status !== 'verified' && status !== 'wontfix' && status !== 'draft';

// 开发任务结束后的自动对账。没关联自动化用例的缺陷停在待验证，由人确认
export function reconcileBug(input: { status: string; devTaskStatus: string | null; caseStatus: string | null }): BugEvent | null {
  if (input.status === 'fixing') {
    if (input.devTaskStatus === 'done') return 'dev_done';
    if (input.devTaskStatus === 'cancelled') return 'verify_fail';
    return null;
  }
  if (input.status === 'verifying') {
    if (input.caseStatus === 'passed') return 'verify_pass';
    if (isFailing(input.caseStatus)) return 'verify_fail';
  }
  return null;
}

export type QaSchedule = 'off' | 'hourly' | 'every6h' | 'daily';

const atToday = (at: string | null | undefined, now: Date) => {
  const m = /^(\d{2}):(\d{2})$/.exec((at ?? '').trim());
  const hh = m ? Number(m[1]) : NaN;
  const mm = m ? Number(m[2]) : NaN;
  const valid = Number.isInteger(hh) && Number.isInteger(mm) && hh <= 23 && mm <= 59;
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), valid ? hh : 9, valid ? mm : 0);
};

// 定时套件的下次触发点：daily 用本机时间的 HH:MM，schedule_at 缺失或非法按 09:00
export function nextScheduledAt(schedule: string | null | undefined, scheduleAt: string | null | undefined, lastScheduledAt: string | null, now: Date): Date | null {
  const last = lastScheduledAt ? new Date(lastScheduledAt) : null;
  if (schedule === 'hourly') return last ? new Date(last.getTime() + 3600_000) : now;
  if (schedule === 'every6h') return last ? new Date(last.getTime() + 6 * 3600_000) : now;
  if (schedule === 'daily') {
    const todayAt = atToday(scheduleAt, now);
    const ranToday = last !== null && last.getTime() >= todayAt.getTime();
    return ranToday ? new Date(todayAt.getTime() + 24 * 3600_000) : todayAt;
  }
  return null;
}

export function scheduleDue(schedule: string | null | undefined, scheduleAt: string | null | undefined, lastScheduledAt: string | null, now: Date): boolean {
  const next = nextScheduledAt(schedule, scheduleAt, lastScheduledAt, now);
  return next !== null && now.getTime() >= next.getTime();
}
