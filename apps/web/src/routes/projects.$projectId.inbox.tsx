import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { InboxEntry } from '@/components/inbox/InboxEntry';
import { notifySupported, notifyPermission, requestNotify } from '@/components/inbox/notify';
import { Button } from '@/components/ui/button';
import { Empty, ErrorState, Loading } from '@/components/ui/feedback';
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
      <div className="mx-auto max-w-[54rem] px-5 pb-16 pt-10 md:px-10">
        <div className="flex items-baseline justify-between gap-3">
          <h1 className="text-page font-bold tracking-tight text-ink">收件箱</h1>
          <NotifyToggle />
        </div>
        <div className="mb-3 mt-3 flex gap-1 border-b border-rule" role="tablist">
          {tabs.map((t) => (
            <button
              key={t.label}
              type="button"
              role="tab"
              aria-selected={status === t.id}
              onClick={() => void navigate({ search: t.id ? { status: t.id } : {} })}
              className={cn('-mb-px border-b-2 px-3 py-2 text-sm', status === t.id ? 'border-cool text-ink' : 'border-transparent text-muted hover:text-ink-2')}
            >
              {t.label}
            </button>
          ))}
        </div>
        {inbox.isLoading && <Loading />}
        {inbox.isError && <ErrorState error={inbox.error} onRetry={() => void inbox.refetch()} />}
        {inbox.data?.length === 0 && <Empty title={status ? '还没有处理过的条目' : '没有待处理项'}>阻塞、命令确认、运行失败和待决定的提案都会进到这里。</Empty>}
        <div className="space-y-4">
          {groups.map(([key, g]) => (
            <section key={key} aria-label={g.title ?? '待处理项'} data-testid="inbox-group">
              {g.id && g.items.length > 1 && (
                <Link to="/projects/$projectId/tasks/$taskId" params={{ projectId, taskId: g.id }} className="px-2 text-sm text-ink-2 hover:underline">{g.title}</Link>
              )}
              <div className="divide-y divide-rule">
                {g.items.map((i) => <div key={i.id} className="py-1"><InboxEntry item={i} projectId={projectId} /></div>)}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
