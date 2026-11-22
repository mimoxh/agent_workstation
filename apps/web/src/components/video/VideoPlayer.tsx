import { composeShotDoc, overlayDoc, shotAt, shotSource, subtitleLayout, videoCues, type PlayerEvent, type ShotMotionKind, type VideoLook } from '@aw/domain';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Empty } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/icons';
import { api } from '@/lib/api';
import type { VideoDetail, VideoShot } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { clock } from './model';
import { ShotCanvas, ShotLayer, type ShotFrameHandle } from './ShotFrame';

// 和服务端 renderableShot 同一种合成方式（含本台风格的 CSS 变量），预览即成片。
// 素材镜头不合成页面：原生图片 / 视频铺底，shot.html 是叠在上面的透明层
export const shotDoc = (s: VideoShot, size: { width: number; height: number }, look?: VideoLook | null) => {
  if (s.assetInfo) return s.html?.trim() ? overlayDoc(s.html, { width: size.width, height: size.height, duration: s.duration, style: look ?? null }) : '';
  return composeShotDoc(shotSource(s).html, { width: size.width, height: size.height, duration: s.duration, style: look ?? null });
};

// 和 ffmpeg 的 zoompan 同一段运动：整段推进 10%，两端各留 5% 余量
export function motionStyle(kind: ShotMotionKind, progress: number): CSSProperties {
  const p = Math.min(1, Math.max(0, progress));
  if (kind === 'zoom-in') return { transform: `scale(${1 + 0.1 * p})` };
  if (kind === 'zoom-out') return { transform: `scale(${1.1 - 0.1 * p})` };
  if (kind === 'pan-left') return { transform: `scale(1.1) translateX(${(0.5 - p) * 9}%)` };
  if (kind === 'pan-right') return { transform: `scale(1.1) translateX(${(p - 0.5) * 9}%)` };
  return {};
}

// 下一个镜头提前这么多秒装进隐藏层，切过去时不闪
const PRELOAD_SECONDS = 1;
// 预览里的背景音乐压低：成片用 sidechaincompress，这里按「有人说话」近似成固定比例
const DUCK_GAIN = 0.3;
const BGM_FADE = 1;

