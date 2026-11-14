import { useNavigate } from '@tanstack/react-router';
import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { STATUS_LABEL } from '@/components/board/labels';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useProjectTasks, type ProjectDetail } from '@/lib/queries';
import { cn } from '@/lib/utils';

interface Item { id: string; group: string; label: string; meta?: string; go: () => void }

export function CommandPalette({ project, onClose }: { project: ProjectDetail; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const navigate = useNavigate();
  const tasks = useProjectTasks(project.id);
  const params = { projectId: project.id };

  const items = useMemo<Item[]>(() => {
    const go = (fn: () => void) => () => { fn(); onClose(); };
    return [
      { id: 'command', group: '页面', label: '控制台', go: go(() => void navigate({ to: '/' })) },
      { id: 'inbox', group: '页面', label: '收件箱', go: go(() => void navigate({ to: '/projects/$projectId/inbox', params })) },
      { id: 'runs', group: '页面', label: '账本与运行记录', go: go(() => void navigate({ to: '/projects/$projectId/runs', params })) },
      { id: 'root', group: '页面', label: '根工作台', go: go(() => void navigate({ to: '/projects/$projectId', params })) },
      { id: 'settings', group: '页面', label: '项目设置', go: go(() => void navigate({ to: '/projects/$projectId/settings', params })) },
      ...project.workstations.map((w) => ({
        id: w.id,
        group: '工作台',
        label: w.name,
        meta: w.pluginId ?? '',
        go: go(() => void navigate({ to: '/projects/$projectId/ws/$wsId', params: { ...params, wsId: w.id } })),
      })),
      ...(tasks.data ?? []).map((t) => ({
        id: t.id,
        group: '任务',
        label: t.title,
        meta: STATUS_LABEL[t.status as keyof typeof STATUS_LABEL] ?? t.status,
        go: go(() => void navigate({ to: '/projects/$projectId/tasks/$taskId', params: { ...params, taskId: t.id } })),
      })),
    ];
  }, [project, tasks.data]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (needle ? items.filter((i) => i.label.toLowerCase().includes(needle)) : items).slice(0, 12);
  }, [items, q]);

  useEffect(() => setActive(0), [q]);

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (shown.length > 0) setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : shown.length - 1)) % shown.length);
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      shown[active]?.go();
    }
  };

  return (
    <Dialog title="跳转" onClose={onClose} className="mt-[12vh] mb-auto w-[34rem]" testId="command-palette">
      <Input autoFocus placeholder="工作台、任务、页面…" aria-label="搜索" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} data-testid="command-input" />
      <ul className="mt-2 max-h-[50vh] overflow-y-auto" role="listbox" aria-label="结果">
        {shown.map((item, i) => (
          <li key={item.id} role="option" aria-selected={i === active}>
            <button
              type="button"
              onMouseEnter={() => setActive(i)}
              onClick={item.go}
              className={cn('flex w-full items-center gap-3 rounded-chip px-2.5 py-1.5 text-left', i === active && 'bg-hover')}
            >
              <span className="w-12 shrink-0 text-xs text-muted">{item.group}</span>
              <span className="min-w-0 flex-1 truncate text-sm text-ink-2">{item.label}</span>
              {item.meta && <span className="measured shrink-0 text-xs text-muted">{item.meta}</span>}
            </button>
          </li>
        ))}
        {shown.length === 0 && <li className="p-3 text-sm text-muted">没有匹配项</li>}
      </ul>
    </Dialog>
  );
}
