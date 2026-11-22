import { useMutation } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { INBOX_LABEL } from '@/components/board/labels';
import { DiffView } from '@/components/panels/DiffView';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Button, buttonClass } from '@/components/ui/button';
import { Icon, type IconName } from '@/components/ui/icons';
import { Textarea } from '@/components/ui/input';
import { api, unwrap } from '@/lib/api';
import { parseJson, when } from '@/lib/format';
import type { InboxRow } from '@/lib/queries';
import { cn } from '@/lib/utils';

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
  docs_drift: 'bad',
  clip_request: 'amber',
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
      <div className="grid w-full gap-2">
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
      <div className="grid w-full gap-2">
        <Textarea rows={2} className="min-h-0" placeholder="你的决定，Agent 恢复后按这个继续（可选）" aria-label="决定" value={answer} onChange={(e) => setAnswer(e.target.value)} data-testid="inbox-decision" />
        <div className="flex gap-2">
          <Button size="sm" variant="primary" disabled={busy} onClick={() => resolve.mutate({ action: 'unblock', ...(answer.trim() ? { answer: answer.trim() } : {}) })}>解除阻塞</Button>
          {dismiss}
        </div>
      </div>
    );
  }
  if (item.kind === 'clip_request') {
    return (
      <>
        <Button size="sm" variant="primary" disabled={busy} onClick={() => resolve.mutate({ decision: 'approve' })} data-testid="clip-request-approve">批准生成</Button>
        <Button size="sm" disabled={busy} onClick={() => resolve.mutate({ decision: 'deny' })} data-testid="clip-request-deny">拒绝</Button>
      </>
    );
  }
  if (item.kind === 'run_failed') {
    return (
      <>
        <Button size="sm" variant="primary" disabled={busy} onClick={() => resolve.mutate({ action: 'retry' })}>重试</Button>
        {item.runId && (
          <Link to="/projects/$projectId/runs/$runId" params={{ projectId, runId: item.runId }} className={buttonClass('quiet', 'sm')}>查看运行</Link>
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

const KIND_ICON: Record<string, IconName> = {
  human_request: 'hand',
  proposal_review: 'diff',
  blocked: 'alert',
  task_countered: 'undo',
  command_confirm: 'terminal',
  docs_drift: 'link',
  run_failed: 'x',
  budget: 'coin',
  gate_confirm: 'stage',
  qa_regression: 'bug',
  task_rejected: 'x',
  clip_request: 'film',
};

const ICON_TONE: Record<BadgeTone, string> = {
  amber: 'bg-accent text-accent-ink',
  cool: 'bg-cool-soft text-cool',
  ok: 'bg-ok-soft text-ok',
  bad: 'bg-bad-soft text-bad',
  neutral: 'bg-paper-2 text-ink-2',
  line: 'bg-paper-2 text-ink-2',
};

export function InboxEntry({ item, projectId, compact }: { item: InboxRow; projectId: string; compact?: boolean }) {
  const open = item.status === 'open';
  const suspects = item.kind === 'qa_regression' ? (JSON.parse(item.payloadJson ?? '{}') as { suspects?: { taskId: string; title: string }[] }).suspects ?? [] : [];
  const docDrift = item.kind === 'docs_drift' ? (JSON.parse(item.payloadJson ?? '{}') as { wsId?: string; docTitle?: string }) : null;
  const clip = item.kind === 'clip_request' ? (JSON.parse(item.payloadJson ?? '{}') as { wsId?: string; videoTitle?: string; shotTitle?: string; duration?: number; estimatedCostMicros?: number }) : null;
  const filePatch = item.proposalTarget === 'file' ? parseJson<{ path?: string; diff?: string }>(item.proposalPatch, {}) : null;
  const tone = TONE[item.kind] ?? 'neutral';
  const titleClass = compact ? 'min-w-0 flex-1 truncate text-sm text-ink-2 hover:underline' : 'min-w-0 break-words text-sm font-bold text-ink hover:underline';
  const title = item.taskId ? (
    <Link to="/projects/$projectId/tasks/$taskId" params={{ projectId, taskId: item.taskId }} className={titleClass}>
      {item.taskTitle}
    </Link>
  ) : docDrift?.wsId ? (
    <Link to="/projects/$projectId/ws/$wsId" params={{ projectId, wsId: docDrift.wsId }} search={{ panel: 'health' }} className={titleClass} data-testid="inbox-doc-drift">
      {docDrift.docTitle ?? '文档健康'}
    </Link>
  ) : clip?.wsId ? (
    <Link to="/projects/$projectId/ws/$wsId" params={{ projectId, wsId: clip.wsId }} search={{ panel: 'assets' }} className={titleClass} data-testid="inbox-clip-request">
      {clip.videoTitle ? `${clip.videoTitle} · ` : ''}{clip.shotTitle || '镜头'} 的片段申请（{clip.duration} 秒，预估 ${((clip.estimatedCostMicros ?? 0) / 1e6).toFixed(3)}）
    </Link>
  ) : (
    <span className={cn(titleClass, 'font-normal text-muted hover:no-underline')}>无关联任务</span>
  );
  const marks = (
    <>
      {item.count > 1 && <span className="shrink-0 text-xs font-semibold tabular-nums text-bad" data-testid="inbox-count">×{item.count}</span>}
      {item.severity === 'critical' && <Badge tone="bad">紧急</Badge>}
    </>
  );
  return (
    <article
      className={cn('grid gap-2.5', compact ? 'gap-1.5 rounded-ctl px-2.5 py-2.5 hover:bg-hover' : 'rounded-card bg-paper p-4 shadow-[var(--shadow-card)]')}
      data-testid="inbox-item"
      data-kind={item.kind}
    >
      {compact ? (
        <div className="flex items-center gap-2">
          <Badge tone={tone}>{INBOX_LABEL[item.kind] ?? item.kind}</Badge>
          {title}
          {marks}
          <span className="shrink-0 text-xs tabular-nums text-muted">{when(item.createdAt)}</span>
        </div>
      ) : (
        <header className="flex min-w-0 items-start gap-3">
          <span aria-hidden className={cn('mt-px grid size-8 shrink-0 place-items-center rounded-ctl', ICON_TONE[tone])}>
            <Icon name={KIND_ICON[item.kind] ?? 'bell'} />
          </span>
          <div className="grid min-w-0 flex-1 gap-1">
            {title}
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
              <Badge tone={tone}>{INBOX_LABEL[item.kind] ?? item.kind}</Badge>
              {marks}
              <span className="tabular-nums">{when(item.createdAt)}</span>
            </p>
          </div>
        </header>
      )}
      {item.command && (compact ? (
        <p className="truncate text-sm text-ink-2"><code className="rounded-chip bg-paper-3 px-1.5 font-mono text-xs">{item.command}</code></p>
      ) : (
        <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-ctl bg-code px-3.5 py-3 font-mono text-xs leading-[1.65] text-code-ink">
          <span className="text-code-dim">$ </span>{item.command}
          {item.cwd && <>{'\n'}<span className="text-code-dim">cwd </span>{item.cwd}</>}
        </pre>
      ))}
      {item.detail && <p className={compact ? 'line-clamp-2 text-xs text-muted' : 'whitespace-pre-wrap text-sm text-ink-2'}>{item.detail}</p>}
      {filePatch?.diff && (
        <details className="text-xs" data-testid="inbox-file-diff">
          <summary className="cursor-pointer font-medium text-cool hover:underline">查看改动{filePatch.path ? ` · ${filePatch.path}` : ''}</summary>
          <div className="mt-2 max-h-72 overflow-y-auto">
            <DiffView patch={filePatch.diff} comments={[]} />
          </div>
        </details>
      )}
      {suspects.length > 0 && (
        <p className="text-xs text-muted">
          可疑任务：
          {suspects.map((s, i) => (
            <span key={s.taskId}>
              {i > 0 && '、'}
              <Link to="/projects/$projectId/tasks/$taskId" params={{ projectId, taskId: s.taskId }} className="font-medium text-ink-2 hover:underline">{s.title}</Link>
            </span>
          ))}
        </p>
      )}
      {open && <div className="flex flex-wrap items-center gap-2"><Actions item={item} projectId={projectId} /></div>}
    </article>
  );
}
