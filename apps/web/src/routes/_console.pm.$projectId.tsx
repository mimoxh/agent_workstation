import { createFileRoute, Link } from '@tanstack/react-router';
import { WsThread } from '@/components/chat/Thread';
import { PageHeader } from '@/components/layout/Page';
import { buttonClass } from '@/components/ui/button';
import { ErrorState, Loading } from '@/components/ui/feedback';
import { nameMaps, useProject } from '@/lib/queries';

export const Route = createFileRoute('/_console/pm/$projectId')({
  component: PmPage,
});

// 控制台里和某个项目的项目经理对话：根工作台的会话
function PmPage() {
  const { projectId } = Route.useParams();
  const project = useProject(projectId);
  if (project.isLoading) return <Loading />;
  const root = project.data?.workstations.find((w) => w.parentId === null);
  if (!project.data || !root) return <ErrorState error={project.error ?? new Error('项目不存在')} />;
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="pm-page">
      <div className="shrink-0 px-5 md:px-10 lg:px-14">
        <div className="mx-auto max-w-[54rem]">
          <PageHeader
            compact
            icon="chat"
            title="项目经理"
            desc={`${project.data.name} 的根工作台：派发、分诊阻塞、汇报进度`}
            actions={<Link to="/projects/$projectId" params={{ projectId }} className={buttonClass()}>打开项目</Link>}
          />
        </div>
      </div>
      <WsThread wsId={root.id} projectId={projectId} names={nameMaps(project.data).agent} root wide />
    </div>
  );
}
