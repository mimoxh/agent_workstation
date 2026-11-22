import { useMutation } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { StreamBlocks, useLiveOutput } from '@/components/run/LiveOutput';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Button, buttonClass } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Empty, Loading } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/icons';
import { api, unwrap } from '@/lib/api';
import { when } from '@/lib/format';
import { useRenderCompare, useVideoRenders, type VideoRender, type WorkstationDetail } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { clock, SUBTITLE_LABEL } from './model';

export const RENDER_STATUS: Record<string, { label: string; tone: BadgeTone }> = {
  queued: { label: '排队中', tone: 'cool' },
  running: { label: '渲染中', tone: 'cool' },
  succeeded: { label: '已完成', tone: 'ok' },
  failed: { label: '失败', tone: 'bad' },
  cancelled: { label: '已取消', tone: 'neutral' },
};

const active = (r: VideoRender) => r.status === 'queued' || r.status === 'running';
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

function Progress({ value }: { value: number }) {
  return (
    <span className="relative flex h-1.5 overflow-hidden rounded-full bg-paper-3" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value * 100)}>
      <span className="h-full bg-cool transition-[width] duration-300" style={{ width: `${Math.round(value * 100)}%` }} />
    </span>
  );
}

function RenderLog({ channel }: { channel: string }) {
  const streams = useLiveOutput(channel);
  if (streams.length === 0) return <p className="text-xs text-muted">没有日志（服务重启后日志不保留）</p>;
  return <StreamBlocks streams={streams} />;
}

function RenderDetail({ r, onCompare }: { r: VideoRender; onCompare?: (() => void) | undefined }) {
  const cancel = useMutation({ mutationFn: async () => unwrap(await api['video-renders'][':id'].cancel.$post({ param: { id: r.id } })) });
  const st = RENDER_STATUS[r.status] ?? { label: r.status, tone: 'neutral' as const };
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto" data-testid="video-render-detail">
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-rule bg-paper px-5 py-2.5">
        <h2 className="min-w-0 truncate text-title font-bold text-ink">{r.title || '视频'}</h2>
        <Badge tone={st.tone} data-testid="video-render-status">{st.label}</Badge>
        <Badge tone="line">{r.width}×{r.height} · {r.fps}fps · 字幕{SUBTITLE_LABEL[r.subtitles] ?? r.subtitles}</Badge>
        <span className="text-xs tabular-nums text-muted">{clock(r.output?.duration ?? r.total, true)}</span>
        <span className="ml-auto flex flex-wrap items-center gap-1.5">
          {active(r) ? (
            <Button size="sm" variant="danger" disabled={cancel.isPending} onClick={() => cancel.mutate()} data-testid="video-render-cancel"><Icon name="stop" />取消</Button>
          ) : null}
          {r.output ? (
            <a className={buttonClass('default', 'sm')} href={`/api/media/${r.output.artifactId}?download=1`} data-testid="video-render-download"><Icon name="download" />mp4 · {mb(r.output.size)}</a>
          ) : null}
          {r.srt ? (
            <a className={buttonClass('default', 'sm')} href={`/api/media/${r.srt.artifactId}?download=1`} data-testid="video-render-srt"><Icon name="download" />字幕 srt</a>
          ) : null}
          {r.status === 'succeeded' && onCompare ? (
            <Button size="sm" onClick={onCompare} data-testid="video-render-compare"><Icon name="diff" />和另一次对比</Button>
          ) : null}
        </span>
      </header>
      <div className="grid gap-4 px-5 py-4">
        {r.status === 'succeeded' && r.output ? (
          <video key={r.output.artifactId} controls preload="metadata" src={`/api/media/${r.output.artifactId}`} className="max-h-[60vh] w-full rounded-card bg-code" data-testid="video-render-player" />
        ) : null}
        {active(r) ? (
          <div className="grid gap-1.5">
            <Progress value={r.progress} />
            <span className="text-xs tabular-nums text-muted" data-testid="video-render-progress">{r.status === 'queued' ? '排队中，前面的出片结束后开始' : `${Math.round(r.progress * 100)}%`}</span>
          </div>
        ) : null}
        {r.error && r.status === 'failed' ? (
          <p className="flex items-start gap-1.5 rounded-ctl bg-bad-soft px-3 py-2 text-sm text-bad" data-testid="video-render-error"><Icon name="alert" className="mt-0.5 size-4" />{r.error}</p>
        ) : null}
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs text-ink-2">
          <dt className="text-muted">镜头</dt>
          <dd className="tabular-nums">{r.shots} 个 · 配音 {r.voiced} 段{r.placeholders ? ` · 占位画面 ${r.placeholders} 个` : ''}</dd>
          <dt className="text-muted">视频版本</dt>
          <dd className="tabular-nums">v{r.videoVersion}</dd>
          <dt className="text-muted">发起</dt>
          <dd>{r.createdBy.type === 'agent' ? 'Agent' : '人'} · {when(r.createdAt)}</dd>
          {r.finishedAt ? (<><dt className="text-muted">结束</dt><dd>{when(r.finishedAt)}</dd></>) : null}
        </dl>
        {r.warnings.length ? (
          <ul className="grid gap-1" data-testid="video-render-warnings">
            {r.warnings.map((w, i) => (
              <li key={i} className="flex items-start gap-1.5 text-xs text-ink-2"><Icon name="alert" className="mt-px size-3.5 text-accent" /><span>{w}</span></li>
            ))}
          </ul>
        ) : null}
        <RenderLog channel={r.channel} />
      </div>
    </div>
  );
}


