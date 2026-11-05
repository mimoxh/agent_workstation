import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { apiClient } from '@/lib/api';
import { cn } from '@/lib/utils';

export interface WorkstationNode {
  id: string;
  parentId: string | null;
  name: string;
}

interface InboxItem {
  id: string;
  kind: string;
  refId: string | null;
}

const KIND_LABEL: Record<string, string> = {
  task_rejected: '任务被拒绝',
  task_countered: '反提案',
  blocked: '阻塞',
  proposal_review: '提案审阅',
  run_failed: '运行失败',
  command_confirm: '命令确认',
};

function InboxBell() {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const inbox = useQuery({
    queryKey: ['inbox'],
    queryFn: async () => {
      const res = await apiClient.inbox.$get({ query: { status: 'open' } });
      return (await res.json()) as InboxItem[];
    },
    refetchInterval: 5000,
  });
  const resolve = useMutation({
    mutationFn: async (id: string) => {
      await apiClient.inbox[':id'].resolve.$post({ param: { id }, json: {} });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['inbox'] }),
  });
  const items = inbox.data ?? [];
  return (
    <div className="relative">
      <button className="text-neutral-600" onClick={() => setOpen(!open)}>
        待处理 {items.length}
      </button>
      {open && (
        <div className="absolute right-0 top-6 z-10 w-72 rounded border border-neutral-200 bg-white p-2 shadow-md">
          {items.length === 0 ? (
            <div className="p-2 text-xs text-neutral-400">暂无待处理</div>
          ) : (
            items.map((i) => (
              <div key={i.id} className="flex items-center justify-between gap-2 border-b border-neutral-100 px-1 py-1.5 text-xs last:border-0">
                <span>{KIND_LABEL[i.kind] ?? i.kind} · {i.refId?.slice(0, 8)}</span>
                <button className="text-blue-600" onClick={() => resolve.mutate(i.id)}>标记已处理</button>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

export function Shell({
  projectId,
  projectName,
  workstations,
  activeWsId,
  members,
  children,
}: {
  projectId: string;
  projectName: string;
  workstations: WorkstationNode[];
  activeWsId: string;
  members?: { name: string; role: string | null; isSteward: number }[];
  children: ReactNode;
}) {
  const roots = workstations.filter((w) => w.parentId === null);
  const childrenOf = (id: string) => workstations.filter((w) => w.parentId === id);

  return (
    <div className="flex h-screen flex-col">
      <header className="flex h-10 shrink-0 items-center gap-3 border-b border-neutral-200 px-4 text-sm">
        <span className="font-semibold">{projectName}</span>
        <span className="text-neutral-400">·</span>
        <InboxBell />
      </header>
      <div className="flex min-h-0 flex-1">
        <aside className="w-44 shrink-0 border-r border-neutral-200 p-2">
          <div className="px-1 pb-2 text-xs font-semibold text-neutral-500">工作台树</div>
          <nav className="space-y-0.5">
            {roots.map((root) => (
              <div key={root.id}>
                <TreeItem projectId={projectId} ws={root} active={activeWsId === root.id} depth={0} />
                {childrenOf(root.id).map((child) => (
                  <TreeItem key={child.id} projectId={projectId} ws={child} active={activeWsId === child.id} depth={1} />
                ))}
              </div>
            ))}
          </nav>
        </aside>
        <main className="min-w-0 flex-1">{children}</main>
        <aside className="w-56 shrink-0 overflow-y-auto border-l border-neutral-200 p-3 text-sm">
          <div className="pb-2 text-xs font-semibold text-neutral-500">成员</div>
          <div className="space-y-1">
            <div className="text-neutral-700">本地用户</div>
            {(members ?? []).map((m, i) => (
              <div key={i} className="text-neutral-700">
                {m.name}
                {m.isSteward === 1 && <span className="ml-1 rounded bg-purple-100 px-1 text-xs text-purple-700">steward</span>}
                <div className="text-xs text-neutral-400">{m.role}</div>
              </div>
            ))}
          </div>
          <div className="pt-4 text-xs font-semibold text-neutral-500">会话</div>
          <div className="text-neutral-400">会话（阶段 2）</div>
        </aside>
      </div>
    </div>
  );
}

function TreeItem({ projectId, ws, active, depth }: { projectId: string; ws: WorkstationNode; active: boolean; depth: number }) {
  return (
    <Link
      to="/projects/$projectId/ws/$wsId"
      params={{ projectId, wsId: ws.id }}
      className={cn('block rounded px-2 py-1 text-sm', active ? 'bg-neutral-200 font-medium' : 'text-neutral-700 hover:bg-neutral-100')}
      style={{ paddingLeft: `${8 + depth * 14}px` }}
    >
      {ws.name}
    </Link>
  );
}
