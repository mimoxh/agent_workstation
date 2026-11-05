import type { TaskEvent } from '@aw/domain';
import { TaskCard, type BoardTask } from './TaskCard';

export function BoardColumn({
  title,
  tasks,
  pendingId,
  projectId,
  wsNames,
  onTransition,
  onDispatch,
}: {
  title: string;
  tasks: BoardTask[];
  pendingId: string | null;
  projectId?: string | undefined;
  wsNames?: Record<string, string> | undefined;
  onTransition: (taskId: string, event: TaskEvent) => void;
  onDispatch?: ((task: BoardTask) => void) | undefined;
}) {
  return (
    <div className="w-52 shrink-0" data-testid={`board-column-${title}`}>
      <div className="mb-2 text-xs font-semibold text-neutral-500">
        {title} <span className="text-neutral-400">{tasks.length}</span>
      </div>
      <div className="space-y-2">
        {tasks.map((t) => (
          <TaskCard
            key={t.id}
            task={t}
            pending={pendingId === t.id}
            projectId={projectId}
            wsNames={wsNames}
            onTransition={onTransition}
            onDispatch={onDispatch}
          />
        ))}
      </div>
    </div>
  );
}
