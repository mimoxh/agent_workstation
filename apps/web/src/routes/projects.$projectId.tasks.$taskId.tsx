import type { TaskStatus } from '@aw/domain';
import { allowedEvents } from '@aw/domain';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useState } from 'react';
import { RespondDialog } from '@/components/board/RespondDialog';
import { EVENT_LABEL, STATUS_LABEL, STATUS_TONE } from '@/components/board/labels';
import { Shell } from '@/components/layout/Shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { apiClient } from '@/lib/api';

export const Route = createFileRoute('/projects/$projectId/tasks/$taskId')({
  component: TaskDetailPage,
});

interface Task {
  id: string; title: string; status: string; stage: string | null; intent: string | null;
  inputJson: string | null; acceptanceJson: string | null; typeId: string | null;
  assigneeType: string | null; assigneeId: string | null; workstationId: string; projectId: string;
}
interface Detail { task: Task; parent: Task | null; children: Task[]; events: { id: string; action: string; payloadJson: string | null; createdAt: string }[] }
interface WsNode { id: string; parentId: string | null; name: string }
interface WsDetail { id: string; agents: { name: string; role: string | null; isSteward: number }[] }

// 事件日志 payload 里的 assigneeId / workstationId / targetId 解析成名字
function nameOf(id: unknown, wsNames: Record<string, string>, agentNames: Record<string, string>): unknown {
  if (typeof id !== 'string') return id;
  return wsNames[id] ?? agentNames[id] ?? (id.length > 12 ? id.slice(0, 8) : id);
}

