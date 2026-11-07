import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { Empty, ErrorState, Loading } from '@/components/ui/feedback';
import { parseWsSearch, renderPanel } from '@/components/workstation/WorkstationScreen';
import { useProject, useWorkstation } from '@/lib/queries';

export const Route = createFileRoute('/projects/$projectId/ws/$wsId_/$panelId')({
  validateSearch: parseWsSearch,
  component: PanelPage,
});

// 板块全屏：长文档、大表格需要占满主区
function PanelPage() {
  const { projectId, wsId, panelId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const project = useProject(projectId);
  const ws = useWorkstation(wsId);

  if (ws.isLoading || project.isLoading) return <Loading />;
  if (!ws.data || !project.data) return <ErrorState error={ws.error ?? new Error('工作台不存在')} />;
  const block = ws.data.blocks.find((b) => b.panelId === panelId);
  if (!block) return <Empty title="板块不存在" />;
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="panel-page">
      <header className="flex items-baseline gap-3 border-b border-rule bg-paper-2 px-4 py-2.5">
        <h1 className="text-title text-ink">{block.name}</h1>
        <Link to="/projects/$projectId/ws/$wsId" params={{ projectId, wsId }} search={{ panel: panelId }} className="text-sm text-cool hover:underline">退出全屏</Link>
      </header>
      <div className="min-h-0 flex-1">
        {renderPanel(block, ws.data, project.data, { q: search.q, status: search.status }, (f) =>
          void navigate({ search: { ...(f.q ? { q: f.q } : {}), ...(f.status && f.status !== 'all' ? { status: f.status } : {}) }, replace: true }),
        )}
      </div>
    </div>
  );
}
