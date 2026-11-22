import { useMutation } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { Page, PageHeader } from '@/components/layout/Page';
import { Badge } from '@/components/ui/badge';
import { Button, Spinner } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Loading, toast } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/icons';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { api, unwrap } from '@/lib/api';
import { useMediaSettings, useModelConfig, useModels, type ModelConfig } from '@/lib/queries';
import { cn } from '@/lib/utils';

export const Route = createFileRoute('/_console/settings')({ component: SettingsPage });

type Kind = 'anthropic' | 'openai-compatible' | 'ollama';
interface ProviderForm { name: string; kind: Kind; model: string; baseUrl: string; apiKey: string; hasKey: boolean; vision: boolean; contextWindow: string; maxOutput: string }

const KINDS: { id: Kind; label: string }[] = [
  { id: 'anthropic', label: 'Anthropic' },
  { id: 'openai-compatible', label: 'OpenAI 兼容' },
  { id: 'ollama', label: 'Ollama（本地）' },
];

const blank = (): ProviderForm => ({ name: '', kind: 'anthropic', model: '', baseUrl: '', apiKey: '', hasKey: false, vision: false, contextWindow: '', maxOutput: '' });

const toForm = (c: ModelConfig): ProviderForm[] =>
  c.providers.map((p) => ({ name: p.name, kind: p.kind, model: p.model, baseUrl: p.baseUrl ?? '', apiKey: '', hasKey: p.hasKey, vision: p.vision ?? false, contextWindow: p.contextWindow != null ? String(p.contextWindow) : '', maxOutput: p.maxOutputTokens != null ? String(p.maxOutputTokens) : '' }));

const toPayload = (p: ProviderForm) => ({
  name: p.name.trim(),
  kind: p.kind,
  model: p.model.trim(),
  ...(p.baseUrl.trim() ? { baseUrl: p.baseUrl.trim() } : {}),
  ...(p.apiKey ? { apiKey: p.apiKey } : {}),
  ...(p.vision ? { vision: true } : {}),
  ...(p.contextWindow.trim() ? { contextWindow: Number(p.contextWindow.trim()) } : {}),
  ...(p.maxOutput.trim() ? { maxOutputTokens: Number(p.maxOutput.trim()) } : {}),
});

const validNum = (s: string) => !s.trim() || Number.isInteger(Number(s.trim()));

// 价格按行编辑：provider:model 输入价 输出价
const pricesToText = (p: ModelConfig['prices']) => Object.entries(p).map(([k, v]) => `${k} ${v.input} ${v.output}`).join('\n');

function textToPrices(text: string) {
  const out: ModelConfig['prices'] = {};
  for (const line of text.split('\n')) {
    const [id, input, output] = line.trim().split(/\s+/);
    if (id && Number.isFinite(Number(input)) && Number.isFinite(Number(output))) out[id] = { input: Number(input), output: Number(output) };
  }
  return out;
}