function TaskDetailPage() {
  const { projectId, taskId } = Route.useParams();
  const qc = useQueryClient();
  const [respond, setRespond] = useState<{ action: 'reject' | 'counter' } | null>(null);
  const [respondError, setRespondError] = useState<string | null>(null);

  const detail = useQuery({
    queryKey: ['task', taskId],
    queryFn: async () => {
      const res = await apiClient.tasks[':id'].$get({ param: { id: taskId } });
      if (!res.ok) throw new Error('任务不存在');
      return (await res.json()) as Detail;
    },
  });
  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: async () => {
      const res = await apiClient.projects[':id'].$get({ param: { id: projectId } });
      if (!res.ok) throw new Error('加载项目失败');
      return (await res.json()) as { name: string; workstations: WsNode[] };
    },
  });
  const wsId = detail.data?.task.workstationId;
  const ws = useQuery({
    queryKey: ['ws', wsId],
    enabled: !!wsId,
    queryFn: async () => {
      const res = await apiClient.workstations[':id'].$get({ param: { id: wsId! } });
      return (await res.json()) as WsDetail;
    },
  });

  const mut = useMutation({
    mutationFn: async ({ path, json }: { path: 'transition' | 'respond'; json: Record<string, unknown> }) => {
      const res = await apiClient.tasks[':id'][path].$post({ param: { id: taskId }, json: json as never });
      if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? '操作失败');
      return res.json();
    },
    onSuccess: async () => {
      setRespond(null);
      setRespondError(null);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['task', taskId] }),
        qc.invalidateQueries({ queryKey: ['inbox'] }),
        qc.invalidateQueries({ queryKey: ['tasks'] }),
      ]);
    },
    onError: (e) => setRespondError(e.message),
  });

  if (!detail.data || !project.data) return <div className="p-8 text-sm text-neutral-500">加载中…</div>;
  const { task, parent, children, events } = detail.data;
  const status = task.status as TaskStatus;
  const input = JSON.parse(task.inputJson ?? '{}') as Record<string, unknown>;
  const acceptance = JSON.parse(task.acceptanceJson ?? '[]') as { kind: string; run?: string }[];
  const wsNames = Object.fromEntries(project.data.workstations.map((w) => [w.id, w.name]));
  const agentNames = Object.fromEntries((ws.data?.agents ?? []).map((a) => [a.name, a.name]));
  const wsNameById = (id: string | null) => (id ? (wsNames[id] ?? id.slice(0, 8)) : '—');
  const events2 = allowedEvents(status).filter(
    (e) => e !== 'accept' && e !== 'reject' && e !== 'counter' && e !== 'dispatch',
  );

  return (
    <Shell
      projectId={projectId}
      projectName={project.data.name}
      workstations={project.data.workstations}
      activeWsId={task.workstationId}
      members={ws.data?.agents ?? []}
    >
      <div className="h-full overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-5 p-8">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-semibold">{task.title}</h1>
            <Badge tone={STATUS_TONE[status] ?? 'neutral'}>{STATUS_LABEL[status] ?? status}</Badge>
            {task.stage && <Badge tone="blue">{task.stage}</Badge>}
          </div>
          {mut.isError && !respond && <div className="text-sm text-red-600">{mut.error.message}</div>}
          <section className="space-y-1 text-sm">
            {task.intent && <div><span className="text-neutral-500">intent：</span>{task.intent}</div>}
            {Object.keys(input).length > 0 && <div><span className="text-neutral-500">input：</span><code className="text-xs">{JSON.stringify(input)}</code></div>}
            {acceptance.length > 0 && (
              <div><span className="text-neutral-500">验收：</span>{acceptance.map((a, i) => <code key={i} className="mr-2 text-xs">{a.run ?? a.kind}</code>)}</div>
            )}
            {task.assigneeType && (
              <div><span className="text-neutral-500">派发去向：</span>{task.assigneeType === 'workstation' ? wsNameById(task.assigneeId) : `${task.assigneeType} / ${task.assigneeId?.slice(0, 8)}`}</div>
            )}
            {parent && (
              <div>父任务：<Link to="/projects/$projectId/tasks/$taskId" params={{ projectId, taskId: parent.id }} className="text-blue-600 hover:underline">{parent.title}</Link></div>
            )}
            {children.map((c) => (
              <div key={c.id}>子任务：<Link to="/projects/$projectId/tasks/$taskId" params={{ projectId, taskId: c.id }} className="text-blue-600 hover:underline">{c.title}</Link>（{STATUS_LABEL[c.status as TaskStatus] ?? c.status}）</div>
            ))}
          </section>
          <section className="flex flex-wrap gap-2">
            {status === 'dispatched' && task.assigneeType === 'workstation' && (
              <>
                <Button size="sm" variant="outline" disabled={mut.isPending} onClick={() => mut.mutate({ path: 'respond', json: { action: 'accept' } })}>接单</Button>
                <Button size="sm" variant="outline" onClick={() => { setRespondError(null); setRespond({ action: 'reject' }); }}>拒绝</Button>
                <Button size="sm" variant="outline" onClick={() => { setRespondError(null); setRespond({ action: 'counter' }); }}>反提案</Button>
              </>
            )}
            {events2.map((e) => (
              <Button key={e} size="sm" variant={e === 'cancel' ? 'ghost' : 'outline'} disabled={mut.isPending}
                onClick={() => mut.mutate({ path: 'transition', json: { event: e } })}>
                {EVENT_LABEL[e]}
              </Button>
            ))}
          </section>
          <section>
            <h2 className="pb-2 text-sm font-semibold">事件日志</h2>
            <div className="space-y-1">
              {events.map((ev) => {
                let payload: string;
                try {
                  const p = JSON.parse(ev.payloadJson ?? '{}') as Record<string, unknown>;
                  for (const k of ['assigneeId', 'workstationId', 'targetId']) {
                    if (p[k] !== undefined) p[k] = nameOf(p[k], wsNames, agentNames);
                  }
                  payload = JSON.stringify(p);
                } catch { payload = ev.payloadJson ?? ''; }
                return (
                  <div key={ev.id} className="text-xs text-neutral-600">
                    <span className="text-neutral-400">{ev.createdAt.slice(11, 19)}</span> {ev.action}
                    {payload && payload !== '{}' && <code className="ml-2 text-neutral-400">{payload}</code>}
                  </div>
                );
              })}
            </div>
          </section>
          <Link to="/projects/$projectId/ws/$wsId" params={{ projectId, wsId: task.workstationId }} className="text-sm text-blue-600 hover:underline">← 返回工作台</Link>
        </div>
      </div>
      {respond && (
        <RespondDialog
          action={respond.action}
          taskTitle={task.title}
          module={typeof input.module === 'string' ? input.module : undefined}
          submitting={mut.isPending}
          error={respondError}
          onClose={() => setRespond(null)}
          onSubmit={(body) => mut.mutate({ path: 'respond', json: body as Record<string, unknown> })}
        />
      )}
    </Shell>
  );
}
