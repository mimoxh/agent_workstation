import { useMutation } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Segmented } from '@/components/design/panes';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogForm } from '@/components/ui/dialog';
import { Empty, Loading } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/icons';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { api, unwrap } from '@/lib/api';
import { useQaAutomated, useQaHandoffs, type QaAutomatedCase } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { CASE_LABEL, CASE_STATUS_LABEL, CASE_STATUS_TONE, CASE_TONE, SEVERITY_TONE, useDocs, type CaseData, type Doc, type Step } from './model';
import { HandoffDialog, ROW, Scroll, TABLE, TD, Toolbar, useAskAgent, type QaProps } from './shared';

function StepsEditor({ steps, onChange }: { steps: Step[]; onChange: (s: Step[]) => void }) {
  const set = (i: number, patch: Partial<Step>) => onChange(steps.map((s, n) => (n === i ? { ...s, ...patch } : s)));
  return (
    <div className="space-y-1.5">
      <p className="text-xs text-muted">步骤</p>
      {steps.map((s, i) => (
        <div key={i} className="flex items-start gap-1.5">
          <span className="measured w-4 shrink-0 pt-2 text-right text-xs text-faint">{i + 1}</span>
          <Textarea className="min-h-8" rows={1} placeholder="操作" aria-label={`步骤 ${i + 1} 操作`} value={s.action} onChange={(e) => set(i, { action: e.target.value })} />
          <Textarea className="min-h-8" rows={1} placeholder="期望看到什么" aria-label={`步骤 ${i + 1} 期望`} value={s.expected} onChange={(e) => set(i, { expected: e.target.value })} />
          <Button variant="quiet" size="sm" aria-label={`删除步骤 ${i + 1}`} onClick={() => onChange(steps.filter((_, n) => n !== i))}>删除</Button>
        </div>
      ))}
      <Button size="sm" onClick={() => onChange([...steps, { action: '', expected: '' }])} data-testid="qa-step-add">加一步</Button>
    </div>
  );
}

