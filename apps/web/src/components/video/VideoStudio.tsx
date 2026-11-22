import { renderTimeline, RENDER_FPS, SHOT_MOTIONS, MOTION_LABEL, type ShotMotionKind } from '@aw/domain';
import { useMutation } from '@tanstack/react-query';
import { useMemo, useRef, useState } from 'react';
import { ChatRail } from '@/components/chat/ChatRail';
import { DocMarkdown } from '@/components/docs/Markdown';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogForm } from '@/components/ui/dialog';
import { Empty, Loading, toast } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/icons';
import { Field, Input, Seg, Select, Switch, Textarea } from '@/components/ui/input';
import { api, unwrap } from '@/lib/api';
import { when } from '@/lib/format';
import { useAssets, useMediaSettings, useOverview, useVideo, useVideoRenders, useVideos, type ProjectDetail, type VideoComment, type VideoDetail, type VideoShot, type WorkstationDetail } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { ASPECTS, ASSET_KIND_LABEL, CLIP_STATUS_LABEL, clock, RESOLUTIONS, seconds, STATUS_LABEL, STATUS_TONE, SUBTITLE_LABEL, TRANSITION_LABEL, VISUAL_LABEL, type Aspect, type Resolution } from './model';
import { VideoPlayer, type PlayerControl, type PlayerPosition } from './VideoPlayer';
import { CommentsPane, GateChecklist, gateFor, ReviewPane, type CommentDraft } from './VideoReview';

type Tab = 'script' | 'storyboard' | 'play';
type Lint = VideoDetail['lint'][number];

const DURATION_SOURCE: Record<string, string> = { set: '手动设定', audio: '按配音时长', estimate: '按旁白估算' };
const PLACEHOLDER_RULES = new Set(['html_empty', 'prompt_empty', 'asset_empty']);

function TabButton({ on, onClick, label, count, testId }: { on: boolean; onClick: () => void; label: string; count?: number | undefined; testId: string }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      data-testid={testId}
      className={cn(
        'relative inline-flex h-10 shrink-0 items-center gap-1.5 whitespace-nowrap px-3 text-sm transition-colors duration-150 after:absolute after:inset-x-2.5 after:-bottom-px after:h-0.5 after:rounded-full after:bg-ink',
        on ? 'font-semibold text-ink after:opacity-100' : 'text-muted after:opacity-0 hover:text-ink',
      )}
    >
      {label}{count ? <span className="text-xs tabular-nums opacity-70">{count}</span> : null}
    </button>
  );
}

function LintList({ items, testId }: { items: Lint[]; testId?: string }) {
  if (items.length === 0) return null;
  return (
    <ul className="grid gap-1" data-testid={testId}>
      {items.map((l, i) => (
        <li key={`${l.rule}-${i}`} className="flex items-start gap-1.5 text-xs text-ink-2">
          <Icon name="alert" className={cn('mt-px size-3.5', l.level === 'error' ? 'text-bad' : 'text-accent')} />
          <span>{l.message}</span>
        </li>
      ))}
    </ul>
  );
}

function NewVideoDialog({ wsId, onClose, onCreated }: { wsId: string; onClose: () => void; onCreated: (id: string) => void }) {
  const [title, setTitle] = useState('');
  const [brief, setBrief] = useState('');
  const [audience, setAudience] = useState('');
  const [aspect, setAspect] = useState<Aspect>('16:9');
  const [resolution, setResolution] = useState<Resolution>('1080p');
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: async () => unwrap(await api.workstations[':id'].videos.$post({ param: { id: wsId }, json: { title: title.trim(), brief, audience, aspect, resolution } })),
    meta: { silent: true },
    onSuccess: (r) => onCreated(r.id),
    onError: (e) => setError(e.message),
  });
  return (
    <Dialog title="新建视频" description="先定主题和画幅，讲解稿和分镜交给编导" onClose={onClose} testId="video-new-dialog">
      <DialogForm error={error} submitting={create.isPending} submitLabel="创建" canSubmit={!!title.trim()} onSubmit={() => create.mutate()} onCancel={onClose}>
        <Field label="标题" required>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} data-testid="video-new-title" autoFocus />
        </Field>
        <Field label="要讲什么" hint="一两句话说清主题、要点和希望观众记住什么">
          <Textarea value={brief} onChange={(e) => setBrief(e.target.value)} rows={3} data-testid="video-new-brief" />
        </Field>
        <Field label="给谁看">
          <Input value={audience} onChange={(e) => setAudience(e.target.value)} data-testid="video-new-audience" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="画幅">
            <Select value={aspect} onChange={(e) => setAspect(e.target.value as Aspect)} data-testid="video-new-aspect">
              {ASPECTS.map((a) => <option key={a} value={a}>{a}</option>)}
            </Select>
          </Field>
          <Field label="分辨率">
            <Select value={resolution} onChange={(e) => setResolution(e.target.value as Resolution)} data-testid="video-new-resolution">
              {RESOLUTIONS.map((r) => <option key={r} value={r}>{r}</option>)}
            </Select>
          </Field>
        </div>
      </DialogForm>
    </Dialog>
  );
}

