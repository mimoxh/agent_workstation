import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { InboxEntry } from '@/components/inbox/InboxEntry';
import { notifyPermission, notifySupported, requestNotify } from '@/components/inbox/notify';
import { Page, PageHeader, SectionTitle } from '@/components/layout/Page';
import { Button, buttonClass } from '@/components/ui/button';
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
        <div className="flex gap-1" role="tablist">
          {tabs.map((t) => (
            <button
              key={t.label}
              type="button"
              role="tab"
              aria-selected={status === t.id}
              onClick={() => void navigate({ search: t.id ? { status: t.id } : {} })}
              className={cn('h-8 rounded-btn px-3.5 text-sm transition-colors', status === t.id ? 'bg-primary font-semibold text-primary-ink' : 'text-muted hover:bg-hover hover:text-ink')}
            >
              {t.label}
            </button>
          ))}
        </div>
        {inbox.isLoading && <Loading />}
        {inbox.isError && <ErrorState error={inbox.error} onRetry={() => void inbox.refetch()} />}
        {inbox.data?.length === 0 && <Empty icon="inbox" title={status ? '还没有处理过的条目' : '没有待处理项'}>Agent 正常推进时不会打扰你。</Empty>}
        {(projects.data ?? []).map((p) => {
          const mine = items.filter((i) => i.projectId === p.id);
          if (mine.length === 0) return null;
          return (
            <section key={p.id} aria-label={p.name} data-testid="inbox-group">
              <SectionTitle aside={<Link to="/projects/$projectId" params={{ projectId: p.id }} className={buttonClass('quiet', 'sm')}>打开项目</Link>}>{p.name}</SectionTitle>
              <div className="grid gap-3">
                {mine.map((i) => <InboxEntry key={i.id} item={i} projectId={p.id} />)}
              </div>
            </section>
          );
        })}
      </Page>
    </div>
  );
}
