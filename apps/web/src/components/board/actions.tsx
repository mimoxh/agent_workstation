import type { TaskEvent, TaskStatus } from '@aw/domain';
import { allowedEvents } from '@aw/domain';
import { useMutation } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { api, unwrap } from '@/lib/api';
import { useDispatchTargets, useWorkstation, type BoardTask, type ProjectDetail } from '@/lib/queries';
import { AssignDialog } from './AssignDialog';
import { DispatchDialog } from './DispatchDialog';
import { EVENT_LABEL } from './labels';
import { RespondDialog } from './RespondDialog';
import { TaskDialog } from './TaskDialog';

export type TaskAction =
  | { kind: 'event'; event: TaskEvent }
  | { kind: 'dispatch' }
  | { kind: 'assign' }
  | { kind: 'edit' }
  | { kind: 'accept' }
  | { kind: 'reject' }
  | { kind: 'counter' };

const LABEL: Record<Exclude<TaskAction['kind'], 'event'>, string> = {
  dispatch: EVENT_LABEL.dispatch,
  assign: '指派 Agent',
  edit: '编辑',
  accept: EVENT_LABEL.accept,
  reject: EVENT_LABEL.reject,
  counter: EVENT_LABEL.counter,
};

export const actionLabel = (a: TaskAction) => (a.kind === 'event' ? EVENT_LABEL[a.event] : LABEL[a.kind]);

// 已交给 Agent 或下级工作台的任务由平台推进，人的手动流转只是兜底，不当主操作
export const isDriven = (task: Pick<BoardTask, 'status' | 'assigneeType'>) =>
  !!task.assigneeType && ['in_progress', 'submitted', 'reviewing'].includes(task.status);

// 第一项是主操作；代码任务的「通过」只能走提案审阅，这里不提供
export function taskActions(task: Pick<BoardTask, 'status' | 'assigneeType' | 'codeRefJson'>, opts: { canDispatch: boolean; canAssign: boolean }): TaskAction[] {
  const status = task.status as TaskStatus;
  const out: TaskAction[] = [];
  if (status === 'draft') {
    if (opts.canDispatch) out.push({ kind: 'dispatch' });
    if (opts.canAssign) out.push({ kind: 'assign' });
    out.push({ kind: 'edit' });
  }
  if (status === 'dispatched' && task.assigneeType === 'workstation') {
    out.push({ kind: 'accept' }, { kind: 'reject' }, { kind: 'counter' });
  }
  for (const event of allowedEvents(status)) {
    if (['dispatch', 'accept', 'reject', 'counter'].includes(event)) continue;
    if (event === 'approve' && task.codeRefJson) continue;
    out.push({ kind: 'event', event });
  }
  return out;
}

// 看板和任务详情共用：执行动作、托管需要填写的对话框
export function useTaskActions(project: ProjectDetail | undefined, wsId: string | undefined) {
  const [dialog, setDialog] = useState<{ action: TaskAction; task: BoardTask } | null>(null);
  const ws = useWorkstation(wsId);
  const targets = useDispatchTargets(project, wsId);
  const agents = (ws.data?.agents ?? []).filter((a) => a.status !== 'paused');

  const transition = useMutation({
    mutationFn: async ({ taskId, event }: { taskId: string; event: TaskEvent }) =>
      unwrap(await api.tasks[':id'].transition.$post({ param: { id: taskId }, json: { event } })),
  });
  const accept = useMutation({
    mutationFn: async (taskId: string) => unwrap(await api.tasks[':id'].respond.$post({ param: { id: taskId }, json: { action: 'accept' } })),
  });

  const run = (action: TaskAction, task: BoardTask) => {
    if (action.kind === 'event') transition.mutate({ taskId: task.id, event: action.event });
    else if (action.kind === 'accept') accept.mutate(task.id);
    else setDialog({ action, task });
  };

  const close = () => setDialog(null);
  let dialogs: ReactNode = null;
  if (dialog?.action.kind === 'dispatch') dialogs = <DispatchDialog task={dialog.task} targets={targets} onClose={close} />;
  if (dialog?.action.kind === 'assign') dialogs = <AssignDialog task={dialog.task} agents={agents} onClose={close} />;
  if (dialog?.action.kind === 'edit' && ws.data) dialogs = <TaskDialog ws={ws.data} task={dialog.task} onClose={close} />;
  if (dialog?.action.kind === 'reject' || dialog?.action.kind === 'counter') {
    dialogs = <RespondDialog action={dialog.action.kind} task={dialog.task} onClose={close} />;
  }

  return {
    run,
    dialogs,
    pendingId: transition.isPending ? transition.variables.taskId : accept.isPending ? accept.variables : null,
    canDispatch: targets.length > 0,
    canAssign: agents.length > 0,
  };
}
