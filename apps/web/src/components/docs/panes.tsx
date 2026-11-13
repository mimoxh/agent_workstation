import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, Textarea } from '@/components/ui/input';
import { api, unwrap } from '@/lib/api';
import { when } from '@/lib/format';
import type { DocDetail, DocRepo } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { commentsPrompt, FINDING_LABEL, FINDING_TONE, type OpenComment } from './model';

export type PendingComment = { quote: string; heading: string };

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
      <div className="shrink-0 space-y-2 border-b border-rule p-3">
        {pending ? (
          <div className="rounded-card border border-rule bg-canvas p-2">
            <p className="text-xs text-muted">{heading ? `「${heading}」下` : '引文'}</p>
            <p className="mt-0.5 line-clamp-3 text-xs text-ink-2">“{quote}”</p>
          </div>
        ) : (
          <p className="text-xs text-muted">在预览里选中文字可引用评论；也可直接留整体意见。</p>
        )}
        <Select value={severity} onChange={(e) => setSeverity(e.target.value as 'block' | 'note')} className="h-7 w-full text-xs" data-testid="doc-comment-severity">
          <option value="note">建议</option>
          <option value="block">阻断</option>
        </Select>
        <Textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="写评论…" rows={3} className="text-sm" data-testid="doc-comment-input" />
        <div className="flex justify-end gap-1.5">
          {pending ? <Button size="sm" variant="quiet" onClick={onClearPending}>取消引用</Button> : null}
          <Button
            size="sm"
            variant="primary"
            disabled={!body.trim() || add.isPending}
            data-testid="doc-comment-submit"
            onClick={() => add.mutate({ body: body.trim(), severity, ...(quote ? { quote } : {}), ...(heading ? { heading } : {}) })}
          >
            评论
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {comments.length === 0 ? <p className="text-sm text-muted">还没有待处理的评论。</p> : null}
        <ul className="space-y-2">
          {comments.map((c) => (
            <li key={c.id} className="rounded-card border border-rule bg-paper p-2.5" data-testid="doc-comment-item">
              <div className="flex items-center gap-1.5">
                <Badge tone={c.severity === 'block' ? 'bad' : 'neutral'}>{c.severity === 'block' ? '阻断' : '建议'}</Badge>
                {c.heading ? <span className="truncate text-xs text-muted">{c.heading}</span> : null}
                <span className="ml-auto text-xs text-faint">{when(c.createdAt)}</span>
              </div>
              {c.quote ? <p className="mt-1 line-clamp-3 rounded bg-canvas p-1.5 text-xs text-ink-2">“{c.quote}”</p> : null}
              <p className="mt-1 whitespace-pre-wrap text-sm">{c.body}</p>
              {c.note ? <p className="mt-1 text-xs text-muted">处理说明：{c.note}</p> : null}
              <div className="mt-1.5 flex justify-end">
                <Button size="sm" variant="quiet" disabled={resolve.isPending} onClick={() => resolve.mutate([c.id])} data-testid="doc-comment-resolve">
                  标记解决
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </div>
      <div className="shrink-0 border-t border-rule p-3">
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
  if (list.length === 0) return <p className="p-3 text-sm text-muted" data-testid="doc-citations-pane">还没有登记的引用。正文里用 [^id] 标记，由主笔或你写入引用清单。</p>;
  return (
    <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3" data-testid="doc-citations-pane">
      {list.map((cit) => (
        <div key={cit.id} className={cn('rounded-card border bg-paper p-2.5', active === cit.id ? 'border-cool' : 'border-rule')} data-testid={`citation-item-${cit.id}`}>
          <div className="flex items-center gap-1.5">
            <Badge tone={cit.kind === 'repo' ? 'cool' : 'amber'}>{cit.kind === 'repo' ? '代码' : '知识库'}</Badge>
            <span className="text-xs font-medium">^{cit.id}</span>
            <button type="button" className="ml-auto text-xs text-muted hover:text-bad" onClick={() => onDelete(cit.id)} data-testid={`citation-del-${cit.id}`}>
              删除
            </button>
          </div>
          {cit.kind === 'repo' ? (
            <p className="mt-1 break-all font-mono text-xs text-ink-2">
              {repoName(cit.repo)} · {cit.path}:{cit.lines?.[0]}-{cit.lines?.[1]} @{(cit.commit ?? '').slice(0, 7)}
            </p>
          ) : (
            <p className="mt-1 break-all text-xs text-ink-2">{cit.sourceId}{cit.headingPath?.length ? ` · ${cit.headingPath.join(' / ')}` : ''}</p>
          )}
          {cit.excerpt ? <p className="mt-1 line-clamp-4 whitespace-pre-wrap rounded bg-canvas p-1.5 font-mono text-xs text-muted">{cit.excerpt}</p> : null}
        </div>
      ))}
    </div>
  );
}

export function ReviewPane({ doc }: { doc: DocDetail }) {
  const review = doc.review;
  if (!review?.verdict) return <p className="p-3 text-sm text-muted" data-testid="doc-review-pane">还没有审查结论。点上方「请求核对」让事实核对跑一遍。</p>;
  const stale = review.contentHash !== doc.contentHash;
  return (
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3" data-testid="doc-review-pane">
      <div className="flex items-center gap-1.5">
        <Badge tone={review.verdict === 'pass' ? 'ok' : 'bad'}>{review.verdict === 'pass' ? '通过' : '未过'}</Badge>
        {stale ? <Badge tone="amber" data-testid="doc-review-stale">已过时</Badge> : null}
        <span className="ml-auto text-xs text-faint">{when(review.at)}</span>
      </div>
      {review.by ? <p className="text-xs text-muted">审查人：{review.by}</p> : null}
      <p className="text-sm">{review.summary}</p>
      <ul className="space-y-2">
        {(review.findings ?? []).map((f, i) => (
          <li key={i} className="rounded-card border border-rule bg-paper p-2.5">
            <div className="flex items-center gap-1.5">
              <Badge tone={FINDING_TONE[f.status] ?? 'neutral'}>{FINDING_LABEL[f.status] ?? f.status}</Badge>
              {f.citation ? <span className="text-xs text-muted">^{f.citation}</span> : null}
            </div>
            <p className="mt-1 text-sm">{f.claim}</p>
            {f.evidence ? <p className="mt-1 text-xs text-muted">证据：{f.evidence}</p> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function GatePane({ doc, onHandoff }: { doc: DocDetail; onHandoff: () => void }) {
  const gate = doc.gate;
  const lint = doc.lint ?? [];
  if (!gate) return <p className="p-3 text-sm text-muted" data-testid="doc-gate-pane">门禁结果不可用。</p>;
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="doc-gate-pane">
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        <div className="flex items-center gap-1.5">
          <Badge tone={gate.ok ? 'ok' : 'amber'}>{gate.ok ? '可交接' : '未就绪'}</Badge>
          <span className="text-xs text-muted">交接前要把这些都清了</span>
        </div>
        {gate.ok ? <p className="text-sm text-ink-2">文档已核过、无阻断问题，可以交接。</p> : (
          <ul className="space-y-1.5">
            {gate.reasons.map((r, i) => (
              <li key={i} className="flex gap-1.5 text-sm" data-testid="doc-gate-reason">
                <span className="text-bad">•</span>
                <span>{r}</span>
              </li>
            ))}
          </ul>
        )}
        {lint.length ? (
          <div>
            <p className="mb-1 text-xs font-medium text-muted">风格检查（{lint.length}）</p>
            <ul className="space-y-1">
              {lint.slice(0, 30).map((l, i) => (
                <li key={i} className="flex items-start gap-1.5 text-xs">
                  <Badge tone={l.level === 'error' ? 'bad' : 'amber'} className="mt-0.5">{l.level === 'error' ? '错' : '警'}</Badge>
                  <span className="text-ink-2">L{l.line} {l.message}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
      <div className="shrink-0 border-t border-rule p-3">
        <Button variant="primary" size="sm" className="w-full" title="把成品文本冻结成交接工件，在开发台起写入任务" data-testid="doc-handoff" onClick={onHandoff}>
          交给开发
        </Button>
      </div>
    </div>
  );
}
