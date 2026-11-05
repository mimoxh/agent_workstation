export const TASK_STATUSES = [
  'draft',
  'dispatched',
  'accepted',
  'rejected',
  'countered',
  'in_progress',
  'blocked',
  'escalated',
  'submitted',
  'reviewing',
  'done',
  'cancelled',
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_EVENTS = [
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
] as const;

export type TaskEvent = (typeof TASK_EVENTS)[number];

export type TransitionResult = { ok: true; to: TaskStatus } | { ok: false; error: string };

const TRANSITIONS: Readonly<Record<TaskStatus, Partial<Record<TaskEvent, TaskStatus>>>> = {
  draft: { dispatch: 'dispatched' },
  dispatched: { accept: 'accepted', reject: 'rejected', counter: 'countered' },
  countered: { redispatch: 'dispatched' },
  rejected: { revise: 'draft' },
  accepted: { start: 'in_progress' },
  in_progress: { submit: 'submitted', block: 'blocked' },
  blocked: { unblock: 'in_progress', escalate: 'escalated' },
  escalated: { resolve: 'in_progress' },
  submitted: { begin_review: 'reviewing' },
  reviewing: { approve: 'done', send_back: 'in_progress' },
  done: {},
  cancelled: {},
};

export const TERMINAL: readonly TaskStatus[] = ['done', 'cancelled'];

export function transition(from: TaskStatus, event: TaskEvent): TransitionResult {
  if (event === 'cancel') {
    return TERMINAL.includes(from)
      ? { ok: false, error: `终态 ${from} 不可再转移` }
      : { ok: true, to: 'cancelled' };
  }
  const to = TRANSITIONS[from][event];
  if (to === undefined) {
    return { ok: false, error: `非法转移：${from} 不能响应事件 ${event}` };
  }
  return { ok: true, to };
}

export function allowedEvents(from: TaskStatus): TaskEvent[] {
  if (TERMINAL.includes(from)) return [];
  const events = TASK_EVENTS.filter((e) => e !== 'cancel' && TRANSITIONS[from][e] !== undefined);
  return [...events, 'cancel'];
}
