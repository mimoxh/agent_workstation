import { evaluateRenderGate, type GateCheck } from '@aw/domain';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type RefObject } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Empty, Loading } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/icons';
import { Seg, Textarea } from '@/components/ui/input';
import { api, unwrap } from '@/lib/api';
import { when } from '@/lib/format';
import { useVideoComments, type VideoComment, type VideoDetail } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { clock, SEVERITY_LABEL } from './model';
import type { PlayerPosition } from './VideoPlayer';

const PLACEHOLDER_RULES = new Set(['html_empty', 'prompt_empty', 'asset_empty']);

// 和服务端 gateOf 同一套判断；allowPlaceholders 时缺画面不算检查错误
export function gateFor(video: VideoDetail, allowPlaceholders = false) {
  const lintErrors = video.lint.filter((l) => l.level === 'error' && !(allowPlaceholders && PLACEHOLDER_RULES.has(l.rule))).map((l) => l.message);
  const openBlocks = video.shots.reduce((n, s) => n + s.comments.block, 0);
  const unvoiced = video.voiceOn ? video.shots.filter((s) => s.narration.trim() && s.audio?.state !== 'fresh').map((s, i) => s.title || `镜头 ${s.order ?? i + 1}`) : [];
  return evaluateRenderGate({ review: video.review, contentHash: video.contentHash, lintErrors, openBlocks, voiceOn: video.voiceOn, unvoiced });
}

