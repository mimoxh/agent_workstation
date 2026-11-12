import { describe, expect, it } from 'vitest';
import { bugTransition, caseKey, compareRuns, computeVerdict, errorFingerprint, flakiness, isBugOpen, normalizeError, nextScheduledAt, reconcileBug, scheduleDue } from '../src/qa.js';

const run = (status: string, commitSha = 'c') => ({ status, commitSha });

describe('错误指纹', () => {
  it('数字、路径、地址不同的同类错误聚到一起', () => {
    expect(errorFingerprint('expected 3 to be 4')).toBe(errorFingerprint('expected 10 to be 20'));
    expect(errorFingerprint('cannot read C:\\a\\b.ts at 0x1f')).toBe(errorFingerprint('cannot read /tmp/x/y.ts at 0x2e'));
    expect(errorFingerprint('expected 3 to be 4')).not.toBe(errorFingerprint('timeout after 3ms'));
  });
  it('只看第一行并去掉颜色控制符', () => {
    expect(normalizeError('\u001b[31mboom\u001b[0m\n  at foo')).toBe('boom');
  });
  it('空消息没有指纹', () => expect(errorFingerprint('')).toBe(''));
});

describe('用例身份', () => {
  it('同名用例在不同套件里是不同的 key', () => {
    expect(caseKey('s1', 'a', 'b')).toBe(caseKey('s1', 'a', 'b'));
    expect(caseKey('s1', 'a', 'b')).not.toBe(caseKey('s2', 'a', 'b'));
  });
});

describe('不稳定判定', () => {
  it('同一提交结果不一致，一次就算', () => {
    expect(flakiness([run('passed'), run('failed')])).toMatchObject({ flaky: true, sameCommit: true });
  });
  it('一次回归不算不稳定', () => {
    const s = [run('passed', 'a'), run('passed', 'b'), run('passed', 'c'), run('failed', 'd'), run('failed', 'e'), run('failed', 'f')];
    expect(flakiness(s)).toMatchObject({ flaky: false, flips: 1 });
  });
  it('跨提交反复翻转算不稳定，但样本要够', () => {
    const flip = ['passed', 'failed', 'passed', 'failed', 'passed', 'failed'].map((st, i) => run(st, `c${i}`));
    expect(flakiness(flip).flaky).toBe(true);
    expect(flakiness(flip.slice(0, 4)).flaky).toBe(false);
  });
  it('跳过的结果不参与', () => {
    expect(flakiness([run('passed'), run('skipped'), run('passed')])).toMatchObject({ flaky: false, runs: 2 });
  });
});

describe('基线对比', () => {
  const c = (caseKey: string, status: string) => ({ caseKey, status });
  it('分出新增失败、已修复、持续失败、增删', () => {
    const r = compareRuns([c('a', 'failed'), c('b', 'passed'), c('c', 'error'), c('e', 'failed')], [c('a', 'passed'), c('b', 'failed'), c('c', 'failed'), c('d', 'passed')]);
    expect(r).toEqual({ newFailures: ['a', 'e'], fixed: ['b'], stillFailing: ['c'], added: ['e'], removed: ['d'] });
  });
});

describe('发布结论', () => {
  const ok = { suite: 's', status: 'passed', passed: 10, failed: 0, commitSha: 'a' };
  const base = { runs: [ok], openBugs: [], flaky: 0, coverage: null };
  it('没有结果是未知，不是可发布', () => expect(computeVerdict({ ...base, runs: [] }).level).toBe('unknown'));
  it('全部满足才是可发布', () => expect(computeVerdict(base)).toMatchObject({ level: 'ready', passRate: 1, reasons: [] }));
  it('失败、P0/P1、没跑完都阻断', () => {
    expect(computeVerdict({ ...base, runs: [{ ...ok, status: 'failed', passed: 9, failed: 1 }] }).level).toBe('blocked');
    expect(computeVerdict({ ...base, openBugs: [{ severity: 'p1' }] }).level).toBe('blocked');
    expect(computeVerdict({ ...base, runs: [{ ...ok, status: 'error', passed: 0 }] }).level).toBe('blocked');
  });
  it('P2 缺陷不阻断', () => expect(computeVerdict({ ...base, openBugs: [{ severity: 'p2' }] }).level).toBe('ready'));
  it('隔离后 failed 归零就不阻断（status 仍是 failed）', () => {
    expect(computeVerdict({ ...base, runs: [{ ...ok, status: 'failed', failed: 0 }] }).level).toBe('ready');
  });
  it('不稳定、覆盖率不足、手工未执行、提交不一致是风险', () => {
    expect(computeVerdict({ ...base, flaky: 2 }).level).toBe('risk');
    expect(computeVerdict({ ...base, coverage: 50, criteria: { minCoverage: 80 } }).level).toBe('risk');
    expect(computeVerdict({ ...base, manual: { failed: 0, pending: 1 } }).level).toBe('risk');
    expect(computeVerdict({ ...base, runs: [ok, { ...ok, commitSha: 'b' }] }).level).toBe('risk');
  });
  it('手工失败阻断；准出线可调低', () => {
    expect(computeVerdict({ ...base, manual: { failed: 1, pending: 0 } }).level).toBe('blocked');
    expect(computeVerdict({ ...base, runs: [{ ...ok, status: 'failed', passed: 96, failed: 4 }], criteria: { minPassRate: 0.95 } }).level).toBe('ready');
  });
});

