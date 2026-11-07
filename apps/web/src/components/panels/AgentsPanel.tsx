import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogForm } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { api, unwrap } from '@/lib/api';
import { parseJson, tokens } from '@/lib/format';
import { useAgentStatus, useModels, type WorkstationDetail, type WsAgent } from '@/lib/queries';

const modelRef = (a: WsAgent) => {
  const m = parseJson<{ provider?: string; name?: string } | null>(a.modelJson, null);
  return m?.provider && m.name ? `${m.provider}:${m.name}` : '';
};

function AgentDialog({ agent, ws, onClose }: { agent: WsAgent; ws: WorkstationDetail; onClose: () => void }) {
  const models = useModels();
  const tpl = ws.manifest?.agents.find((t) => t.id === agent.templateId);
  const allTools = tpl?.tools ?? [];
  const custom = agent.prompt && !agent.prompt.endsWith('.md') ? agent.prompt : '';
  const [name, setName] = useState(agent.name);
  const [model, setModel] = useState(modelRef(agent));
  const [prompt, setPrompt] = useState(custom);
  const [tools, setTools] = useState<string[]>(parseJson<string[]>(agent.toolsJson, []));

  const save = useMutation({
    meta: { silent: true },
    mutationFn: async () => {
      const i = model.indexOf(':');
      return unwrap(
        await api.agents[':id'].$patch({
          param: { id: agent.id },
          json: { name: name.trim(), model: model ? { provider: model.slice(0, i), name: model.slice(i + 1) } : null, prompt, tools },
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
        <Field label="模型" hint={`留空使用全局默认（${models.data?.default ?? '…'}）`}>
          <Select value={model} onChange={(e) => setModel(e.target.value)} data-testid="agent-model">
            <option value="">全局默认</option>
            {models.data?.models.map((m) => <option key={m.id} value={m.id}>{m.id}</option>)}
          </Select>
        </Field>
        <Field label="提示词覆盖" hint="留空使用插件模板的提示词">
          <Textarea rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        </Field>
        <fieldset>
          <legend className="mb-1 text-xs text-muted">工具（只能在模板范围内收窄）</legend>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1">
            {allTools.map((t) => (
              <label key={t} className="flex items-center gap-2 text-sm text-ink-2">
                <input
                  type="checkbox"
                  className="accent-[var(--color-accent)]"
                  checked={tools.includes(t)}
                  onChange={(e) => setTools(e.target.checked ? [...tools, t] : tools.filter((x) => x !== t))}
                />
                <code>{t}</code>
              </label>
            ))}
          </div>
        </fieldset>
      </DialogForm>
    </Dialog>
  );
}

const TH = 'px-4 py-2.5 text-left text-sm font-normal text-muted';
const TD = 'px-4 py-2.5 text-sm text-ink-2';

export function AgentsPanel({ ws }: { ws: WorkstationDetail }) {
  const status = useAgentStatus(ws.id);
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
    <div className="h-full overflow-auto" data-testid="agents-panel">
      <div className="flex items-center gap-2 px-4 py-3">
        <p className="flex-1 text-sm text-muted">编制 <span className="measured">{ws.agents.length}</span></p>
        <Select className="h-8 w-44" aria-label="选择模板" value={template} onChange={(e) => setTemplate(e.target.value)} data-testid="agent-template">
          <option value="">选择模板…</option>
          {ws.manifest?.agents.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </Select>
        <Button disabled={!template || add.isPending} onClick={() => add.mutate(template)}>添加实例</Button>
      </div>
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-y border-rule">
            <th className={TH}>Agent</th>
            <th className={TH}>模型</th>
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
            return (
              <tr key={a.id} className="border-b border-rule" data-testid="agent-row">
                <td className={TD}>
                  <p className="text-ink">{a.name}{a.isSteward === 1 && <span className="measured ml-2 text-xs text-cool">steward</span>}</p>
                  <p className="max-w-72 truncate text-xs text-muted">{a.role}</p>
                </td>
                <td className={`${TD} measured text-xs`}>{modelRef(a) || '默认'}</td>
                <td className={`${TD} measured text-right text-xs`}>{stats?.runs ?? 0}</td>
                <td className={`${TD} measured text-right text-xs`}>{tokens(stats?.tokens)}</td>
                <td className={TD}>
                  {running.has(a.id) ? <Badge tone="cool">运行中</Badge> : paused ? <Badge tone="amber">已暂停</Badge> : <Badge>待命</Badge>}
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
      {editing && <AgentDialog agent={editing} ws={ws} onClose={() => setEditing(null)} />}
    </div>
  );
}
