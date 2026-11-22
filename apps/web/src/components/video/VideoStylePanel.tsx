import { composeShotDoc, DEFAULT_BGM_VOLUME, DEFAULT_PALETTE, lookError, subtitleLayout, type SubtitleBackground, type SubtitleLook, type SubtitlePosition, type SubtitleSize } from '@aw/domain';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Empty, Loading, toast } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/icons';
import { Field, Input, Seg, Select, Switch, Textarea } from '@/components/ui/input';
import { api, unwrap } from '@/lib/api';
import { useMediaSettings, useVideoMedia, useVideoStyle, type VideoStyleDetail, type WorkstationDetail } from '@/lib/queries';
import { seconds } from './model';
import { ShotFrame } from './ShotFrame';

const PREVIEW = { width: 1280, height: 720 };
const DEMO_HTML = `<!doctype html><html><head><style>body{display:grid;align-content:center;gap:28px;padding:0 120px;box-sizing:border-box}i{display:block;width:220px;height:14px;border-radius:7px;background:var(--aw-accent)}h1{margin:0;font:700 88px/1.15 var(--aw-font-heading);color:var(--aw-fg)}p{margin:0;font:400 36px/1.5 var(--aw-font-body);color:var(--aw-muted)}</style></head><body><i></i><h1>本台风格预览</h1><p>正文与说明文字 · Body text 123</p></body></html>`;

const COLOR_LABEL: Record<string, string> = { bg: '底色', fg: '主文字', accent: '强调', muted: '次要文字' };
const SIZE_OPTIONS: { value: SubtitleSize; label: string }[] = [{ value: 's', label: '小' }, { value: 'm', label: '中' }, { value: 'l', label: '大' }];
const POSITION_OPTIONS: { value: SubtitlePosition; label: string }[] = [{ value: 'bottom', label: '底部' }, { value: 'top', label: '顶部' }];
const BACKGROUND_OPTIONS: { value: SubtitleBackground; label: string }[] = [{ value: 'box', label: '底框' }, { value: 'shadow', label: '阴影' }, { value: 'none', label: '无' }];

const hex6 = (v: string) => {
  const s = v.trim();
  if (/^#[0-9a-f]{6}$/i.test(s)) return s;
  if (/^#[0-9a-f]{3}$/i.test(s)) return `#${[...s.slice(1)].map((c) => c + c).join('')}`;
  return null;
};

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="grid gap-3 border-b border-rule pb-5">
      <div className="grid gap-0.5">
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
        {hint ? <p className="text-xs text-muted">{hint}</p> : null}
      </div>
      {children}
    </section>
  );
}