function VideoMetaDialog({ video, onClose, onDeleted }: { video: VideoDetail; onClose: () => void; onDeleted: () => void }) {
  const [title, setTitle] = useState(video.title);
  const [brief, setBrief] = useState(video.brief);
  const [audience, setAudience] = useState(video.audience);
  const [aspect, setAspect] = useState<Aspect>(video.aspect as Aspect);
  const [resolution, setResolution] = useState<Resolution>(video.resolution as Resolution);
  const [fps, setFps] = useState(String(video.fps));
  const [notes, setNotes] = useState(video.notes);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: async () => unwrap(await api.videos[':id'].$patch({ param: { id: video.id }, json: { title: title.trim(), brief, audience, aspect, resolution, fps: Number(fps), notes, baseVersion: video.latestVersion, reason: '人工改视频信息' } })),
    meta: { silent: true },
    onSuccess: onClose,
    onError: (e) => setError(e.message),
  });
  const remove = useMutation({
    mutationFn: async () => unwrap(await api.videos[':id'].$delete({ param: { id: video.id } })),
    meta: { silent: true },
    onSuccess: onDeleted,
    onError: (e) => setError(e.message),
  });
  const fpsOk = Number.isInteger(Number(fps)) && Number(fps) >= 12 && Number(fps) <= 60;
  return (
    <Dialog title="视频信息" onClose={onClose} testId="video-meta-dialog">
      <DialogForm error={error} submitting={save.isPending} submitLabel="保存" canSubmit={!!title.trim() && fpsOk} onSubmit={() => save.mutate()} onCancel={onClose}>
        <Field label="标题" required>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} data-testid="video-meta-title" />
        </Field>
        <Field label="要讲什么">
          <Textarea value={brief} onChange={(e) => setBrief(e.target.value)} rows={3} />
        </Field>
        <Field label="给谁看">
          <Input value={audience} onChange={(e) => setAudience(e.target.value)} />
        </Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label="画幅">
            <Select value={aspect} onChange={(e) => setAspect(e.target.value as Aspect)} data-testid="video-meta-aspect">
              {ASPECTS.map((a) => <option key={a} value={a}>{a}</option>)}
            </Select>
          </Field>
          <Field label="分辨率">
            <Select value={resolution} onChange={(e) => setResolution(e.target.value as Resolution)}>
              {RESOLUTIONS.map((r) => <option key={r} value={r}>{r}</option>)}
            </Select>
          </Field>
          <Field label="帧率">
            <Input type="number" min={12} max={60} value={fps} onChange={(e) => setFps(e.target.value)} />
          </Field>
        </div>
        <Field label="备注">
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
        </Field>
        <div className="flex flex-wrap items-center gap-2 border-t border-rule pt-3">
          {confirm ? (
            <>
              <span className="text-sm text-bad">删除视频和全部镜头，不能恢复</span>
              <Button size="sm" variant="danger-solid" className="ml-auto" disabled={remove.isPending} onClick={() => remove.mutate()} data-testid="video-delete-confirm">确认删除</Button>
              <Button size="sm" variant="quiet" onClick={() => setConfirm(false)}>算了</Button>
            </>
          ) : (
            <Button size="sm" variant="danger" onClick={() => setConfirm(true)} data-testid="video-delete">
              <Icon name="trash" />删除视频
            </Button>
          )}
        </div>
      </DialogForm>
    </Dialog>
  );
}

