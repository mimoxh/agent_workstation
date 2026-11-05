import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Navigate, Outlet, useChildMatches } from '@tanstack/react-router';
import { apiClient } from '@/lib/api';

export const Route = createFileRoute('/projects/$projectId')({
  component: RootWorkstation,
});

interface Workstation {
  id: string;
  parentId: string | null;
  name: string;
}

// /projects/:id 本身是布局路由：子路由（ws 页）命中时渲染 Outlet；
// 访问裸 /projects/:id 时跳到根工作台视图
function RootWorkstation() {
  const { projectId } = Route.useParams();
  const childMatches = useChildMatches();
  const detail = useQuery({
    queryKey: ['project', projectId],
    queryFn: async () => {
      const res = await apiClient.projects[':id'].$get({ param: { id: projectId } });
      if (!res.ok) throw new Error('加载项目失败');
      return (await res.json()) as { workstations: Workstation[] };
    },
  });

  if (childMatches.length > 0) {
    return <Outlet />;
  }

  const root = detail.data?.workstations.find((w) => w.parentId === null);
  if (root) {
    return <Navigate to="/projects/$projectId/ws/$wsId" params={{ projectId, wsId: root.id }} replace />;
  }
  if (detail.isLoading) {
    return <div className="p-8 text-sm text-neutral-500">加载中…</div>;
  }
  return <div className="p-8 text-sm text-red-600">项目不存在或没有根工作台</div>;
}
