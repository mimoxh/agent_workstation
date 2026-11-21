import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogForm } from '@/components/ui/dialog';
import { toast } from '@/components/ui/feedback';
import { Icon, type IconName } from '@/components/ui/icons';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import type { ProjectDetail, WorkstationDetail } from '@/lib/queries';
import { api, unwrap } from '@/lib/api';
import { cn } from '@/lib/utils';
import type { WsSearch } from '@/components/workstation/WorkstationScreen';
import { VERDICT_LABEL, VERDICT_TONE } from './model';

export const TABLE_WRAP = 'overflow-x-auto rounded-card bg-paper shadow-[var(--shadow-card)]';
export const TH = 'whitespace-nowrap border-b border-rule bg-paper-2 px-3.5 py-2.5 text-left text-xs font-semibold text-muted';
export const TD = 'border-b border-rule px-3.5 py-3 text-sm text-ink-2';
export const TABLE = 'w-full min-w-[40rem] border-collapse [&_tbody_tr:last-child>td]:border-b-0';
export const ROW = 'cursor-pointer transition-colors duration-150 hover:bg-hover';
export const HOVER_ROW = 'transition-colors duration-150 hover:bg-hover';
export const STATS = 'grid grid-cols-2 gap-3 lg:grid-cols-4';
export const LIST_ROW = 'grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-b border-rule px-4 py-3 last:border-b-0';

export type Tone = 'bad' | 'accent' | 'cool' | 'ok';
const TONE_TEXT: Record<Tone, string> = { bad: 'text-bad', accent: 'text-accent', cool: 'text-cool', ok: 'text-ok' };
const TONE_BLOCK: Record<Tone, string> = { bad: 'bg-bad-soft text-bad', accent: 'bg-accent text-accent-ink', cool: 'bg-cool-soft text-cool', ok: 'bg-ok-soft text-ok' };

export function IconBlock({ icon, tone, small }: { icon: IconName; tone?: Tone | undefined; small?: boolean }) {
  return (
    <span aria-hidden className={cn('grid shrink-0 place-items-center', small ? 'size-7 rounded-chip [&_svg]:size-3.5' : 'size-8 rounded-ctl', tone ? TONE_BLOCK[tone] : 'bg-paper-2 text-ink-2')}>
      <Icon name={icon} />
    </span>
  );
}

// 统计块：人读的数值；末尾的 % 缩小显示，文本内容不变
export function Stat({ icon, label, value, note, tone, onClick }: { icon?: IconName | undefined; label: string; value: string; note?: ReactNode; tone?: Tone | undefined; onClick?: (() => void) | undefined }) {
  const unit = value.length > 1 && value.endsWith('%');
  const body = (
    <>
      <span className="flex items-center gap-1.5 text-xs font-medium text-muted">{icon && <Icon name={icon} className="size-3.5" />}{label}</span>
      <span className={cn('text-display font-bold tabular-nums', tone ? TONE_TEXT[tone] : 'text-ink')}>
        {unit ? <>{value.slice(0, -1)}<small className="ml-1 text-sm font-medium text-muted">%</small></> : value}
      </span>
      {note && <span className="text-xs text-muted">{note}</span>}
    </>
  );
  const cls = 'grid min-w-0 content-start gap-1 rounded-card bg-paper-2 p-4 text-left text-ink';
  return onClick
    ? <button type="button" onClick={onClick} className={cn(cls, 'transition-[background-color,translate] duration-150 hover:bg-paper-3 active:translate-y-px')}>{body}</button>
    : <div className={cls}>{body}</div>;
}

export function SectionHead({ title, children, as: H = 'h2', className }: { title: ReactNode; children?: ReactNode; as?: 'h2' | 'h3'; className?: string }) {
  return (
    <div className={cn('mb-3 flex flex-wrap items-center gap-x-3 gap-y-1', className)}>
      <H className={cn('font-bold text-ink', H === 'h2' ? 'text-title' : 'text-sm')}>{title}</H>
      {children}
    </div>
  );
}

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
      <div className="px-5 pb-14 pt-4 md:px-8">{children}</div>
    </div>
  );
}

export function Toolbar({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('mb-4 flex flex-wrap items-center gap-2', className)}>{children}</div>;
}

export const VerdictBadge = ({ level }: { level: string }) => <Badge tone={VERDICT_TONE[level] ?? 'neutral'}>{VERDICT_LABEL[level] ?? level}</Badge>;

// 缺陷和用例默认在本台生成开发任务，也可以交给项目里其他开发台
export function HandoffDialog({ title, defaultModule, defaultPriority, wsId, devStations, submitting, error, onSubmit, onClose }: {
  title: string; defaultModule?: string | undefined; defaultPriority: 'p0' | 'p1' | 'p2'; wsId: string; devStations: { id: string; name: string }[]; submitting: boolean; error?: string | undefined;
  onSubmit: (v: { targetWorkstationId?: string; module: string; priority: 'p0' | 'p1' | 'p2'; note?: string }) => void; onClose: () => void;
}) {
  const [target, setTarget] = useState(devStations.find((w) => w.id === wsId)?.id ?? devStations[0]?.id ?? '');
  const [module, setModule] = useState(defaultModule ?? '');
  const [priority, setPriority] = useState(defaultPriority);
  const [note, setNote] = useState('');
  return (
    <Dialog title={title} onClose={onClose} testId="qa-handoff-dialog">
      <DialogForm error={error} submitting={submitting} submitLabel="创建开发任务" canSubmit={!!module.trim() && !!target} onSubmit={() => onSubmit({ targetWorkstationId: target, module: module.trim(), priority, ...(note.trim() ? { note: note.trim() } : {}) })} onCancel={onClose}>
        <p className="text-sm text-muted">把当前信息冻结进任务描述，起草一个开发任务，确认后由你派发给实现者。</p>
        {devStations.length > 1 && (
          <Field label="开发工作台" hint={target === wsId ? '默认本台，也可以交给项目里其他开发台' : undefined}>
            <Select value={target} onChange={(e) => setTarget(e.target.value)} data-testid="qa-handoff-target">{devStations.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</Select>
          </Field>
        )}
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
        {draft.case_name && <p className="rounded-ctl bg-paper-2 px-3.5 py-2.5 text-xs text-muted">关联用例：<span className="measured">{draft.case_name}</span>。修复后回归通过会自动验证。</p>}
        <Field label="复现步骤"><Textarea rows={3} value={steps} onChange={(e) => setSteps(e.target.value)} /></Field>
        <Field label="期望"><Textarea rows={2} value={expected} onChange={(e) => setExpected(e.target.value)} /></Field>
        <Field label="实际"><Textarea className="measured" rows={3} value={actual} onChange={(e) => setActual(e.target.value)} /></Field>
      </DialogForm>
    </Dialog>
  );
}