function VoiceDialog({ video, onClose }: { video: VideoDetail; onClose: () => void }) {
  const media = useMediaSettings();
  const pref = video.voicePref;
  const [provider, setProvider] = useState(pref?.provider ?? '');
  const [voice, setVoice] = useState(pref?.voice ?? '');
  const [speed, setSpeed] = useState(String(pref?.speed ?? 1));
  const [force, setForce] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const speedNum = Number(speed);
  const speedOk = Number.isFinite(speedNum) && speedNum >= 0.25 && speedNum <= 4;
  const narrated = video.shots.filter((s) => s.narration.trim());
  const fresh = narrated.filter((s) => s.audio?.state === 'fresh').length;
  const run = useMutation({
    mutationFn: async () => {
      const next = { ...(provider ? { provider } : {}), ...(voice.trim() ? { voice: voice.trim() } : {}), speed: speedNum };
      if (JSON.stringify(next) !== JSON.stringify({ ...(pref?.provider ? { provider: pref.provider } : {}), ...(pref?.voice ? { voice: pref.voice } : {}), speed: pref?.speed ?? 1 })) {
        unwrap(await api.videos[':id'].$patch({ param: { id: video.id }, json: { voice: next, baseVersion: video.latestVersion, reason: '改配音设置' } }));
      }
      return unwrap(await api.videos[':id'].voice.$post({ param: { id: video.id }, json: { force } }));
    },
    meta: { silent: true },
    onSuccess: (r) => {
      toast(`配音完成：生成 ${r.voiced.length} 段，跳过 ${r.skipped.length} 段${r.costMicros ? ` · ${(r.costMicros / 1e6).toFixed(4)}` : ''}`, 'ok');
      onClose();
    },
    onError: (e) => setError(e.message),
  });
  const providers = media.data?.providers ?? [];
  const resolved = 'error' in video.voice ? null : video.voice;
  return (
    <Dialog title="生成配音" description={`按旁白合成，${narrated.length} 个镜头有旁白，${fresh} 个已有最新配音`} onClose={onClose} testId="video-voice-dialog">
      <DialogForm error={error ?? ('error' in video.voice && !providers.length ? video.voice.error : null)} submitting={run.isPending} submitLabel={force ? '全部重新生成' : '生成配音'} canSubmit={speedOk && narrated.length > 0 && providers.length > 0} onSubmit={() => run.mutate()} onCancel={onClose}>
        <div className="grid grid-cols-3 gap-3">
          <Field label="配音服务" hint={resolved ? `当前：${resolved.provider}` : undefined}>
            <Select value={provider} onChange={(e) => setProvider(e.target.value)} data-testid="video-voice-provider">
              <option value="">默认{media.data?.default ? `（${media.data.default}）` : ''}</option>
              {providers.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
            </Select>
          </Field>
          <Field label="音色" hint={resolved ? `当前：${resolved.voice}` : undefined}>
            <Input value={voice} onChange={(e) => setVoice(e.target.value)} placeholder="留空用服务默认" data-testid="video-voice-voice" />
          </Field>
          <Field label="语速">
            <Input type="number" min={0.25} max={4} step={0.05} value={speed} onChange={(e) => setSpeed(e.target.value)} data-testid="video-voice-speed" />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-sm text-ink-2">
          <Switch checked={force} onChange={setForce} aria-label="全部重新生成" data-testid="video-voice-force" />
          旁白没变的也重新生成
        </label>
        <p className="text-xs text-muted">每段配音都会计入预算。没设时长的镜头，时长会变成配音时长加 0.3 秒。</p>
      </DialogForm>
    </Dialog>
  );
}

const FPS_OPTIONS = RENDER_FPS.map((f) => ({ value: String(f) as `${number}`, label: `${f}` }));
const SUB_OPTIONS = (['burn', 'srt', 'off'] as const).map((v) => ({ value: v, label: SUBTITLE_LABEL[v]! }));

function RenderDialog({ video, onClose }: { video: VideoDetail; onClose: () => void }) {
  const [fps, setFps] = useState<`${number}`>(String((RENDER_FPS as readonly number[]).includes(video.fps) ? video.fps : 30) as `${number}`);
  const [subtitles, setSubtitles] = useState<'burn' | 'srt' | 'off'>(video.subtitles as 'burn' | 'srt' | 'off');
  const [allow, setAllow] = useState(false);
  const [override, setOverride] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const placeholders = video.shots.filter((s) => s.placeholder).length;
  const blocking = video.lint.filter((l) => l.level === 'error' && !(allow && PLACEHOLDER_RULES.has(l.rule)));
  const warnings = video.lint.filter((l) => !blocking.includes(l));
  const tl = useMemo(() => renderTimeline(video.shots, Number(fps)), [video.shots, fps]);
  const voiced = video.voiceOn ? video.shots.filter((s) => s.audio?.state === 'fresh').length : 0;
  const gate = gateFor(video, allow);
  // 检查错误不能越过（服务端同样拒绝），能越过的只有审片 / 阻断评论 / 配音
  const soft = gate.checks.filter((c) => !c.ok && c.id !== 'lint');
  const overriding = soft.length > 0 && override;
  const start = useMutation({
    mutationFn: async () => unwrap(await api.videos[':id'].renders.$post({ param: { id: video.id }, json: { fps: Number(fps), subtitles, allowPlaceholders: allow, ...(overriding ? { override: reason.trim() } : {}) } })),
    meta: { silent: true },
    onSuccess: () => {
      toast(overriding ? '已越过门禁开始出片，原因已记录并发到大群' : '已开始出片，在左侧「成片」看进度', 'ok');
      onClose();
    },
    onError: (e) => setError(e.message),
  });
  const canSubmit = blocking.length === 0 && video.shots.length > 0 && (soft.length === 0 || (override && !!reason.trim()));
  return (
    <Dialog title="出片" description={`${video.size.width}×${video.size.height} · ${video.shots.length} 个镜头 · ${video.voiceOn ? `配音 ${voiced} 段` : '不配音'}${video.bgm ? ' · 背景音乐' : ''}`} onClose={onClose} testId="video-render-dialog">
      <DialogForm error={error} submitting={start.isPending} submitLabel={overriding ? '越过门禁出片' : '开始出片'} canSubmit={canSubmit} onSubmit={() => start.mutate()} onCancel={onClose}>
        <Field label="帧率">
          <Seg value={fps} options={FPS_OPTIONS} onChange={setFps} size="sm" label="帧率" />
        </Field>
        <Field label="字幕" hint="不管选哪种，都会另存一份 .srt">
          <Seg value={subtitles} options={SUB_OPTIONS} onChange={setSubtitles} size="sm" label="字幕" />
        </Field>
        {placeholders ? (
          <label className="flex items-center gap-2 text-sm text-ink-2">
            <Switch checked={allow} onChange={setAllow} aria-label="用占位画面出片" data-testid="video-render-allow-placeholders" />
            {placeholders} 个镜头缺画面，先用占位画面出片
          </label>
        ) : null}
        <p className="text-xs tabular-nums text-muted" data-testid="video-render-total">
          成片 {clock(tl.total, true)}（和预览同一条时间线，淡入 / 滑入两镜头交叠）
        </p>
        <div className="grid gap-2 rounded-ctl border border-rule bg-paper-2 px-3 py-2.5">
          <span className="flex items-center gap-1.5 text-sm font-semibold text-ink">
            出片门禁{gate.ok ? <Badge tone="ok">全部通过</Badge> : <Badge tone="amber">{gate.checks.filter((c) => !c.ok).length} 项没通过</Badge>}
          </span>
          <GateChecklist checks={gate.checks} testId="video-render-gate" />
          {soft.length ? (
            <div className="grid gap-2 border-t border-rule pt-2">
              <label className="flex items-center gap-2 text-sm text-ink-2">
                <Switch checked={override} onChange={setOverride} aria-label="越过门禁出片" data-testid="video-render-override" />
                人工越过门禁出片（原因会记录，并发到大群）
              </label>
              {override ? (
                <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="为什么现在就要出片" maxLength={500} data-testid="video-render-override-reason" autoFocus />
              ) : null}
            </div>
          ) : null}
        </div>
        {blocking.length ? <LintList items={blocking} testId="video-render-blocking" /> : null}
        {warnings.length ? <LintList items={warnings} testId="video-render-lint" /> : null}
      </DialogForm>
    </Dialog>
  );
}

function ScriptPane({ video }: { video: VideoDetail }) {
  const [mode, setMode] = useState<'preview' | 'edit'>('preview');
  const [draft, setDraft] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: async (script: string) => unwrap(await api.videos[':id'].script.$put({ param: { id: video.id }, json: { script, baseVersion: video.latestVersion, reason: '人工改讲解稿' } })),
    onSuccess: () => setDraft(null),
  });
  const dirty = draft !== null && draft !== video.script;
  const scriptLint = video.lint.filter((l) => !l.shotId);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="video-script">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-rule bg-paper px-4 py-2">
        <div className="inline-flex gap-0.5 rounded-btn bg-paper-3 p-[3px]">
          {(['preview', 'edit'] as const).map((m) => (
            <button key={m} type="button" aria-pressed={mode === m} data-testid={`video-script-mode-${m}`} onClick={() => setMode(m)} className={cn('h-[22px] rounded-btn px-2.5 text-xs transition-colors duration-150', mode === m ? 'bg-primary font-semibold text-primary-ink' : 'text-muted hover:text-ink')}>
              {m === 'preview' ? '预览' : '编辑'}
            </button>
          ))}
        </div>
        {video.brief ? <span className="min-w-0 flex-1 truncate text-xs text-muted" title={video.brief}>{video.brief}</span> : null}
        {mode === 'edit' ? (
          <Button variant="primary" size="sm" className="ml-auto" disabled={!dirty || save.isPending} onClick={() => draft !== null && save.mutate(draft)} data-testid="video-script-save">
            保存
          </Button>
        ) : null}
      </div>
      {mode === 'edit' ? (
        <Textarea
          value={draft ?? video.script}
          onChange={(e) => setDraft(e.target.value)}
          aria-label="讲解稿（Markdown）"
          spellCheck={false}
          className="min-h-0 flex-1 resize-none rounded-none border-0 bg-paper px-5 py-4 font-mono text-[13px] leading-[1.7] hover:border-0 focus-visible:bg-paper focus-visible:shadow-[inset_0_0_0_2px_var(--color-focus)]"
          data-testid="video-script-editor"
        />
      ) : video.script.trim() ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-10 pt-6 md:px-10" data-testid="video-script-preview">
          <DocMarkdown content={video.script} />
        </div>
      ) : (
        <Empty title="还没有讲解稿" icon="doc">在右边点「请编导写稿」，或切到编辑自己写。</Empty>
      )}
      {scriptLint.length ? <div className="shrink-0 border-t border-rule bg-paper-2 px-4 py-2"><LintList items={scriptLint} /></div> : null}
    </div>
  );
}

