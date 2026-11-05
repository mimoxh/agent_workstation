import { describe, expect, it } from 'vitest';
import {
  TASK_STATUSES,
  TERMINAL,
  allowedEvents,
  transition,
} from '../src/task-state.js';
import type { TaskEvent, TaskStatus } from '../src/task-state.js';

const EXPECTED: Record<string, TaskStatus> = {
  'draft+dispatch': 'dispatched',
  'dispatched+accept': 'accepted',
  'dispatched+reject': 'rejected',
  'dispatched+counter': 'countered',
  'countered+redispatch': 'dispatched',
  'rejected+revise': 'draft',
  'accepted+start': 'in_progress',
  'in_progress+submit': 'submitted',
  'in_progress+block': 'blocked',
  'blocked+unblock': 'in_progress',
  'blocked+escalate': 'escalated',
  'escalated+resolve': 'in_progress',
  'submitted+begin_review': 'reviewing',
  'reviewing+approve': 'done',
  'reviewing+send_back': 'in_progress',
};

const ALL_EVENTS: TaskEvent[] = [
  'dispatch',
  'accept',
  'reject',
  'counter',
  'redispatch',
  'revise',
  'start',
  'submit',
  'block',
  'unblock',
  'escalate',
  'resolve',
  'begin_review',
  'approve',
  'send_back',
  'cancel',
];

describe('task-state', () => {
  it.each(Object.entries(EXPECTED))('%s → %s', (key, to) => {
    const [from, event] = key.split('+') as [TaskStatus, TaskEvent];
    expect(transition(from, event)).toEqual({ ok: true, to });
  });

  it('非终态任意状态可 cancel 到 cancelled', () => {
    for (const s of TASK_STATUSES) {
      if (TERMINAL.includes(s)) continue;
      expect(transition(s, 'cancel')).toEqual({ ok: true, to: 'cancelled' });
    }
  });

  it('笛卡尔积：表外组合全部 ok:false', () => {
    for (const s of TASK_STATUSES) {
      for (const e of ALL_EVENTS) {
        const key = `${s}+${e}`;
        const r = transition(s, e);
        if (e === 'cancel') {
          expect(r.ok).toBe(!TERMINAL.includes(s));
          continue;
        }
        if (key in EXPECTED) {
          expect(r.ok).toBe(true);
        } else {
          expect(r.ok).toBe(false);
        }
      }
    }
  });

  it('终态没有任何可用事件', () => {
    for (const s of TERMINAL) {
      expect(allowedEvents(s)).toEqual([]);
    }
  });

  it('approve 有验收未通过时拒绝', () => {
    expect(transition('reviewing', 'approve', { hasAcceptance: true, acceptancePassed: false })).toEqual({
      ok: false,
      error: '需先通过可执行验收',
    });
    expect(transition('reviewing', 'approve', { hasAcceptance: true, acceptancePassed: true })).toEqual({ ok: true, to: 'done' });
    expect(transition('reviewing', 'approve', { hasAcceptance: false })).toEqual({ ok: true, to: 'done' });
  });

  it('allowedEvents 与转移表一致', () => {
    for (const s of TASK_STATUSES) {
      for (const e of allowedEvents(s)) {
        expect(transition(s, e).ok).toBe(true);
      }
    }
  });
});
