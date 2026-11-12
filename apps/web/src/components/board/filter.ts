import { isOverdue, localDate } from '@aw/domain';
import { parseJson } from '@/lib/format';

export type StatusFilter = 'all' | 'open' | 'attention' | 'done';
export type FlagFilter = 'overdue' | 'waiting';

export interface BoardFilter {
  q?: string | undefined;
  status?: StatusFilter | undefined;
  // '' / undefined 不筛；'none' = 未指派；其余为 Agent id
  assignee?: string | undefined;
  flag?: FlagFilter | undefined;
}

export const FILTERS: { id: StatusFilter; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'open', label: '进行中' },
  { id: 'attention', label: '待人处理' },
  { id: 'done', label: '已结束' },
];

export const FLAGS: { id: FlagFilter; label: string }[] = [
  { id: 'overdue', label: '逾期' },
  { id: 'waiting', label: '等待前置' },
];

const CLOSED = ['done', 'cancelled'];
const ATTENTION = ['blocked', 'escalated', 'rejected', 'countered', 'reviewing'];

const matchStatus = (status: string, f: StatusFilter) => {
  if (f === 'open') return !CLOSED.includes(status);
  if (f === 'attention') return ATTENTION.includes(status);
  if (f === 'done') return CLOSED.includes(status);
  return true;
};

// deps：前置任务 id → status；缺省/查不到都视为未完成
const matchFlag = (t: Filterable, flag: FlagFilter, deps?: Map<string, string>) =>
  flag === 'overdue'
    ? isOverdue(t.dueAt ?? null, t.status, localDate())
    : (t.dependsOn ?? []).some((id) => (deps?.get(id) ?? '') !== 'done');

interface Filterable {
  title: string;
  status: string;
  inputJson: string | null;
  assigneeId: string | null;
  dueAt?: string | null;
  dependsOn?: string[] | undefined;
}

export function filterTasks<T extends Filterable>(tasks: T[], filter: BoardFilter, names: { ws: Record<string, string>; agent: Record<string, string> }, deps?: Map<string, string>): T[] {
  const q = filter.q?.trim().toLowerCase();
  return tasks.filter((t) => {
    if (filter.status && !matchStatus(t.status, filter.status)) return false;
    if (filter.assignee === 'none' ? t.assigneeId !== null : !!filter.assignee && t.assigneeId !== filter.assignee) return false;
    if (filter.flag && !matchFlag(t, filter.flag, deps)) return false;
    if (!q) return true;
    const module = parseJson<{ module?: string }>(t.inputJson, {}).module ?? '';
    const who = t.assigneeId ? (names.agent[t.assigneeId] ?? names.ws[t.assigneeId] ?? '') : '';
    return `${t.title}\n${module}\n${who}`.toLowerCase().includes(q);
  });
}