function ShotDialog({ shot, videoId, wsId, onClose }: { shot: VideoShot; videoId: string; wsId: string; onClose: () => void }) {
  const [title, setTitle] = useState(shot.title);
  const [narration, setNarration] = useState(shot.narration);
  const [duration, setDuration] = useState(shot.durationSet === null ? '' : String(shot.durationSet));
  const [transition, setTransition] = useState(shot.transition as 'cut' | 'fade' | 'slide');
  const [visual, setVisual] = useState(shot.visual as 'html' | 'generated' | 'asset');
  const prompt = shot.prompt;
  const [asset, setAsset] = useState(shot.asset);
  const [motion, setMotion] = useState<ShotMotionKind>((shot.motion ?? 'none') as ShotMotionKind);
  const [keepAudio, setKeepAudio] = useState(shot.keepAudio);
  const [status, setStatus] = useState(shot.status as 'draft' | 'ready');
  const [html, setHtml] = useState(shot.html ?? '');
  const [clipPrompt, setClipPrompt] = useState(shot.prompt);
  const [clipDuration, setClipDuration] = useState('');
  const [pending, setPending] = useState<{ id: string; cost: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const assets = useAssets(wsId);
  const pickable = (assets.data?.assets ?? []).filter((a) => a.kind !== 'audio');
  const dur = duration.trim() ? Number(duration) : null;
  const durOk = dur === null || (Number.isFinite(dur) && dur > 0 && dur <= 120);
  const save = useMutation({
    mutationFn: async () =>
      unwrap(
        await api.shots[':id'].$patch({
          param: { id: shot.id },
          json: { title, narration, duration: dur, transition, visual, prompt, asset, motion, keepAudio, status, ...(html !== (shot.html ?? '') ? { html } : {}), baseVersion: shot.version, reason: '人工改镜头' },
        }),
      ),
    meta: { silent: true },
    onSuccess: onClose,
    onError: (e) => setError(e.message),
  });
  // 人自己点「生成片段」：先建申请拿到预估花费，确认后再批准（等于自己批自己）
  const createClip = useMutation({
    mutationFn: async () =>
      unwrap(
        await api.videos[':id']['clip-requests'].$post({
          param: { id: videoId },
          json: { shotId: shot.id, prompt: clipPrompt.trim(), ...(Number(clipDuration) > 0 ? { duration: Number(clipDuration) } : {}), ...(asset && visual !== 'html' ? { image: asset } : {}) },
        }),
      ),
    meta: { silent: true },
    onSuccess: (r) => setPending({ id: r.id, cost: r.estimatedCostMicros }),
    onError: (e) => setError(e.message),
  });
  const confirmClip = useMutation({
    mutationFn: async (input: { id: string; decision: 'approve' | 'reject' }) => unwrap(await api['clip-requests'][':id'].decide.$post({ param: { id: input.id }, json: { decision: input.decision } })),
    meta: { silent: true },
    onSuccess: (r) => {
      setPending(null);
      toast(r.status === 'rejected' ? '已取消这次申请' : '已批准，开始生成片段；好了会自动接到镜头上', 'ok');
    },
    onError: (e) => setError(e.message),
  });
  return (
    <Dialog title={`镜头 ${shot.order}`} onClose={onClose} className="w-[44rem]" testId="video-shot-dialog">
      <DialogForm error={error} submitting={save.isPending} submitLabel="保存" canSubmit={durOk} onSubmit={() => save.mutate()} onCancel={onClose}>
        <Field label="要表达什么">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} data-testid="video-shot-title" />
        </Field>
        <Field label="旁白" hint="字幕和配音都从这里来">
          <Textarea value={narration} onChange={(e) => setNarration(e.target.value)} rows={3} data-testid="video-shot-narration" />
        </Field>
        {shot.audio ? (
          <div className="flex flex-wrap items-center gap-2">
            <audio controls preload="none" src={`/api/media/${shot.audio.artifactId}`} className="h-8 min-w-0 flex-1" data-testid="video-shot-audio-player" />
            <Badge tone={shot.audio.state === 'fresh' ? 'ok' : 'amber'}>{shot.audio.state === 'fresh' ? `配音 ${seconds(shot.audio.duration)}` : '旁白或音色改过，配音过期'}</Badge>
          </div>
        ) : null}
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Field label="时长（秒）" hint="留空按旁白估算">
            <Input type="number" min={0.5} max={120} step={0.5} value={duration} onChange={(e) => setDuration(e.target.value)} placeholder={String(shot.duration)} data-testid="video-shot-duration" />
          </Field>
          <Field label="转场">
            <Select value={transition} onChange={(e) => setTransition(e.target.value as typeof transition)}>
              {Object.entries(TRANSITION_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </Select>
          </Field>
          <Field label="画面类型">
            <Select value={visual} onChange={(e) => setVisual(e.target.value as typeof visual)}>
              {Object.entries(VISUAL_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </Select>
          </Field>
          <Field label="状态">
            <Select value={status} onChange={(e) => setStatus(e.target.value as typeof status)} data-testid="video-shot-status">
              <option value="draft">草稿</option>
              <option value="ready">画面已确认</option>
            </Select>
          </Field>
        </div>
        {visual !== 'html' ? (
          <>
            <div className="grid grid-cols-2 gap-3">
              <Field label="素材" hint="图片或片段，没有合适的就提交生成申请">
                <Select value={asset} onChange={(e) => setAsset(e.target.value)} data-testid="video-shot-asset">
                  <option value="">（还没选）</option>
                  {pickable.map((a) => (
                    <option key={a.id} value={a.id}>{a.name}（{ASSET_KIND_LABEL[a.kind] ?? a.kind}）</option>
                  ))}
                </Select>
              </Field>
              <Field label="画面运动" hint="图片镜头的推拉摇移">
                <Select value={motion} onChange={(e) => setMotion(e.target.value as ShotMotionKind)} data-testid="video-shot-motion">
                  {SHOT_MOTIONS.map((m) => <option key={m} value={m}>{MOTION_LABEL[m]}</option>)}
                </Select>
              </Field>
            </div>
            <label className="flex items-center gap-2 text-sm text-ink-2">
              <Switch checked={keepAudio} onChange={setKeepAudio} aria-label="保留原声" data-testid="video-shot-keep-audio" />
              片段自带的声音进成片（默认丢掉）
            </label>
            <Field label="叠加画面 HTML" hint="可选：透明底的一层，叠在素材上（文字、箭头、标注）；时间 0 是镜头开始">
              <Textarea value={html} onChange={(e) => setHtml(e.target.value)} rows={6} spellCheck={false} className="font-mono text-xs" data-testid="video-shot-overlay" />
            </Field>
            <div className="grid gap-2 rounded-ctl border border-rule bg-paper-2 px-3 py-2.5" data-testid="video-clip-form">
              <span className="text-sm font-semibold text-ink">生成片段</span>
              <p className="text-xs text-muted">写提示词提交申请，人批了平台才去生成并记预算；成功后自动接到这个镜头上。</p>
              <Field label="提示词" hint="谁 / 在哪 / 做什么 + 景别机位光线 + 风格">
                <Textarea value={clipPrompt} onChange={(e) => setClipPrompt(e.target.value)} rows={2} data-testid="video-clip-prompt" />
              </Field>
              <span className="flex items-end gap-2">
                <Field label="时长（秒）" hint={`镜头 ${seconds(shot.duration)}`}>
                  <Input type="number" min={1} max={20} step={0.5} value={clipDuration} onChange={(e) => setClipDuration(e.target.value)} placeholder={String(shot.duration)} className="w-24" data-testid="video-clip-duration" />
                </Field>
                <Button size="sm" disabled={!clipPrompt.trim() || createClip.isPending} onClick={() => createClip.mutate()} data-testid="video-clip-request">提交申请</Button>
              </span>
              {shot.clip ? (
                <p className="text-xs text-muted" data-testid="video-shot-clip">
                  最近一次申请：{CLIP_STATUS_LABEL[shot.clip.status] ?? shot.clip.status}
                  {shot.clip.error ? ` · ${shot.clip.error}` : ''}
                  {shot.clip.estimatedCostMicros ? ` · 预估 $${(shot.clip.estimatedCostMicros / 1e6).toFixed(3)}` : ''}
                </p>
              ) : null}
            </div>
          </>
        ) : null}
        {visual === 'html' ? (
          <Field label="画面 HTML" hint="动画师写的完整文档；画布尺寸等于视频分辨率，时间 0 是镜头开始">
            <Textarea value={html} onChange={(e) => setHtml(e.target.value)} rows={8} spellCheck={false} className="font-mono text-xs" data-testid="video-shot-html" />
          </Field>
        ) : null}
      </DialogForm>
      {pending ? (
        <Dialog title="确认生成片段" description={`预估花费 $${(pending.cost / 1e6).toFixed(3)}，按实际时长记账`} onClose={() => confirmClip.mutate({ id: pending.id, decision: 'reject' })} testId="video-clip-confirm">
          <DialogForm error={null} submitting={confirmClip.isPending} submitLabel="确认生成" onSubmit={() => confirmClip.mutate({ id: pending.id, decision: 'approve' })} onCancel={() => confirmClip.mutate({ id: pending.id, decision: 'reject' })}>
            <p className="text-sm text-ink-2">这笔花费会计入本台预算，生成好之前这个镜头一直缺素材。</p>
          </DialogForm>
        </Dialog>
      ) : null}
    </Dialog>
  );
}

function StoryboardPane({ video, wsId, selected, onSelect, control }: { video: VideoDetail; wsId: string; selected: string | null; onSelect: (id: string | null) => void; control: PlayerControl }) {
  const [editing, setEditing] = useState<string | null>(null);
  const shots = video.shots;
  const board = useMutation({
    mutationFn: async (input: { shots: { id?: string; title?: string }[]; reason: string }) => unwrap(await api.videos[':id'].storyboard.$put({ param: { id: video.id }, json: input })),
  });
  const reorder = useMutation({
    mutationFn: async (ids: string[]) => unwrap(await api.videos[':id'].reorder.$post({ param: { id: video.id }, json: { ids } })),
  });
  const busy = board.isPending || reorder.isPending;
  const move = (i: number, d: -1 | 1) => {
    const ids = shots.map((s) => s.id);
    const j = i + d;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    reorder.mutate(ids);
  };
  const remove = (id: string) => {
    if (selected === id) onSelect(null);
    board.mutate({ shots: shots.filter((s) => s.id !== id).map((s) => ({ id: s.id })), reason: '人工删镜头' });
  };
  const add = () => board.mutate({ shots: [...shots.map((s) => ({ id: s.id })), { title: `镜头 ${shots.length + 1}` }], reason: '人工加镜头' });
  const current = shots.find((s) => s.id === selected) ?? shots[0];
  // 单镜头试播：从镜头自己的 0 秒开始，不带转场交叠和背景音乐
  const single = useMemo(() => (current ? { ...video, shots: [{ ...current, start: 0, end: current.duration, overlap: 0, renderStart: 0, renderEnd: current.duration }], total: current.duration, bgm: null } : null), [video, current]);
  const videoLint = video.lint.filter((l) => !l.shotId);
  const editShot = shots.find((s) => s.id === editing);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 max-lg:flex-col" data-testid="video-storyboard">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col lg:max-w-[28rem] lg:border-r lg:border-rule">
        <div className="flex shrink-0 items-center gap-2 border-b border-rule bg-paper px-4 py-2">
          <span className="text-sm font-semibold text-ink">{shots.length} 个镜头</span>
          <span className="text-xs tabular-nums text-muted" title="和成片同一条时间线（转场交叠已扣掉）">共 {clock(video.total, true)}</span>
          <Button size="sm" className="ml-auto" disabled={busy} onClick={add} data-testid="video-shot-add"><Icon name="plus" />加镜头</Button>
        </div>
        {videoLint.length ? <div className="shrink-0 border-b border-rule bg-paper-2 px-4 py-2"><LintList items={videoLint} testId="video-lint" /></div> : null}
        <ol className="min-h-0 flex-1 overflow-y-auto p-3" aria-label="分镜">
          {shots.length === 0 ? <li className="px-1 py-2 text-sm text-muted">还没有分镜。写好讲解稿后点「请编导拆分镜」。</li> : null}
          {shots.map((s, i) => {
            const lint = video.lint.filter((l) => l.shotId === s.id);
            const on = current?.id === s.id;
            return (
              <li key={s.id} className="mb-2" data-testid={`video-shot-${i + 1}`}>
                <div className={cn('grid gap-1.5 rounded-ctl border bg-paper px-3 py-2.5 transition-colors duration-150', on ? 'border-ink' : 'border-rule hover:bg-paper-2')}>
                  <button type="button" onClick={() => onSelect(s.id)} className="grid gap-1 text-left" data-testid={`video-shot-open-${i + 1}`}>
                    <span className="flex items-center gap-2">
                      <span className="text-xs tabular-nums text-muted">{i + 1}</span>
                      <span className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{s.title || `镜头 ${i + 1}`}</span>
                      <span className="text-xs tabular-nums text-muted" title={`${DURATION_SOURCE[s.durationSource] ?? ''} · 成片 ${clock(s.start, true)}–${clock(s.end, true)}`}>{s.estimated ? '≈' : ''}{seconds(s.duration)}</span>
                    </span>
                    {s.narration ? <span className="line-clamp-2 text-xs text-ink-2">{s.narration}</span> : null}
                  </button>
                  <span className="flex flex-wrap items-center gap-1.5">
                    <Badge tone="line">{TRANSITION_LABEL[s.transition] ?? s.transition}</Badge>
                    {s.placeholder ? <Badge tone="amber" data-testid="video-shot-missing">缺画面</Badge> : <Badge tone="neutral">{VISUAL_LABEL[s.visual] ?? s.visual}</Badge>}
                    {s.clip && (s.clip.status === 'pending' || s.clip.status === 'running' || s.clip.status === 'approved') ? (
                      <Badge tone="amber" title={s.clip.prompt} data-testid="video-shot-clip-status">{CLIP_STATUS_LABEL[s.clip.status] ?? s.clip.status}</Badge>
                    ) : null}
                    {s.motion && s.motion !== 'none' ? <Badge tone="line">{MOTION_LABEL[s.motion as ShotMotionKind] ?? s.motion}</Badge> : null}
                    {s.status === 'ready' ? <Badge tone="ok">已确认</Badge> : null}
                    {s.audio?.state === 'fresh' ? <Badge tone="ok" data-testid="video-shot-audio">配音 {seconds(s.audio.duration)}</Badge> : s.audio ? <Badge tone="amber" data-testid="video-shot-audio-stale">配音过期</Badge> : null}
                    {s.issues.length ? <Badge tone="bad" title={s.issues.join('\n')} data-testid="video-shot-issues"><Icon name="alert" />画面问题 {s.issues.length}</Badge> : null}
                    {s.comments.open ? <Badge tone={s.comments.block ? 'bad' : 'amber'} title={s.comments.block ? `${s.comments.block} 条阻断` : undefined} data-testid="video-shot-comments"><Icon name="comment" />{s.comments.open}</Badge> : null}
                    <span className="ml-auto flex items-center">
                      <Button variant="quiet" size="icon-sm" aria-label="上移" disabled={busy || i === 0} onClick={() => move(i, -1)} data-testid={`video-shot-up-${i + 1}`}><Icon name="chev" className="rotate-180" /></Button>
                      <Button variant="quiet" size="icon-sm" aria-label="下移" disabled={busy || i === shots.length - 1} onClick={() => move(i, 1)} data-testid={`video-shot-down-${i + 1}`}><Icon name="chev" /></Button>
                      <Button variant="quiet" size="icon-sm" aria-label="编辑镜头" onClick={() => setEditing(s.id)} data-testid={`video-shot-edit-${i + 1}`}><Icon name="edit" /></Button>
                      <Button variant="quiet" size="icon-sm" aria-label="删除镜头" disabled={busy} onClick={() => remove(s.id)} data-testid={`video-shot-delete-${i + 1}`}><Icon name="trash" /></Button>
                    </span>
                  </span>
                  {lint.length ? <LintList items={lint} /> : null}
                </div>
              </li>
            );
          })}
        </ol>
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col max-lg:min-h-[22rem]">
        {single && current ? <VideoPlayer key={`${current.id}-${current.version}`} video={single} control={{ ...control, markers: undefined }} /> : <Empty title="选一个镜头看画面" icon="film" />}
      </div>
      {editShot ? <ShotDialog key={`${editShot.id}-${editShot.version}`} shot={editShot} videoId={video.id} wsId={wsId} onClose={() => setEditing(null)} /> : null}
    </div>
  );
}

type RailTab = 'chat' | 'comments' | 'review';

function VideoEditor({ ws, project, id, running, onBack }: { ws: WorkstationDetail; project: ProjectDetail; id: string; running: boolean; onBack: () => void }) {
  const videoQ = useVideo(id);
  const names = useMemo(() => Object.fromEntries(project.agents.map((a) => [a.id, a.name])), [project.agents]);
  const [tab, setTab] = useState<Tab>('script');
  const [selected, setSelected] = useState<string | null>(null);
  const [metaOpen, setMetaOpen] = useState(false);
  const [dialog, setDialog] = useState<'voice' | 'render' | null>(null);
  const renders = useVideoRenders(ws.id);
  const [railOpen, setRailOpen] = useState(() => window.innerWidth >= 768);
  const [railKey, setRailKey] = useState(0);
  const [railTab, setRailTab] = useState<RailTab>('chat');
  const position = useRef<PlayerPosition | null>(null);
  const [seek, setSeek] = useState<{ t: number; n: number } | null>(null);
  const [mark, setMark] = useState<{ shotId: string; selector: string | null } | null>(null);
  const [picking, setPicking] = useState(false);
  const [draft, setDraft] = useState<CommentDraft | null>(null);
  const toChat = () => {
    setRailKey((k) => k + 1);
    setRailTab('chat');
    setRailOpen(true);
  };
  const ask = useMutation({
    mutationFn: async (who: 'director' | 'motion') => unwrap(await api.videos[':id'].ask.$post({ param: { id }, json: { who } })),
    onSuccess: toChat,
  });
  const review = useMutation({
    mutationFn: async () => unwrap(await api.videos[':id']['request-review'].$post({ param: { id }, json: {} })),
    onSuccess: () => {
      toast('已请审片，结论和评论会回到这里', 'ok');
      toChat();
    },
  });
  const reviewer = ws.agents.find((a) => a.templateId === 'video-reviewer' && a.status === 'active');
  const video = videoQ.data;
  if (!video) return videoQ.isError ? <Empty title="视频加载失败" /> : <Loading className="flex-1" />;
  const missing = video.shots.filter((s) => s.placeholder).length;
  const errors = video.lint.filter((l) => l.level === 'error').length;
  const hasScript = !!video.script.trim();
  const rendering = renders.data?.renders.find((r) => r.videoId === video.id && (r.status === 'queued' || r.status === 'running'));
  const startOf = (shotId: string) => video.shots.find((s) => s.id === shotId)?.start ?? 0;

  const onDraft = (d: CommentDraft | null) => {
    setDraft(d);
    if (!d?.selector) setMark(null);
  };
  const control: PlayerControl = {
    seek,
    onSeeked: () => setSeek(null),
    picking,
    mark,
    position,
    onPick: (p) => {
      setPicking(false);
      setDraft({ shotId: p.shotId, local: p.local, selector: p.selector, anchor: p.anchor, tag: p.tag });
      setMark({ shotId: p.shotId, selector: p.selector });
    },
    markers: video.openComments.map((c) => ({ id: c.id, t: startOf(c.shot) + c.time, block: c.severity === 'block' })),
  };
  const openComment = (c: VideoComment) => {
    if (!video.shots.some((s) => s.id === c.shot)) return;
    setPicking(false);
    setTab('play');
    setSeek({ t: startOf(c.shot) + c.time, n: Date.now() });
    setMark({ shotId: c.shot, selector: c.selector ?? null });
  };
  const canLocate = (tab === 'play' || tab === 'storyboard') && video.shots.length > 0;
  const reviewTitle = !reviewer ? '本台没有审片成员（在成员里加一个「审片」）' : video.status === 'reviewing' ? '正在审片' : video.reviewFresh && video.review?.verdict === 'pass' ? '已经审过，内容没再改' : undefined;

  return (
    <div className="flex min-h-0 min-w-0 flex-1" data-testid="video-editor">
      <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-paper">
        <header className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-rule bg-paper px-4 py-2.5">
          <Button variant="quiet" size="sm" onClick={onBack} title="回到视频列表" data-testid="video-back">
            <Icon name="chev-l" />全部
          </Button>
          <div className="flex min-w-0 flex-[1_1_16rem] flex-wrap items-center gap-2">
            <h1 className="min-w-0 truncate text-title font-bold text-ink" data-testid="video-title">{video.title}</h1>
            <Badge tone={STATUS_TONE[video.status] ?? 'neutral'} data-testid="video-status">{STATUS_LABEL[video.status] ?? video.status}</Badge>
            <Badge tone="line">{video.aspect} · {video.resolution} · {video.fps}fps</Badge>
            <span className="text-xs tabular-nums text-muted" data-testid="video-total">{clock(video.total, true)}</span>
            {running ? <Badge tone="cool">成员在动</Badge> : null}
            {rendering ? <Badge tone="cool" data-testid="video-rendering">出片中 {Math.round(rendering.progress * 100)}%</Badge> : null}
          </div>
          <div className="ml-auto flex shrink-0 flex-wrap items-center gap-1">
            <Button size="sm" disabled={!reviewer || video.shots.length === 0 || video.status === 'reviewing' || review.isPending} title={reviewTitle} onClick={() => review.mutate()} data-testid="video-request-review"><Icon name="eye" />请求审片</Button>
            <Button size="sm" disabled={video.shots.length === 0} onClick={() => setDialog('voice')} data-testid="video-voice"><Icon name="wave" />生成配音</Button>
            <Button size="sm" variant="primary" disabled={video.shots.length === 0 || !!rendering} onClick={() => setDialog('render')} data-testid="video-render"><Icon name="film" />出片</Button>
            <Button variant="quiet" size="icon-sm" onClick={() => setMetaOpen(true)} title="视频信息" aria-label="视频信息" data-testid="video-meta">
              <Icon name="sliders" />
            </Button>
            <Button variant="quiet" size="icon-sm" aria-label={railOpen ? '收起侧栏' : '展开侧栏'} onClick={() => setRailOpen((v) => !v)} data-testid="video-rail-toggle">
              <Icon name={railOpen ? 'chev-r' : 'chev-l'} />
            </Button>
          </div>
        </header>
        <div className="flex shrink-0 items-end gap-1 overflow-x-auto border-b border-rule bg-paper px-2 [scrollbar-width:none]">
          <TabButton on={tab === 'script'} onClick={() => setTab('script')} label="讲解稿" testId="video-tab-script" />
          <TabButton on={tab === 'storyboard'} onClick={() => setTab('storyboard')} label="分镜" count={video.shots.length} testId="video-tab-storyboard" />
          <TabButton on={tab === 'play'} onClick={() => setTab('play')} label="预览" testId="video-tab-play" />
          {missing ? <span className="mb-2.5 ml-auto mr-2 text-xs text-accent" data-testid="video-missing">{missing} 个镜头缺画面</span> : errors ? <span className="mb-2.5 ml-auto mr-2 text-xs text-bad">{errors} 个问题</span> : null}
        </div>
        {tab === 'script' ? <ScriptPane key={video.id} video={video} /> : null}
        {tab === 'storyboard' ? <StoryboardPane video={video} wsId={ws.id} selected={selected} onSelect={setSelected} control={control} /> : null}
        {tab === 'play' ? <VideoPlayer video={video} control={control} /> : null}
      </section>
      {railOpen ? (
        <aside className="flex w-[340px] shrink-0 flex-col border-l border-rule bg-paper" data-testid="video-rail">
          <div className="flex shrink-0 items-end gap-1 border-b border-rule px-1">
            <TabButton on={railTab === 'chat'} onClick={() => setRailTab('chat')} label="对话" testId="video-rail-tab-chat" />
            <TabButton on={railTab === 'comments'} onClick={() => setRailTab('comments')} label="评论" count={video.openComments.length} testId="video-rail-tab-comments" />
            <TabButton on={railTab === 'review'} onClick={() => setRailTab('review')} label="审片" testId="video-rail-tab-review" />
            {!video.gate.ok ? <span className="mb-2.5 ml-auto mr-2 text-xs text-accent" title={video.gate.reasons.join('\n')}>门禁 {video.gate.checks.filter((c) => !c.ok).length} 项未过</span> : <span className="mb-2.5 ml-auto mr-2 text-xs text-ok">可出片</span>}
          </div>
          <div className={cn('min-h-0 flex-1 flex-col', railTab === 'chat' ? 'flex' : 'hidden')}>
            <div className="grid shrink-0 gap-1.5 border-b border-rule px-3 py-2.5">
              <div className="flex flex-wrap gap-1.5">
                <Button size="sm" disabled={ask.isPending} onClick={() => ask.mutate('director')} data-testid="video-ask-director">
                  {hasScript ? '请编导拆分镜' : '请编导写稿'}
                </Button>
                <Button size="sm" disabled={ask.isPending || video.shots.length === 0} onClick={() => ask.mutate('motion')} data-testid="video-ask-motion">
                  请动画师做画面
                </Button>
              </div>
              <p className="text-xs text-muted">请求会发在{ws.name}大群里，成员做完会回在那里</p>
            </div>
            <ChatRail key={railKey} ws={ws} projectId={project.id} names={names} root={false} defaultWs={railKey > 0} hint="@编导 改稿或拆分镜；@动画师 改画面；@审片 看片" placeholder={`关于《${video.title}》想改什么`} />
          </div>
          {railTab === 'comments' ? (
            <CommentsPane video={video} wsId={ws.id} names={names} position={position} canLocate={canLocate} draft={draft} onDraft={onDraft} picking={picking} onPicking={setPicking} onOpen={openComment} />
          ) : null}
          {railTab === 'review' ? <ReviewPane video={video} names={names} /> : null}
        </aside>
      ) : null}
      {dialog === 'voice' ? <VoiceDialog video={video} onClose={() => setDialog(null)} /> : null}
      {dialog === 'render' ? <RenderDialog video={video} onClose={() => setDialog(null)} /> : null}
      {metaOpen ? <VideoMetaDialog key={video.latestVersion} video={video} onClose={() => setMetaOpen(false)} onDeleted={() => { setMetaOpen(false); onBack(); }} /> : null}
    </div>
  );
}

export function VideoStudio({ ws, project, openId, onOpen }: { ws: WorkstationDetail; project: ProjectDetail; openId?: string | undefined; onOpen: (id: string | null) => void }) {
  const videos = useVideos(ws.id);
  const overview = useOverview(project.id);
  const names = useMemo(() => Object.fromEntries(project.agents.map((a) => [a.id, a.name])), [project.agents]);
  const [newOpen, setNewOpen] = useState(false);
  const running = (overview.data?.workstations.find((w) => w.id === ws.id)?.running ?? 0) > 0;

  if (!videos.data) return videos.isError ? <Empty title="视频台加载失败" /> : <Loading className="flex-1" />;
  const list = videos.data.videos;
  const open = openId ? list.find((v) => v.id === openId) : undefined;
  if (open) return <VideoEditor key={open.id} ws={ws} project={project} id={open.id} running={running} onBack={() => onOpen(null)} />;

  return (
    <div className="flex min-h-0 min-w-0 flex-1" data-testid="video-studio">
      <aside className="flex w-72 shrink-0 flex-col border-r border-rule bg-paper-2">
        <div className="flex shrink-0 items-center gap-2 border-b border-rule px-4 py-2.5">
          <h2 className="text-title font-bold text-ink">视频</h2>
          {list.length ? <span className="text-xs text-muted tabular-nums">{list.length}</span> : null}
          <Button size="sm" className="ml-auto" onClick={() => setNewOpen(true)} data-testid="video-new">
            <Icon name="plus" /> 新建
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {list.length === 0 ? <p className="px-1 py-2 text-sm text-muted">还没有视频。新建一支，或在右边对编导说想讲什么。</p> : null}
          <ul className="grid gap-2">
            {list.map((v) => (
              <li key={v.id}>
                <button type="button" onClick={() => onOpen(v.id)} className="grid w-full gap-1.5 rounded-ctl border border-rule bg-paper px-3 py-2.5 text-left transition-[background-color,translate] duration-150 hover:bg-paper-2 active:translate-y-px" data-testid={`video-item-${v.id}`}>
                  <span className="truncate text-sm font-semibold text-ink">{v.title}</span>
                  <span className="flex flex-wrap items-center gap-1.5">
                    <Badge tone={STATUS_TONE[v.status] ?? 'neutral'}>{STATUS_LABEL[v.status] ?? v.status}</Badge>
                    <Badge tone="line">{v.aspect}</Badge>
                    {v.missing ? <Badge tone="amber">缺画面 {v.missing}</Badge> : null}
                    {v.openComments ? <Badge tone="neutral" title="未解决的评论"><Icon name="comment" />{v.openComments}</Badge> : null}
                  </span>
                  <span className="flex items-center gap-1.5 text-xs text-muted">
                    <span className="tabular-nums">{v.shots} 个镜头 · {clock(v.duration)}</span>
                    <span className="ml-auto">{when(v.updatedAt)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </aside>
      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-2 border-b border-rule bg-paper px-5 py-2.5">
          <h2 className="text-title font-bold text-ink">和编导说想讲什么</h2>
          {running ? <Badge tone="cool">成员在动</Badge> : null}
        </div>
        <ChatRail ws={ws} projectId={project.id} names={names} root={false} hint="编导写讲解稿、拆分镜；动画师给镜头做画面" placeholder="比如：做一支两分钟的视频，讲清楚我们的部署流程" />
      </section>
      {newOpen ? (
        <NewVideoDialog
          wsId={ws.id}
          onClose={() => setNewOpen(false)}
          onCreated={(id) => {
            setNewOpen(false);
            onOpen(id);
          }}
        />
      ) : null}
    </div>
  );
}
