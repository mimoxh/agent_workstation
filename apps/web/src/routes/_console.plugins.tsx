import { useMutation } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { GlobalPage } from '@/components/layout/ProjectHeader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Loading } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/icons';
import { api, unwrap } from '@/lib/api';
import { usePlugins, type PluginInfo } from '@/lib/queries';

export const Route = createFileRoute('/_console/plugins')({ component: PluginsPage });

function Detail({ label, items }: { label: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 text-ink [overflow-wrap:anywhere]">{items.join('、')}</dd>
    </>
  );
}

function PluginCard({ p }: { p: PluginInfo }) {
  const [open, setOpen] = useState(false);
  const toggle = useMutation({
    mutationFn: async () => unwrap(await api.plugins[':id'].$patch({ param: { id: p.id }, json: { enabled: !p.enabled } })),
  });
  return (
    <Card className="grid gap-3 p-4" data-testid="plugin-card">
      <div className="flex flex-wrap items-center gap-2">
        <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-ctl bg-paper-2 text-ink-2"><Icon name="plug" /></span>
        <h2 className="text-md font-bold text-ink">{p.name}</h2>
        <span className="measured text-xs text-muted">{p.id}@{p.version}</span>
        <Badge tone={p.enabled ? 'ok' : 'line'}>{p.enabled && <Icon name="check" />}{p.enabled ? '已启用' : '已停用'}</Badge>
        <span className="ml-auto flex flex-wrap gap-1.5">
          <Button size="sm" variant="quiet" aria-expanded={open} onClick={() => setOpen(!open)}><Icon name="chev" className={open ? 'rotate-180' : ''} />{open ? '收起' : '查看声明'}</Button>
          {p.id !== 'pm' && <Button size="sm" variant={p.enabled ? 'default' : 'primary'} disabled={toggle.isPending} onClick={() => toggle.mutate()} data-testid="plugin-toggle">{p.enabled ? '停用' : '启用'}</Button>}
        </span>
      </div>
      <p className="text-sm text-ink-2">{p.description}</p>
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
        <span>{p.panels.length} 个板块</span>
        <span>{p.entities.length} 种实体</span>
        {p.stages.length > 0 && <span>{p.stages.length} 个阶段</span>}
      </p>
      {open && (
        <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-2.5 rounded-card bg-paper-2 p-4 text-sm">
          <Detail label="板块" items={p.panels.map((x) => `${x.title}（${x.type}）`)} />
          <Detail label="阶段" items={p.stages.map((x) => x.name)} />
          <Detail label="实体" items={p.entities.map((x) => `${x.label}：${x.fields.join('、')}`)} />
          <Detail label="预设" items={p.presets.map((x) => x.name)} />
        </dl>
      )}
    </Card>
  );
}

function PluginsPage() {
  const plugins = usePlugins();
  return (
    <GlobalPage title="插件" icon="plug" testId="plugins-page">
      <p className="text-sm text-muted">停用后不能再挂载新工作台，已挂载的工作台不受影响。根工作台依赖 pm，不能停用。</p>
      {plugins.isLoading && <Loading />}
      <div className="grid gap-3">{plugins.data?.map((p) => <PluginCard key={p.id} p={p} />)}</div>
    </GlobalPage>
  );
}
