import type { TaskStatus } from '@aw/domain';
import { isOverdue, localDate } from '@aw/domain';
import { Link } from '@tanstack/react-router';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { MenuItem, Popover } from '@/components/ui/feedback';
import { parseJson } from '@/lib/format';
import type { BoardTask, NameMaps } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { actionLabel, isDriven, taskActions, type TaskAction } from './actions';
import { STATUS_LABEL, STATUS_TONE } from './labels';

export const moduleOf = (t: Pick<BoardTask, 'inputJson'>) => parseJson<{ module?: string }>(t.inputJson, {}).module ?? null;

function whoOf(task: BoardTask, wsId: string, names: NameMaps) {
  if (task.workstationId !== wsId) return `来自 ${names.ws[task.workstationId] ?? '上级'}`;
  if (task.assigneeType === 'workstation' && task.assigneeId) return `已派发 → ${names.ws[task.assigneeId] ?? '工作台'}`;
  if (task.assigneeType === 'agent' && task.assigneeId) return names.agent[task.assigneeId] ?? 'Agent';
  if (task.assigneeType === 'human') return '本地用户接管中';
  return '未指派';
}

function Ticks({ stages, current, finished }: { stages: string[]; current: string | null; finished: boolean }) {
  const idx = current ? stages.indexOf(current) : -1;
  return (
    <span className="inline-flex shrink-0 gap-1" aria-label={`阶段 ${idx + 1}/${stages.length}`}>
      {stages.map((s, i) => (
        <i key={s} className={cn('h-[3px] w-2.5 rounded-full', finished || i < idx ? 'bg-cool' : i === idx ? 'bg-accent' : 'bg-rule')} />
      ))}
    </span>
  );
}

export function TaskCard({
  task,
  projectId,
  wsId,
  names,
  stages,
  stageNames,
  pending,
  canDispatch,
  canAssign,
  depStatus,
  onAction,
  selection,
}: {
  task: BoardTask;
  projectId: string;
  wsId: string;
  names: NameMaps;
  stages: string[];
  stageNames: Record<string, string>;
  pending: boolean;
  canDispatch: boolean;
  canAssign: boolean;
  depStatus: Map<string, string>;
  onAction: (action: TaskAction, task: BoardTask) => void;
  selection?: { checked: boolean; onToggle: () => void } | undefined;
}) {
  const status = task.status as TaskStatus;
  const module = moduleOf(task);
  const local = task.workstationId === wsId;
  const actions = taskActions(task, { canDispatch: local && canDispatch, canAssign: local && canAssign });
  const driven = isDriven(task);
  const primary = driven ? undefined : actions[0];
  const rest = driven ? actions : actions.slice(1);
  const finished = status === 'done' || status === 'cancelled';
  const awaitingReview = status === 'reviewing' && !!task.codeRefJson;
  const today = localDate();
  const overdue = isOverdue(task.dueAt, task.status, today);
  const waitingDeps = (task.dependsOn ?? []).filter((id) => (depStatus.get(id) ?? '') !== 'done').length;

  return (
    <Card
      data-testid="task-card"
      data-task-title={task.title}
      className={cn('flex flex-col gap-2 border-0 p-3 shadow-[var(--shadow-card)] hover:bg-paper-2', status === 'blocked' || status === 'escalated' ? 'shadow-[0_0_0_1px_var(--color-accent),var(--shadow-card)]' : '', finished && 'opacity-70')}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2">
          {selection && <input type="checkbox" checked={selection.checked} onChange={selection.onToggle} aria-label="选择任务" data-testid="task-select" className="size-4 shrink-0 accent-ink" />}
          <span className="truncate text-xs text-muted">{task.parentId ? '子任务' : task.typeId ? '派发' : '内部'}</span>
        </span>
        <Badge tone={STATUS_TONE[status] ?? 'neutral'}>{STATUS_LABEL[status] ?? task.status}</Badge>
      </div>
      <Link to="/projects/$projectId/tasks/$taskId" params={{ projectId, taskId: task.id }} className="text-md font-medium leading-snug text-ink hover:underline">
        {task.title}
      </Link>
      <p className="truncate text-xs text-muted">{whoOf(task, wsId, names)}</p>
      {task.blockedReason && <p className="line-clamp-3 text-xs text-ink-2">{task.blockedReason}</p>}
      {(task.dueAt || waitingDeps > 0) && (
        <div className="flex items-center gap-1.5">
          {task.dueAt && <span className={cn('measured text-xs', overdue ? 'font-medium text-bad' : 'text-muted')}>截止 {task.dueAt.slice(5)}</span>}
          {waitingDeps > 0 && <Badge tone="amber" data-testid="dep-chip">等待前置 {waitingDeps}</Badge>}
        </div>
      )}
      {(module || stages.length > 0 || task.stage) && (
        <div className="flex items-center justify-between gap-2">
          <span className="measured truncate text-xs text-muted" title={module ?? undefined}>{module}</span>
          {stages.length > 0 ? <Ticks stages={stages} current={task.stage} finished={status === 'done'} /> : task.stage && <span className="shrink-0 text-xs text-cool" data-testid="card-stage">{stageNames[task.stage] ?? task.stage}</span>}
        </div>
      )}
      {(actions.length > 0 || awaitingReview) && (
        <div className="flex items-center gap-1.5 pt-0.5">
          {awaitingReview ? (
            <Link
              to="/projects/$projectId/tasks/$taskId"
              params={{ projectId, taskId: task.id }}
              search={{ view: 'changes' }}
              className="inline-flex min-h-6 items-center rounded-pill bg-primary px-2 text-xs font-medium text-primary-ink hover:bg-primary-hover"
            >
              审阅改动
            </Link>
          ) : (
            primary && (
              <Button size="sm" variant={primary.kind === 'event' && primary.event === 'cancel' ? 'quiet' : 'default'} disabled={pending} onClick={() => onAction(primary, task)}>
                {actionLabel(primary)}
              </Button>
            )
          )}
          {rest.length > 0 && (
            <Popover
              align="left"
              className="min-w-32"
              trigger={(_, toggle) => (
                <Button size="sm" variant="quiet" aria-label="更多操作" disabled={pending} onClick={toggle}>···</Button>
              )}
            >
              {(close) =>
                rest.map((a) => (
                  <MenuItem
                    key={actionLabel(a)}
                    danger={a.kind === 'event' && a.event === 'cancel'}
                    onClick={() => { close(); onAction(a, task); }}
                  >
                    {actionLabel(a)}
                  </MenuItem>
                ))
              }
            </Popover>
          )}
        </div>
      )}
    </Card>
  );
}