export function GateChecklist({ checks, testId }: { checks: GateCheck[]; testId?: string }) {
  return (
    <ul className="grid gap-1.5" data-testid={testId}>
      {checks.map((c) => (
        <li key={c.id} className="flex items-start gap-2 text-sm" data-testid={`video-gate-${c.id}`} data-ok={c.ok ? '1' : '0'}>
          <Icon name={c.ok ? 'check' : 'alert'} className={cn('mt-0.5 size-4 shrink-0', c.ok ? 'text-ok' : 'text-accent')} />
          <span className="grid min-w-0 gap-0.5">
            <span className={cn('font-medium', c.ok ? 'text-ink-2' : 'text-ink')}>{c.label}</span>
            <span className="text-xs text-muted">{c.detail}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

const byName = (by: { type: string; id: string }, names: Record<string, string>) => (by.type === 'agent' ? names[by.id] ?? 'Agent' : '我');

export function ReviewPane({ video, names }: { video: VideoDetail; names: Record<string, string> }) {
  const r = video.review;
  return (
    <div className="grid content-start gap-4 overflow-y-auto p-3" data-testid="video-review-pane">
      <section className="grid gap-1.5 rounded-ctl border border-rule bg-paper px-3 py-2.5" data-testid="video-review-summary">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-sm font-semibold text-ink">审片结论</span>
          {r ? <Badge tone={r.verdict === 'pass' ? 'ok' : 'bad'} data-testid="video-review-verdict">{r.verdict === 'pass' ? '通过' : '没通过'}</Badge> : <Badge tone="neutral">还没有</Badge>}
          {r && !video.reviewFresh ? <Badge tone="amber" title="审片后镜头、旁白、配音或风格改过">内容改过，需重审</Badge> : null}
          {video.status === 'reviewing' ? <Badge tone="cool">审片中</Badge> : null}
        </div>
        {r ? (
          <>
            <p className="whitespace-pre-wrap text-sm text-ink-2">{r.summary}</p>
            <span className="text-xs text-muted">{byName({ type: r.byType, id: r.by }, names)} · {when(r.at)}</span>
          </>
        ) : (
          <p className="text-xs text-muted">点顶栏「请求审片」，审片会逐个镜头看画面、把问题钉在时间点上，再给结论。</p>
        )}
      </section>
      <section className="grid gap-2">
        <span className="text-sm font-semibold text-ink">出片门禁</span>
        <GateChecklist checks={video.gate.checks} testId="video-rail-gate" />
        <p className="text-xs text-muted">都通过才能出片。人可以在出片时填写原因越过门禁（会记录并发到大群），Agent 不能越过。</p>
      </section>
    </div>
  );
}

export interface CommentDraft { shotId: string; local: number; selector?: string | undefined; anchor?: string | undefined; tag?: string | undefined }

const SEVERITY_OPTIONS = [{ value: 'note' as const, label: '备注' }, { value: 'block' as const, label: '阻断' }];

export function CommentsPane({ video, wsId, names, position, canLocate, draft, onDraft, picking, onPicking, onOpen }: {
  video: VideoDetail; wsId: string; names: Record<string, string>; position: RefObject<PlayerPosition | null>; canLocate: boolean;
  draft: CommentDraft | null; onDraft: (d: CommentDraft | null) => void; picking: boolean; onPicking: (on: boolean) => void; onOpen: (c: VideoComment) => void;
}) {
  const qc = useQueryClient();
  const q = useVideoComments(video.id);
  const [all, setAll] = useState(false);
  const [body, setBody] = useState('');
  const [severity, setSeverity] = useState<'note' | 'block'>('note');
  const [error, setError] = useState<string | null>(null);
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['video-comments', video.id] }), qc.invalidateQueries({ queryKey: ['video', video.id] })]);
  const add = useMutation({
    mutationFn: async (d: CommentDraft) =>
      unwrap(await api.videos[':id'].comments.$post({ param: { id: video.id }, json: { shot: d.shotId, time: Math.round(d.local * 100) / 100, body, severity, ...(d.selector ? { selector: d.selector } : {}), ...(d.anchor ? { anchor: d.anchor } : {}) } })),
    meta: { silent: true },
    onSuccess: async () => {
      setBody('');
      setSeverity('note');
      setError(null);
      onDraft(null);
      await refresh();
    },
    onError: (e) => setError(e.message),
  });
  const resolve = useMutation({
    mutationFn: async (id: string) => unwrap(await api.workstations[':id']['video-comments'].resolve.$post({ param: { id: wsId }, json: { ids: [id] } })),
    onSuccess: refresh,
  });

  const shotOf = (id: string) => video.shots.find((s) => s.id === id);
  const label = (id: string) => {
    const i = video.shots.findIndex((s) => s.id === id);
    const s = video.shots[i];
    return s ? `${i + 1} · ${s.title || `镜头 ${i + 1}`}` : '镜头已删除';
  };
  const start = () => {
    const p = position.current;
    if (!p) return;
    setError(null);
    onDraft({ shotId: p.shotId, local: p.local });
  };

  if (!q.data) return q.isError ? <Empty title="评论加载失败" /> : <Loading className="flex-1" />;
  const list = q.data.comments
    .filter((c) => shotOf(c.shot) && (all || c.status !== 'resolved'))
    .map((c) => ({ c, t: (shotOf(c.shot)?.start ?? 0) + c.time }))
    .sort((a, b) => a.t - b.t);
  const open = q.data.comments.filter((c) => c.status !== 'resolved' && shotOf(c.shot)).length;
  const draftShot = draft ? shotOf(draft.shotId) : undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="video-comments">
      <div className="grid shrink-0 gap-2 border-b border-rule px-3 py-2.5">
        {draft && draftShot ? (
          <div className="grid gap-2" data-testid="video-comment-composer">
            <span className="text-xs text-ink-2" data-testid="video-comment-at">
              {label(draft.shotId)} · 镜头内 {clock(draft.local, true)}（全片 {clock(draftShot.start + draft.local, true)}）
            </span>
            <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={3} placeholder="这个时刻哪里要改" data-testid="video-comment-body" autoFocus />
            <div className="flex flex-wrap items-center gap-1.5">
              <Seg value={severity} options={SEVERITY_OPTIONS} onChange={setSeverity} size="sm" label="严重程度" />
              {draft.selector ? (
                <Badge tone="cool" title={draft.selector} data-testid="video-comment-picked">
                  {draft.anchor || draft.tag || '元素'}
                  <button type="button" aria-label="去掉圈选" className="-mr-1 ml-0.5" onClick={() => onDraft({ shotId: draft.shotId, local: draft.local })}><Icon name="x" /></button>
                </Badge>
              ) : (
                <Button size="sm" variant="quiet" aria-pressed={picking} disabled={!canLocate} onClick={() => onPicking(!picking)} data-testid="video-comment-pick">
                  <Icon name="cursor" />{picking ? '在画面里点一下' : '圈选元素'}
                </Button>
              )}
            </div>
            {error ? <p className="text-xs text-bad">{error}</p> : null}
            <div className="flex items-center gap-1.5">
              <Button size="sm" variant="primary" disabled={!body.trim() || add.isPending} onClick={() => add.mutate(draft)} data-testid="video-comment-submit">发表</Button>
              <Button size="sm" variant="quiet" onClick={() => { onPicking(false); onDraft(null); }}>取消</Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-1.5">
            <Button size="sm" disabled={!canLocate} onClick={start} data-testid="video-comment-new" title={canLocate ? undefined : '先切到预览或分镜，定位到要评论的时刻'}>
              <Icon name="comment" />在当前时刻留评论
            </Button>
            <span className="ml-auto text-xs tabular-nums text-muted">{open} 条未解决</span>
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2 px-3 pt-2">
        <button type="button" aria-pressed={all} onClick={() => setAll((v) => !v)} className="text-xs text-muted hover:text-ink" data-testid="video-comment-filter">
          {all ? '只看未解决' : '包括已解决'}
        </button>
      </div>
      <ol className="grid min-h-0 flex-1 content-start gap-2 overflow-y-auto p-3" aria-label="评论">
        {list.length === 0 ? <li className="px-1 py-2 text-sm text-muted">{all ? '还没有评论。' : '没有未解决的评论。'}</li> : null}
        {list.map(({ c, t }) => (
          <li key={c.id} className={cn('grid gap-1.5 rounded-ctl border bg-paper px-3 py-2.5', c.status === 'resolved' ? 'border-rule opacity-70' : c.severity === 'block' ? 'border-bad' : 'border-rule')}>
            <button type="button" onClick={() => onOpen(c)} className="grid gap-1 text-left" data-testid={`video-comment-${c.id}`} title="跳到这个时刻">
              <span className="flex flex-wrap items-center gap-1.5 text-xs">
                <Badge tone={c.severity === 'block' ? 'bad' : 'neutral'}>{SEVERITY_LABEL[c.severity] ?? c.severity}</Badge>
                <span className="tabular-nums text-ink-2">{clock(t, true)}</span>
                <span className="min-w-0 flex-1 truncate text-muted">{label(c.shot)}</span>
                {c.status === 'resolved' ? <Badge tone="ok">已解决</Badge> : null}
              </span>
              <span className="whitespace-pre-wrap text-sm text-ink">{c.body}</span>
              {c.anchor ? <span className="truncate text-xs text-muted">圈选：{c.anchor}</span> : null}
            </button>
            <span className="flex items-center gap-1.5 text-xs text-muted">
              <span>{byName(c.by, names)}</span>
              {c.createdAt ? <span>· {when(c.createdAt)}</span> : null}
              {c.status !== 'resolved' ? (
                <Button size="sm" variant="quiet" className="ml-auto" disabled={resolve.isPending} onClick={() => resolve.mutate(c.id)} data-testid={`video-comment-resolve-${c.id}`}>
                  <Icon name="check" />解决
                </Button>
              ) : c.note ? <span className="ml-auto truncate" title={c.note}>{c.note}</span> : null}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
