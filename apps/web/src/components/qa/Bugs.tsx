import { useMutation } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { Segmented } from '@/components/design/panes';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Empty, Loading } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/icons';
import { api, unwrap } from '@/lib/api';
import { when } from '@/lib/format';
import { useQaHandoffs } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { BUG_LABEL, BUG_TONE, SEVERITY_TONE, useDocs, type BugData, type Doc } from './model';
import { HandoffDialog, NewBugDialog, ROW, Scroll, TABLE, TD, TH, Toolbar, type QaProps } from './shared';

type Event = 'confirm' | 'dev_done' | 'verify_pass' | 'verify_fail' | 'reject' | 'reopen';
type Filter = 'todo' | 'fixing' | 'closed' | 'all';

const TODO = ['draft', 'open', 'reopened', 'verifying'];
const CLOSED = ['verified', 'wontfix'];
const SEVERITY_ORDER: Record<string, number> = { p0: 0, p1: 1, p2: 2, p3: 3 };

function Section({ label, text }: { label: string; text: string | undefined }) {
  if (!text) return null;
  return <div className="mt-3"><p className="text-xs text-muted">{label}</p><p className="mt-0.5 whitespace-pre-wrap break-words text-sm text-ink-2">{text}</p></div>;
}

function BugDetail({ doc, project, go, onClose }: { doc: Doc<BugData>; project: QaProps['project']; go: QaProps['go']; onClose: () => void }) {
  const d = doc.data;
  const status = d.status ?? 'open';
  const [handing, setHanding] = useState(false);
  const act = useMutation({
    mutationFn: async (event: Event) => unwrap(await api['qa-bugs'][':id'].transition.$post({ param: { id: doc.id }, json: { event } })),
  });
  const handoff = useMutation({
    meta: { silent: true },
    mutationFn: async (v: { targetWorkstationId?: string; module: string; priority: 'p0' | 'p1' | 'p2'; note?: string }) => unwrap(await api['qa-bugs'][':id'].handoff.$post({ param: { id: doc.id }, json: v })),
    onSuccess: () => setHanding(false),
  });
  const devStations = project.workstations.filter((w) => w.pluginId === 'dev').map((w) => ({ id: w.id, name: w.name }));
  const severity = d.severity === 'p0' || d.severity === 'p1' || d.severity === 'p2' ? d.severity : 'p2';
  const btn = (event: Event, label: string, primary = false) => <Button variant={primary ? 'primary' : 'default'} disabled={act.isPending} onClick={() => act.mutate(event)} data-testid={`qa-bug-${event}`}>{label}</Button>;
  return (
    <Dialog title={d.title} onClose={onClose} testId="qa-bug-detail" className="w-[40rem]">
      <div className="-mt-2 flex flex-wrap items-center gap-2">
        <Badge tone={SEVERITY_TONE[d.severity] ?? 'neutral'}>{d.severity.toUpperCase()}</Badge>
        <Badge tone={BUG_TONE[status] ?? 'neutral'} data-testid="qa-bug-status">{BUG_LABEL[status] ?? status}</Badge>
        {d.module && <code className="measured text-xs text-muted">{d.module}</code>}
        <span className="text-xs text-muted">{doc.authorType === 'agent' ? 'Agent 起草' : '人工创建'} · {when(doc.createdAt)}</span>
      </div>
      {d.case_name && <p className="mt-3 text-sm text-ink-2">关联用例 <code className="measured text-xs">{d.case_name}</code>{status === 'verifying' ? '，回归通过后自动验证' : ''}</p>}
      {d.run_id && <Button variant="quiet" size="sm" className="-ml-2 mt-1" onClick={() => { onClose(); go('runs', d.run_id); }}>查看失败的运行</Button>}
      <Section label="复现步骤" text={d.steps} />
      <Section label="期望" text={d.expected} />
      <Section label="实际" text={d.actual} />
      {d.handoff && (
        <p className="mt-3 text-sm text-ink-2">开发任务：<Link to="/projects/$projectId/tasks/$taskId" params={{ projectId: project.id, taskId: d.handoff.taskId }} className="text-cool hover:underline">打开</Link></p>
      )}
      {status === 'verifying' && !d.case_key && <p className="mt-3 rounded-pill bg-accent-soft p-2.5 text-sm text-accent">这个缺陷没有关联自动化用例，需要你手工验证。</p>}
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        {status === 'draft' && btn('reject', '驳回')}
        {status === 'draft' && btn('confirm', '确认缺陷', true)}
        {(status === 'open' || status === 'reopened') && btn('reject', '不修复')}
        {(status === 'open' || status === 'reopened') && <Button variant="primary" onClick={() => setHanding(true)} data-testid="qa-bug-handoff">派给开发台</Button>}
        {status === 'fixing' && btn('dev_done', '已修复，进入验证')}
        {status === 'verifying' && btn('verify_fail', '验证未通过')}
        {status === 'verifying' && btn('verify_pass', '验证通过', true)}
        {(status === 'verified' || status === 'wontfix') && btn('reopen', '重开')}
        <Button variant="quiet" onClick={onClose}>关闭</Button>
      </div>
      {handing && <HandoffDialog title="派给开发台" defaultModule={d.module} defaultPriority={severity} devStations={devStations} submitting={handoff.isPending} error={handoff.error?.message} onSubmit={(v) => handoff.mutate(v)} onClose={() => setHanding(false)} />}
    </Dialog>
  );
}

