import { createFileRoute } from '@tanstack/react-router';
import { ProjectSettings } from '@/components/layout/ProjectSettings';
import { Loading } from '@/components/ui/feedback';
import { useProject } from '@/lib/queries';

export const Route = createFileRoute('/projects/$projectId/settings')({
  component: ProjectSettingsPage,
});

function ProjectSettingsPage() {
  const { projectId } = Route.useParams();
  const project = useProject(projectId);
  if (!project.data) return <Loading />;
  return <ProjectSettings key={project.data.id} project={project.data} />;
}
