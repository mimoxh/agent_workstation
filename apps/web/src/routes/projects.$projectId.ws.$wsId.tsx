import { createFileRoute, Navigate, useNavigate } from '@tanstack/react-router';
import { ErrorState, Loading } from '@/components/ui/feedback';
import { parseWsSearch, WorkstationScreen } from '@/components/workstation/WorkstationScreen';
import { useProject, useWorkstation } from '@/lib/queries';

export const Route = createFileRoute('/projects/$projectId/ws/$wsId')({
  validateSearch: parseWsSearch,
  component: WorkstationPage,
});

function WorkstationPage() {
  const { projectId, wsId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const project = useProject(projectId);
  const detail = useWorkstation(wsId);

  if (detail.isLoading || project.isLoading) return <Loading />;
  if (!detail.data || !project.data) return <ErrorState error={detail.error ?? new Error('工作台不存在')} />;
  if (detail.data.parentId === null) return <Navigate to="/projects/$projectId" params={{ projectId }} search={search} replace />;
  return <WorkstationScreen ws={detail.data} project={project.data} search={search} onSearch={(s, replace) => void navigate({ search: s, ...(replace ? { replace } : {}) })} />;
}
