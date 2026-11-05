import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { TaskBoard, type StageCol } from '@/components/board/TaskBoard';
import type { DispatchTarget } from '@/components/board/DispatchDialog';
import { Shell } from '@/components/layout/Shell';
import { WsThread } from '@/components/chat/Thread';
import { DiffPanel, FileTree, TestRunTable } from '@/components/board/panels';
import { apiClient } from '@/lib/api';
import { cn } from '@/lib/utils';

export const Route = createFileRoute('/projects/$projectId/ws/$wsId')({
  component: WorkstationPage,
});

interface WsNode { id: string; parentId: string | null; name: string }
interface Block { id: string; panelId: string | null; panelType: string | null; name: string | null; configJson: string | null; sort: number | null }
interface Agent { id: string; name: string; role: string | null; isSteward: number }
interface WsDetail {
  id: string; name: string; pluginId: string | null;
  blocks: Block[]; agents: Agent[];
  manifest: { id: string; panels: { id: string; title: string }[]; stages: { id: string; name: string }[]; tasks: { id: string; name: string; inputSchema: Record<string, unknown> }[] } | null;
}

const descendants = (all: WsNode[], rootId: string): WsNode[] => {
  const out: WsNode[] = [];
  const q = [rootId];
  while (q.length) {
    const cur = q.shift()!;
    for (const w of all) if (w.parentId === cur) { out.push(w); q.push(w.id); }
  }
  return out;
};

function WorkstationPage() {
  const { projectId, wsId } = Route.useParams();
  const [tab, setTab] = useState(0);

  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: async () => {
      const res = await apiClient.projects[':id'].$get({ param: { id: projectId } });
      if (!res.ok) throw new Error('加载项目失败');
  return (await res.json()) as { name: string; workstations: WsNode[] };
    },
  });
  const detail = useQuery({
    queryKey: ['ws', wsId],
    queryFn: async () => {
      const res = await apiClient.workstations[':id'].$get({ param: { id: wsId } });
      if (!res.ok) throw new Error('加载工作台失败');
  return (await res.json()) as WsDetail;
    },
  });

  // 子孙台的 manifest taskTypes（供派发对话框）

  const agentStatus = useQuery({
    queryKey: ['agent-status', wsId],
    queryFn: async () => {
      const res = await apiClient.workstations[':id'].agents.status.$get({ param: { id: wsId } });
      return (await res.json()) as { running: string[] };
    },
    refetchInterval: 3000,
  });
  const runningIds = new Set(agentStatus.data?.running ?? []);
  const targets = descendants(project.data?.workstations ?? [], wsId);
  const targetDetails = useQuery({
    queryKey: ['ws-targets', targets.map((t) => t.id).join(',')],
    enabled: targets.length > 0,
    queryFn: async () => {
      const out: DispatchTarget[] = [];
      for (const t of targets) {
        const res = await apiClient.workstations[':id'].$get({ param: { id: t.id } });
        const d = (await res.json()) as WsDetail;
        out.push({ id: t.id, name: t.name, taskTypes: d.manifest?.tasks ?? [] });
      }
      return out;
    },
  });

  if (!project.data || !detail.data) {
    return <div className="p-8 text-sm text-neutral-500">加载中…</div>;
  }

  const ws = detail.data;
  const blocks = [...ws.blocks].sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
  const active = blocks[tab] ?? blocks[0];
  const field = (() => { try { return (JSON.parse(active?.configJson ?? '{}') as { field?: string }).field; } catch { return undefined; } })();
  const stageCols: StageCol[] = (ws.manifest?.stages ?? []).map((s) => ({ id: s.id, title: s.name }));
  const wsNames = Object.fromEntries(project.data.workstations.map((w) => [w.id, w.name]));
  const members = (ws.agents ?? []).map((a) => ({ ...a, running: runningIds.has(a.id) }));

  return (
    <Shell projectId={projectId} projectName={project.data.name} workstations={project.data.workstations} activeWsId={wsId} thread={<WsThread wsId={wsId} />} members={members}>
      <div className="flex h-full flex-col">
        <div className="flex gap-1 border-b border-neutral-200 px-3 pt-2">
          {blocks.map((b, i) => (
            <button key={b.id} onClick={() => setTab(i)}
              className={cn('rounded-t px-3 py-1.5 text-sm', i === tab ? 'bg-neutral-200 font-medium' : 'text-neutral-500 hover:bg-neutral-100')}>
              {b.name}
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {active?.panelType === 'board' && (
            <TaskBoard
              workstationId={wsId}
              projectId={projectId}
              groupBy={field === 'stage' ? 'stage' : 'status'}
              stageColumns={stageCols}
              dispatchTargets={targetDetails.data ?? []}
              createTaskTypes={ws.manifest?.tasks ?? []}
              wsNames={wsNames}
            />
          )}
          {active?.panelType === 'table' && (
            <TestRunTable wsId={wsId} />
          )}
          {active?.panelType === 'diff' && <DiffPanel wsId={wsId} />}
          {active?.panelType === 'tree' && <FileTree wsId={wsId} />}
          {(active?.panelType === 'preview' || active?.panelType === 'timeline') && (
            <div className="p-6 text-sm text-neutral-400">{active.name}（阶段 3+ 实现）</div>
          )}
        </div>
      </div>
    </Shell>
  );
}
