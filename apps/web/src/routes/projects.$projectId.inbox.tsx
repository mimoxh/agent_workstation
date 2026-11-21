import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { InboxEntry } from '@/components/inbox/InboxEntry';
import { notifySupported, notifyPermission, requestNotify } from '@/components/inbox/notify';
import { Page, PageHeader } from '@/components/layout/Page';
import { Button } from '@/components/ui/button';
import { Empty, ErrorState, Loading } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/icons';
import { useInbox, type InboxRow } from '@/lib/queries';
import { cn } from '@/lib/utils';

export const Route = createFileRoute('/projects/$projectId/inbox')({
  validateSearch: (s: Record<string, unknown>): { status?: 'resolved' } => (s.status === 'resolved' ? { status: 'resolved' } : {}),
  component: InboxPage,
});

// 同一任务的待处理项放一起，人一次看完一件事；服务端已按严重度排好序
function groupByTask(items: InboxRow[]) {
  const groups = new Map<string, { id: string | null; title: string | null; items: InboxRow[] }>();
  for (const i of items) {
    const key = i.taskId ?? `solo:${i.id}`;
    const g = groups.get(key) ?? { id: i.taskId, title: i.taskTitle, items: [] };
    g.items.push(i);
    groups.set(key, g);
  }
  return [...groups.entries()];
}

function NotifyToggle() {
  const [state, setState] = useState(notifyPermission());
  if (!notifySupported() || state === 'denied') return null;
  if (state === 'granted') return <span className="text-xs text-muted">通知已开启</span>;
  return <Button size="sm" variant="quiet" onClick={() => void requestNotify().then(setState)} data-testid="inbox-notify">开启桌面通知</Button>;
}

function InboxPage() {
  const { projectId } = Route.useParams();
  const { status } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const inbox = useInbox(projectId, status ?? 'open');
  const tabs = [{ id: undefined, label: '待处理' }, { id: 'resolved' as const, label: '已处理' }];
  const groups = groupByTask(inbox.data ?? []);

  return (
    <div className="h-full overflow-y-auto" data-testid="inbox-page">
      <Page narrow>
        <PageHeader icon="inbox" title="收件箱" actions={<NotifyToggle />} compact />
        <div className="mb-4 flex gap-1" role="tablist">
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
        {inbox.data?.length === 0 && <Empty icon="inbox" title={status ? '还没有处理过的条目' : '没有待处理项'}>阻塞、命令确认、运行失败和待决定的提案都会进到这里。</Empty>}
        <div className="grid gap-6">
          {groups.map(([key, g]) => (
            <section key={key} aria-label={g.title ?? '待处理项'} className="grid gap-3" data-testid="inbox-group">
              {g.id && g.items.length > 1 && (
                <Link to="/projects/$projectId/tasks/$taskId" params={{ projectId, taskId: g.id }} className="flex w-fit items-center gap-1.5 px-1 text-sm font-bold text-ink hover:underline">
                  <Icon name="board" className="size-3.5 text-muted" />
                  {g.title}
                </Link>
              )}
              {g.items.map((i) => <InboxEntry key={i.id} item={i} projectId={projectId} />)}
            </section>
          ))}
        </div>
      </Page>
    </div>
  );
}
