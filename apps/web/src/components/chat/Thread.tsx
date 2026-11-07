import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef } from 'react';
import { DecisionCard, MessageItem, type MessageLike } from '@/components/timeline/cards';
import { foldByDecision } from '@/components/timeline/fold';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { api, unwrap } from '@/lib/api';
import { useThreadMessages } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { Composer } from './Composer';

interface ThreadInfo { id: string; state: string; turnCount: number }

function ThreadView({ thread, projectId, names, hint, placeholder, wide }: { thread: ThreadInfo; projectId: string; names: Record<string, string>; hint: string; placeholder?: string; wide?: boolean | undefined }) {
  const q = useThreadMessages(thread.id);
  const logRef = useRef<HTMLDivElement>(null);
  const messages = useMemo<MessageLike[]>(() => (q.data ?? []).map((m) => ({ ...m, at: m.createdAt })), [q.data]);
  const rows = useMemo(() => foldByDecision(messages, (m) => m.kind === 'chat', (m) => m.kind === 'decision'), [messages]);
  const silenced = thread.state === 'silenced';
  const toggle = useMutation({
    mutationFn: async () => unwrap(await api.threads[':id'].silence.$post({ param: { id: thread.id }, json: { silenced: !silenced } })),
  });

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="thread-view">
      <div ref={logRef} className={cn('flex min-h-0 flex-1 flex-col overflow-y-auto', wide ? 'px-5 py-6 md:px-10 lg:px-14' : 'px-3.5 py-3')}>
        <div className={cn('flex flex-col', wide ? 'mx-auto w-full max-w-[54rem] gap-5' : 'gap-4')}>
        {messages.length === 0 && <p className="text-sm text-muted">还没有消息</p>}
        {rows.map(({ item, folded }) =>
          item.kind === 'decision' ? (
            <DecisionCard key={item.id} m={item} foldedCount={folded.length}>
              {folded.map((f) => <MessageItem key={f.id} m={f} names={names} projectId={projectId} />)}
            </DecisionCard>
          ) : (
            <MessageItem key={item.id} m={item} names={names} projectId={projectId} />
          ),
        )}
        </div>
      </div>
      <Composer
        wide={wide}
        threadId={thread.id}
        hint={silenced ? '已静默，发话后恢复' : hint}
        placeholder={placeholder}
        actions={<Button size="sm" variant="quiet" aria-pressed={silenced} disabled={toggle.isPending} onClick={() => toggle.mutate()} data-testid="thread-silence">{silenced ? '恢复' : '静默'}</Button>}
      />
    </div>
  );
}

export function WsThread({ wsId, projectId, names, root, wide }: { wsId: string; projectId: string; names: Record<string, string>; root: boolean; wide?: boolean }) {
  const th = useQuery({ queryKey: ['thread', 'ws', wsId], queryFn: async () => unwrap(await api.workstations[':id'].thread.$get({ param: { id: wsId } })) });
  if (!th.data) return <p className="p-3 text-sm text-muted">加载会话…</p>;
  return root
    ? <ThreadView thread={th.data.thread} projectId={projectId} names={names} wide={wide} hint="项目经理会起草任务，确认后派发" placeholder="说目标，比如：给任务看板加状态筛选" />
    : <ThreadView thread={th.data.thread} projectId={projectId} names={names} wide={wide} hint="steward 主持讨论，@ 可以直接点名成员" />;
}

export function DmDialog({ agentId, agentName, projectId, names, onClose }: { agentId: string; agentName: string; projectId: string; names: Record<string, string>; onClose: () => void }) {
  const th = useQuery({ queryKey: ['thread', 'dm', agentId], queryFn: async () => unwrap(await api.agents[':id'].thread.$get({ param: { id: agentId } })) });
  return (
    <Dialog title={`私聊 ${agentName}`} onClose={onClose} testId="dm-dialog" className="w-[34rem]">
      <div className="flex h-[60dvh] min-h-0 flex-col">
        {th.data ? <ThreadView thread={th.data.thread} projectId={projectId} names={names} hint="只有你和它能看到" /> : <p className="text-sm text-muted">加载会话…</p>}
      </div>
    </Dialog>
  );
}
