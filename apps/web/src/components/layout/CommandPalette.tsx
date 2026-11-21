import { useNavigate } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { STATUS_LABEL } from '@/components/board/labels';
import { Icon, type IconName } from '@/components/ui/icons';
import { useProjectTasks, type ProjectDetail } from '@/lib/queries';
import { cn } from '@/lib/utils';

const ICON: Record<string, IconName> = { 页面: 'doc', 工作台: 'terminal', 任务: 'check' };

interface Item { id: string; group: string; label: string; meta?: string; go: () => void }

export function CommandPalette({ project, onClose }: { project: ProjectDetail; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el && !el.open) el.showModal();
  }, []);
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
    <dialog
      ref={ref}
      aria-label="跳转"
      data-testid="command-palette"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onMouseDown={(e) => {
        if (e.target === ref.current) onClose();
      }}
      className="mx-auto mb-auto mt-[12dvh] w-[38.75rem] max-w-[calc(100vw-2rem)] animate-pop overflow-hidden rounded-pop border-0 bg-paper p-0 text-ink shadow-[var(--shadow-pop)]"
    >
      <div className="flex items-center gap-2.5 border-b border-rule px-4">
        <Icon name="search" className="text-muted" />
        <input
          autoFocus
          placeholder="工作台、任务、页面…"
          aria-label="搜索"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKey}
          data-testid="command-input"
          className="h-14 min-w-0 flex-1 border-0 bg-transparent text-md text-ink outline-none placeholder:text-faint focus-visible:outline-none"
        />
        <kbd>Esc</kbd>
      </div>
      <ul className="max-h-[52dvh] overflow-y-auto p-1.5" role="listbox" aria-label="结果">
        {shown.map((item, i) => (
          <li key={item.id} role="option" aria-selected={i === active}>
            {(i === 0 || shown[i - 1]?.group !== item.group) && <p className="px-2.5 pb-1 pt-2 text-xs font-semibold text-muted">{item.group}</p>}
            <button
              type="button"
              onMouseEnter={() => setActive(i)}
              onClick={item.go}
              className={cn('flex min-h-[38px] w-full items-center gap-2.5 rounded-ctl px-2.5 text-left text-sm text-ink-2', i === active && 'bg-hover text-ink')}
            >
              <Icon name={ICON[item.group] ?? 'doc'} className="size-[15px] text-muted" />
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              {item.meta && <span className="measured shrink-0 text-xs text-faint">{item.meta}</span>}
            </button>
          </li>
        ))}
        {shown.length === 0 && <li className="px-3 py-6 text-center text-sm text-muted">没有匹配项</li>}
      </ul>
      <div className="flex flex-wrap gap-3.5 border-t border-rule px-4 py-2.5 text-xs text-muted">
        <span className="inline-flex items-center gap-1.5"><kbd>↑</kbd><kbd>↓</kbd>选择</span>
        <span className="inline-flex items-center gap-1.5"><kbd>Enter</kbd>打开</span>
        <span className="inline-flex items-center gap-1.5"><kbd>Esc</kbd>关闭</span>
      </div>
    </dialog>
  );
}