export interface PlayerPosition { shotId: string; index: number; local: number; t: number }
export interface PickResult { shotId: string; local: number; selector: string; anchor: string; tag: string }
export interface PlayerControl {
  seek?: { t: number; n: number } | null | undefined;
  onSeeked?: (() => void) | undefined;
  picking?: boolean | undefined;
  onPick?: ((p: PickResult) => void) | undefined;
  mark?: { shotId: string; selector: string | null } | null | undefined;
  position?: RefObject<PlayerPosition | null> | undefined;
  markers?: { id: string; t: number; block: boolean }[] | undefined;
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

// 一层镜头画面：自己的虚拟时钟和配音都跟着父页面的主时钟走
function Layer({ shot, doc, local, running, anchor, top, style, picking, mark, voiceOn, onEvent }: {
  shot: VideoShot; doc: string; local: number; running: boolean; anchor: number; top: boolean; style: CSSProperties;
  picking: boolean; mark: string | null; voiceOn: boolean; onEvent: (s: VideoShot, e: PlayerEvent) => void;
}) {
  const frame = useRef<ShotFrameHandle>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const clip = useRef<HTMLVideoElement>(null);
  const media = shot.assetInfo;
  const clipDuration = media?.duration ?? null;
  const now = useRef({ local, running });
  useEffect(() => {
    now.current = { local, running };
  });

  const sync = () => {
    const s = now.current;
    if (s.running) frame.current?.play(s.local);
    else frame.current?.pause(s.local);
  };
  useEffect(sync, [running, anchor]);
  useEffect(() => frame.current?.pick(picking && top), [picking, top]);
  useEffect(() => frame.current?.mark(mark), [mark]);

  const voice = voiceOn && shot.audio?.state === 'fresh' ? shot.audio : null;
  const src = voice ? `/api/media/${voice.artifactId}` : null;
  useEffect(() => {
    const el = audio.current;
    if (!el || !voice) return;
    const want = now.current.local;
    if (!running || want >= voice.duration) {
      el.pause();
      return;
    }
    if (Math.abs(el.currentTime - want) > 0.05) el.currentTime = want;
    void el.play().catch(() => {});
  }, [src, running, anchor]);
  useEffect(() => {
    const el = audio.current;
    if (!el || !running || el.paused) return;
    if (Math.abs(el.currentTime - local) > 0.3) el.currentTime = local;
  }, [Math.floor(local * 2)]);
  // 素材片段跟主时钟走：差得多就跳，播放中只微调
  const clipRunning = running && (clipDuration === null || local < clipDuration);
  useEffect(() => {
    const el = clip.current;
    if (!el || !clipDuration) return;
    const want = Math.min(local, clipDuration);
    if (!clipRunning) {
      el.pause();
      if (Math.abs(el.currentTime - want) > 0.05) el.currentTime = want;
      return;
    }
    if (Math.abs(el.currentTime - want) > 0.2) el.currentTime = want;
    void el.play().catch(() => {});
  }, [clipRunning, anchor, Math.floor(local * 2)]);

  const progress = shot.duration > 0 ? local / shot.duration : 0;
  return (
    <>
      {src ? <audio ref={audio} src={src} preload="auto" data-testid={top ? 'video-audio' : undefined} /> : null}
      {media?.kind === 'image' ? (
        <img
          src={`/api/media/${media.artifactId}`}
          alt=""
          className="absolute inset-0 size-full origin-center object-cover"
          style={motionStyle(shot.motion, progress)}
          data-testid={top ? 'video-player-image' : undefined}
        />
      ) : null}
      {media?.kind === 'video' ? (
        <video
          ref={clip}
          src={`/api/media/${media.artifactId}`}
          muted={!shot.keepAudio}
          playsInline
          preload="auto"
          className="absolute inset-0 size-full bg-black object-contain"
          data-testid={top ? 'video-player-clip' : undefined}
        />
      ) : null}
      {doc ? <ShotLayer
        ref={frame}
        doc={doc}
        title={`${shot.title || '镜头'} 画面`}
        testId={top ? 'video-player-frame' : 'video-player-frame-under'}
        interactive={picking && top}
        style={style}
        onEvent={(e) => {
          if (e.type === 'ready') sync();
          onEvent(shot, e);
        }}
      /> : null}
    </>
  );
}

// 全片播放：父页面持有主时钟，时间线和成片同一条（转场交叠）；交叠期间两层画面叠着播，淡入调透明度、滑入平移
export function VideoPlayer({ video, control }: { video: VideoDetail; control?: PlayerControl }) {
  const qc = useQueryClient();
  const shots = video.shots;
  const total = video.total;
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [anchor, setAnchor] = useState(0);
  const [issues, setIssues] = useState<Record<string, string[]>>({});
  const bgmEl = useRef<HTMLAudioElement>(null);
  const posted = useRef(new Set<string>());
  const state = useRef({ t: 0, playing: false });

  const end = Math.max(0, total - 0.001);
  const at = shotAt(shots, Math.min(t, end));
  const index = at?.index ?? -1;
  const shot = shots[index];
  const local = at?.local ?? 0;
  const docs = useMemo(() => new Map(shots.map((s) => [s.id, shotDoc(s, video.size, video.look)])), [shots, video.size, video.look]);
  const cues = useMemo(() => videoCues(shots.map((s) => ({ renderStart: s.start, duration: s.duration, narration: s.narration }))), [shots]);
  const sub = useMemo(() => subtitleLayout(video.size.width, video.size.height, null, video.subtitleLook), [video.size, video.subtitleLook]);

  useEffect(() => {
    state.current = { t, playing };
    if (control?.position && shot) control.position.current = { shotId: shot.id, index, local, t };
  });

  useEffect(() => {
    if (!playing) return;
    const base = performance.now();
    const t0 = state.current.t >= end ? 0 : state.current.t;
    let raf = requestAnimationFrame(function tick(now) {
      const nt = t0 + (now - base) / 1000;
      if (nt >= total) {
        setT(total);
        setPlaying(false);
        return;
      }
      setT(nt);
      raf = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(raf);
  }, [playing, anchor, total, end]);

  const seekTo = (x: number) => {
    const nt = Math.min(Math.max(0, x), total);
    setT(nt);
    setAnchor((n) => n + 1);
    state.current = { ...state.current, t: nt };
  };

  const seekReq = control?.seek;
  useEffect(() => {
    if (!seekReq) return;
    setPlaying(false);
    seekTo(seekReq.t);
    control?.onSeeked?.();
  }, [seekReq?.n]);

  const picking = control?.picking === true;
  useEffect(() => {
    if (picking) setPlaying(false);
  }, [picking]);

  // 画面问题按镜头版本攒着，有新的就报给服务端，分镜和审片都看得到
  const issueKey = (s: VideoShot) => `${s.id}@${s.version}`;
  useEffect(() => {
    for (const s of shots) {
      const mine = issues[issueKey(s)];
      if (!mine?.length) continue;
      const merged = [...new Set([...s.issues, ...mine])].slice(-20);
      if (merged.length === s.issues.length) continue;
      const key = `${issueKey(s)}:${merged.join('\n')}`;
      if (posted.current.has(key)) continue;
      posted.current.add(key);
      void api.shots[':id'].issues
        .$post({ param: { id: s.id }, json: { version: s.version, items: merged } })
        .then(() => qc.invalidateQueries({ queryKey: ['video'] }))
        .catch(() => {});
    }
  }, [issues, shots]);

  const onEvent = (s: VideoShot, e: PlayerEvent) => {
    if (e.type === 'issue') {
      const k = issueKey(s);
      setIssues((prev) => (prev[k]?.includes(e.message) ? prev : { ...prev, [k]: [...(prev[k] ?? []), e.message].slice(-20) }));
    } else if (e.type === 'pick' && picking && s.id === shot?.id) {
      control?.onPick?.({ shotId: s.id, local: e.t, selector: e.selector, anchor: e.anchor, tag: e.tag });
    }
  };

  const layers = shots
    .map((s, i) => ({ s, i }))
    .filter(({ s, i }) => i === index || (i === index - 1 && t < s.end) || (i === index + 1 && t >= s.start - PRELOAD_SECONDS));
  const top = shot;
  const progress = top && top.overlap > 0 && t - top.start < top.overlap ? clamp01((t - top.start) / top.overlap) : 1;
  const styleOf = (i: number): CSSProperties => {
    if (i > index) return { visibility: 'hidden' };
    if (progress >= 1 || !top) return {};
    if (i === index) return top.transition === 'slide' ? { transform: `translateX(${(1 - progress) * 100}%)` } : { opacity: progress };
    return top.transition === 'slide' ? { transform: `translateX(${-progress * 100}%)` } : {};
  };

  const voiceOn = video.voiceOn;
  const bgm = video.bgm;
  const speaking = layers.some(({ s }) => voiceOn && s.audio?.state === 'fresh' && t >= s.start && t - s.start < s.audio.duration);
  const bgmVolume = bgm ? clamp01(bgm.volume * clamp01(Math.min(t / BGM_FADE, (total - t) / BGM_FADE)) * (bgm.ducking && speaking ? DUCK_GAIN : 1)) : 0;
  useEffect(() => {
    if (bgmEl.current) bgmEl.current.volume = bgmVolume;
  });
  useEffect(() => {
    const el = bgmEl.current;
    if (!el) return;
    const d = el.duration;
    const want = Number.isFinite(d) && d > 0 ? state.current.t % d : state.current.t;
    if (Math.abs(el.currentTime - want) > 0.1) el.currentTime = want;
    if (playing) void el.play().catch(() => {});
    else el.pause();
  }, [playing, anchor, bgm?.artifactId]);

  if (!shot) return <Empty title="还没有分镜" icon="film">先写讲解稿并拆分镜，这里才能播放。</Empty>;

  const cue = video.subtitles === 'off' ? undefined : cues.find((c) => t >= c.start && t < c.end) ?? (t >= end ? cues.at(-1) : undefined);
  const shotIssues = [...new Set([...shot.issues, ...(issues[issueKey(shot)] ?? [])])];
  const portrait = video.size.height > video.size.width;
  const markSel = (s: VideoShot) => (control?.mark && control.mark.shotId === s.id ? control.mark.selector : null);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="video-player">
      {bgm ? <audio ref={bgmEl} src={`/api/media/${bgm.artifactId}`} loop preload="auto" data-testid="video-bgm" /> : null}
      <div className={cn('flex min-h-0 flex-1 bg-paper-3 p-4', portrait && 'px-10', picking && 'cursor-crosshair')}>
        <ShotCanvas width={video.size.width} height={video.size.height} className="flex-1">
          {layers.map(({ s, i }) => (
            <Layer
              key={s.id}
              shot={s}
              doc={docs.get(s.id) ?? ''}
              local={Math.min(Math.max(0, t - s.start), s.duration)}
              running={playing && t >= s.start && t < s.end}
              anchor={anchor}
              top={i === index}
              style={styleOf(i)}
              picking={picking}
              mark={markSel(s)}
              voiceOn={voiceOn}
              onEvent={onEvent}
            />
          ))}
          {cue ? (
            <p className="pointer-events-none z-10" style={sub.p as CSSProperties} data-testid="video-subtitle">
              <span style={sub.span as CSSProperties}>{cue.text}</span>
            </p>
          ) : null}
        </ShotCanvas>
      </div>
      <div className="shrink-0 border-t border-rule bg-paper px-4 py-2.5">
        <div className="relative mb-2 flex h-2 overflow-hidden rounded-full bg-paper-3" aria-hidden>
          {shots.map((s, i) => (
            <span key={s.id} className={cn('h-full border-r border-paper', i === index ? 'bg-cool' : i < index ? 'bg-ink-2/40' : 'bg-rule-2', s.placeholder && i !== index && 'bg-accent-soft')} style={{ width: `${total > 0 ? (((shots[i + 1]?.start ?? total) - s.start) / total) * 100 : 0}%` }} title={s.title} />
          ))}
          {(control?.markers ?? []).map((m) => (
            <span key={m.id} className={cn('absolute top-0 h-full w-1 -translate-x-1/2 rounded-full', m.block ? 'bg-bad' : 'bg-accent')} style={{ left: `${total > 0 ? (m.t / total) * 100 : 0}%` }} />
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <Button variant="primary" size="icon-sm" aria-label={playing ? '暂停' : '播放'} disabled={picking} onClick={() => { if (!playing && t >= end) seekTo(0); setPlaying((p) => !p); }} data-testid="video-play">
            <Icon name={playing ? 'pause' : 'play'} />
          </Button>
          <input
            type="range"
            min={0}
            max={total}
            step={0.05}
            value={Math.min(t, total)}
            onChange={(e) => seekTo(Number(e.target.value))}
            aria-label="播放进度"
            className="min-w-40 flex-1 accent-[var(--color-ink)]"
            data-testid="video-seek"
          />
          <span className="text-xs tabular-nums text-muted" data-testid="video-time">{clock(t, true)} / {clock(total, true)}</span>
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-ink-2">
            <span className="tabular-nums text-muted">{index + 1}/{shots.length}</span>
            <span className="max-w-48 truncate" data-testid="video-current-shot">{shot.title || `镜头 ${index + 1}`}</span>
            {shot.placeholder ? <Badge tone="amber">缺画面</Badge> : null}
            {voiceOn && shot.audio?.state === 'fresh' ? <Badge tone="line" title="播放时同步配音">配音</Badge> : null}
            {bgm ? <Badge tone="line" title={bgm.ducking ? '说话时压低' : undefined}>背景音乐</Badge> : null}
            {picking ? <Badge tone="cool" data-testid="video-picking">点画面里的元素</Badge> : null}
            {shotIssues.length ? <Badge tone="bad" title={shotIssues.join('\n')} data-testid="video-issues">{shotIssues.length} 个问题</Badge> : null}
          </span>
        </div>
      </div>
    </div>
  );
}
