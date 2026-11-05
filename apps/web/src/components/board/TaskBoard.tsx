import type { TaskEvent } from '@aw/domain';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { apiClient } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { BoardColumn } from './BoardColumn';
import { COLUMNS } from './labels';
import type { BoardTask } from './TaskCard';

export function TaskBoard({ workstationId }: { workstationId: string }) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState('');
  const [module, setModule] = useState('');

  const tasksQuery = useQuery({
    queryKey: ['tasks', workstationId],
    queryFn: async () => {
      const res = await apiClient.workstations[':id'].tasks.$get({
        param: { id: workstationId },
      });
      if (!res.ok) throw new Error('加载任务失败');
      return (await res.json()) as BoardTask[];
    },
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['tasks', workstationId] });

  const createMutation = useMutation({
    mutationFn: async (input: { title: string; module?: string }) => {
      const res = await apiClient.workstations[':id'].tasks.$post({
        param: { id: workstationId },
        json: input,
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? '创建任务失败');
      }
      return res.json();
    },
    onSuccess: async () => {
      setTitle('');
      setModule('');
      await invalidate();
    },
  });

  const transitionMutation = useMutation({
    mutationFn: async ({ taskId, event }: { taskId: string; event: TaskEvent }) => {
      const res = await apiClient.tasks[':id'].transition.$post({
        param: { id: taskId },
        json: { event },
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? '转移失败');
      }
      return res.json();
    },
    onSuccess: invalidate,
  });

  const tasks = tasksQuery.data ?? [];

  return (
    <div className="flex h-full flex-col gap-3 p-4" data-testid="task-board">
      <div className="flex items-center gap-2">
        <Input
          placeholder="任务标题"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="w-64"
          data-testid="new-task-title"
        />
        <Input
          placeholder="Module（可选）"
          value={module}
          onChange={(e) => setModule(e.target.value)}
          className="w-64"
        />
        <Button
          disabled={!title.trim() || createMutation.isPending}
          onClick={() =>
            createMutation.mutate(module.trim() ? { title: title.trim(), module: module.trim() } : { title: title.trim() })
          }
        >
          新建任务
        </Button>
      </div>
      {createMutation.isError ? (
        <div className="text-sm text-red-600">{createMutation.error.message}</div>
      ) : null}
      {transitionMutation.isError ? (
        <div className="text-sm text-red-600">{transitionMutation.error.message}</div>
      ) : null}
      {tasksQuery.isLoading ? <div className="text-sm text-neutral-500">加载中…</div> : null}
      {tasksQuery.isError ? <div className="text-sm text-red-600">加载失败</div> : null}
      <div className="flex flex-1 gap-3 overflow-x-auto">
        {COLUMNS.map((col) => (
          <BoardColumn
            key={col.id}
            title={col.title}
            tasks={tasks.filter((t) => col.statuses.includes(t.status as never))}
            pendingId={transitionMutation.isPending ? (transitionMutation.variables?.taskId ?? null) : null}
            onTransition={(taskId, event) => transitionMutation.mutate({ taskId, event })}
          />
        ))}
      </div>
    </div>
  );
}