function CaseEditor({ wsId, doc, automated, devStations, onClose }: { wsId: string; doc: Doc<CaseData> | null; automated: QaAutomatedCase[]; devStations: { id: string; name: string }[]; onClose: () => void }) {
  const d = doc?.data;
  const [title, setTitle] = useState(d?.title ?? '');
  const [module, setModule] = useState(d?.module ?? '');
  const [priority, setPriority] = useState(d?.priority ?? 'p1');
  const [preconditions, setPre] = useState(d?.preconditions ?? '');
  const [steps, setSteps] = useState<Step[]>(d?.steps ?? [{ action: '', expected: '' }]);
  const [requirement, setRequirement] = useState(d?.requirement ?? '');
  const [automation, setAutomation] = useState(d?.automation_key ?? '');
  const [handing, setHanding] = useState(false);
  const data = (status: string) => {
    const hit = automated.find((a) => a.caseKey === automation);
    return { ...d, title: title.trim(), module: module.trim(), priority, preconditions, steps: steps.filter((s) => s.action.trim()), requirement, automation_key: automation, automation_name: hit?.name ?? d?.automation_name ?? '', status };
  };
  const save = useMutation({
    meta: { silent: true },
    mutationFn: async (status: string) => (doc
      ? unwrap(await api.entities[':id'].$patch({ param: { id: doc.id }, json: { data: data(status), baseVersion: doc.version } }))
      : unwrap(await api.workstations[':id'].entities.$post({ param: { id: wsId }, json: { entityType: 'TestCase', data: data(status), reason: '人工创建' } }))),
    onSuccess: onClose,
  });
  const handoff = useMutation({
    meta: { silent: true },
    mutationFn: async (v: { targetWorkstationId?: string; module: string; priority: 'p0' | 'p1' | 'p2'; note?: string }) => unwrap(await api['qa-cases'][':id'].handoff.$post({ param: { id: doc!.id }, json: v })),
    onSuccess: onClose,
  });
  const status = d?.status ?? 'active';
  return (
    <Dialog title={doc ? '编辑用例' : '新建用例'} onClose={onClose} testId="qa-case-editor" className="w-[42rem]">
      <DialogForm error={save.error?.message} submitting={save.isPending} submitLabel={status === 'draft' ? '审核通过' : '保存'} canSubmit={!!title.trim()} onSubmit={() => save.mutate(status === 'draft' ? 'active' : status)} onCancel={onClose}>
        <Field label="标题" required hint="写清楚在什么情况下，应该怎样"><Input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} data-testid="qa-tc-title" /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="模块"><Input value={module} onChange={(e) => setModule(e.target.value)} /></Field>
          <Field label="优先级"><Select value={priority} onChange={(e) => setPriority(e.target.value)}>{['p0', 'p1', 'p2'].map((p) => <option key={p} value={p}>{p.toUpperCase()}</option>)}</Select></Field>
        </div>
        <Field label="前置条件"><Textarea rows={2} value={preconditions} onChange={(e) => setPre(e.target.value)} /></Field>
        <StepsEditor steps={steps} onChange={setSteps} />
        <Field label="需求来源"><Input value={requirement} onChange={(e) => setRequirement(e.target.value)} /></Field>
        <Field label="对应的自动化用例" hint="关联后这里显示它的最新结果">
          <Select value={automation} onChange={(e) => setAutomation(e.target.value)}>
            <option value="">手工用例</option>
            {automation && !automated.some((a) => a.caseKey === automation) && <option value={automation}>{d?.automation_name || automation}</option>}
            {automated.map((a) => <option key={a.caseKey} value={a.caseKey}>{a.name}</option>)}
          </Select>
        </Field>
        {doc && (
          <div className="flex flex-wrap gap-2 border-t border-rule pt-3">
            {status === 'draft' && <Button size="sm" onClick={() => save.mutate('deprecated')}>驳回</Button>}
            {status === 'active' && <Button size="sm" onClick={() => save.mutate('deprecated')}>废弃</Button>}
            {status === 'deprecated' && <Button size="sm" onClick={() => save.mutate('active')}>恢复</Button>}
            {!automation && !d?.handoff && status === 'active' && <Button size="sm" onClick={() => setHanding(true)} data-testid="qa-case-handoff">生成自动化任务</Button>}
            {d?.handoff && <span className="self-center text-xs text-muted">已生成补自动化的开发任务</span>}
          </div>
        )}
      </DialogForm>
      {handing && <HandoffDialog title="生成自动化任务" defaultModule={module} defaultPriority="p2" wsId={wsId} devStations={devStations} submitting={handoff.isPending} error={handoff.error?.message} onSubmit={(v) => handoff.mutate(v)} onClose={() => setHanding(false)} />}
    </Dialog>
  );
}

function GenerateDialog({ wsId, onClose }: { wsId: string; onClose: () => void }) {
  const [text, setText] = useState('');
  const ask = useAskAgent(wsId);
  return (
    <Dialog title="让用例设计生成草稿" onClose={onClose} testId="qa-generate-dialog">
      <DialogForm submitting={ask.isPending} submitLabel="发送" canSubmit={!!text.trim()} onSubmit={() => ask.mutate(`@用例设计 ${text.trim()}`, { onSuccess: onClose })} onCancel={onClose}>
        <Field label="要测什么" required hint="贴需求、描述功能或给代码路径。生成的是草稿，你审过才入库。">
          <Textarea autoFocus rows={5} value={text} onChange={(e) => setText(e.target.value)} data-testid="qa-generate-text" />
        </Field>
      </DialogForm>
    </Dialog>
  );
}

type Filter = 'all' | 'draft' | 'manual' | 'automated';

