import type { TaskEvent, TaskStatus } from '@aw/domain';
import { allowedEvents } from '@aw/domain';
import { Link } from '@tanstack/react-router';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EVENT_LABEL, STATUS_LABEL, STATUS_TONE } from './labels';

export interface BoardTask {
  id: string;
  title: string;
  status: string;
  stage?: string | null;
  inputJson: string | null;
  assigneeType?: string | null;
  assigneeId?: string | null;
}

function moduleOf(inputJson: string | null): string | null {
  if (!inputJson) return null;
  try {
    return (JSON.parse(inputJson) as { module?: string }).module ?? null;
  } catch {
    return null;
  }
}

export function TaskCard({
  task,
  pending,
  projectId,
  wsNames = {},
  onTransition,
  onDispatch,
}: {
  task: BoardTask;
  pending: boolean;
  projectId?: string | undefined;
  wsNames?: Record<string, string> | undefined;
  onTransition: (taskId: string, event: TaskEvent) => void;
  onDispatch?: ((task: BoardTask) => void) | undefined;
}) {
  const status = task.status as TaskStatus;
  const module = moduleOf(task.inputJson);
  // accept/reject/counter 走 respond 接口；dispatch 走派发对话框
  const events = allowedEvents(status).filter(
    (e) => e !== 'accept' && e !== 'reject' && e !== 'counter' && e !== 'dispatch',
  );
  return (
    <Card className="space-y-2 p-3" data-testid="task-card" data-task-title={task.title}>
      <div className="flex items-start justify-between gap-2">
        {projectId ? (
          <Link to="/projects/$projectId/tasks/$taskId" params={{ projectId, taskId: task.id }} className="text-sm font-medium hover:underline">
            {task.title}
          </Link>
        ) : (
          <div className="text-sm font-medium">{task.title}</div>
        )}
        <Badge tone={STATUS_TONE[status] ?? 'neutral'}>{STATUS_LABEL[status] ?? task.status}</Badge>
      </div>
      {module ? <div className="text-xs text-neutral-500">{module}</div> : null}
      {task.assigneeType === 'workstation' && task.assigneeId ? (
        <div className="text-xs text-blue-600">已派发 → {wsNames[task.assigneeId] ?? task.assigneeId.slice(0, 8)}</div>
      ) : null}
      {(events.length > 0 || (status === 'draft' && onDispatch)) && (
        <div className="flex flex-wrap gap-1">
          {events.map((e) => (
            <Button
              key={e}
              size="sm"
              variant={e === 'cancel' ? 'ghost' : 'outline'}
              disabled={pending}
              onClick={() => onTransition(task.id, e)}
            >
              {EVENT_LABEL[e]}
            </Button>
          ))}
          {status === 'draft' && onDispatch && (
            <Button size="sm" variant="outline" disabled={pending} onClick={() => onDispatch(task)}>
              {EVENT_LABEL.dispatch}
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}
