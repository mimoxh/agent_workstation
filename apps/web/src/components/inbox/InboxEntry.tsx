import { useMutation } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { INBOX_LABEL } from '@/components/board/labels';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/input';
import { api, unwrap } from '@/lib/api';
import { when } from '@/lib/format';
import type { InboxRow } from '@/lib/queries';

const TONE: Record<string, BadgeTone> = {
  command_confirm: 'amber',
  blocked: 'amber',
  human_request: 'amber',
  gate_confirm: 'amber',
  task_countered: 'amber',
  proposal_review: 'cool',
  run_failed: 'bad',
  budget: 'bad',
  task_rejected: 'bad',
};

type Resolve = { decision?: 'approve' | 'deny'; action?: 'retry' | 'unblock'; answer?: string };

function Actions({ item, projectId }: { item: InboxRow; projectId: string }) {
  const [answer, setAnswer] = useState('');
  const resolve = useMutation({
    mutationFn: async (json: Resolve) => unwrap(await api.inbox[':id'].resolve.$post({ param: { id: item.id }, json })),
  });
  const merge = useMutation({ mutationFn: async (id: string) => unwrap(await api.proposals[':id'].merge.$post({ param: { id } })) });
  const decide = useMutation({
    mutationFn: async ({ id, approve }: { id: string; approve: boolean }) =>
      unwrap(approve ? await api.proposals[':id'].approve.$post({ param: { id } }) : await api.proposals[':id'].reject.$post({ param: { id }, json: {} })),
  });
  const busy = resolve.isPending || merge.isPending || decide.isPending;
  const dismiss = <Button size="sm" variant="quiet" disabled={busy} onClick={() => resolve.mutate({})}>标记已处理</Button>;

  if (item.kind === 'command_confirm') {
    return (
      <>
        <Button size="sm" variant="primary" disabled={busy} onClick={() => resolve.mutate({ decision: 'approve' })}>批准执行</Button>
        <Button size="sm" disabled={busy} onClick={() => resolve.mutate({ decision: 'deny' })}>拒绝</Button>
      </>
    );
  }
  if (item.kind === 'gate_confirm') {
    return (
      <>
        <Button size="sm" variant="primary" disabled={busy} onClick={() => resolve.mutate({ decision: 'approve' })} data-testid="gate-approve">确认并推进</Button>
        <Button size="sm" disabled={busy} onClick={() => resolve.mutate({ decision: 'deny' })}>先不推进</Button>
      </>
    );
  }
  if (item.kind === 'human_request') {
    return (
      <div className="w-full space-y-1.5">
        <Textarea rows={2} className="min-h-0" placeholder="回复后 Agent 继续运行" aria-label="回复" value={answer} onChange={(e) => setAnswer(e.target.value)} data-testid="inbox-answer" />
        <div className="flex gap-2">
          <Button size="sm" variant="primary" disabled={busy || !answer.trim()} onClick={() => resolve.mutate({ answer: answer.trim() })}>回复</Button>
          {dismiss}
        </div>
      </div>
    );
  }
  if (item.kind === 'blocked') {
    const live = item.taskStatus === 'blocked' || item.taskStatus === 'escalated';
    if (!live) return dismiss;
    return (
      <div className="w-full space-y-1.5">
        <Textarea rows={2} className="min-h-0" placeholder="你的决定，Agent 恢复后按这个继续（可选）" aria-label="决定" value={answer} onChange={(e) => setAnswer(e.target.value)} data-testid="inbox-decision" />
        <div className="flex gap-2">
          <Button size="sm" variant="primary" disabled={busy} onClick={() => resolve.mutate({ action: 'unblock', ...(answer.trim() ? { answer: answer.trim() } : {}) })}>解除阻塞</Button>
          {dismiss}
        </div>
      </div>
    );
  }
  if (item.kind === 'run_failed') {
    return (
      <>
        <Button size="sm" variant="primary" disabled={busy} onClick={() => resolve.mutate({ action: 'retry' })}>重试</Button>
        {item.runId && (
          <Link to="/projects/$projectId/runs/$runId" params={{ projectId, runId: item.runId }} className="inline-flex min-h-7 items-center px-2 text-xs text-cool hover:underline">查看运行</Link>
        )}
        {dismiss}
      </>
    );
  }
  if (item.kind === 'proposal_review' && item.proposalId && item.proposalTarget !== 'code') {
    const id = item.proposalId;
    return (
      <>
        <Button size="sm" variant="primary" disabled={busy} onClick={() => decide.mutate({ id, approve: true })} data-testid="proposal-approve">通过</Button>
        <Button size="sm" disabled={busy} onClick={() => decide.mutate({ id, approve: false })}>驳回</Button>
      </>
    );
  }
  if (item.kind === 'proposal_review' && item.proposalId) {
    return (
      <>
        <Button size="sm" variant="primary" disabled={busy} onClick={() => merge.mutate(item.proposalId!)}>入队合并</Button>
        {dismiss}
      </>
    );
  }
  return dismiss;
}

export function InboxEntry({ item, projectId, compact }: { item: InboxRow; projectId: string; compact?: boolean }) {
  const open = item.status === 'open';
  return (
    <article className="space-y-1.5 rounded-chip px-2 py-2.5 hover:bg-hover" data-testid="inbox-item" data-kind={item.kind}>
      <div className="flex items-center gap-2">
        <Badge tone={TONE[item.kind] ?? 'neutral'}>{INBOX_LABEL[item.kind] ?? item.kind}</Badge>
        {item.taskId ? (
          <Link to="/projects/$projectId/tasks/$taskId" params={{ projectId, taskId: item.taskId }} className="min-w-0 flex-1 truncate text-sm text-ink-2 hover:underline">
            {item.taskTitle}
          </Link>
        ) : (
          <span className="min-w-0 flex-1 truncate text-sm text-muted">无关联任务</span>
        )}
        {item.count > 1 && <span className="measured shrink-0 text-xs text-bad" data-testid="inbox-count">×{item.count}</span>}
        {item.severity === 'critical' && <Badge tone="bad">紧急</Badge>}
        <span className="measured shrink-0 text-xs text-muted">{when(item.createdAt)}</span>
      </div>
      {item.command && (
        <p className="text-sm text-ink-2"><code>{item.command}</code>{!compact && item.cwd && <span className="measured ml-2 text-xs text-muted">{item.cwd}</span>}</p>
      )}
      {item.detail && <p className={compact ? 'line-clamp-2 text-xs text-muted' : 'whitespace-pre-wrap text-sm text-muted'}>{item.detail}</p>}
      {open && <div className="flex flex-wrap items-center gap-1.5"><Actions item={item} projectId={projectId} /></div>}
    </article>
  );
}