export function Bugs({ ws, project, item, go }: QaProps) {
  const { docs, isLoading } = useDocs<BugData>(ws.id, 'BugReport');
  const handoffs = useQaHandoffs(ws.id);
  const [filter, setFilter] = useState<Filter>('todo');
  const [creating, setCreating] = useState(false);
  const shown = useMemo(() => docs.filter((b) => {
    const s = b.data.status ?? 'open';
    return filter === 'all' || (filter === 'todo' ? TODO.includes(s) : filter === 'closed' ? CLOSED.includes(s) : s === 'fixing');
  }).sort((a, b) => (SEVERITY_ORDER[a.data.severity] ?? 9) - (SEVERITY_ORDER[b.data.severity] ?? 9) || b.createdAt.localeCompare(a.createdAt)), [docs, filter]);
  const open = docs.find((b) => b.id === item);
  if (isLoading) return <Loading />;
  const tasks = handoffs.data as Record<string, { status: string; stage: string | null }> | undefined;
  return (
    <Scroll testId="qa-bugs">
      <Toolbar>
        <Segmented label="缺陷筛选" value={filter} onChange={setFilter} options={[{ id: 'todo', label: '待处理' }, { id: 'fixing', label: '修复中' }, { id: 'closed', label: '已关闭' }, { id: 'all', label: `全部 ${docs.length}` }]} />
        <span className="flex-1" />
        <Button variant="primary" onClick={() => setCreating(true)} data-testid="qa-bug-new"><Icon name="plus" className="size-3.5" />新建缺陷</Button>
      </Toolbar>
      {docs.length === 0 ? <Empty title="还没有缺陷">在失败的运行里点「建缺陷」，或让失败分析起草。</Empty> : shown.length === 0 ? <p className="py-2 text-sm text-muted">这个分类下没有缺陷。</p> : (
        <div className="overflow-x-auto">
          <table className={TABLE} data-testid="qa-bug-table">
            <thead><tr className="border-b border-rule"><th className={TH}>严重度</th><th className={TH}>标题</th><th className={TH}>状态</th><th className={TH}>开发任务</th><th className={cn(TH, 'text-right')}>创建</th></tr></thead>
            <tbody>
              {shown.map((b) => {
                const s = b.data.status ?? 'open';
                const t = b.data.handoff ? tasks?.[b.data.handoff.taskId] : undefined;
                return (
                  <tr key={b.id} className={ROW} onClick={() => go('bugs', b.id)} data-testid="qa-bug-row">
                    <td className={cn(TD, 'w-16')}><Badge tone={SEVERITY_TONE[b.data.severity] ?? 'neutral'}>{b.data.severity.toUpperCase()}</Badge></td>
                    <td className={cn(TD, 'max-w-96 truncate text-ink')}>{b.data.title}</td>
                    <td className={TD}><Badge tone={BUG_TONE[s] ?? 'neutral'}>{BUG_LABEL[s] ?? s}</Badge></td>
                    <td className={cn(TD, 'text-xs')}>{t ? `${t.stage ?? t.status}` : '—'}</td>
                    <td className={cn(TD, 'measured text-right text-xs')}>{when(b.createdAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {open && <BugDetail key={open.id} doc={open} project={project} go={go} onClose={() => go('bugs')} />}
      {creating && <NewBugDialog wsId={ws.id} draft={{}} onClose={() => setCreating(false)} onDone={(id) => go('bugs', id)} />}
    </Scroll>
  );
}
