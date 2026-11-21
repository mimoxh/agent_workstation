import { Link } from '@tanstack/react-router';
import type { CSSProperties } from 'react';
import { ResizeHandle, useResizableWidth } from '@/components/design/resize';
import { Icon, panelIcon } from '@/components/ui/icons';
import { useOverview, useWorkstation, type ProjectDetail } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { setDock, useDock } from './dock';
import { dockBlocks } from './home';
import { renderPanel } from './WorkstationScreen';

const noop = () => {};

// 工作台右侧栏：最右一列图标切改动审阅 / 文件树 / 页面预览，打开后和主区同屏，可拖宽
export function RightDock({ project, wsId }: { project: ProjectDetail; wsId: string }) {
  const ws = useWorkstation(wsId);
  const overview = useOverview(project.id);
  const open = useDock();
  const [width, resize] = useResizableWidth('aw.dockWidth', { min: 360, max: 1600, initial: 560, edge: 'left', maxRatio: 0.75 });
  const blocks = dockBlocks(ws.data?.blocks ?? []);
  if (!ws.data || blocks.length === 0) return null;
  const block = blocks.find((b) => b.panelId === open);
  const pending = overview.data?.workstations.find((w) => w.id === wsId)?.pendingReviews ?? 0;

  return (
    <>
      {block && (
        <aside
          aria-label={block.name ?? '右侧栏'}
          data-testid="dock"
          style={{ '--dock-w': `${width}px` } as CSSProperties}
          className="relative flex min-w-0 shrink-0 flex-col border-l border-rule bg-paper animate-slide-l max-md:fixed max-md:bottom-0 max-md:right-12 max-md:top-[52px] max-md:z-40 max-md:w-[calc(100vw-3rem)] max-md:shadow-[var(--shadow-pop)] md:w-[var(--dock-w)]"
        >
          <span className="max-md:hidden"><ResizeHandle {...resize} testId="dock-resize" /></span>
          <header className="flex h-12 shrink-0 items-center gap-2 border-b border-rule pl-3.5 pr-2">
            <Icon name={panelIcon(block.panelType, block.entityType, block.panelId)} className="text-muted" />
            <h2 className="truncate text-sm font-bold text-ink">{block.name}</h2>
            <span className="truncate text-xs text-muted">{ws.data.name}</span>
            <Link
              to="/projects/$projectId/ws/$wsId/$panelId"
              params={{ projectId: project.id, wsId, panelId: block.panelId ?? '' }}
              onClick={() => setDock(null)}
              className="ml-auto grid size-8 shrink-0 place-items-center rounded-full text-muted hover:bg-hover hover:text-ink"
              aria-label="全屏打开"
              title="全屏打开"
              data-testid="dock-fullscreen"
            >
              <Icon name="expand" className="size-3.5" />
            </Link>
            <button type="button" onClick={() => setDock(null)} className="grid size-8 shrink-0 place-items-center rounded-full text-muted hover:bg-hover hover:text-ink" aria-label="收起右侧栏" title="收起" data-testid="dock-close">
              <Icon name="close" className="size-3.5" />
            </button>
          </header>
          <div className="min-h-0 flex-1" data-testid={`dock-panel-${block.panelId}`}>
            {renderPanel(block, ws.data, project, {}, noop)}
          </div>
        </aside>
      )}
      <nav aria-label="右侧栏" className="flex w-12 shrink-0 flex-col items-center gap-1.5 border-l border-rule bg-paper-2 py-2.5 max-md:w-10" data-testid="dock-rail">
        {blocks.map((b) => {
          const on = b.panelId === open;
          return (
            <button
              key={b.id}
              type="button"
              aria-pressed={on}
              aria-label={b.name ?? ''}
              onClick={() => setDock(on ? null : b.panelId)}
              data-testid={`dock-tab-${b.name}`}
              className={cn(
                'group/dock relative grid size-9 place-items-center rounded-full transition-colors duration-150 max-md:size-8',
                on ? 'bg-primary text-primary-ink' : 'text-muted hover:bg-hover hover:text-ink',
              )}
            >
              <Icon name={panelIcon(b.panelType, b.entityType, b.panelId)} className="size-[18px]" />
              <span role="tooltip" className="pointer-events-none absolute right-full top-1/2 z-50 mr-2 -translate-y-1/2 whitespace-nowrap rounded-chip bg-primary px-2 py-1 text-xs text-primary-ink opacity-0 shadow-[var(--shadow-pop)] transition-opacity duration-150 group-hover/dock:opacity-100 group-focus-visible/dock:opacity-100">
                {on ? `收起${b.name}` : b.name}
              </span>
              {b.panelType === 'diff' && pending > 0 && (
                <span className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-cool-tag px-1 text-[10px] font-semibold tabular-nums text-cool-tag-ink shadow-[0_0_0_2px_var(--color-paper-2)]" aria-label={`${pending} 个待审`}>{pending}</span>
              )}
            </button>
          );
        })}
      </nav>
    </>
  );
}
