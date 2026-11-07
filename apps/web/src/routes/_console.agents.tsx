import { createFileRoute } from '@tanstack/react-router';
import { GlobalPage } from '@/components/layout/ProjectHeader';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Loading } from '@/components/ui/feedback';
import { usePlugins } from '@/lib/queries';

export const Route = createFileRoute('/_console/agents')({ component: AgentsPage });

// 模板来自已装插件；实例的模型、提示词、工具在各工作台的「编制」里调整
function AgentsPage() {
  const plugins = usePlugins();
  return (
    <GlobalPage title="Agent 模板" icon="robot" testId="agents-page">
      <p className="text-sm text-muted">这里是插件声明的模板。要调整某个工作台里的实例，到该工作台的「编制」板块。</p>
      {plugins.isLoading && <Loading />}
      {plugins.data?.map((p) => (
        <section key={p.id} className="space-y-2" aria-label={p.name}>
          <h2 className="text-title text-ink">{p.name} <span className="measured text-xs text-muted">{p.id}@{p.version}</span></h2>
          <div className="grid gap-2 md:grid-cols-2">
            {p.agents.map((a) => (
              <Card key={a.id} className="space-y-1.5 p-3" data-testid="template-card">
                <p className="flex items-center gap-2">
                  <span className="text-md text-ink">{a.name}</span>
                  {p.steward === a.id && <Badge tone="cool">steward</Badge>}
                </p>
                <p className="text-sm text-muted">{a.role}</p>
                <p className="flex flex-wrap gap-1">{a.tools.map((t) => <code key={t} className="rounded bg-paper-3 px-1 text-xs text-ink-2">{t}</code>)}</p>
              </Card>
            ))}
          </div>
        </section>
      ))}
    </GlobalPage>
  );
}
