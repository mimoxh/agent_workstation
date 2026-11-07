import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { InboxEntry } from '@/components/inbox/InboxEntry';
import { notifyPermission, notifySupported, requestNotify } from '@/components/inbox/notify';
import { Page, PageHeader, SectionTitle } from '@/components/layout/Page';
import { Button } from '@/components/ui/button';
import { Empty, ErrorState, Loading } from '@/components/ui/feedback';
import { useAllInbox, useProjects } from '@/lib/queries';
import { cn } from '@/lib/utils';

export const Route = createFileRoute('/_console/inbox')({
  validateSearch: (s: Record<string, unknown>): { status?: 'resolved' } => (s.status === 'resolved' ? { status: 'resolved' } : {}),
  component: AllInboxPage,
});

function NotifyToggle() {
  const [state, setState] = useState(notifyPermission());
  if (!notifySupported() || state === 'denied') return null;
  if (state === 'granted') return <span className="text-xs text-muted">通知已开启</span>;
  return <Button variant="quiet" onClick={() => void requestNotify().then(setState)} data-testid="inbox-notify">开启桌面通知</Button>;
}

// 控制台「需要我」：跨项目汇总，按项目分组；服务端已按严重度排好序
function AllInboxPage() {
  const { status } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const inbox = useAllInbox(status ?? 'open');
  const projects = useProjects();
  const items = inbox.data ?? [];
  const tabs = [{ id: undefined, label: '待处理' }, { id: 'resolved' as const, label: '已处理' }];

  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-testid="inbox-page">
      <Page>
        <PageHeader icon="inbox" title="需要我" desc="阻塞、命令确认、运行失败和待决定的提案，跨项目汇总在这里" actions={<NotifyToggle />} />
        <div className="mt-6 flex gap-0.5 border-b border-rule" role="tablist">
          {tabs.map((t) => (
            <button
              key={t.label}
              type="button"
              role="tab"
              aria-selected={status === t.id}
              onClick={() => void navigate({ search: t.id ? { status: t.id } : {} })}
              className={cn('relative h-9 px-2.5 text-sm after:absolute after:inset-x-1.5 after:-bottom-px after:h-0.5 after:bg-ink', status === t.id ? 'font-medium text-ink after:opacity-100' : 'text-muted after:opacity-0 hover:text-ink')}
            >
              {t.label}
            </button>
          ))}
        </div>
        {inbox.isLoading && <Loading />}
        {inbox.isError && <ErrorState error={inbox.error} onRetry={() => void inbox.refetch()} />}
        {inbox.data?.length === 0 && <Empty title={status ? '还没有处理过的条目' : '没有待处理项'}>Agent 正常推进时不会打扰你。</Empty>}
        {(projects.data ?? []).map((p) => {
          const mine = items.filter((i) => i.projectId === p.id);
          if (mine.length === 0) return null;
          return (
            <section key={p.id} aria-label={p.name} data-testid="inbox-group">
              <SectionTitle aside={<Link to="/projects/$projectId" params={{ projectId: p.id }} className="rounded-[4px] px-1.5 text-sm text-muted hover:bg-hover hover:text-ink">打开项目</Link>}>{p.name}</SectionTitle>
              <div className="divide-y divide-rule border-y border-rule">
                {mine.map((i) => <InboxEntry key={i.id} item={i} projectId={p.id} />)}
              </div>
            </section>
          );
        })}
      </Page>
    </div>
  );
}
