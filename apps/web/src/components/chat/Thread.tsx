import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { DecisionCard, MessageItem, type MessageLike } from '@/components/timeline/cards';
import { foldByDecision } from '@/components/timeline/fold';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { toast } from '@/components/ui/feedback';
import { api, unwrap } from '@/lib/api';
import { useThreadActive, useThreadMessages } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { Composer, type MessageMeta } from './Composer';

export interface ThreadInfo { id: string; state: string; turnCount: number }

export function ThreadView({ thread, projectId, names, hint, placeholder, wide, meta, composerTop, onSent }: { thread: ThreadInfo; projectId: string; names: Record<string, string>; hint: string; placeholder?: string | undefined; wide?: boolean | undefined; meta?: MessageMeta | undefined; composerTop?: ReactNode | undefined; onSent?: (() => void) | undefined }) {
  const q = useThreadMessages(thread.id);
  const qc = useQueryClient();
  const logRef = useRef<HTMLDivElement>(null);
  const messages = useMemo<MessageLike[]>(() => (q.data ?? []).map((m) => ({ ...m, at: m.createdAt })), [q.data]);
  const rows = useMemo(() => foldByDecision(messages, (m) => m.kind === 'chat', (m) => m.kind === 'decision'), [messages]);
  const silenced = thread.state === 'silenced';
  const toggle = useMutation({
    mutationFn: async () => unwrap(await api.threads[':id'].silence.$post({ param: { id: thread.id }, json: { silenced: !silenced } })),
  });
  const active = useThreadActive(thread.id);
  const busy = (active.data?.running ?? false) || (active.data?.queued ?? 0) > 0;
  const speaker = names[active.data?.agentIds[0] ?? ''] ?? 'Agent';
  const stop = useMutation({
    mutationFn: async () => unwrap(await api.threads[':id'].stop.$post({ param: { id: thread.id } })),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['thread-active', thread.id] });
      void qc.invalidateQueries({ queryKey: ['thread-messages', thread.id] });
      if (r.stopped === 0) toast('没有正在进行的回复');
    },
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
      {composerTop}
      <Composer
        wide={wide}
        threadId={thread.id}
        hint={silenced ? '已静默，发话后恢复' : hint}
        placeholder={placeholder}
        meta={meta}
        onSent={onSent}
        actions={<>
          {busy && <span className="shrink-0 animate-pulse-soft text-xs text-cool" data-testid="thread-busy">{speaker} 正在回复…</span>}
          {busy && <Button size="sm" variant="danger" disabled={stop.isPending} onClick={() => stop.mutate()} data-testid="thread-stop">停止</Button>}
          <Button size="sm" variant="quiet" aria-pressed={silenced} disabled={toggle.isPending} onClick={() => toggle.mutate()} data-testid="thread-silence">{silenced ? '恢复' : '静默'}</Button>
        </>}
      />
    </div>
  );
}

export function WsThread({ wsId, projectId, names, root, wide, meta, hint, placeholder }: { wsId: string; projectId: string; names: Record<string, string>; root: boolean; wide?: boolean | undefined; meta?: MessageMeta | undefined; hint?: string | undefined; placeholder?: string | undefined }) {
  const th = useQuery({ queryKey: ['thread', 'ws', wsId], queryFn: async () => unwrap(await api.workstations[':id'].thread.$get({ param: { id: wsId } })) });
  if (!th.data) return <p className="p-3 text-sm text-muted">加载会话…</p>;
  return root
    ? <ThreadView thread={th.data.thread} projectId={projectId} names={names} wide={wide} hint="项目经理会起草任务，确认后派发" placeholder="说目标，比如：给任务看板加状态筛选" />
    : <ThreadView thread={th.data.thread} projectId={projectId} names={names} wide={wide} hint={hint ?? 'steward 主持讨论，@ 可以直接点名成员'} placeholder={placeholder} meta={meta} />;
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
