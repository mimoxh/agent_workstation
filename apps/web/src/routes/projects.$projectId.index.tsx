import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { ErrorState, Loading } from '@/components/ui/feedback';
import { parseWsSearch, WorkstationScreen } from '@/components/workstation/WorkstationScreen';
import { useProject, useWorkstation } from '@/lib/queries';

export const Route = createFileRoute('/projects/$projectId/')({
  validateSearch: parseWsSearch,
  component: CommandCenter,
});

// 根工作台：项目的入口
function CommandCenter() {
  const { projectId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const project = useProject(projectId);
  const rootId = project.data?.workstations.find((w) => w.parentId === null)?.id;
  const ws = useWorkstation(rootId);

  if (project.isLoading || ws.isLoading) return <Loading />;
  if (!project.data || !ws.data) return <ErrorState error={ws.error ?? new Error('根工作台不存在')} />;
  return <WorkstationScreen ws={ws.data} project={project.data} search={search} onSearch={(s, replace) => void navigate({ search: s, ...(replace ? { replace } : {}) })} />;
}
