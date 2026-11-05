import type { TaskEvent } from '@aw/domain';
import { TaskCard, type BoardTask } from './TaskCard';

export function BoardColumn({
  title,
  tasks,
  pendingId,
  onTransition,
}: {
  title: string;
  tasks: BoardTask[];
  pendingId: string | null;
  onTransition: (taskId: string, event: TaskEvent) => void;
}) {
  return (
    <section
      className="flex w-44 shrink-0 flex-col gap-2 rounded-md bg-neutral-50 p-2"
      data-testid={`board-column-${title}`}
    >
      <header className="flex items-center justify-between px-1 text-xs font-semibold text-neutral-600">
        <span>{title}</span>
        <span>{tasks.length}</span>
      </header>
      {tasks.map((t) => (
        <TaskCard key={t.id} task={t} pending={pendingId === t.id} onTransition={onTransition} />
      ))}
    </section>
  );
}
