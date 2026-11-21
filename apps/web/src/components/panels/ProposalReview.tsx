import { useMutation } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { PROPOSAL_LABEL, PROPOSAL_TONE } from '@/components/board/labels';
import { Badge } from '@/components/ui/badge';
import { Button, Spinner } from '@/components/ui/button';
import { Empty, ErrorState, Loading } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/icons';
import { Textarea } from '@/components/ui/input';
import { api, unwrap } from '@/lib/api';
import { parseJson, shortId, when } from '@/lib/format';
import { useTaskProposals, useWsProposals, type Proposal } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { DiffView, type LineComment } from './DiffView';

const OPEN = ['pending', 'changes_requested'];
const isCode = (p: Proposal) => p.targetType === 'code';
const isFile = (p: Proposal) => p.targetType === 'file';
const filePatch = (p: Proposal) => (isFile(p) ? parseJson<{ path?: string; diff?: string }>(p.patchJson, {}) : null);

function FilePatch({ patch }: { patch: string | null }) {
  const data = parseJson<{ path?: string; diff?: string }>(patch, {});
  return (
    <div className="space-y-2" data-testid="file-patch">
      <p className="measured flex items-center gap-1.5 text-xs text-muted"><Icon name="doc" className="size-3.5" />{data.path}</p>
      <DiffView patch={data.diff ?? ''} comments={[]} />
    </div>
  );
}

function EntityPatch({ patch }: { patch: string | null }) {
  const data = parseJson<Record<string, unknown>>(patch, {});
  return (
    <dl className="divide-y divide-rule overflow-hidden rounded-card bg-paper shadow-[var(--shadow-card)]" data-testid="entity-patch">
      {Object.entries(data).map(([k, v]) => (
        <div key={k} className="grid grid-cols-[8rem_minmax(0,1fr)] gap-4 px-4 py-2.5 text-sm max-sm:grid-cols-1 max-sm:gap-1">
          <dt className="measured text-xs leading-5 text-muted">{k}</dt>
          <dd className="whitespace-pre-wrap text-ink-2">{typeof v === 'string' ? v : JSON.stringify(v)}</dd>
        </div>
      ))}
    </dl>
  );
}

function ReviewPane({ proposal, drafts, projectId, onSubmitted }: { proposal: Proposal; drafts: LineComment[]; projectId: string; onSubmitted: () => void }) {
  const [summary, setSummary] = useState('');
  const review = useMutation({
    mutationFn: async (decision: 'approve' | 'request_changes') =>
      unwrap(
        await api.proposals[':id'].review.$post({
          param: { id: proposal.id },
          json: {
            decision,
            summary: summary.trim() || (decision === 'approve' ? '通过' : '要求修改'),
            comments: drafts.map((c) => ({ path: c.path!, line: c.line!, body: c.body! })),
          },
        }),
      ),
    onSuccess: () => {
      setSummary('');
      onSubmitted();
    },
  });
  const merge = useMutation({ mutationFn: async () => unwrap(await api.proposals[':id'].merge.$post({ param: { id: proposal.id } })) });

  const code = isCode(proposal);
  const open = OPEN.includes(proposal.status);
  const ready = !code || proposal.task?.status === 'reviewing';
  const canMerge = code && proposal.status === 'approved' && proposal.task?.status !== 'done';
  const notes = proposal.comments;

  return (
    <aside className="flex max-h-72 min-h-0 flex-col gap-3 overflow-y-auto border-t border-rule bg-paper p-3.5 @4xl:max-h-none @4xl:border-l @4xl:border-t-0" data-testid="review-form">
      <div className="grid gap-1.5 text-sm">
        <p className="text-xs font-semibold text-muted">{code ? '代码提案' : isFile(proposal) ? `文件改动 · ${filePatch(proposal)?.path ?? ''}` : `实体提案 · ${proposal.targetType ?? ''}`}</p>
        {proposal.reason && <p className="font-semibold text-ink">{proposal.reason}</p>}
        <p className="measured text-xs text-muted">{proposal.authorName ?? shortId(proposal.authorId)} · {when(proposal.createdAt)}</p>
        {proposal.task && (
          <Link to="/projects/$projectId/tasks/$taskId" params={{ projectId, taskId: proposal.task.id }} className="block truncate text-xs font-medium text-cool hover:underline">
            {proposal.task.title}
          </Link>
        )}
      </div>
      {notes.length > 0 && (
        <div className="grid gap-2">
          <p className="text-xs font-semibold text-muted">审查意见 {notes.length}</p>
          {notes.map((c) => (
            <div key={c.id} className={cn('rounded-r-ctl border-l-2 bg-paper-2 px-2.5 py-1.5 text-sm', c.resolved ? 'border-ok text-muted' : 'border-cool text-ink-2')}>
              <p className="measured truncate text-xs text-muted">{c.path}{c.line ? `:${c.line}` : ''}</p>
              {c.body}
            </div>
          ))}
        </div>
      )}
      <span className="flex-1" />
      {open && !ready && <p className="flex items-center gap-2 rounded-ctl bg-cool-soft px-3 py-2 text-xs text-ink-2"><span aria-hidden className="size-[7px] shrink-0 animate-pulse-soft rounded-full bg-cool" />验收还在跑，任务进入评审后才能决定。</p>}
      {open && ready && (
        <>
          {drafts.length > 0 && <p className="rounded-ctl bg-accent-soft px-3 py-2 text-xs font-medium text-ink-2">{drafts.length} 条行内意见将随审阅提交</p>}
          <Textarea rows={2} value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="审查结论（可选）" aria-label="审查结论" />
          <div className="flex flex-col gap-2">
            <Button variant="primary" disabled={review.isPending} onClick={() => review.mutate('approve')}><Icon name="check" />通过</Button>
            <Button disabled={review.isPending} onClick={() => review.mutate('request_changes')}>{code ? '要求修改' : '驳回'}</Button>
          </div>
        </>
      )}
      {canMerge && (
        <Button variant="primary" disabled={merge.isPending} aria-busy={merge.isPending || undefined} onClick={() => merge.mutate()} data-testid="merge-proposal">
          {merge.isPending ? <Spinner /> : <Icon name="merge" />}
          {merge.isPending ? '入队中…' : '入队合并'}
        </Button>
      )}
    </aside>
  );
}