function StyleForm({ ws, style }: { ws: WorkstationDetail; style: VideoStyleDetail }) {
  const qc = useQueryClient();
  const media = useMediaSettings();
  const library = useVideoMedia(ws.id);
  const fileInput = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(style.name);
  const [palette, setPalette] = useState<Record<string, string>>(() => ({ ...DEFAULT_PALETTE, ...Object.fromEntries(Object.entries(style.palette).filter((e): e is [string, string] => typeof e[1] === 'string')) }));
  const [heading, setHeading] = useState(style.fonts.heading ?? '');
  const [body, setBody] = useState(style.fonts.body ?? '');
  const [voiceOff, setVoiceOff] = useState(style.voice?.off === true);
  const [provider, setProvider] = useState(style.voice?.provider ?? '');
  const [voice, setVoice] = useState(style.voice?.voice ?? '');
  const [speed, setSpeed] = useState(String(style.voice?.speed ?? 1));
  const [bgm, setBgm] = useState<string | null>(style.bgm);
  const [volume, setVolume] = useState(Math.round((style.bgmVolume ?? DEFAULT_BGM_VOLUME) * 100));
  const [ducking, setDucking] = useState(style.ducking);
  const [rules, setRules] = useState(style.rules);
  const [subtitle, setSubtitle] = useState<SubtitleLook>(style.subtitle);
  const [sample, setSample] = useState<string | null>(null);
  useEffect(() => () => { if (sample) URL.revokeObjectURL(sample); }, [sample]);

  const speedNum = Number(speed);
  const speedOk = Number.isFinite(speedNum) && speedNum >= 0.25 && speedNum <= 4;
  const fonts = { ...(heading.trim() ? { heading: heading.trim() } : {}), ...(body.trim() ? { body: body.trim() } : {}) };
  const look = { palette, fonts };
  const lookBad = lookError(look);
  const voicePref = voiceOff ? { off: true } : provider || voice.trim() || speedNum !== 1 ? { ...(provider ? { provider } : {}), ...(voice.trim() ? { voice: voice.trim() } : {}), speed: speedNum } : null;
  const doc = useMemo(() => composeShotDoc(DEMO_HTML, { ...PREVIEW, style: look }), [JSON.stringify(look)]);
  const sub = subtitleLayout(PREVIEW.width, PREVIEW.height, null, subtitle);

  const save = useMutation({
    mutationFn: async () =>
      unwrap(await api.workstations[':id']['video-style'].$put({
        param: { id: ws.id },
        json: { name: name.trim() || '本台风格', palette, fonts, voice: voicePref, bgm, bgmVolume: volume / 100, ducking, rules, subtitle, ...(style.id ? { baseVersion: style.version } : {}) },
      })),
    onSuccess: async () => {
      toast('风格已保存，所有视频的预览和出片都会用新风格', 'ok');
      await Promise.all([qc.invalidateQueries({ queryKey: ['video-style', ws.id] }), qc.invalidateQueries({ queryKey: ['video'] }), qc.invalidateQueries({ queryKey: ['videos'] })]);
    },
  });
  const test = useMutation({
    mutationFn: async () => {
      const res = await api.workstations[':id']['video-style']['voice-test'].$post({ param: { id: ws.id }, json: voicePref ?? {} });
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `试听失败（${res.status}）`);
      return URL.createObjectURL(await res.blob());
    },
    onSuccess: setSample,
  });
  const upload = useMutation({
    mutationFn: async (file: File) => {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch(`/api/workstations/${ws.id}/media`, { method: 'POST', body: fd });
      const out = (await res.json().catch(() => ({}))) as { id?: string; name?: string; error?: string };
      if (!res.ok || !out.id) throw new Error(out.error ?? `上传失败（${res.status}）`);
      return out as { id: string; name: string };
    },
    onSuccess: async (r) => {
      setBgm(r.id);
      toast(`已上传「${r.name}」，保存后生效`, 'ok');
      await qc.invalidateQueries({ queryKey: ['video-media', ws.id] });
    },
  });

  const keys = Object.keys(palette);
  const providers = media.data?.providers ?? [];
  const tracks = library.data?.media ?? [];
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="video-style">
      <header className="flex min-h-14 shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-rule px-5 py-2.5">
        <Icon name="palette" className="size-[18px] shrink-0 text-muted" />
        <div className="grid min-w-0 flex-[1_1_16rem] gap-0.5">
          <h1 className="truncate text-title font-bold text-ink">风格</h1>
          <p className="text-xs text-muted">本台所有视频共用。改了风格，已有的审片结论要重新确认。</p>
        </div>
        <Button variant="primary" size="sm" className="ml-auto" disabled={!!lookBad || !speedOk || save.isPending} onClick={() => save.mutate()} data-testid="video-style-save">保存</Button>
      </header>
      <div className="flex min-h-0 flex-1 max-lg:flex-col max-lg:overflow-y-auto">
        <div className="grid min-h-0 flex-1 content-start gap-5 px-5 py-4 lg:max-w-[40rem] lg:overflow-y-auto">
          <Field label="名称">
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} data-testid="video-style-name" />
          </Field>
          <Section title="调色板" hint="注入成镜头的 CSS 变量 var(--aw-bg) / var(--aw-fg) / var(--aw-accent) / var(--aw-muted)，动画师写画面时直接引用">
            <div className="grid gap-2 sm:grid-cols-2">
              {keys.map((k) => {
                const hex = hex6(palette[k] ?? '');
                return (
                  <label key={k} className="flex items-center gap-2">
                    <input type="color" value={hex ?? '#000000'} onChange={(e) => setPalette((p) => ({ ...p, [k]: e.target.value }))} aria-label={`${COLOR_LABEL[k] ?? k}取色`} className="size-8 shrink-0 cursor-pointer rounded-ctl border border-rule bg-paper p-0.5" data-testid={`video-style-swatch-${k}`} />
                    <span className="w-16 shrink-0 text-xs text-ink-2">{COLOR_LABEL[k] ?? k}</span>
                    <Input value={palette[k] ?? ''} onChange={(e) => setPalette((p) => ({ ...p, [k]: e.target.value }))} className="min-w-0 flex-1 font-mono text-xs" data-testid={`video-style-color-${k}`} />
                  </label>
                );
              })}
            </div>
            {lookBad ? <p className="text-xs text-bad" data-testid="video-style-error">{lookBad}</p> : null}
          </Section>
          <Section title="字体" hint="写字体名列表，逗号分隔；镜头里用 var(--aw-font-heading) / var(--aw-font-body)，没写时用系统字体">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="标题">
                <Input value={heading} onChange={(e) => setHeading(e.target.value)} placeholder='比如 "Noto Serif SC", serif' data-testid="video-style-font-heading" />
              </Field>
              <Field label="正文">
                <Input value={body} onChange={(e) => setBody(e.target.value)} placeholder="比如 Inter, sans-serif" data-testid="video-style-font-body" />
              </Field>
            </div>
          </Section>
          <Section title="配音" hint="视频自己设了配音时以视频为准">
            <label className="flex items-center gap-2 text-sm text-ink-2">
              <Switch checked={voiceOff} onChange={setVoiceOff} aria-label="不配音" data-testid="video-style-voice-off" />
              不配音（出片门禁不再要求配音）
            </label>
            {!voiceOff ? (
              <div className="grid grid-cols-3 gap-3">
                <Field label="配音服务">
                  <Select value={provider} onChange={(e) => setProvider(e.target.value)} data-testid="video-style-voice-provider">
                    <option value="">默认{media.data?.default ? `（${media.data.default}）` : ''}</option>
                    {providers.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
                  </Select>
                </Field>
                <Field label="音色">
                  <Input value={voice} onChange={(e) => setVoice(e.target.value)} placeholder="留空用服务默认" data-testid="video-style-voice-voice" />
                </Field>
                <Field label="语速">
                  <Input type="number" min={0.25} max={4} step={0.05} value={speed} onChange={(e) => setSpeed(e.target.value)} data-testid="video-style-voice-speed" />
                </Field>
              </div>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" disabled={voiceOff || !speedOk || test.isPending} onClick={() => test.mutate()} data-testid="video-style-voice-test"><Icon name="play" />{test.isPending ? '合成中…' : '试听'}</Button>
              {sample ? <audio key={sample} src={sample} autoPlay controls className="h-8 min-w-0 flex-1" data-testid="video-style-voice-sample" /> : null}
            </div>
          </Section>
          <Section title="背景音乐" hint="铺满全片、循环播放，开头结尾各淡入淡出 1 秒；mp3 / wav / m4a / ogg，30MB 以内">
            <div className="flex flex-wrap items-center gap-2">
              <Select value={bgm ?? ''} onChange={(e) => setBgm(e.target.value || null)} className="min-w-0 flex-1" data-testid="video-style-bgm">
                <option value="">不要背景音乐</option>
                {tracks.map((m) => <option key={m.id} value={m.id}>{m.name}{m.duration ? ` · ${seconds(m.duration)}` : ''}</option>)}
              </Select>
              <input ref={fileInput} type="file" accept=".mp3,.wav,.m4a,.ogg,audio/*" className="hidden" data-testid="video-style-bgm-file" onChange={(e) => { const f = e.target.files?.[0]; if (f) upload.mutate(f); e.target.value = ''; }} />
              <Button size="sm" disabled={upload.isPending} onClick={() => fileInput.current?.click()} data-testid="video-style-bgm-upload"><Icon name="upload" />{upload.isPending ? '上传中…' : '上传'}</Button>
            </div>
            {bgm ? (
              <>
                <audio key={bgm} src={`/api/media/${bgm}`} controls preload="none" className="h-8 w-full" data-testid="video-style-bgm-player" />
                <label className="flex items-center gap-3 text-sm text-ink-2">
                  <span className="w-10 shrink-0">音量</span>
                  <input type="range" min={0} max={100} step={1} value={volume} onChange={(e) => setVolume(Number(e.target.value))} aria-label="背景音乐音量" className="min-w-0 flex-1 accent-[var(--color-ink)]" data-testid="video-style-bgm-volume" />
                  <span className="w-10 shrink-0 text-right text-xs tabular-nums text-muted">{volume}%</span>
                </label>
                <label className="flex items-center gap-2 text-sm text-ink-2">
                  <Switch checked={ducking} onChange={setDucking} aria-label="说话时压低" data-testid="video-style-ducking" />
                  说话时自动压低背景音乐
                </label>
              </>
            ) : null}
          </Section>
          <Section title="字幕" hint="烧进画面和预览用同一套样式">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <Seg value={subtitle.size ?? 'm'} options={SIZE_OPTIONS} onChange={(v) => setSubtitle((s) => ({ ...s, size: v }))} size="sm" label="字号" />
              <Seg value={subtitle.position ?? 'bottom'} options={POSITION_OPTIONS} onChange={(v) => setSubtitle((s) => ({ ...s, position: v }))} size="sm" label="位置" />
              <Seg value={subtitle.background ?? 'box'} options={BACKGROUND_OPTIONS} onChange={(v) => setSubtitle((s) => ({ ...s, background: v }))} size="sm" label="底" />
            </div>
          </Section>
          <Field label="风格规则" hint="给编导和动画师看的约定（markdown），比如镜头节奏、标题写法、哪些颜色只能用来强调">
            <Textarea value={rules} onChange={(e) => setRules(e.target.value)} rows={6} data-testid="video-style-rules" />
          </Field>
        </div>
        <div className="flex min-h-[18rem] min-w-0 flex-1 flex-col gap-2 border-rule bg-paper-3 p-4 lg:border-l">
          <span className="text-xs text-muted">预览（{PREVIEW.width}×{PREVIEW.height}，没保存的改动也算）</span>
          <ShotFrame doc={doc} width={PREVIEW.width} height={PREVIEW.height} title="风格预览" className="min-h-0 flex-1" testId="video-style-preview">
            <p className="pointer-events-none" style={sub.p as CSSProperties}>
              <span style={sub.span as CSSProperties}>这是一句字幕的样子</span>
            </p>
          </ShotFrame>
        </div>
      </div>
    </div>
  );
}

export function VideoStylePanel({ ws }: { ws: WorkstationDetail }) {
  const q = useVideoStyle(ws.id);
  if (!q.data) return q.isError ? <Empty title="风格加载失败" /> : <Loading className="flex-1" />;
  return <StyleForm key={`${q.data.id ?? 'new'}-${q.data.version}`} ws={ws} style={q.data} />;
}