describe('缺陷状态机', () => {
  it('按流程走', () => {
    expect(bugTransition('draft', 'confirm')).toBe('open');
    expect(bugTransition('open', 'dispatch')).toBe('fixing');
    expect(bugTransition('fixing', 'dev_done')).toBe('verifying');
    expect(bugTransition('verifying', 'verify_pass')).toBe('verified');
    expect(bugTransition('verifying', 'verify_fail')).toBe('reopened');
    expect(bugTransition('reopened', 'dispatch')).toBe('fixing');
  });
  it('跳步被拒绝', () => {
    expect(bugTransition('draft', 'dispatch')).toBeNull();
    expect(bugTransition('open', 'verify_pass')).toBeNull();
    expect(bugTransition('verified', 'dispatch')).toBeNull();
  });
  it('草稿和已关闭不算未关闭', () => {
    expect(isBugOpen('draft')).toBe(false);
    expect(isBugOpen('verified')).toBe(false);
    expect(isBugOpen('reopened')).toBe(true);
  });
  it('对账：开发完成进验证，结果决定去向', () => {
    expect(reconcileBug({ status: 'fixing', devTaskStatus: 'done', caseStatus: null })).toBe('dev_done');
    expect(reconcileBug({ status: 'fixing', devTaskStatus: 'cancelled', caseStatus: null })).toBe('verify_fail');
    expect(reconcileBug({ status: 'fixing', devTaskStatus: 'in_progress', caseStatus: 'passed' })).toBeNull();
    expect(reconcileBug({ status: 'verifying', devTaskStatus: 'done', caseStatus: 'passed' })).toBe('verify_pass');
    expect(reconcileBug({ status: 'verifying', devTaskStatus: 'done', caseStatus: 'failed' })).toBe('verify_fail');
    expect(reconcileBug({ status: 'verifying', devTaskStatus: 'done', caseStatus: null })).toBeNull();
  });
});

describe('定时套件', () => {
  const at = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo - 1, d, h, mi);

  it('hourly/every6h 按间隔，没跑过立即到期', () => {
    const now = at(2026, 1, 10, 12, 0);
    expect(scheduleDue('hourly', null, null, now)).toBe(true);
    expect(scheduleDue('hourly', null, at(2026, 1, 10, 11, 30).toISOString(), now)).toBe(false);
    expect(scheduleDue('hourly', null, at(2026, 1, 10, 10, 59).toISOString(), now)).toBe(true);
    expect(scheduleDue('every6h', null, at(2026, 1, 10, 6, 0).toISOString(), now)).toBe(true);
    expect(scheduleDue('every6h', null, at(2026, 1, 10, 6, 1).toISOString(), now)).toBe(false);
    expect(scheduleDue('off', null, null, now)).toBe(false);
    expect(scheduleDue('weird', null, null, now)).toBe(false);
  });

  it('daily 按本机时间 HH:MM，跨过零点才再次到期', () => {
    const before = at(2026, 1, 10, 8, 59);
    const after = at(2026, 1, 10, 9, 0);
    expect(scheduleDue('daily', '09:00', null, before)).toBe(false);
    expect(scheduleDue('daily', '09:00', null, after)).toBe(true);
    // 今天已跑过，哪怕再晚也不再触发；到明天同一时刻才到期
    const ran = at(2026, 1, 10, 9, 5).toISOString();
    expect(scheduleDue('daily', '09:00', ran, at(2026, 1, 10, 23, 0))).toBe(false);
    expect(scheduleDue('daily', '09:00', ran, at(2026, 1, 11, 8, 59))).toBe(false);
    expect(scheduleDue('daily', '09:00', ran, at(2026, 1, 11, 9, 0))).toBe(true);
    // schedule_at 缺失/非法按 09:00
    expect(scheduleDue('daily', null, null, at(2026, 1, 10, 8, 0))).toBe(false);
    expect(scheduleDue('daily', null, null, at(2026, 1, 10, 9, 0))).toBe(true);
    expect(scheduleDue('daily', 'junk', null, at(2026, 1, 10, 9, 0))).toBe(true);
  });

  it('nextScheduledAt 给出下一次触发点', () => {
    const now = at(2026, 1, 10, 12, 0);
    expect(nextScheduledAt('off', null, null, now)).toBeNull();
    expect(nextScheduledAt('hourly', null, at(2026, 1, 10, 11, 0).toISOString(), now)!.getTime()).toBe(at(2026, 1, 10, 12, 0).getTime());
    expect(nextScheduledAt('daily', '09:00', null, now)!.getTime()).toBe(at(2026, 1, 10, 9, 0).getTime());
    expect(nextScheduledAt('daily', '09:00', at(2026, 1, 10, 9, 5).toISOString(), now)!.getTime()).toBe(at(2026, 1, 11, 9, 0).getTime());
  });
});
