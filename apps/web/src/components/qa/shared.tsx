import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogForm } from '@/components/ui/dialog';
import { toast } from '@/components/ui/feedback';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import type { ProjectDetail, WorkstationDetail } from '@/lib/queries';
import { api, unwrap } from '@/lib/api';
import { cn } from '@/lib/utils';
import type { WsSearch } from '@/components/workstation/WorkstationScreen';
import { VERDICT_LABEL, VERDICT_TONE } from './model';

export const TH = 'px-3 py-2.5 text-left text-sm font-normal text-muted whitespace-nowrap';
export const TD = 'px-3 py-2.5 text-sm text-ink-2';
export const TABLE = 'w-full min-w-[40rem] border-collapse';
export const ROW = 'cursor-pointer border-b border-rule transition-colors duration-150 hover:bg-hover';

export interface QaProps { ws: WorkstationDetail; project: ProjectDetail; item: string | undefined; go: (panel: string, item?: string) => void }

export function useQaNav(ws: WorkstationDetail, project: ProjectDetail) {
  const search = useSearch({ strict: false }) as WsSearch;
  const navigate = useNavigate();
  const go = (panel: string, item?: string) => void navigate({ to: '/projects/$projectId/ws/$wsId', params: { projectId: project.id, wsId: ws.id }, search: { panel, ...(item ? { item } : {}) } });
  return { item: search.item, go };
}

export function useAskAgent(wsId: string) {
  const thread = useQuery({ queryKey: ['thread', 'ws', wsId], queryFn: async () => unwrap(await api.workstations[':id'].thread.$get({ param: { id: wsId } })) });
  return useMutation({
    mutationFn: async (content: string) => unwrap(await api.threads[':id'].messages.$post({ param: { id: thread.data!.thread.id }, json: { content } })),
    onSuccess: () => toast('已发给 Agent，结果会写回这里', 'ok'),
  });
}

export function Scroll({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <div className="h-full overflow-y-auto" data-testid={testId}>
      <div className="px-5 pb-16 pt-3 md:px-8">{children}</div>
    </div>
  );
}

export function Toolbar({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('mb-3 flex flex-wrap items-center gap-2', className)}>{children}</div>;
}

export const VerdictBadge = ({ level }: { level: string }) => <Badge tone={VERDICT_TONE[level] ?? 'neutral'}>{VERDICT_LABEL[level] ?? level}</Badge>;

export function HandoffDialog({ title, defaultModule, defaultPriority, devStations, submitting, error, onSubmit, onClose }: {
  title: string; defaultModule?: string | undefined; defaultPriority: 'p0' | 'p1' | 'p2'; devStations: { id: string; name: string }[]; submitting: boolean; error?: string | undefined;
  onSubmit: (v: { targetWorkstationId?: string; module: string; priority: 'p0' | 'p1' | 'p2'; note?: string }) => void; onClose: () => void;
}) {
  const [target, setTarget] = useState(devStations[0]?.id ?? '');
  const [module, setModule] = useState(defaultModule ?? '');
  const [priority, setPriority] = useState(defaultPriority);
  const [note, setNote] = useState('');
  return (
    <Dialog title={title} onClose={onClose} testId="qa-handoff-dialog">
      <DialogForm error={error} submitting={submitting} submitLabel="交给开发台" canSubmit={!!module.trim() && !!target} onSubmit={() => onSubmit({ targetWorkstationId: target, module: module.trim(), priority, ...(note.trim() ? { note: note.trim() } : {}) })} onCancel={onClose}>
        <Field label="开发台" required>
          <Select value={target} onChange={(e) => setTarget(e.target.value)}>{devStations.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</Select>
        </Field>
        <Field label="改动范围" required hint="开发任务只能改这些路径，多个用逗号分隔，. 表示整个仓库">
          <Input className="measured" autoFocus value={module} onChange={(e) => setModule(e.target.value)} data-testid="qa-handoff-module" />
        </Field>
        <Field label="优先级">
          <Select value={priority} onChange={(e) => setPriority(e.target.value as 'p0' | 'p1' | 'p2')}>{(['p0', 'p1', 'p2'] as const).map((p) => <option key={p} value={p}>{p.toUpperCase()}</option>)}</Select>
        </Field>
        <Field label="备注"><Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </DialogForm>
    </Dialog>
  );
}

export interface BugDraft { title?: string; severity?: string; module?: string; steps?: string; expected?: string; actual?: string; run_id?: string; case_key?: string; case_name?: string }

export function NewBugDialog({ wsId, draft, onClose, onDone }: { wsId: string; draft: BugDraft; onClose: () => void; onDone?: (id: string) => void }) {
  const [title, setTitle] = useState(draft.title ?? '');
  const [severity, setSeverity] = useState(draft.severity ?? 'p2');
  const [module, setModule] = useState(draft.module ?? '');
  const [steps, setSteps] = useState(draft.steps ?? '');
  const [expected, setExpected] = useState(draft.expected ?? '');
  const [actual, setActual] = useState(draft.actual ?? '');
  const save = useMutation({
    meta: { silent: true },
    mutationFn: async () => unwrap(await api.workstations[':id'].entities.$post({ param: { id: wsId }, json: { entityType: 'BugReport', data: { ...draft, title: title.trim(), severity, module: module.trim(), steps, expected, actual, status: 'open' }, reason: '人工创建' } })),
    onSuccess: (r) => { onClose(); onDone?.(r.id); },
  });
  return (
    <Dialog title="新建缺陷" onClose={onClose} testId="qa-bug-dialog">
      <DialogForm error={save.error?.message} submitting={save.isPending} submitLabel="创建" canSubmit={!!title.trim()} onSubmit={() => save.mutate()} onCancel={onClose}>
        <Field label="标题" required><Input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} data-testid="qa-bug-title" /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="严重度" required hint="P0、P1 未关闭时结论是阻断">
            <Select value={severity} onChange={(e) => setSeverity(e.target.value)} data-testid="qa-bug-severity">{['p0', 'p1', 'p2', 'p3'].map((s) => <option key={s} value={s}>{s.toUpperCase()}</option>)}</Select>
          </Field>
          <Field label="模块"><Input value={module} onChange={(e) => setModule(e.target.value)} /></Field>
        </div>
        {draft.case_name && <p className="text-xs text-muted">关联用例：<span className="measured">{draft.case_name}</span>。修复后回归通过会自动验证。</p>}
        <Field label="复现步骤"><Textarea rows={3} value={steps} onChange={(e) => setSteps(e.target.value)} /></Field>
        <Field label="期望"><Textarea rows={2} value={expected} onChange={(e) => setExpected(e.target.value)} /></Field>
        <Field label="实际"><Textarea className="measured" rows={3} value={actual} onChange={(e) => setActual(e.target.value)} /></Field>
      </DialogForm>
    </Dialog>
  );
}