export function Cases({ ws, project }: QaProps) {
  const { docs, isLoading } = useDocs<CaseData>(ws.id, 'TestCase');
  const automated = useQaAutomated(ws.id);
  const handoffs = useQaHandoffs(ws.id);
  const [editing, setEditing] = useState<Doc<CaseData> | 'new' | null>(null);
  const [generating, setGenerating] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const devStations = project.workstations.filter((w) => w.pluginId === 'dev').map((w) => ({ id: w.id, name: w.name }));
  const latest = useMemo(() => new Map((automated.data ?? []).map((a) => [a.caseKey, a])), [automated.data]);
  const uniqueAutomated = useMemo(() => [...latest.values()], [latest]);
  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const shown = docs.filter((d) => {
      if (needle && !`${d.data.title} ${d.data.module ?? ''}`.toLowerCase().includes(needle)) return false;
      if (filter === 'draft') return d.data.status === 'draft';
      if (filter === 'manual') return !d.data.automation_key && d.data.status !== 'draft';
      if (filter === 'automated') return !!d.data.automation_key;
      return true;
    });
    const m = new Map<string, typeof docs>();
    for (const d of shown) m.set(d.data.module || '未分组', [...(m.get(d.data.module || '未分组') ?? []), d]);
    return [...m].sort(([a], [b]) => a.localeCompare(b));
  }, [docs, filter, q]);
  const drafts = docs.filter((d) => d.data.status === 'draft').length;
  if (isLoading) return <Loading />;
  return (
    <Scroll testId="qa-cases">
      <Toolbar>
        <Segmented label="用例筛选" value={filter} onChange={setFilter} options={[{ id: 'all', label: `全部 ${docs.length}` }, { id: 'draft', label: `待审核 ${drafts}` }, { id: 'manual', label: '手工' }, { id: 'automated', label: '自动化' }]} />
        <Input className="w-56" placeholder="搜索标题或模块" aria-label="搜索用例" value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="flex-1" />
        <Button onClick={() => setGenerating(true)} data-testid="qa-generate">AI 生成</Button>
        <Button variant="primary" onClick={() => setEditing('new')} data-testid="qa-tc-new"><Icon name="plus" className="size-3.5" />新建用例</Button>
      </Toolbar>
      {docs.length === 0 ? <Empty title="用例库是空的">手工写一条，或者让用例设计从需求生成草稿。</Empty> : groups.length === 0 ? <p className="py-2 text-sm text-muted">没有符合条件的用例。</p> : groups.map(([name, rows]) => (
        <section key={name} className="mb-5">
          <h2 className="mb-1 text-sm font-medium text-ink">{name} <span className="text-xs font-normal text-faint">{rows.length}</span></h2>
          <div className="overflow-x-auto">
            <table className={TABLE}>
              <thead className="sr-only"><tr><th>优先级</th><th>标题</th><th>执行方式</th><th>最新结果</th><th>状态</th></tr></thead>
              <tbody>
                {rows.map((c) => {
                  const last = c.data.automation_key ? latest.get(c.data.automation_key) : undefined;
                  const status = c.data.status ?? 'active';
                  const task = c.data.handoff ? (handoffs.data as Record<string, { status: string }> | undefined)?.[c.data.handoff.taskId] : undefined;
                  return (
                    <tr key={c.id} className={ROW} onClick={() => setEditing(c)} data-testid="qa-tc-row">
                      <td className={cn(TD, 'w-12')}><Badge tone={SEVERITY_TONE[c.data.priority ?? ''] ?? 'neutral'}>{(c.data.priority ?? '—').toUpperCase()}</Badge></td>
                      <td className={cn(TD, 'text-ink')}>{c.data.title}</td>
                      <td className={cn(TD, 'w-28 whitespace-nowrap text-xs')}>{c.data.automation_key ? '自动化' : task ? '补自动化中' : '手工'}</td>
                      <td className={cn(TD, 'w-20')}>{last ? <Badge tone={CASE_TONE[last.status] ?? 'neutral'}>{CASE_LABEL[last.status] ?? last.status}</Badge> : <span className="text-xs text-faint">—</span>}</td>
                      <td className={cn(TD, 'w-20')}><Badge tone={CASE_STATUS_TONE[status] ?? 'neutral'}>{CASE_STATUS_LABEL[status] ?? status}</Badge></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      ))}
      {editing && <CaseEditor key={editing === 'new' ? 'new' : editing.id} wsId={ws.id} doc={editing === 'new' ? null : editing} automated={uniqueAutomated} devStations={devStations} onClose={() => setEditing(null)} />}
      {generating && <GenerateDialog wsId={ws.id} onClose={() => setGenerating(false)} />}
    </Scroll>
  );
}
