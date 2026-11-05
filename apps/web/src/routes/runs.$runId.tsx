import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { apiClient } from '@/lib/api';
import { Shell } from '@/components/layout/Shell';
import { Badge } from '@/components/ui/badge';
import { WsThread } from '@/components/chat/Thread';

export const Route = createFileRoute('/runs/$runId')({ component: RunPage });

interface Step {
  t: string; type: 'model' | 'tool'; text?: string;
  toolCalls?: { id: string; name: string; args: unknown }[];
  usage?: { inputTokens?: number; outputTokens?: number };
  usageEstimated?: boolean;
  name?: string; args?: unknown; result?: unknown; truncated?: boolean; ms?: number; error?: string;
}
interface Run { id: string; agentId: string | null; taskId: string | null; status: string; trigger: string | null; stopReason: string | null; provider: string | null; model: string | null; tokensIn: number | null; tokensOut: number | null; startedAt: string | null; endedAt: string | null; error: string | null }
interface TaskDetail { task: { id: string; title: string; projectId: string; workstationId: string } }

const dur = (start: string | null, end: string | null) => {
  if (!start) return '—';
  const ms = (end ? new Date(end).getTime() : Date.now()) - new Date(start).getTime();
  return `${(ms / 1000).toFixed(1)}s`;
};

function RunPage() {
  const { runId } = Route.useParams();
  const run = useQuery({
    queryKey: ['run', runId],
    queryFn: async () => {
      const res = await apiClient.runs[':id'].$get({ param: { id: runId } });
      return (await res.json()) as Run;
    },
  });
  const taskId = run.data?.taskId ?? null;
  const task = useQuery({
    queryKey: ['task', taskId],
    enabled: !!taskId,
    queryFn: async () => {
      const res = await apiClient.tasks[':id'].$get({ param: { id: taskId! } });
      return (await res.json()) as TaskDetail;
    },
  });
  const projectId = task.data?.task.projectId ?? null;
  const r = run.data;
  const agentQ = useQuery({
    queryKey: ['agent', r?.agentId],
    enabled: !!r?.agentId,
    queryFn: async () => {
      const res = await apiClient.agents[':id'].$get({ param: { id: r!.agentId! } });
      return res.ok ? ((await res.json()) as { id: string; workstationId: string; name: string }) : null;
    },
  });
  const wsId = agentQ.data?.workstationId ?? task.data?.task.workstationId ?? null;
  const project = useQuery({
    queryKey: ['project', projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const res = await apiClient.projects[':id'].$get({ param: { id: projectId! } });
      return (await res.json()) as { name: string; workstations: { id: string; parentId: string | null; name: string }[] };
    },
  });
  const ws = useQuery({
    queryKey: ['ws', wsId],
    enabled: !!wsId,
    queryFn: async () => {
      const res = await apiClient.workstations[':id'].$get({ param: { id: wsId! } });
      return (await res.json()) as { agents: { id: string; name: string; role: string | null; isSteward: number }[] };
    },
  });
  const [steps, setSteps] = useState<Step[]>([]);
  const [finished, setFinished] = useState<string | null>(null);

  useEffect(() => {
    setSteps([]);
    setFinished(null);
    const es = new EventSource(`/api/runs/${runId}/stream`);
    es.addEventListener('step', (ev) => setSteps((p) => [...p, JSON.parse((ev as MessageEvent).data) as Step]));
    es.addEventListener('finished', (ev) => { setFinished((JSON.parse((ev as MessageEvent).data) as { stopReason: string }).stopReason); es.close(); });
    return () => es.close();
  }, [runId]);

  const agentRow = agentQ.data ? { id: agentQ.data.id, name: agentQ.data.name } : (ws.data?.agents ?? []).find((a) => a.id === r?.agentId);
  const body = (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-4 p-8">
        {r && (
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-semibold">Run {r.id.slice(0, 8)}</h1>
              <Badge tone={r.status === 'completed' ? 'green' : r.status === 'running' ? 'blue' : 'red'}>{r.status}{r.stopReason ? `/${r.stopReason}` : ''}</Badge>
              {r.trigger && <Badge tone="neutral">{r.trigger}</Badge>}
            </div>
            <div className="text-sm text-neutral-600">
              {agentRow && wsId && projectId
                ? <Link to="/projects/$projectId/ws/$wsId" params={{ projectId, wsId }} className="text-blue-600 hover:underline">{agentRow.name}</Link>
                : `agent ${r.agentId?.slice(0, 8) ?? '—'}`}
              {' · 任务：'}
              {task.data && projectId && <Link to="/projects/$projectId/tasks/$taskId" params={{ projectId, taskId: task.data.task.id }} className="text-blue-600 hover:underline">{task.data.task.title}</Link>}
              {` · ${r.provider ?? '?'}:${r.model ?? '?'} · tokens ${r.tokensIn ?? 0}+${r.tokensOut ?? 0} · ${dur(r.startedAt, r.endedAt)}`}
            </div>
            {r.error && <div className="text-sm text-red-600">{r.error}</div>}
          </div>
        )}
        <h2 className="text-sm font-semibold">Trace</h2>
        <div className="space-y-2" data-testid="run-trace">
          {steps.map((s, i) => (
            <details key={i} className="rounded border border-neutral-200 p-2 text-xs" open={i === steps.length - 1}>
              <summary className="cursor-pointer font-medium">
                {s.type === 'model' ? '模型' : `工具 ${s.name}`} · {s.t.slice(11, 19)}{s.error ? ' ⚠' : ''}
                {s.usage ? ` · ${s.usage.inputTokens ?? 0}+${s.usage.outputTokens ?? 0} tok${s.usageEstimated ? '(估)' : ''}` : ''}
              </summary>
              {s.text && <pre className="mt-1 whitespace-pre-wrap">{s.text}</pre>}
              {s.toolCalls?.map((c) => <pre key={c.id} className="mt-1 whitespace-pre-wrap text-neutral-600">{c.name}({JSON.stringify(c.args)})</pre>)}
              {s.result !== undefined && <pre className="mt-1 whitespace-pre-wrap text-neutral-600">{JSON.stringify(s.result).slice(0, 2000)}{s.truncated ? '…[truncated]' : ''}</pre>}
            </details>
          ))}
        </div>
        {finished && <div className="text-sm text-neutral-500">run 结束：{finished}</div>}
      </div>
    </div>
  );

  if (!project.data || !wsId) return body;
  return (
    <Shell
      projectId={projectId ?? ''}
      projectName={project.data.name}
      workstations={project.data.workstations}
      activeWsId={wsId}
      members={ws.data?.agents ?? []}
      thread={<WsThread wsId={wsId} />}
    >
      {body}
    </Shell>
  );
}
