import type { TaskEvent, TaskStatus } from '@aw/domain';
import { allowedEvents } from '@aw/domain';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EVENT_LABEL, STATUS_LABEL, STATUS_TONE } from './labels';

export interface BoardTask {
  id: string;
  title: string;
  status: string;
  inputJson: string | null;
}

function moduleOf(inputJson: string | null): string | null {
  if (!inputJson) return null;
  try {
    const parsed = JSON.parse(inputJson) as { module?: string };
    return parsed.module ?? null;
  } catch {
    return null;
  }
}

export function TaskCard({
  task,
  pending,
  onTransition,
}: {
  task: BoardTask;
  pending: boolean;
  onTransition: (taskId: string, event: TaskEvent) => void;
}) {
  const status = task.status as TaskStatus;
  const module = moduleOf(task.inputJson);
  const events = allowedEvents(status);
  return (
    <Card className="space-y-2 p-3" data-testid="task-card" data-task-title={task.title}>
      <div className="flex items-start justify-between gap-2">
        <div className="text-sm font-medium">{task.title}</div>
        <Badge tone={STATUS_TONE[status] ?? 'neutral'}>{STATUS_LABEL[status] ?? task.status}</Badge>
      </div>
      {module ? <div className="text-xs text-neutral-500">{module}</div> : null}
      {events.length > 0 ? (
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
        </div>
      ) : null}
    </Card>
  );
}
