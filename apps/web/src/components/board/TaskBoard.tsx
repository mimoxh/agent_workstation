import type { TaskEvent } from '@aw/domain';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { apiClient } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { BoardColumn } from './BoardColumn';
import { DispatchDialog, type DispatchTarget } from './DispatchDialog';
import { COLUMNS, STATUS_LABEL } from './labels';
import { fieldsOf } from './schemaForm';
import type { BoardTask } from './TaskCard';

const OTHER = '其他';

export interface StageCol {
  id: string;
  title: string;
}

// groupBy=status：固定列；groupBy=stage：任务类型 stages + 「未开始」列
export function TaskBoard({
  workstationId,
  projectId,
  groupBy = 'status',
  stageColumns = [],
  dispatchTargets = [],
  createTaskTypes = [],
  wsNames = {},
}: {
  workstationId: string;
  projectId?: string;
  groupBy?: 'status' | 'stage';
  stageColumns?: StageCol[];
  dispatchTargets?: DispatchTarget[];
  createTaskTypes?: { id: string; name: string; inputSchema: Record<string, unknown> }[];
  wsNames?: Record<string, string>;
}) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState('');
  const [intent, setIntent] = useState('');
  const [module, setModule] = useState('');
  const [acceptance, setAcceptance] = useState('pnpm build');
  const [dispatchTask, setDispatchTask] = useState<BoardTask | null>(null);
  const [dispatchError, setDispatchError] = useState<string | null>(null);
  const [typeId, setTypeId] = useState(createTaskTypes[0]?.id ?? '');
  const [enumVals, setEnumVals] = useState<Record<string, string>>({});

  const tasksQuery = useQuery({
    queryKey: ['tasks', workstationId],
    queryFn: async () => {
      const res = await apiClient.workstations[':id'].tasks.$get({ param: { id: workstationId } });
      if (!res.ok) throw new Error('加载任务失败');
      return (await res.json()) as BoardTask[];
    },
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['tasks', workstationId] });

  const readErr = async (res: Response, fallback: string) => {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? fallback);
  };

  const createMutation = useMutation({
    mutationFn: async (body: { title: string; intent?: string; typeId?: string; input?: Record<string, unknown>; acceptance?: { kind: string; run: string; expect: { exitCode: number } }[] }) => {
      const res = await apiClient.workstations[':id'].tasks.$post({ param: { id: workstationId }, json: body });
      if (!res.ok) await readErr(res, '创建任务失败');
      return res.json();
    },
    onSuccess: async () => {
      setTitle(''); setIntent(''); setModule('');
      await invalidate();
    },
  });

  const transitionMutation = useMutation({
    mutationFn: async ({ taskId, event }: { taskId: string; event: TaskEvent }) => {
      const res = await apiClient.tasks[':id'].transition.$post({ param: { id: taskId }, json: { event } });
      if (!res.ok) await readErr(res, '转移失败');
      return res.json();
    },
    onSuccess: invalidate,
  });

  const dispatchMutation = useMutation({
    mutationFn: async (body: { taskId: string; targetWorkstationId: string; typeId: string; input: Record<string, unknown> }) => {
      const { taskId, ...json } = body;
      const res = await apiClient.tasks[':id'].dispatch.$post({ param: { id: taskId }, json });
      if (!res.ok) await readErr(res, '派发失败');
      return res.json();
    },
    onSuccess: async () => {
      setDispatchTask(null);
      setDispatchError(null);
      await invalidate();
    },
    onError: (e) => setDispatchError(e.message),
  });

  const tasks = tasksQuery.data ?? [];
  const cols: { key: string; title: string; match: (t: BoardTask) => boolean }[] =
    groupBy === 'stage'
      ? [
          { key: '__none', title: '未开始', match: (t) => t.stage === null || t.stage === undefined },
          ...stageColumns.map((s) => ({ key: s.id, title: s.title, match: (t: BoardTask) => t.stage === s.id })),
        ]
      : [
          ...COLUMNS.map((col) => ({ key: col.id, title: col.title, match: (t: BoardTask) => col.statuses.includes(t.status as never) })),
          { key: OTHER, title: OTHER, match: (t: BoardTask) => !COLUMNS.some((c) => c.statuses.includes(t.status as never)) },
        ];

  return (
    <div className="flex h-full flex-col gap-3 p-4" data-testid="task-board">
      <div className="flex flex-wrap items-center gap-2">
        <Input placeholder="任务标题" value={title} onChange={(e) => setTitle(e.target.value)} className="w-56" data-testid="new-task-title" />
        <Input placeholder="intent（可选）" value={intent} onChange={(e) => setIntent(e.target.value)} className="w-48" />
        {createTaskTypes.length > 1 && (
          <select className="rounded border border-neutral-300 px-2 py-1 text-sm" value={typeId} onChange={(e) => { setTypeId(e.target.value); setEnumVals({}); }}>
            {createTaskTypes.map((t) => <option key={t.id} value={t.id}>{t.id}</option>)}
          </select>
        )}
        {fieldsOf(createTaskTypes.find((t) => t.id === (typeId || createTaskTypes[0]?.id))?.inputSchema).filter((f) => f.name !== 'title').map((f) =>
          f.enum ? (
            <label key={f.name} className="flex items-center gap-1 text-xs text-neutral-600">
              {f.name}{f.required && <span className="text-red-500">*</span>}
              <select
                className="rounded border border-neutral-300 px-1.5 py-1 text-sm"
                value={enumVals[f.name] ?? f.enum[0]!}
                onChange={(e) => setEnumVals({ ...enumVals, [f.name]: e.target.value })}
              >
                {f.enum.map((v) => <option key={v}>{v}</option>)}
              </select>
            </label>
          ) : null,
        )}
        <Input
          placeholder={createTaskTypes.length > 0 ? 'module（必填）' : 'module（可选）'}
          value={module}
          onChange={(e) => setModule(e.target.value)}
          className="w-56"
          data-testid="new-task-module"
        />
        <Input placeholder="验收命令（每行一条）" value={acceptance} onChange={(e) => setAcceptance(e.target.value)} className="w-56" />
        <Button
          disabled={!title.trim() || createMutation.isPending}
          onClick={() => {
            const active = createTaskTypes.find((t) => t.id === (typeId || createTaskTypes[0]?.id));
            const input: Record<string, unknown> = {
              ...Object.fromEntries(fieldsOf(active?.inputSchema).filter((f) => f.enum).map((f) => [f.name, enumVals[f.name] ?? f.enum![0]!])),
              ...(module.trim() ? { module: module.trim() } : {}),
            };
            createMutation.mutate({
              title: title.trim(),
              ...(intent.trim() ? { intent: intent.trim() } : {}),
              ...(active ? { typeId: active.id } : {}),
              ...(Object.keys(input).length > 0 ? { input } : {}),
              ...(acceptance.trim()
                ? { acceptance: acceptance.split('\n').filter(Boolean).map((run) => ({ kind: 'command' as const, run: run.trim(), expect: { exitCode: 0 } })) }
                : {}),
            });
          }}
        >
          新建任务
        </Button>
      </div>
      {createMutation.isError && <div className="text-sm text-red-600">{createMutation.error.message}</div>}
      {transitionMutation.isError && <div className="text-sm text-red-600">{transitionMutation.error.message}</div>}
      {tasksQuery.isLoading && <div className="text-sm text-neutral-500">加载中…</div>}
      {tasksQuery.isError && <div className="text-sm text-red-600">加载失败</div>}
      <div className="flex flex-1 gap-3 overflow-x-auto">
        {cols.map((col) => (
          <BoardColumn
            key={col.key}
            title={col.title}
            tasks={tasks.filter(col.match)}
            projectId={projectId}
            wsNames={wsNames}
            onDispatch={dispatchTargets.length > 0 ? (t) => { setDispatchError(null); setDispatchTask(t); } : undefined}
            pendingId={transitionMutation.isPending ? (transitionMutation.variables?.taskId ?? null) : null}
            onTransition={(taskId, event) => transitionMutation.mutate({ taskId, event })}
          />
        ))}
      </div>
      {dispatchTask && (
        <DispatchDialog
          task={{ id: dispatchTask.id, title: dispatchTask.title, module: parseModule(dispatchTask) }}
          targets={dispatchTargets}
          submitting={dispatchMutation.isPending}
          error={dispatchError}
          onClose={() => setDispatchTask(null)}
          onSubmit={(body) => dispatchMutation.mutate({ taskId: dispatchTask.id, ...body })}
        />
      )}
    </div>
  );
}

export function parseModule(t: BoardTask): string | undefined {
  try {
    const input = JSON.parse(t.inputJson ?? '{}') as { module?: string };
    return input.module;
  } catch {
    return undefined;
  }
}

export { STATUS_LABEL };
