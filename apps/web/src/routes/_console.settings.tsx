import { useMutation } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { GlobalPage } from '@/components/layout/ProjectHeader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Loading, toast } from '@/components/ui/feedback';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { api, unwrap } from '@/lib/api';
import { useModelConfig, useModels, type ModelConfig } from '@/lib/queries';

export const Route = createFileRoute('/_console/settings')({ component: SettingsPage });

type Kind = 'anthropic' | 'openai-compatible' | 'ollama';
interface ProviderForm { name: string; kind: Kind; model: string; baseUrl: string; apiKey: string; hasKey: boolean; vision: boolean }

const KINDS: { id: Kind; label: string }[] = [
  { id: 'anthropic', label: 'Anthropic' },
  { id: 'openai-compatible', label: 'OpenAI 兼容' },
  { id: 'ollama', label: 'Ollama（本地）' },
];

const blank = (): ProviderForm => ({ name: '', kind: 'anthropic', model: '', baseUrl: '', apiKey: '', hasKey: false, vision: false });

const toForm = (c: ModelConfig): ProviderForm[] =>
  c.providers.map((p) => ({ name: p.name, kind: p.kind, model: p.model, baseUrl: p.baseUrl ?? '', apiKey: '', hasKey: p.hasKey, vision: p.vision ?? false }));

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
  const set = (patch: Partial<ProviderForm>) => onChange({ ...p, ...patch });
  return (
    <div className="grid grid-cols-2 gap-3 rounded-card border border-rule p-3" data-testid="provider-row">
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
      {p.kind !== 'ollama' && (
        <Field label="API Key" hint={p.hasKey ? '已保存，留空沿用' : '加密存在本地，不进数据库和日志'} className="col-span-2">
          <Input type="password" autoComplete="off" value={p.apiKey} onChange={(e) => set({ apiKey: e.target.value })} data-testid="provider-key" />
        </Field>
      )}
      <label className="col-span-2 flex items-center gap-2 text-sm text-ink-2">
        <input type="checkbox" checked={p.vision} onChange={(e) => set({ vision: e.target.checked })} data-testid="provider-vision" />支持看图
        <span className="text-xs text-faint">工具结果（如 view_design 截图）会作为图片发给模型；不开就只给文字说明</span>
      </label>
      <div className="col-span-2 flex justify-end">
        <Button size="sm" variant="danger" onClick={onRemove}>移除</Button>
      </div>
    </div>
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
            providers: providers.map((p) => ({ name: p.name.trim(), kind: p.kind, model: p.model.trim(), ...(p.baseUrl.trim() ? { baseUrl: p.baseUrl.trim() } : {}), ...(p.apiKey ? { apiKey: p.apiKey } : {}), ...(p.vision ? { vision: true } : {}) })),
            ...(defaultModel.trim() ? { defaultModel: defaultModel.trim() } : {}),
            chain: chain.split('\n').map((l) => l.trim()).filter(Boolean),
            prices: textToPrices(prices),
          },
        }),
      ),
    onSuccess: () => toast('模型配置已保存', 'ok'),
  });

  return (
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
      <div className="space-y-3">
        {providers.map((p, i) => (
          <ProviderRow key={i} p={p} onChange={(next) => setProviders(providers.map((x, k) => (k === i ? next : x)))} onRemove={() => setProviders(providers.filter((_, k) => k !== i))} />
        ))}
        <Button onClick={() => setProviders([...providers, blank()])} data-testid="provider-add">添加 Provider</Button>
      </div>
      <Field label="默认模型" hint="provider:model；留空取第一个 provider">
        <Input className="measured" value={defaultModel} onChange={(e) => setDefault(e.target.value)} />
      </Field>
      <Field label="降级链" hint="每行一个 provider:model。主模型限流、超时或不可用时按序切换，运行记录会标注">
        <Textarea className="measured" rows={3} value={chain} onChange={(e) => setChain(e.target.value)} />
      </Field>
      <Field label="单价" hint="每行：provider:model 输入价 输出价（美元 / 百万 token）。没填单价的模型只统计 token">
        <Textarea className="measured" rows={3} value={prices} onChange={(e) => setPrices(e.target.value)} />
      </Field>
      <Button type="submit" variant="primary" disabled={save.isPending} data-testid="models-save">{save.isPending ? '保存中…' : '保存模型配置'}</Button>
    </form>
  );
}

function SettingsPage() {
  const config = useModelConfig();
  const models = useModels();
  return (
    <GlobalPage title="模型与设置" icon="gear" testId="settings-page">
      <section className="space-y-3" aria-label="模型与密钥">
        <div className="flex items-baseline gap-3">
          <h2 className="text-title text-ink">模型与密钥</h2>
          {models.data && <Badge tone={models.data.ready ? 'ok' : 'amber'}>{models.data.ready ? `${models.data.models.length} 个可用` : '没有可用模型'}</Badge>}
        </div>
        <p className="text-sm text-muted">环境变量（.env.local）里配置的 provider 优先于这里。调用云端模型时，任务内容和相关代码片段会发送给对应服务商。</p>
        {models.data && models.data.models.length > 0 && (
          <ul className="flex flex-wrap gap-2">
            {models.data.models.map((m) => <li key={m.id}><Badge tone={m.local ? 'neutral' : 'cool'}>{m.id}{m.local ? ' · 本地' : ' · 云端'}</Badge></li>)}
          </ul>
        )}
        {config.isLoading ? <Loading /> : config.data && <ModelForm config={config.data} />}
      </section>
      <section className="space-y-1" aria-label="数据">
        <h2 className="text-title text-ink">数据</h2>
        <p className="text-sm text-muted">全部数据在本地 SQLite（默认 data/agent-workstation.db），合并提案前自动快照到 data/snapshots，保留最近 20 份。项目数据可在指挥台的「设置」里导出。</p>
      </section>
    </GlobalPage>
  );
}