function ProposalList({ proposals, projectId }: { proposals: Proposal[]; projectId: string }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, LineComment[]>>({});
  const cur = proposals.find((p) => p.id === selected) ?? proposals.find((p) => OPEN.includes(p.status)) ?? proposals[0]!;
  const mine = drafts[cur.id] ?? [];
  const reviewable = OPEN.includes(cur.status) && isCode(cur) && cur.task?.status === 'reviewing';

  return (
    // 右侧栏里宽度有限：窄时列表、改动、审阅上下排，够宽再三栏
    <div className="@container h-full min-h-0">
    <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] @4xl:grid-cols-[15rem_minmax(0,1fr)_16rem] @4xl:grid-rows-1">
      <div className="flex max-h-40 min-h-0 flex-col gap-0.5 overflow-y-auto border-b border-rule bg-paper p-2 @4xl:max-h-none @4xl:border-b-0 @4xl:border-r" data-testid="proposal-list">
        <p className="px-2 pb-1 pt-0.5 text-xs font-semibold text-muted">提案 {proposals.length}</p>
        {proposals.map((p) => (
          <button
            key={p.id}
            type="button"
            aria-current={cur.id === p.id}
            onClick={() => setSelected(p.id)}
            className={cn('grid gap-1.5 rounded-ctl border px-3 py-2.5 text-left transition-colors duration-100', cur.id === p.id ? 'border-rule-2 bg-paper-2' : 'border-transparent hover:bg-hover')}
          >
            <span className="block truncate text-sm font-semibold text-ink">{p.reason || p.task?.title || shortId(p.id)}</span>
            <span className="flex items-center justify-between gap-2">
              <Badge tone={PROPOSAL_TONE[p.status] ?? 'neutral'}>{PROPOSAL_LABEL[p.status] ?? p.status}</Badge>
              <span className="measured text-xs text-muted">{when(p.createdAt)}</span>
            </span>
          </button>
        ))}
      </div>
      <div className="min-h-0 min-w-0 overflow-y-auto p-4">
        {isCode(cur) ? (
          <DiffView
            patch={cur.patchJson ?? ''}
            comments={[...cur.comments, ...mine]}
            onComment={reviewable ? (path, line, body) => setDrafts({ ...drafts, [cur.id]: [...mine, { path, line, body }] }) : undefined}
          />
        ) : isFile(cur) ? (
          <FilePatch patch={cur.patchJson} />
        ) : (
          <EntityPatch patch={cur.patchJson} />
        )}
      </div>
      <ReviewPane key={cur.id} proposal={cur} drafts={mine} projectId={projectId} onSubmitted={() => setDrafts({ ...drafts, [cur.id]: [] })} />
    </div>
    </div>
  );
}

export function WsProposalsPanel({ wsId, projectId }: { wsId: string; projectId: string }) {
  const q = useWsProposals(wsId);
  if (q.isLoading) return <Loading />;
  if (q.isError) return <ErrorState error={q.error} />;
  if (!q.data?.length) return <Empty title="还没有提案" icon="diff">Agent 提交改动或实体变更后，会在这里等你审阅。</Empty>;
  return <ProposalList proposals={q.data} projectId={projectId} />;
}

export function TaskProposalsPanel({ taskId, projectId }: { taskId: string; projectId: string }) {
  const q = useTaskProposals(taskId);
  if (q.isLoading) return <Loading />;
  if (q.isError) return <ErrorState error={q.error} />;
  if (!q.data?.length) return <Empty title="这个任务还没有提案" icon="diff" />;
  return <ProposalList proposals={q.data} projectId={projectId} />;
}
