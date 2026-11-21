import { createFileRoute, Link, Outlet } from '@tanstack/react-router';
import { Shell } from '@/components/layout/Shell';
import { buttonClass } from '@/components/ui/button';
import { Empty, Loading } from '@/components/ui/feedback';
import { useProject } from '@/lib/queries';

export const Route = createFileRoute('/projects/$projectId')({
  component: ProjectLayout,
});

function ProjectLayout() {
  const { projectId } = Route.useParams();
  const project = useProject(projectId);
  if (project.isLoading) return <Loading className="h-dvh" />;
  if (!project.data) {
    return (
      <Empty title="项目不存在" icon="alert" className="h-dvh">
        <Link to="/" className={buttonClass('default', 'sm', 'mt-2')}>回到项目列表</Link>
      </Empty>
    );
  }
  return (
    <Shell project={project.data}>
      <Outlet />
    </Shell>
  );
}
