import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button, Spinner } from '@/components/ui/button';
import { Dialog, DialogForm } from '@/components/ui/dialog';
import { Icon } from '@/components/ui/icons';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { api, unwrap } from '@/lib/api';
import { parseJson, tokens } from '@/lib/format';
import { useAgentStatus, useHarnesses, useModels, type WorkstationDetail, type WsAgent } from '@/lib/queries';
import { cn } from '@/lib/utils';

const BUILTIN = 'builtin';
const CUSTOM_MODEL = '__custom__';
const engineOf = (a: WsAgent) => a.engine ?? BUILTIN;

const parsedModel = (a: WsAgent) => parseJson<{ provider?: string; name?: string } | null>(a.modelJson, null);

const builtinModelRef = (a: WsAgent) => {
  const m = parsedModel(a);
  return m?.provider && m.name ? `${m.provider}:${m.name}` : '';
};

const harnessModelName = (a: WsAgent) => {
  const eng = engineOf(a);
  if (eng === BUILTIN) return '';
  const m = parsedModel(a);
  return m?.provider === eng && m.name ? m.name : '';
};

function AgentDialog({ agent, ws, onClose }: { agent: WsAgent; ws: WorkstationDetail; onClose: () => void }) {
  const models = useModels();
  const harnesses = useHarnesses();
  const tpl = ws.manifest?.agents.find((t) => t.id === agent.templateId);
  const allTools = tpl?.tools ?? [];
  const custom = agent.prompt && !agent.prompt.endsWith('.md') ? agent.prompt : '';
  const [name, setName] = useState(agent.name);
  const [engine, setEngine] = useState(engineOf(agent));
  const [model, setModel] = useState(engineOf(agent) === BUILTIN ? builtinModelRef(agent) : harnessModelName(agent));
  const [customModel, setCustomModel] = useState(false);
  const [prompt, setPrompt] = useState(custom);
  const [tools, setTools] = useState<string[]>(parseJson<string[]>(agent.toolsJson, []));
  const external = engine !== BUILTIN;
  const activeHarness = external ? harnesses.data?.find((h) => h.id === engine) : undefined;
  const harnessModels = activeHarness?.models ?? [];
  const isCustom = external && (customModel || (!!model && harnesses.data !== undefined && !harnessModels.some((m) => m.id === model)));
  const builtinModels = models.data?.models ?? [];
  const hasSavedBuiltin = !external && !!model && !builtinModels.some((m) => m.id === model);

  const save = useMutation({
    meta: { silent: true },
    mutationFn: async () => {
      const nextModel = external
        ? (model.trim() ? { provider: engine, name: model.trim() } : null)
        : (() => {
            const i = model.indexOf(':');
            return model && i > 0 ? { provider: model.slice(0, i), name: model.slice(i + 1) } : null;
          })();
      return unwrap(
        await api.agents[':id'].$patch({
          param: { id: agent.id },
          json: { name: name.trim(), engine, model: nextModel, prompt, tools },
        }),
      );
    },
    onSuccess: onClose,
  });

  return (
    <Dialog title={`编辑 ${agent.name}`} onClose={onClose} testId="agent-dialog">
      <DialogForm error={save.error?.message} submitting={save.isPending} submitLabel="保存" canSubmit={!!name.trim()} onSubmit={() => save.mutate()} onCancel={onClose}>
        <Field label="名称" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="执行引擎" hint={external ? '在应用内终端里驱动外部 Agent 工具，权限限定在任务 worktree 内；平台工具经 MCP 提供' : '平台自己的循环，按下面的模型调用 API'}>
          <Select
            value={engine}
            onChange={(e) => {
              setEngine(e.target.value);
              setModel('');
              setCustomModel(false);
            }}
            data-testid="agent-engine"
          >
            <option value={BUILTIN}>内置循环（模型 API）</option>
            {harnesses.data?.map((h) => (
              <option key={h.id} value={h.id} disabled={!h.installed && h.id !== engine}>{h.label}{h.installed ? (h.version ? ` · ${h.version}` : '') : '（未安装）'}</option>
            ))}
          </Select>
        </Field>
        <Field
          label="模型"
          hint={
            external
              ? `留空使用 ${activeHarness?.label ?? engine} 自己的默认配置${activeHarness?.defaultModel ? `（当前：${activeHarness.defaultModel}）` : ''}`
              : `留空使用全局默认（${models.data?.default ?? '…'}）`
          }
        >
          {external ? (
            <>
              <Select
                value={isCustom ? CUSTOM_MODEL : model}
                onChange={(e) => {
                  if (e.target.value === CUSTOM_MODEL) {
                    setCustomModel(true);
                  } else {
                    setCustomModel(false);
                    setModel(e.target.value);
                  }
                }}
                data-testid="agent-model"
              >
                <option value="">工具默认{activeHarness?.defaultModel ? `（${activeHarness.defaultModel}）` : ''}</option>
                {harnessModels.map((m) => <option key={m.id} value={m.id}>{m.label ?? m.id}</option>)}
                <option value={CUSTOM_MODEL}>自定义模型…</option>
              </Select>
              {isCustom && (
                <Input
                  className="mt-2"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="输入模型名，例如 sonnet / gpt-6.1-sol"
                  data-testid="agent-model-custom"
                />
              )}
            </>
          ) : (
            <Select value={model} onChange={(e) => setModel(e.target.value)} data-testid="agent-model">
              <option value="">全局默认</option>
              {hasSavedBuiltin && <option value={model}>{model}</option>}
              {builtinModels.map((m) => <option key={m.id} value={m.id}>{m.id}</option>)}
            </Select>
          )}
        </Field>
        <Field label="提示词覆盖" hint="留空使用插件模板的提示词">
          <Textarea rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        </Field>
        <fieldset>
          <legend className="mb-1.5 text-sm font-medium text-ink-2">工具（只能在模板范围内收窄{external ? '；读写文件和跑命令用引擎自带的工具' : ''}）</legend>
          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 rounded-ctl bg-paper-2 p-2 max-sm:grid-cols-1">
            {allTools.map((t) => (
              <label key={t} className="flex min-w-0 cursor-pointer items-center gap-2 rounded-chip px-1.5 py-1 text-sm text-ink-2 hover:bg-hover">
                <input
                  type="checkbox"
                  className="size-3.5 shrink-0 accent-[var(--color-primary)]"
                  checked={tools.includes(t)}
                  onChange={(e) => setTools(e.target.checked ? [...tools, t] : tools.filter((x) => x !== t))}
                />
                <code className="truncate text-xs">{t}</code>
              </label>
            ))}
          </div>
        </fieldset>
      </DialogForm>
    </Dialog>
  );
}