function ProviderRow({ p, onChange, onRemove }: { p: ProviderForm; onChange: (next: ProviderForm) => void; onRemove: () => void }) {
  const test = useMutation({
    mutationFn: async () => unwrap(await api.settings.models.test.$post({ json: toPayload(p) })),
    meta: { silent: true },
  });
  const set = (patch: Partial<ProviderForm>) => {
    test.reset();
    onChange({ ...p, ...patch });
  };
  return (
    <Card className="grid gap-4 p-4" data-testid="provider-row">
      <div className="flex flex-wrap items-center gap-2">
        <span aria-hidden className="grid size-8 place-items-center rounded-ctl bg-paper-2 text-ink-2"><Icon name="cpu" /></span>
        <h3 className={cn('min-w-0 truncate text-sm font-bold', p.name.trim() ? 'text-ink' : 'text-muted')}>{p.name.trim() || '新 Provider'}</h3>
        <Badge tone="line">{KINDS.find((k) => k.id === p.kind)?.label ?? p.kind}</Badge>
        {p.kind !== 'ollama' && (p.hasKey ? <Badge tone="ok"><Icon name="key" />已保存密钥</Badge> : <Badge tone="line">未配置密钥</Badge>)}
      </div>
      <div className="grid grid-cols-2 gap-4 max-md:grid-cols-1">
        <Field label="名称" required hint="用于 provider:model 引用">
          <Input className="measured" value={p.name} onChange={(e) => set({ name: e.target.value })} data-testid="provider-name" />
        </Field>
        <Field label="类型">
          <Select value={p.kind} onChange={(e) => set({ kind: e.target.value as Kind })} data-testid="provider-kind">
            {KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
          </Select>
        </Field>
        <Field label="默认模型" required>
          <Input className="measured" value={p.model} onChange={(e) => set({ model: e.target.value })} data-testid="provider-model" />
        </Field>
        <Field label="地址" hint={p.kind === 'ollama' ? '留空用 http://localhost:11434/v1' : p.kind === 'anthropic' ? '可选' : '必填'}>
          <Input className="measured" value={p.baseUrl} onChange={(e) => set({ baseUrl: e.target.value })} />
        </Field>
        <Field label="上下文窗口" hint="tokens，留空不限；用于裁剪过长的工具结果、给输出留空间">
          <Input className="measured" inputMode="numeric" value={p.contextWindow} aria-invalid={!validNum(p.contextWindow) || undefined} onChange={(e) => set({ contextWindow: e.target.value })} data-testid="provider-context" />
          <span className="block text-xs text-muted">按模型文档填写，例如 128000</span>
          {!validNum(p.contextWindow) && <span className="block text-xs font-medium text-bad">请填整数</span>}
        </Field>
        <Field label="最大输出" hint="tokens；写设计稿这类大输出的 Agent 单次最多生成这么多，留空用默认 16000（AW_LARGE_OUTPUT_TOKENS）">
          <Input className="measured" inputMode="numeric" value={p.maxOutput} aria-invalid={!validNum(p.maxOutput) || undefined} onChange={(e) => set({ maxOutput: e.target.value })} data-testid="provider-max-output" />
          <span className="block text-xs text-muted">按模型文档填写，例如 128000</span>
          {!validNum(p.maxOutput) && <span className="block text-xs font-medium text-bad">请填整数</span>}
        </Field>
        {p.kind !== 'ollama' && (
          <Field label="API Key" hint={p.hasKey ? '已保存，留空沿用' : '加密存在本地，不进数据库和日志'} className="col-span-2 max-md:col-span-1">
            <Input className="measured" type="password" autoComplete="off" value={p.apiKey} onChange={(e) => set({ apiKey: e.target.value })} data-testid="provider-key" />
          </Field>
        )}
      </div>
      <label className="flex cursor-pointer items-start gap-3 border-t border-rule pt-3.5">
        <input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-primary" checked={p.vision} onChange={(e) => set({ vision: e.target.checked })} data-testid="provider-vision" />
        <span className="grid gap-0.5">
          <span className="text-sm font-semibold text-ink">支持看图</span>
          <span className="text-xs text-muted">工具结果（如 view_design 截图）会作为图片发给模型；不开就只给文字说明</span>
        </span>
      </label>
      {(test.data ?? test.error) && (
        <div
          className={cn('flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-ctl px-3.5 py-2.5 text-sm text-ink-2', test.isError || !test.data!.ok ? 'bg-bad-soft' : test.data!.toolCall ? 'bg-ok-soft' : 'bg-accent-soft')}
          data-testid="provider-test-result"
        >
          {test.isError ? (
            <>
              <Badge tone="bad">不可用</Badge>
              <span className="break-all text-xs text-muted">{test.error.message}</span>
            </>
          ) : test.data!.ok ? (
            test.data!.toolCall ? (
              <Badge tone="ok">可用 · {test.data!.latencyMs} ms{typeof test.data!.maxOutputChecked === 'number' ? ` · 最大输出 ${test.data!.maxOutputChecked} 已接受` : ''}</Badge>
            ) : (
              <Badge tone="amber">能对话，但没调用工具 · Agent 需要工具调用</Badge>
            )
          ) : (
            <>
              <Badge tone="bad">不可用</Badge>
              {test.data!.error && <span className="break-all text-xs text-muted">{test.data!.error}</span>}
            </>
          )}
        </div>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button size="sm" variant="danger" onClick={onRemove}><Icon name="trash" />移除</Button>
        <Button size="sm" disabled={test.isPending || !p.name.trim() || !p.model.trim()} aria-busy={test.isPending || undefined} onClick={() => test.mutate()} data-testid="provider-test">
          {test.isPending ? <Spinner /> : <Icon name="pulse" />}{test.isPending ? '测试中…' : '测试'}
        </Button>
      </div>
    </Card>
  );
}

function ModelForm({ config }: { config: ModelConfig }) {
  const [providers, setProviders] = useState(toForm(config));
  const [defaultModel, setDefault] = useState(config.defaultModel ?? '');
  const [chain, setChain] = useState(config.chain.join('\n'));
  const [prices, setPrices] = useState(pricesToText(config.prices));
  useEffect(() => setProviders(toForm(config)), [config]);

  const save = useMutation({
    mutationFn: async () =>
      unwrap(
        await api.settings.models.$put({
          json: {
            providers: providers.map(toPayload),
            ...(defaultModel.trim() ? { defaultModel: defaultModel.trim() } : {}),
            chain: chain.split('\n').map((l) => l.trim()).filter(Boolean),
            prices: textToPrices(prices),
          },
        }),
      ),
    onSuccess: () => toast('模型配置已保存', 'ok'),
  });

  return (
    <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
      <div className="grid gap-3">
        {providers.map((p, i) => (
          <ProviderRow key={i} p={p} onChange={(next) => setProviders(providers.map((x, k) => (k === i ? next : x)))} onRemove={() => setProviders(providers.filter((_, k) => k !== i))} />
        ))}
        <Button className="justify-self-start" onClick={() => setProviders([...providers, blank()])} data-testid="provider-add"><Icon name="plus" />添加 Provider</Button>
      </div>
      <Card className="grid gap-4 p-4">
        <Field label="默认模型" hint="provider:model；留空取第一个 provider">
          <Input className="measured" value={defaultModel} onChange={(e) => setDefault(e.target.value)} />
        </Field>
        <Field label="降级链" hint="每行一个 provider:model。主模型限流、超时或不可用时按序切换，运行记录会标注">
          <Textarea className="measured" rows={3} value={chain} onChange={(e) => setChain(e.target.value)} />
        </Field>
        <Field label="单价" hint="每行：provider:model 输入价 输出价（美元 / 百万 token）。没填单价的模型只统计 token">
          <Textarea className="measured" rows={3} value={prices} onChange={(e) => setPrices(e.target.value)} />
        </Field>
      </Card>
      <div className="flex justify-end">
        <Button type="submit" variant="primary" disabled={save.isPending || providers.some((p) => !validNum(p.contextWindow) || !validNum(p.maxOutput))} aria-busy={save.isPending || undefined} data-testid="models-save">
          {save.isPending ? <Spinner /> : <Icon name="check" />}{save.isPending ? '保存中…' : '保存模型配置'}
        </Button>
      </div>
    </form>
  );
}

interface MediaForm { name: string; model: string; voice: string; baseUrl: string; apiKey: string; hasKey: boolean; format: 'mp3' | 'wav'; price: string }

const blankMedia = (): MediaForm => ({ name: '', model: 'tts-1', voice: 'alloy', baseUrl: '', apiKey: '', hasKey: false, format: 'mp3', price: '' });

const toMediaForm = (c: ModelConfig): MediaForm[] =>
  c.media.filter((m) => m.kind === 'tts').map((m) => ({ name: m.name, model: m.model ?? '', voice: m.voice ?? '', baseUrl: m.baseUrl ?? '', apiKey: '', hasKey: m.hasKey, format: m.format ?? 'mp3', price: m.price?.perMillionChars != null ? String(m.price.perMillionChars) : '' }));

const toMediaPayload = (m: MediaForm) => ({
  name: m.name.trim(),
  kind: 'tts' as const,
  protocol: 'openai-speech' as const,
  ...(m.baseUrl.trim() ? { baseUrl: m.baseUrl.trim() } : {}),
  ...(m.apiKey ? { apiKey: m.apiKey } : {}),
  ...(m.model.trim() ? { model: m.model.trim() } : {}),
  ...(m.voice.trim() ? { voice: m.voice.trim() } : {}),
  format: m.format,
  ...(m.price.trim() ? { price: { perMillionChars: Number(m.price.trim()) } } : {}),
});

const validPrice = (s: string) => !s.trim() || (Number.isFinite(Number(s.trim())) && Number(s.trim()) >= 0);

function MediaRow({ m, onChange, onRemove }: { m: MediaForm; onChange: (next: MediaForm) => void; onRemove: () => void }) {
  const [sample, setSample] = useState<{ url: string; duration: string; ms: string } | null>(null);
  const test = useMutation({
    mutationFn: async () => {
      const res = await api.settings.media.test.$post({ json: toMediaPayload(m) });
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`);
      return { url: URL.createObjectURL(await res.blob()), duration: res.headers.get('x-aw-duration') ?? '', ms: res.headers.get('x-aw-ms') ?? '' };
    },
    meta: { silent: true },
    onSuccess: (r) => setSample((prev) => {
      if (prev) URL.revokeObjectURL(prev.url);
      return r;
    }),
  });
  useEffect(() => () => { if (sample) URL.revokeObjectURL(sample.url); }, [sample]);
  const set = (patch: Partial<MediaForm>) => {
    test.reset();
    onChange({ ...m, ...patch });
  };
  return (
    <Card className="grid gap-4 p-4" data-testid="media-row">
      <div className="flex flex-wrap items-center gap-2">
        <span aria-hidden className="grid size-8 place-items-center rounded-ctl bg-paper-2 text-ink-2"><Icon name="wave" /></span>
        <h3 className={cn('min-w-0 truncate text-sm font-bold', m.name.trim() ? 'text-ink' : 'text-muted')}>{m.name.trim() || '新配音服务'}</h3>
        <Badge tone="line">配音 · OpenAI 兼容</Badge>
        {m.hasKey ? <Badge tone="ok"><Icon name="key" />已保存密钥</Badge> : <Badge tone="line">未配置密钥</Badge>}
      </div>
      <div className="grid grid-cols-2 gap-4 max-md:grid-cols-1">
        <Field label="名称" required>
          <Input className="measured" value={m.name} onChange={(e) => set({ name: e.target.value })} data-testid="media-name" />
        </Field>
        <Field label="地址" required hint="到 /v1 为止，平台会请求 /audio/speech">
          <Input className="measured" value={m.baseUrl} onChange={(e) => set({ baseUrl: e.target.value })} placeholder="https://api.openai.com/v1" data-testid="media-base-url" />
        </Field>
        <Field label="模型">
          <Input className="measured" value={m.model} onChange={(e) => set({ model: e.target.value })} data-testid="media-model" />
        </Field>
        <Field label="默认音色">
          <Input className="measured" value={m.voice} onChange={(e) => set({ voice: e.target.value })} data-testid="media-voice" />
        </Field>
        <Field label="格式">
          <Select value={m.format} onChange={(e) => set({ format: e.target.value as MediaForm['format'] })}>
            <option value="mp3">mp3</option>
            <option value="wav">wav</option>
          </Select>
        </Field>
        <Field label="单价" hint="美元 / 百万字符；计入预算，留空只记次数">
          <Input className="measured" inputMode="decimal" value={m.price} aria-invalid={!validPrice(m.price) || undefined} onChange={(e) => set({ price: e.target.value })} data-testid="media-price" />
        </Field>
        <Field label="API Key" hint={m.hasKey ? '已保存，留空沿用' : '加密存在本地，不进数据库和日志'} className="col-span-2 max-md:col-span-1">
          <Input className="measured" type="password" autoComplete="off" value={m.apiKey} onChange={(e) => set({ apiKey: e.target.value })} data-testid="media-key" />
        </Field>
      </div>
      {test.isError ? (
        <div className="flex flex-wrap items-center gap-2 rounded-ctl bg-bad-soft px-3.5 py-2.5 text-sm" data-testid="media-test-result">
          <Badge tone="bad">不可用</Badge>
          <span className="break-all text-xs text-muted">{test.error.message}</span>
        </div>
      ) : sample && !test.isPending ? (
        <div className="flex flex-wrap items-center gap-2 rounded-ctl bg-ok-soft px-3.5 py-2.5 text-sm" data-testid="media-test-result">
          <Badge tone="ok">可用 · {sample.duration} 秒 · {sample.ms} ms</Badge>
          <audio controls autoPlay src={sample.url} className="h-8 min-w-0 flex-1" />
        </div>
      ) : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button size="sm" variant="danger" onClick={onRemove}><Icon name="trash" />移除</Button>
        <Button size="sm" disabled={test.isPending || !m.name.trim() || !m.baseUrl.trim()} aria-busy={test.isPending || undefined} onClick={() => test.mutate()} data-testid="media-test">
          {test.isPending ? <Spinner /> : <Icon name="play" />}{test.isPending ? '合成中…' : '试听'}
        </Button>
      </div>
    </Card>
  );
}

// 媒体单独保存：模型部分按已保存的配置原样回传（密钥留空即沿用），两个表单互不覆盖
function MediaSection({ config }: { config: ModelConfig }) {
  const available = useMediaSettings();
  const [rows, setRows] = useState(toMediaForm(config));
  const [defaultTts, setDefaultTts] = useState(config.defaultTts ?? '');
  useEffect(() => setRows(toMediaForm(config)), [config]);
  const save = useMutation({
    mutationFn: async () =>
      unwrap(
        await api.settings.models.$put({
          json: {
            providers: config.providers.map((p) => toPayload({ ...toForm({ ...config, providers: [p] })[0]!, apiKey: '' })),
            ...(config.defaultModel ? { defaultModel: config.defaultModel } : {}),
            chain: config.chain,
            prices: config.prices,
            media: [...config.media.filter((x) => x.kind !== 'tts').map(({ hasKey, ...x }) => (void hasKey, x)), ...rows.map(toMediaPayload)],
            defaultTts: defaultTts.trim(),
          },
        }),
      ),
    onSuccess: () => toast('媒体配置已保存', 'ok'),
  });
  const external = (available.data?.providers ?? []).filter((p) => p.source !== 'settings');
  return (
    <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
      {external.length ? (
        <ul className="flex flex-wrap gap-2">
          {external.map((p) => <li key={p.name}><Badge tone="line"><span className="measured font-medium">{p.name}</span>{p.source === 'env' ? ' · 环境变量' : ' · mock'}</Badge></li>)}
        </ul>
      ) : null}
      <div className="grid gap-3">
        {rows.map((m, i) => (
          <MediaRow key={i} m={m} onChange={(next) => setRows(rows.map((x, k) => (k === i ? next : x)))} onRemove={() => setRows(rows.filter((_, k) => k !== i))} />
        ))}
        <Button className="justify-self-start" onClick={() => setRows([...rows, blankMedia()])} data-testid="media-add"><Icon name="plus" />添加配音服务</Button>
      </div>
      <Card className="grid gap-4 p-4">
        <Field label="默认配音服务" hint="视频没指定时用它；留空先用环境变量里的，再用第一个">
          <Select value={defaultTts} onChange={(e) => setDefaultTts(e.target.value)} data-testid="media-default">
            <option value="">自动</option>
            {[...new Set([...rows.map((r) => r.name.trim()).filter(Boolean), ...external.map((p) => p.name)])].map((n) => <option key={n} value={n}>{n}</option>)}
          </Select>
        </Field>
      </Card>
      <div className="flex justify-end">
        <Button type="submit" variant="primary" disabled={save.isPending || rows.some((m) => !m.name.trim() || !validPrice(m.price))} aria-busy={save.isPending || undefined} data-testid="media-save">
          {save.isPending ? <Spinner /> : <Icon name="check" />}{save.isPending ? '保存中…' : '保存媒体配置'}
        </Button>
      </div>
    </form>
  );
}

interface VideoForm { name: string; protocol: 'mock'; baseUrl: string; apiKey: string; model: string; price: string; hasKey: boolean }

const toVideoForm = (c: ModelConfig): VideoForm[] =>
  c.media.filter((m) => m.kind === 'video').map((m) => ({ name: m.name, protocol: 'mock' as const, baseUrl: m.baseUrl ?? '', apiKey: '', model: m.model ?? '', price: m.price?.perSecond != null ? String(m.price.perSecond) : '', hasKey: m.hasKey }));

const blankVideo = (): VideoForm => ({ name: '', protocol: 'mock', baseUrl: '', apiKey: '', model: 'mock', price: '', hasKey: false });

const toVideoPayload = (m: VideoForm) => ({
  name: m.name.trim(),
  kind: 'video' as const,
  protocol: m.protocol,
  ...(m.baseUrl.trim() ? { baseUrl: m.baseUrl.trim() } : {}),
  ...(m.apiKey ? { apiKey: m.apiKey } : {}),
  ...(m.model.trim() ? { model: m.model.trim() } : {}),
  ...(m.price.trim() ? { price: { perSecond: Number(m.price.trim()) } } : {}),
});

// 视频生成按秒计价；现在只有本机 mock 适配器，接真实厂商要先在服务端加 adapter（见 docs/PLUGINS/VIDEO.md）
function VideoSection({ config }: { config: ModelConfig }) {
  const available = useMediaSettings();
  const [rows, setRows] = useState(toVideoForm(config));
  const [defaultVideo, setDefaultVideo] = useState(config.defaultVideo ?? '');
  useEffect(() => setRows(toVideoForm(config)), [config]);
  const save = useMutation({
    mutationFn: async () =>
      unwrap(
        await api.settings.models.$put({
          json: {
            providers: config.providers.map((p) => toPayload({ ...toForm({ ...config, providers: [p] })[0]!, apiKey: '' })),
            ...(config.defaultModel ? { defaultModel: config.defaultModel } : {}),
            chain: config.chain,
            prices: config.prices,
            media: [...config.media.filter((x) => x.kind !== 'video').map(({ hasKey, ...x }) => (void hasKey, x)), ...rows.map(toVideoPayload)],
            defaultVideo: defaultVideo.trim(),
          },
        }),
      ),
    onSuccess: () => toast('视频生成配置已保存', 'ok'),
  });
  const external = (available.data?.providers ?? []).filter((p) => p.kind === 'video' && p.source !== 'settings');
  return (
    <form className="mt-6 grid gap-3.5" onSubmit={(e) => { e.preventDefault(); save.mutate(); }} data-testid="video-media-section">
      <h2 className="text-title font-bold text-ink">视频生成</h2>
      <p className="text-sm text-muted">片段生成的 provider，按秒计价、按实际时长计入预算。现在只有本机 mock（ffmpeg 合成）适配器：接了真实厂商的协议要在服务端加 adapter。</p>
      {external.length ? (
        <ul className="flex flex-wrap gap-2">
          {external.map((p) => <li key={p.name}><Badge tone="line"><span className="measured font-medium">{p.name}</span>{p.source === 'env' ? ' · 环境变量' : ' · mock'}</Badge></li>)}
        </ul>
      ) : null}
      {rows.map((m, i) => {
        const set = (patch: Partial<VideoForm>) => setRows(rows.map((x, k) => (k === i ? { ...x, ...patch } : x)));
        return (
          <Card key={i} className="grid gap-4 p-4" data-testid="video-media-row">
            <div className="flex flex-wrap items-center gap-2">
              <span aria-hidden className="grid size-8 place-items-center rounded-ctl bg-paper-2 text-ink-2"><Icon name="film" /></span>
              <h3 className={cn('min-w-0 truncate text-sm font-bold', m.name.trim() ? 'text-ink' : 'text-muted')}>{m.name.trim() || '新视频服务'}</h3>
              <Badge tone="line">视频生成</Badge>
              {m.hasKey ? <Badge tone="ok"><Icon name="key" />已保存密钥</Badge> : null}
            </div>
            <div className="grid grid-cols-2 gap-4 max-md:grid-cols-1">
              <Field label="名称" required>
                <Input className="measured" value={m.name} onChange={(e) => set({ name: e.target.value })} data-testid="video-media-name" />
              </Field>
              <Field label="协议" hint="每个协议对应服务端一个适配器">
                <Select value={m.protocol} onChange={(e) => set({ protocol: e.target.value as VideoForm['protocol'] })} data-testid="video-media-protocol">
                  <option value="mock">mock（本机合成）</option>
                </Select>
              </Field>
              <Field label="地址" hint="厂商的生成接口，mock 不用填">
                <Input className="measured" value={m.baseUrl} onChange={(e) => set({ baseUrl: e.target.value })} placeholder="https://api.example.com/v1" />
              </Field>
              <Field label="模型">
                <Input className="measured" value={m.model} onChange={(e) => set({ model: e.target.value })} />
              </Field>
              <Field label="单价" hint="美元 / 秒；计入预算，留空只记次数">
                <Input className="measured" inputMode="decimal" value={m.price} aria-invalid={!validPrice(m.price) || undefined} onChange={(e) => set({ price: e.target.value })} data-testid="video-media-price" />
              </Field>
              <Field label="API Key" hint={m.hasKey ? '已保存，留空沿用' : '加密存在本地，不进数据库和日志'}>
                <Input className="measured" type="password" autoComplete="off" value={m.apiKey} onChange={(e) => set({ apiKey: e.target.value })} data-testid="video-media-key" />
              </Field>
            </div>
            <div className="flex justify-end">
              <Button size="sm" variant="danger" onClick={() => setRows(rows.filter((_, k) => k !== i))}><Icon name="trash" />移除</Button>
            </div>
          </Card>
        );
      })}
      <Button className="justify-self-start" onClick={() => setRows([...rows, blankVideo()])} data-testid="video-media-add"><Icon name="plus" />添加视频服务</Button>
      <Card className="grid gap-4 p-4">
        <Field label="默认视频服务" hint="片段申请没指定时用它；留空先用环境变量里的，再用第一个">
          <Select value={defaultVideo} onChange={(e) => setDefaultVideo(e.target.value)} data-testid="video-media-default">
            <option value="">自动</option>
            {[...new Set([...rows.map((r) => r.name.trim()).filter(Boolean), ...external.map((p) => p.name)])].map((n) => <option key={n} value={n}>{n}</option>)}
          </Select>
        </Field>
      </Card>
      <div className="flex justify-end">
        <Button type="submit" variant="primary" disabled={save.isPending || rows.some((m) => !m.name.trim() || !validPrice(m.price))} aria-busy={save.isPending || undefined} data-testid="video-media-save">
          {save.isPending ? <Spinner /> : <Icon name="check" />}{save.isPending ? '保存中…' : '保存视频配置'}
        </Button>
      </div>
    </form>
  );
}

function SettingsPage() {
  const config = useModelConfig();
  const models = useModels();
  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-testid="settings-page">
      <Page narrow>
        <PageHeader icon="gear" title="模型与设置" />
        <section className="grid gap-3.5" aria-label="模型与密钥">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <h2 className="text-title font-bold text-ink">模型与密钥</h2>
            {models.data && <Badge tone={models.data.ready ? 'ok' : 'amber'}>{models.data.ready ? `${models.data.models.length} 个可用` : '没有可用模型'}</Badge>}
          </div>
          <p className="text-sm text-muted">环境变量（.env.local）里配置的 provider 优先于这里。调用云端模型时，任务内容和相关代码片段会发送给对应服务商。</p>
          {models.data && models.data.models.length > 0 && (
            <ul className="flex flex-wrap gap-2">
              {models.data.models.map((m) => <li key={m.id}><Badge tone={m.local ? 'line' : 'cool'}><span className="measured font-medium">{m.id}</span>{m.local ? ' · 本地' : ' · 云端'}</Badge></li>)}
            </ul>
          )}
          {config.isLoading ? <Loading /> : config.data && <ModelForm config={config.data} />}
        </section>
        <section className="mt-8 grid gap-3.5" aria-label="媒体">
          <h2 className="text-title font-bold text-ink">媒体</h2>
          <p className="text-sm text-muted">视频台的配音服务（OpenAI 兼容的 /audio/speech）和片段生成服务。旁白文字、生成提示词会发送给对应服务商，花费计入预算。出片还需要本机装好 ffmpeg。</p>
          {config.data ? <MediaSection config={config.data} /> : null}
          {config.data ? <VideoSection config={config.data} /> : null}
        </section>
        <section className="mt-8 grid gap-3.5" aria-label="数据">
          <h2 className="text-title font-bold text-ink">数据</h2>
          <div className="grid grid-cols-[1rem_minmax(0,1fr)] gap-2.5 rounded-card bg-paper-2 p-4 text-sm text-ink-2">
            <Icon name="info" className="mt-0.5 text-muted" />
            <p>全部数据在本地 SQLite（默认 data/agent-workstation.db），合并提案前自动快照到 data/snapshots，保留最近 20 份。项目数据可在指挥台的「设置」里导出。</p>
          </div>
        </section>
      </Page>
    </div>
  );
}
