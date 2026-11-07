import { parseJson } from '@/lib/format';

export type StatusFilter = 'all' | 'open' | 'attention' | 'done';

export interface BoardFilter {
  q?: string | undefined;
  status?: StatusFilter | undefined;
}

export const FILTERS: { id: StatusFilter; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'open', label: '进行中' },
  { id: 'attention', label: '待人处理' },
  { id: 'done', label: '已结束' },
];

const CLOSED = ['done', 'cancelled'];
const ATTENTION = ['blocked', 'escalated', 'rejected', 'countered', 'reviewing'];

const matchStatus = (status: string, f: StatusFilter) => {
  if (f === 'open') return !CLOSED.includes(status);
  if (f === 'attention') return ATTENTION.includes(status);
  if (f === 'done') return CLOSED.includes(status);
  return true;
};

interface Filterable {
  title: string;
  status: string;
  inputJson: string | null;
  assigneeId: string | null;
}

export function filterTasks<T extends Filterable>(tasks: T[], filter: BoardFilter, names: { ws: Record<string, string>; agent: Record<string, string> }): T[] {
  const q = filter.q?.trim().toLowerCase();
  return tasks.filter((t) => {
    if (filter.status && !matchStatus(t.status, filter.status)) return false;
    if (!q) return true;
    const module = parseJson<{ module?: string }>(t.inputJson, {}).module ?? '';
    const who = t.assigneeId ? (names.agent[t.assigneeId] ?? names.ws[t.assigneeId] ?? '') : '';
    return `${t.title}\n${module}\n${who}`.toLowerCase().includes(q);
  });
}
