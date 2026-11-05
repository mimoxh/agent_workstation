import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { TaskBoard } from '@/components/board';
import { Shell, type WorkstationNode } from '@/components/layout/Shell';
import { apiClient } from '@/lib/api';

export const Route = createFileRoute('/projects/$projectId/ws/$wsId')({
  component: WorkstationPage,
});

function WorkstationPage() {
  const { projectId, wsId } = Route.useParams();
  const detail = useQuery({
    queryKey: ['project', projectId],
    queryFn: async () => {
      const res = await apiClient.projects[':id'].$get({ param: { id: projectId } });
      if (!res.ok) throw new Error('加载项目失败');
      return (await res.json()) as { name: string; workstations: WorkstationNode[] };
    },
  });

  if (detail.isLoading) {
    return <div className="p-8 text-sm text-neutral-500">加载中…</div>;
  }
  if (detail.isError || !detail.data) {
    return <div className="p-8 text-sm text-red-600">加载失败</div>;
  }
  return (
    <Shell
      projectId={projectId}
      projectName={detail.data.name}
      workstations={detail.data.workstations}
      activeWsId={wsId}
    >
      <TaskBoard workstationId={wsId} />
    </Shell>
  );
}
