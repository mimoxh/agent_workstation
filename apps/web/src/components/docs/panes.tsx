import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icons';
import { Select, Textarea } from '@/components/ui/input';
import { api, unwrap } from '@/lib/api';
import { when } from '@/lib/format';
import type { DocDetail, DocRepo } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { commentsPrompt, FINDING_LABEL, FINDING_TONE, type OpenComment } from './model';

export type PendingComment = { quote: string; heading: string };

const QUOTE = 'rounded-chip border border-rule bg-paper px-2.5 py-2 text-xs text-ink-2 [overflow-wrap:anywhere]';

export function CommentsPane({ doc, comments, pending, onClearPending, onSend }: {
  doc: DocDetail;
  comments: OpenComment[];
  pending: PendingComment | null;
  onClearPending: () => void;
  onSend: (content: string) => void;
}) {
  const [body, setBody] = useState('');
  const [severity, setSeverity] = useState<'block' | 'note'>('note');
  const quote = pending?.quote ?? '';
  const heading = pending?.heading ?? '';

  const add = useMutation({
    mutationFn: async (input: { body: string; severity: 'block' | 'note'; quote?: string; heading?: string }) =>
      unwrap(
        await api.docs[':id'].comments.$post({
          param: { id: doc.id },
          json: { body: input.body, severity: input.severity, ...(input.quote ? { quote: input.quote } : {}), ...(input.heading ? { heading: input.heading } : {}) },
        }),
      ),
    onSuccess: () => {
      setBody('');
      onClearPending();
    },
  });
  const resolve = useMutation({
    mutationFn: async (ids: string[]) => unwrap(await api.docs[':id'].comments.resolve.$post({ param: { id: doc.id }, json: { ids, note: '人工标记解决' } })),
  });

  const canSend = comments.length > 0;
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="doc-comments-pane">
      <div className="shrink-0 border-b border-rule p-3.5">
        <div className="grid gap-2.5 rounded-card bg-paper-2 p-3.5">
          {pending ? (
            <div className={QUOTE}>
              <p className="text-muted">{heading ? `「${heading}」下` : '引文'}</p>
              <p className="mt-0.5 line-clamp-3">“{quote}”</p>
            </div>
          ) : (
            <p className="text-xs text-muted">在预览里选中文字可引用评论；也可直接留整体意见。</p>
          )}
          <Select value={severity} onChange={(e) => setSeverity(e.target.value as 'block' | 'note')} className="h-7 w-full text-xs" data-testid="doc-comment-severity">
            <option value="note">建议</option>
            <option value="block">阻断</option>
          </Select>
          <Textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="写评论…" rows={3} className="min-h-16 bg-paper" data-testid="doc-comment-input" />
          <div className="flex justify-end gap-1.5">
            {pending ? <Button size="sm" variant="quiet" onClick={onClearPending}>取消引用</Button> : null}
            <Button
              size="sm"
              variant="primary"
              disabled={!body.trim() || add.isPending}
              data-testid="doc-comment-submit"
              onClick={() => add.mutate({ body: body.trim(), severity, ...(quote ? { quote } : {}), ...(heading ? { heading } : {}) })}
            >
              <Icon name="comment" />评论
            </Button>
          </div>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3.5">
        {comments.length === 0 ? <p className="text-xs text-muted">还没有待处理的评论。</p> : null}
        <ul className="grid gap-2.5">
          {comments.map((c) => (
            <li key={c.id} className="grid gap-2 rounded-card bg-paper-2 p-3.5" data-testid="doc-comment-item">
              <div className="flex min-w-0 items-center gap-2">
                <Badge tone={c.severity === 'block' ? 'bad' : 'line'}>{c.severity === 'block' ? '阻断' : '建议'}</Badge>
                {c.heading ? <span className="min-w-0 truncate text-xs text-muted">{c.heading}</span> : null}
                <span className="ml-auto shrink-0 text-xs text-muted">{when(c.createdAt)}</span>
              </div>
              {c.quote ? <p className={cn(QUOTE, 'line-clamp-3')}>“{c.quote}”</p> : null}
              <p className="whitespace-pre-wrap text-sm text-ink-2">{c.body}</p>
              {c.note ? <p className="text-xs text-muted">处理说明：{c.note}</p> : null}
              <div className="flex justify-end">
                <Button size="sm" variant="quiet" disabled={resolve.isPending} onClick={() => resolve.mutate([c.id])} data-testid="doc-comment-resolve">
                  <Icon name="check" />标记解决
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </div>
      <div className="shrink-0 border-t border-rule p-3.5">
        <Button
          size="sm"
          className="w-full"
          disabled={!canSend}
          title={canSend ? '把未解决的评论发给主笔' : '没有未解决的评论'}
          data-testid="doc-comments-send"
          onClick={() => {
            const content = commentsPrompt(doc.id, doc.title ?? '', comments);
            if (content) onSend(content);
          }}
        >
          把 {comments.length} 条评论发给主笔
        </Button>
      </div>
    </div>
  );
}

export function CitationsPane({ doc, repos, active, onDelete }: { doc: DocDetail; repos: DocRepo[]; active: string | null; onDelete: (id: string) => void }) {
  const list = doc.citations ?? [];
  const repoName = (id: string | null | undefined) => repos.find((r) => r.repo === id)?.name ?? id ?? '';
  if (list.length === 0) return <p className="p-3.5 text-xs text-muted" data-testid="doc-citations-pane">还没有登记的引用。正文里用 [^id] 标记，由主笔或你写入引用清单。</p>;
  return (
    <div className="grid min-h-0 flex-1 content-start gap-2.5 overflow-y-auto p-3.5" data-testid="doc-citations-pane">
      {list.map((cit) => (
        <div
          key={cit.id}
          className={cn('grid gap-1.5 rounded-ctl border border-rule bg-paper px-3 py-2.5 transition-shadow duration-150', active === cit.id && 'shadow-[0_0_0_2px_var(--color-cool)]')}
          data-testid={`citation-item-${cit.id}`}
        >
          <div className="flex items-center gap-2">
            <Badge tone={cit.kind === 'repo' ? 'cool' : 'amber'}>{cit.kind === 'repo' ? '代码' : '知识库'}</Badge>
            <code className="text-xs">^{cit.id}</code>
            <Button size="sm" variant="quiet" className="ml-auto hover:text-bad" onClick={() => onDelete(cit.id)} data-testid={`citation-del-${cit.id}`}>
              删除
            </Button>
          </div>
          {cit.kind === 'repo' ? (
            <p className="measured break-all text-xs text-muted">
              {repoName(cit.repo)} · {cit.path}:{cit.lines?.[0]}-{cit.lines?.[1]} @{(cit.commit ?? '').slice(0, 7)}
            </p>
          ) : (
            <p className="break-all text-xs text-muted">{cit.sourceId}{cit.headingPath?.length ? ` · ${cit.headingPath.join(' / ')}` : ''}</p>
          )}
          {cit.excerpt ? <p className="line-clamp-4 whitespace-pre-wrap rounded-chip bg-paper-2 px-2.5 py-2 font-mono text-xs text-ink-2 [overflow-wrap:anywhere]">{cit.excerpt}</p> : null}
        </div>
      ))}
    </div>
  );
}

export function ReviewPane({ doc }: { doc: DocDetail }) {
  const review = doc.review;
  if (!review?.verdict) return <p className="p-3.5 text-xs text-muted" data-testid="doc-review-pane">还没有审查结论。点上方「请求核对」让事实核对跑一遍。</p>;
  const stale = review.contentHash !== doc.contentHash;
  return (
    <div className="grid min-h-0 flex-1 content-start gap-3 overflow-y-auto p-3.5" data-testid="doc-review-pane">
      <div className="grid gap-3 rounded-card bg-paper-2 p-3.5">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={review.verdict === 'pass' ? 'ok' : 'bad'}>{review.verdict === 'pass' ? '通过' : '未过'}</Badge>
          {stale ? <Badge tone="amber" data-testid="doc-review-stale">已过时</Badge> : null}
          <span className="ml-auto flex flex-wrap items-center gap-x-3 text-xs text-muted">
            {review.by ? <span>审查人：{review.by}</span> : null}
            <span>{when(review.at)}</span>
          </span>
        </div>
        <p className="text-sm text-ink-2">{review.summary}</p>
      </div>
      <ul className="grid gap-2.5">
        {(review.findings ?? []).map((f, i) => (
          <li key={i} className="grid gap-1.5 rounded-ctl border border-rule bg-paper px-3 py-2.5">
            <div className="flex items-center gap-2">
              <Badge tone={FINDING_TONE[f.status] ?? 'neutral'}>{FINDING_LABEL[f.status] ?? f.status}</Badge>
              {f.citation ? <code className="text-xs">^{f.citation}</code> : null}
            </div>
            <p className="text-sm text-ink-2">{f.claim}</p>
            {f.evidence ? <p className="text-xs text-muted">证据：{f.evidence}</p> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function GatePane({ doc, onHandoff }: { doc: DocDetail; onHandoff: () => void }) {
  const gate = doc.gate;
  const lint = doc.lint ?? [];
  if (!gate) return <p className="p-3.5 text-xs text-muted" data-testid="doc-gate-pane">门禁结果不可用。</p>;
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="doc-gate-pane">
      <div className="grid min-h-0 flex-1 content-start gap-3 overflow-y-auto p-3.5">
        <div className="grid gap-2.5 rounded-card bg-paper-2 p-3.5">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-bold text-ink">交接条件</h3>
            <Badge tone={gate.ok ? 'ok' : 'amber'} className="ml-auto">{gate.ok ? '可交接' : '未就绪'}</Badge>
          </div>
          <p className="text-xs text-muted">交接前要把这些都清了</p>
          {gate.ok ? (
            <p className="flex items-center gap-2 text-sm text-ink-2"><Icon name="check" className="size-4 shrink-0 text-ok" />文档已核过、无阻断问题，可以交接。</p>
          ) : (
            <ul className="grid gap-2">
              {gate.reasons.map((r, i) => (
                <li key={i} className="flex items-start gap-2 text-sm text-ink-2" data-testid="doc-gate-reason">
                  <Icon name="x" className="mt-0.5 size-4 shrink-0 text-bad" />
                  <span>{r}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        {lint.length ? (
          <div className="grid gap-2 rounded-card bg-paper-2 p-3.5">
            <h3 className="text-sm font-bold text-ink">风格检查<span className="ml-1.5 font-medium text-muted tabular-nums">{lint.length}</span></h3>
            <ul className="grid gap-1.5">
              {lint.slice(0, 30).map((l, i) => (
                <li key={i} className="flex items-start gap-2 text-xs">
                  <Badge tone={l.level === 'error' ? 'bad' : 'amber'}>{l.level === 'error' ? '错' : '警'}</Badge>
                  <span className="pt-0.5 text-ink-2"><span className="measured text-muted">L{l.line}</span> {l.message}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
      <div className="shrink-0 border-t border-rule p-3.5">
        <Button variant="primary" size="sm" className="w-full" title="把成品文本冻结成交接工件，在开发台起写入任务" data-testid="doc-handoff" onClick={onHandoff}>
          <Icon name="send" />交给开发
        </Button>
      </div>
    </div>
  );
}