// 两次出片并排看：两边共用一条进度，下面列出变了 / 新增 / 删掉的镜头和整体设置的差异
function ComparePane({ a, b, onClose }: { a: string; b: string; onClose: () => void }) {
  const q = useRenderCompare(a, b);
  const left = useRef<HTMLVideoElement>(null);
  const right = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [t, setT] = useState(0);
  const d = q.data;
  const total = Math.max(d?.a.total ?? 0, d?.b.total ?? 0);
  const seek = (x: number) => {
    setT(x);
    for (const el of [left.current, right.current]) if (el) el.currentTime = Math.min(x, el.duration || x || 0);
  };
  // 镜头在两次成片里的起点可能不同（前面的镜头改了时长），两边各跳到自己的起点；
  // 起点往后挪到转场交叠之后（交叠最多 0.5 秒、不过镜头一半），停下来看到的才是这个镜头本身
  const jump = (s: { timeA: number | null; timeB: number | null; durationA: number | null; durationB: number | null }) => {
    const at = (start: number | null, dur: number | null) => (start === null ? null : start + Math.min(0.5, (dur ?? 0) / 2));
    const ta = at(s.timeA, s.durationA);
    const tb = at(s.timeB, s.durationB);
    setT(ta ?? tb ?? 0);
    if (left.current && ta !== null) left.current.currentTime = ta;
    if (right.current && tb !== null) right.current.currentTime = tb;
  };
  const toggle = () => {
    const next = !playing;
    setPlaying(next);
    for (const el of [left.current, right.current]) {
      if (!el) continue;
      if (next) void el.play().catch(() => {});
      else el.pause();
    }
  };
  const follows = () => {
    const x = left.current?.currentTime ?? 0;
    setT(x);
    if (playing && right.current && Math.abs(right.current.currentTime - x) > 0.2 && Math.abs((d?.a.total ?? 0) - (d?.b.total ?? 0)) < 0.05) right.current.currentTime = x;
  };
  if (!d) return q.isError ? <Empty title="对比失败" icon="info">{q.error.message}</Empty> : <Loading className="flex-1" />;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto" data-testid="video-compare">
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-rule bg-paper px-5 py-2.5">
        <h2 className="text-title font-bold text-ink">对比两次出片</h2>
        <Badge tone={d.changed ? 'amber' : 'ok'}>{d.changed ? `${d.changed} 个镜头有变化` : '镜头完全一致'}</Badge>
        <span className="text-xs tabular-nums text-muted">设置差异 {d.settings.length} 项</span>
        <Button size="sm" variant="quiet" className="ml-auto" onClick={onClose} data-testid="video-compare-close"><Icon name="close" />退出对比</Button>
      </header>
      <div className="grid shrink-0 gap-2 px-5 pt-4">
        <div className="grid grid-cols-2 gap-3">
          <div className="grid gap-1">
            <span className="text-xs text-muted">A · {when(d.a.createdAt)}</span>
            <video ref={left} src={`/api/media/${d.a.output}`} muted playsInline preload="auto" onTimeUpdate={follows} className="w-full rounded-card bg-code" data-testid="video-compare-a" />
          </div>
          <div className="grid gap-1">
            <span className="text-xs text-muted">B · {when(d.b.createdAt)}</span>
            <video ref={right} src={`/api/media/${d.b.output}`} muted playsInline preload="auto" className="w-full rounded-card bg-code" data-testid="video-compare-b" />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button size="icon-sm" variant="primary" aria-label={playing ? '暂停' : '播放'} onClick={toggle} data-testid="video-compare-play"><Icon name={playing ? 'pause' : 'play'} /></Button>
          <input type="range" min={0} max={total || 1} step={0.05} value={t} onChange={(e) => seek(Number(e.target.value))} aria-label="对比进度" className="min-w-40 flex-1 accent-[var(--color-ink)]" />
          <span className="text-xs tabular-nums text-muted">{clock(t, true)} / {clock(total, true)}</span>
        </div>
      </div>
      <div className="grid gap-4 px-5 py-4">
        <section className="grid gap-1.5">
          <h3 className="text-sm font-semibold text-ink">设置差异</h3>
          {d.settings.length === 0 ? <p className="text-xs text-muted">两次的设置完全一样。</p> : (
            <table className="w-full text-xs">
              <thead><tr className="text-left text-muted"><th className="py-1 font-normal">项</th><th className="py-1 font-normal">A</th><th className="py-1 font-normal">B</th></tr></thead>
              <tbody>
                {d.settings.map((s) => (
                  <tr key={s.field} className="border-t border-rule" data-testid={`video-compare-setting-${s.field}`}>
                    <td className="py-1 pr-3 text-ink-2">{s.label}</td>
                    <td className="py-1 pr-3 font-mono text-[11px] text-muted">{s.a}</td>
                    <td className="py-1 font-mono text-[11px] text-ink-2">{s.b}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
        <section className="grid gap-1.5">
          <h3 className="text-sm font-semibold text-ink">逐个镜头</h3>
          <ul className="grid gap-1" data-testid="video-compare-shots">
            {d.shots.map((s) => (
              <li key={s.id} role="button" tabIndex={0} title="两边跳到这个镜头" onClick={() => jump(s)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); jump(s); } }} className={cn('flex cursor-pointer items-center gap-2 rounded-ctl border px-2.5 py-1.5 text-xs hover:border-ink-3', s.status === 'same' ? 'border-rule bg-paper' : s.status === 'changed' ? 'border-accent bg-accent-soft' : 'border-rule bg-paper-2')} data-testid={`video-compare-shot-${s.id}`}>
                <span className="w-6 text-right tabular-nums text-muted">{s.order}</span>
                <span className="min-w-0 flex-1 truncate text-ink">{s.title || '未命名'}</span>
                <Badge tone={s.status === 'same' ? 'line' : s.status === 'changed' ? 'amber' : s.status === 'added' ? 'cool' : 'neutral'}>{s.status === 'same' ? '没变' : s.status === 'changed' ? '改过' : s.status === 'added' ? '新增' : '删掉'}</Badge>
                <span className="tabular-nums text-muted">{s.durationA !== null ? clock(s.durationA) : '—'} / {s.durationB !== null ? clock(s.durationB) : '—'}</span>
                <span className="font-mono text-[10px] text-muted" title={`A ${s.hashA ?? '—'}\nB ${s.hashB ?? '—'}`}>{(s.hashA ?? '—').slice(0, 6)}·{(s.hashB ?? '—').slice(0, 6)}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}

export function VideoRenders({ ws }: { ws: WorkstationDetail }) {
  const q = useVideoRenders(ws.id);
  const [picked, setPicked] = useState<string | null>(null);
  const [other, setOther] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  if (!q.data) return q.isError ? <Empty title="成片加载失败" /> : <Loading className="flex-1" />;
  const list = q.data.renders;
  const current = list.find((r) => r.id === picked) ?? list[0];
  const candidates = current ? list.filter((r) => r.id !== current.id && r.videoId === current.videoId && r.status === 'succeeded') : [];
  return (
    <div className="flex min-h-0 min-w-0 flex-1" data-testid="video-renders">
      <aside className="flex w-80 shrink-0 flex-col border-r border-rule bg-paper-2">
        <div className="flex shrink-0 items-center gap-2 border-b border-rule px-4 py-2.5">
          <h2 className="text-title font-bold text-ink">成片</h2>
          {list.length ? <span className="text-xs tabular-nums text-muted">{list.length}</span> : null}
        </div>
        <ul className="grid min-h-0 flex-1 content-start gap-2 overflow-y-auto p-3">
          {list.length === 0 ? <li className="px-1 py-2 text-sm text-muted">还没有出过片。在工作室打开视频点「出片」，或让编导出片。</li> : null}
          {list.map((r) => {
            const st = RENDER_STATUS[r.status] ?? { label: r.status, tone: 'neutral' as const };
            return (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => setPicked(r.id)}
                  className={cn('grid w-full gap-1.5 rounded-ctl border bg-paper px-3 py-2.5 text-left transition-colors duration-150', current?.id === r.id ? 'border-ink' : 'border-rule hover:bg-paper-2')}
                  data-testid={`video-render-item-${r.id}`}
                >
                  <span className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{r.title || '视频'}</span>
                    <Badge tone={st.tone}>{st.label}</Badge>
                  </span>
                  {active(r) ? <Progress value={r.progress} /> : null}
                  <span className="flex items-center gap-1.5 text-xs text-muted">
                    <span className="tabular-nums">{r.width}×{r.height} · {clock(r.output?.duration ?? r.total)}</span>
                    <span className="ml-auto">{when(r.createdAt)}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </aside>
      {current && other ? (
        <ComparePane a={current.id} b={other} onClose={() => setOther(null)} />
      ) : current ? (
        <RenderDetail key={current.id} r={current} onCompare={candidates.length ? () => setPicking(true) : undefined} />
      ) : (
        <Empty title="选一次出片看结果" icon="film" />
      )}
      {picking && current ? (
        <Dialog title="和哪一次出片对比" description={`《${current.title || '视频'}》成功出片的其他版本`} onClose={() => setPicking(false)} testId="video-compare-picker">
          <ul className="grid gap-1.5">
            {candidates.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded-ctl border border-rule bg-paper px-3 py-2 text-left text-sm transition-colors duration-150 hover:bg-paper-2"
                  onClick={() => {
                    setOther(r.id);
                    setPicking(false);
                  }}
                  data-testid={`video-compare-pick-${r.id}`}
                >
                  <span className="tabular-nums text-xs text-muted">{when(r.createdAt)}</span>
                  <span className="text-xs text-ink-2">{r.width}×{r.height} · {r.fps}fps · 字幕{SUBTITLE_LABEL[r.subtitles] ?? r.subtitles}</span>
                  <span className="ml-auto tabular-nums text-xs text-muted">{clock(r.output?.duration ?? r.total, true)}</span>
                </button>
              </li>
            ))}
          </ul>
        </Dialog>
      ) : null}
    </div>
  );
}
