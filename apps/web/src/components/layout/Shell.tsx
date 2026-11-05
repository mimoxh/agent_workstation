import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface WorkstationNode {
  id: string;
  parentId: string | null;
  name: string;
}

// PRD 附录 A 的 IDE 三栏：顶栏 / 工作台树 / 板块区 / 会话占位
export function Shell({
  projectId,
  projectName,
  workstations,
  activeWsId,
  children,
}: {
  projectId: string;
  projectName: string;
  workstations: WorkstationNode[];
  activeWsId: string;
  children: ReactNode;
}) {
  const roots = workstations.filter((w) => w.parentId === null);
  const childrenOf = (id: string) => workstations.filter((w) => w.parentId === id);

  return (
    <div className="flex h-screen flex-col">
      <header className="flex h-10 shrink-0 items-center gap-3 border-b border-neutral-200 px-4 text-sm">
        <span className="font-semibold">{projectName}</span>
        <span className="text-neutral-400">·</span>
        <span className="text-neutral-600">待处理 0</span>
      </header>
      <div className="flex min-h-0 flex-1">
        <aside className="w-44 shrink-0 border-r border-neutral-200 p-2">
          <div className="px-1 pb-2 text-xs font-semibold text-neutral-500">工作台树</div>
          <nav className="space-y-0.5">
            {roots.map((root) => (
              <div key={root.id}>
                <TreeItem projectId={projectId} ws={root} active={activeWsId === root.id} depth={0} />
                {childrenOf(root.id).map((child) => (
                  <TreeItem
                    key={child.id}
                    projectId={projectId}
                    ws={child}
                    active={activeWsId === child.id}
                    depth={1}
                  />
                ))}
              </div>
            ))}
          </nav>
        </aside>
        <main className="min-w-0 flex-1">{children}</main>
        <aside className="w-56 shrink-0 border-l border-neutral-200 p-3 text-sm text-neutral-400">
          会话（M0.2）
        </aside>
      </div>
    </div>
  );
}

function TreeItem({
  projectId,
  ws,
  active,
  depth,
}: {
  projectId: string;
  ws: WorkstationNode;
  active: boolean;
  depth: number;
}) {
  return (
    <Link
      to="/projects/$projectId/ws/$wsId"
      params={{ projectId, wsId: ws.id }}
      className={cn(
        'block rounded px-2 py-1 text-sm',
        active ? 'bg-neutral-200 font-medium' : 'text-neutral-700 hover:bg-neutral-100',
      )}
      style={{ paddingLeft: `${8 + depth * 14}px` }}
    >
      {ws.name}
    </Link>
  );
}
