import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { ErrorState, Loading } from '@/components/ui/feedback';
import { Input, Select } from '@/components/ui/input';
import { nameMaps, useOverview, useProjectTasks, useWsTasks, type BoardTask, type ProjectDetail, type WorkstationDetail } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { useTaskActions } from './actions';
import { BatchBar, useBatch } from './BatchBar';
import { BoardColumn } from './BoardColumn';
import { filterTasks, FILTERS, FLAGS, type BoardFilter } from './filter';
import { COLUMNS } from './labels';
import { TaskCard } from './TaskCard';
import { TaskDialog } from './TaskDialog';

interface Column { key: string; title: string; match: (t: BoardTask) => boolean }

const WAITING = ['dispatched', 'countered', 'rejected'];

function columnsOf(ws: WorkstationDetail, groupBy: 'status' | 'stage', tasks: BoardTask[]): Column[] {
  if (groupBy === 'status') {
    const known = COLUMNS.flatMap((c) => c.statuses as string[]);
    const cols: Column[] = COLUMNS.map((c) => ({ key: c.id, title: c.title, match: (t) => (c.statuses as string[]).includes(t.status) }));
    return tasks.some((t) => !known.includes(t.status)) ? [...cols, { key: 'other', title: '其他', match: (t) => !known.includes(t.status) }] : cols;
  }
  // 派入的任务接单前等 steward，接单后按真实 stage 落列
  const waiting = (t: BoardTask) => t.workstationId !== ws.id && (WAITING.includes(t.status) || !t.stage);
  const incoming: Column = { key: 'incoming', title: '派入', match: waiting };
  return [
    ...(tasks.some(incoming.match) ? [incoming] : []),
    { key: 'none', title: '未开始', match: (t) => t.workstationId === ws.id && !t.stage },
    ...(ws.manifest?.stages ?? []).map((s) => ({ key: s.id, title: s.name, match: (t: BoardTask) => !waiting(t) && t.stage === s.id })),
  ];
}

// groupBy=status：固定生命周期列；groupBy=stage：插件声明的工作流列
export function TaskBoard({
  ws,
  project,
  groupBy,
  filter,
  onFilter,
}: {
  ws: WorkstationDetail;
  project: ProjectDetail;
  groupBy: 'status' | 'stage';
  filter: BoardFilter;
  onFilter: (f: BoardFilter) => void;
}) {
  const tasks = useWsTasks(ws.id);
  const [creating, setCreating] = useState(false);
  const actions = useTaskActions(project, ws.id);
  const names = nameMaps(project);
  const stageNames = useOverview(project.id).data?.stageNames ?? {};
  const stages = (ws.manifest?.stages ?? []).map((s) => s.id);
  const all = tasks.data ?? [];
  // 前置任务可能在别的工作台，用项目任务表解析完成状态
  const depStatus = new Map((useProjectTasks(project.id).data ?? []).map((t) => [t.id, t.status]));
  const shown = filterTasks(all, filter, names, depStatus);
  const cols = columnsOf(ws, groupBy, all);
  const batch = useBatch(ws.id, all);

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="task-board">
      <div className="flex flex-wrap items-center gap-2 border-b border-rule px-4 py-2 md:px-6">
        <Input
          className="h-8 w-52"
          placeholder="搜索标题、模块、指派"
          aria-label="搜索任务"
          data-testid="board-search"
          value={filter.q ?? ''}
          onChange={(e) => onFilter({ ...filter, q: e.target.value || undefined })}
        />
        <div className="flex gap-0.5" role="group" aria-label="按状态筛选">
          {FILTERS.map((f) => {
            const on = (filter.status ?? 'all') === f.id;
            return (
              <button
                key={f.id}
                type="button"
                aria-pressed={on}
                data-testid={`board-filter-${f.id}`}
                onClick={() => onFilter({ ...filter, status: f.id === 'all' ? undefined : f.id })}
                className={cn('min-h-8 rounded-pill px-2.5 text-sm transition-colors duration-150', on ? 'bg-paper-3 font-medium text-ink' : 'text-muted hover:bg-hover hover:text-ink')}
              >
                {f.label}
              </button>
            );
          })}
        </div>
        <Select
          className="h-8 w-36"
          aria-label="按负责人筛选"
          data-testid="board-assignee"
          value={filter.assignee ?? ''}
          onChange={(e) => onFilter({ ...filter, assignee: e.target.value || undefined })}
        >
          <option value="">全部负责人</option>
          <option value="none">未指派</option>
          {(ws.agents ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </Select>
        <div className="flex gap-0.5" role="group" aria-label="按标记筛选">
          {FLAGS.map((f) => {
            const on = filter.flag === f.id;
            return (
              <button
                key={f.id}
                type="button"
                aria-pressed={on}
                data-testid={`board-flag-${f.id}`}
                onClick={() => onFilter({ ...filter, flag: on ? undefined : f.id })}
                className={cn('min-h-8 rounded-pill px-2.5 text-sm transition-colors duration-150', on ? 'bg-paper-3 font-medium text-ink' : 'text-muted hover:bg-hover hover:text-ink')}
              >
                {f.label}
              </button>
            );
          })}
        </div>
        {shown.length !== all.length && <span className="measured text-xs text-muted">{shown.length} / {all.length}</span>}
        <span className="flex-1" />
        <Button variant="quiet" aria-pressed={batch.active} onClick={() => (batch.active ? batch.exit() : batch.setActive(true))} data-testid="batch-toggle" className="aria-pressed:bg-paper-3 aria-pressed:text-ink">多选</Button>
        <Button variant="primary" onClick={() => setCreating(true)} data-testid="new-task">新建任务</Button>
      </div>
      {tasks.isLoading && <Loading />}
      {tasks.isError && <ErrorState error={tasks.error} onRetry={() => void tasks.refetch()} />}
      {tasks.data && (
        <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto px-4 py-3 md:px-6">
          {cols.map((col) => {
            const list = shown.filter(col.match);
            return (
              <BoardColumn key={col.key} title={col.title} count={list.length}>
                {list.map((t) => (
                  <TaskCard
                    key={t.id}
                    task={t}
                    projectId={project.id}
                    wsId={ws.id}
                    names={names}
                    stages={stages}
                    stageNames={stageNames}
                    pending={actions.pendingId === t.id}
                    canDispatch={actions.canDispatch}
                    canAssign={actions.canAssign}
                    depStatus={depStatus}
                    onAction={actions.run}
                    selection={batch.active && batch.selectable(t) ? { checked: batch.picked.has(t.id), onToggle: () => batch.toggle(t.id) } : undefined}
                  />
                ))}
              </BoardColumn>
            );
          })}
          <div className="min-w-0 flex-1" />
        </div>
      )}
      {batch.active && <BatchBar batch={batch} />}
      {creating && <TaskDialog ws={ws} onClose={() => setCreating(false)} />}
      {actions.dialogs}
    </div>
  );
}
