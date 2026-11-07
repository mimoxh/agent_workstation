import { useMutation } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { GlobalPage } from '@/components/layout/ProjectHeader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Loading } from '@/components/ui/feedback';
import { api, unwrap } from '@/lib/api';
import { usePlugins, type PluginInfo } from '@/lib/queries';

export const Route = createFileRoute('/_console/plugins')({ component: PluginsPage });

function Detail({ label, items }: { label: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="grid grid-cols-[4rem_minmax(0,1fr)] gap-2 text-sm">
      <dt className="text-muted">{label}</dt>
      <dd className="text-ink-2">{items.join('、')}</dd>
    </div>
  );
}

function PluginCard({ p }: { p: PluginInfo }) {
  const [open, setOpen] = useState(false);
  const toggle = useMutation({
    mutationFn: async () => unwrap(await api.plugins[':id'].$patch({ param: { id: p.id }, json: { enabled: !p.enabled } })),
  });
  return (
    <Card className="space-y-2 p-4" data-testid="plugin-card">
      <div className="flex items-center gap-2">
        <h2 className="text-title text-ink">{p.name}</h2>
        <span className="measured text-xs text-muted">{p.id}@{p.version}</span>
        <Badge tone={p.enabled ? 'ok' : 'neutral'}>{p.enabled ? '已启用' : '已停用'}</Badge>
        <span className="flex-1" />
        <Button size="sm" variant="quiet" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? '收起' : '查看声明'}</Button>
        {p.id !== 'pm' && <Button size="sm" disabled={toggle.isPending} onClick={() => toggle.mutate()} data-testid="plugin-toggle">{p.enabled ? '停用' : '启用'}</Button>}
      </div>
      <p className="text-sm text-muted">{p.description}</p>
      {open && (
        <dl className="space-y-1 border-t border-rule pt-2">
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
      <div className="space-y-3">{plugins.data?.map((p) => <PluginCard key={p.id} p={p} />)}</div>
    </GlobalPage>
  );
}
