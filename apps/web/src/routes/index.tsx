import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { apiClient } from '@/lib/api';
import { Card } from '@/components/ui/card';

export const Route = createFileRoute('/')({
  component: ProjectList,
});

function ProjectList() {
  const projectsQuery = useQuery({
    queryKey: ['projects'],
    queryFn: async () => {
      const res = await apiClient.projects.$get();
      if (!res.ok) throw new Error('加载项目失败');
      return (await res.json()) as Array<{ id: string; name: string; goal: string | null }>;
    },
  });

  return (
    <div className="mx-auto max-w-3xl p-8">
      <h1 className="mb-6 text-xl font-semibold">项目总览</h1>
      {projectsQuery.isLoading ? <div className="text-sm text-neutral-500">加载中…</div> : null}
      <div className="space-y-3">
        {(projectsQuery.data ?? []).map((p) => (
          <Link key={p.id} to="/projects/$projectId" params={{ projectId: p.id }}>
            <Card className="p-4 hover:bg-neutral-50">
              <div className="font-medium">{p.name}</div>
              {p.goal ? <div className="text-sm text-neutral-500">{p.goal}</div> : null}
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
