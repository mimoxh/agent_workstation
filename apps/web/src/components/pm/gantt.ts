import { isOverdue } from '@aw/domain';

const DAY = 24 * 60 * 60 * 1000;

// YYYY-MM-DD / ISO 时间戳 → 整数日；布局全按日计算
export const dayOf = (d: string) => Math.floor(Date.parse(`${d.slice(0, 10)}T00:00:00Z`) / DAY);

export interface GanttTask {
  id: string;
  title: string;
  status: string;
  workstationId: string;
  startAt: string | null;
  dueAt: string | null;
  createdAt: string;
}

export interface GanttBar {
  task: GanttTask;
  from: string;
  to: string;
  left: number;
  width: number;
  overdue: boolean;
}

export interface GanttLayout {
  start: number;
  days: number;
  bars: GanttBar[];
  milestones: { id: string; name: string; due: string; pos: number }[];
  today: number | null;
}

// 范围 = min(任务开始 ?? 创建日, 里程碑日) ~ max(任务截止, 里程碑日)，两侧各留 pad 天；没有截止的任务不排进图
export function layoutGantt({
  tasks,
  milestones,
  today,
  pad = 2,
}: {
  tasks: GanttTask[];
  milestones: { id: string; name: string; due: string | null }[];
  today: string;
  pad?: number;
}): GanttLayout {
  const dated = tasks.filter((t): t is GanttTask & { dueAt: string } => !!t.dueAt);
  const rows = dated.map((t) => {
    const from = t.startAt ?? t.createdAt.slice(0, 10);
    return { t, from: from <= t.dueAt ? from : t.dueAt, to: t.dueAt };
  });
  const points = [
    ...rows.flatMap((r) => [dayOf(r.from), dayOf(r.to)]),
    ...milestones.flatMap((m) => (m.due ? [dayOf(m.due)] : [])),
    dayOf(today),
  ];
  const lo = Math.min(...points) - pad;
  const hi = Math.max(...points) + pad;
  const pos = (d: string) => dayOf(d) - lo;
  return {
    start: lo,
    days: hi - lo + 1,
    bars: rows.map(({ t, from, to }) => ({ task: t, from, to, left: pos(from), width: Math.max(1, dayOf(to) - dayOf(from) + 1), overdue: isOverdue(t.dueAt, t.status, today) })),
    milestones: milestones.flatMap((m) => (m.due ? [{ id: m.id, name: m.name, due: m.due, pos: pos(m.due) }] : [])),
    today: pos(today),
  };
}