const TH = 'whitespace-nowrap border-b border-rule bg-paper-2 px-3.5 py-2.5 text-left text-xs font-semibold text-muted';
const TD = 'border-b border-rule px-3.5 py-3 text-sm text-ink-2';

export function AgentsPanel({ ws }: { ws: WorkstationDetail }) {
  const status = useAgentStatus(ws.id);
  const harnesses = useHarnesses();
  const labels = Object.fromEntries((harnesses.data ?? []).map((h) => [h.id, h.label]));
  const [editing, setEditing] = useState<WsAgent | null>(null);
  const [template, setTemplate] = useState('');
  const running = new Set(status.data?.running ?? []);
  const toggle = useMutation({
    mutationFn: async (a: WsAgent) =>
      unwrap(await api.agents[':id'].$patch({ param: { id: a.id }, json: { status: a.status === 'paused' ? 'active' : 'paused' } })),
  });
  const add = useMutation({
    mutationFn: async (templateId: string) => unwrap(await api.workstations[':id'].agents.$post({ param: { id: ws.id }, json: { templateId } })),
    onSuccess: () => setTemplate(''),
  });

  return (
    <div className="h-full overflow-auto px-5 py-4" data-testid="agents-panel">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <p className="flex-1 text-sm text-muted">编制 <span className="font-semibold tabular-nums text-ink">{ws.agents.length}</span></p>
        <Select className="w-44" aria-label="选择模板" value={template} onChange={(e) => setTemplate(e.target.value)} data-testid="agent-template">
          <option value="">选择模板…</option>
          {ws.manifest?.agents.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </Select>
        <Button disabled={!template || add.isPending} aria-busy={add.isPending || undefined} onClick={() => add.mutate(template)}>{add.isPending ? <Spinner /> : <Icon name="plus" />}添加实例</Button>
      </div>
      <div className="overflow-x-auto rounded-card bg-paper shadow-[var(--shadow-card)]">
      <table className="w-full border-collapse [&_tbody_tr:last-child>td]:border-b-0">
        <thead>
          <tr>
            <th className={TH}>Agent</th>
            <th className={TH}>引擎 / 模型</th>
            <th className={`${TH} text-right`}>运行</th>
            <th className={`${TH} text-right`}>tokens</th>
            <th className={TH}>状态</th>
            <th className={TH}><span className="sr-only">操作</span></th>
          </tr>
        </thead>
        <tbody>
          {ws.agents.map((a) => {
            const stats = status.data?.stats[a.id];
            const paused = a.status === 'paused';
            const extModel = harnessModelName(a);
            return (
              <tr key={a.id} className="transition-colors duration-100 hover:bg-hover" data-testid="agent-row">
                <td className={TD}>
                  <div className="flex items-center gap-3">
                    <span aria-hidden className={cn('grid size-[26px] shrink-0 place-items-center rounded-full text-[11px] font-semibold', running.has(a.id) ? 'bg-cool-tag text-cool-tag-ink' : 'bg-tag text-tag-ink')}>{a.name.slice(0, 1)}</span>
                    <div className="min-w-0">
                      <p className="flex items-center gap-2 font-semibold text-ink">{a.name}{a.isSteward === 1 && <Badge tone="line" className="measured font-medium">steward</Badge>}</p>
                      <p className="max-w-72 truncate text-xs text-muted">{a.role}</p>
                    </div>
                  </div>
                </td>
                <td className={`${TD} measured whitespace-nowrap text-xs`} data-testid="agent-engine-cell">
                  {engineOf(a) !== BUILTIN ? (
                    <span className="inline-flex items-center gap-1.5">
                      <Badge tone="line" className="font-sans"><Icon name="terminal" />{labels[engineOf(a)] ?? engineOf(a)}</Badge>
                      {extModel && <span className="text-muted">{extModel}</span>}
                    </span>
                  ) : builtinModelRef(a) || <span className="font-sans text-muted">默认</span>}
                </td>
                <td className={`${TD} text-right tabular-nums`}>{stats?.runs ?? 0}</td>
                <td className={`${TD} measured text-right text-xs`}>{tokens(stats?.tokens)}</td>
                <td className={TD}>
                  {running.has(a.id) ? <Badge tone="cool"><span aria-hidden className="size-1.5 animate-pulse-soft rounded-full bg-current" />运行中</Badge> : paused ? <Badge tone="amber">已暂停</Badge> : <Badge>待命</Badge>}
                </td>
                <td className={`${TD} whitespace-nowrap text-right`}>
                  <Button size="sm" variant="quiet" onClick={() => setEditing(a)}>编辑</Button>
                  <Button size="sm" variant="quiet" disabled={toggle.isPending} onClick={() => toggle.mutate(a)}>{paused ? '恢复' : '暂停'}</Button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>
      {editing && <AgentDialog agent={editing} ws={ws} onClose={() => setEditing(null)} />}
    </div>
  );
}
