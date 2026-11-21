import { createFileRoute } from '@tanstack/react-router';
import { GlobalPage } from '@/components/layout/ProjectHeader';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Loading } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/icons';
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
        <section key={p.id} className="grid gap-3.5 pt-2" aria-label={p.name}>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h2 className="flex flex-wrap items-baseline gap-x-3 text-title font-bold text-ink">{p.name} <span className="measured text-xs font-normal text-muted">{p.id}@{p.version}</span></h2>
            <span className="text-xs text-muted">{p.agents.length} 个模板</span>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            {p.agents.map((a) => (
              <Card key={a.id} className="grid content-start gap-2.5 p-4" data-testid="template-card">
                <p className="flex min-w-0 items-center gap-2.5">
                  <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-ctl bg-paper-2 text-ink-2"><Icon name="robot" /></span>
                  <span className="min-w-0 truncate text-sm font-bold text-ink">{a.name}</span>
                  {p.steward === a.id && <Badge tone="cool">steward</Badge>}
                </p>
                <p className="text-sm text-ink-2">{a.role}</p>
                <p className="flex flex-wrap gap-1.5">{a.tools.map((t) => <code key={t} className="text-xs">{t}</code>)}</p>
              </Card>
            ))}
          </div>
        </section>
      ))}
    </GlobalPage>
  );
}
