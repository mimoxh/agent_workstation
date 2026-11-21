import type { TaskStatus } from '@aw/domain';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { STATUS_LABEL, STATUS_TONE } from '@/components/board/labels';
import { EntityDialog, type EntityDef } from '@/components/panels/EntityPanel';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Empty, ErrorState, Loading } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/icons';
import { useProjectStatus, useProjectTasks, useWsEntities, type EntityRow, type ProjectDetail, type WorkstationDetail } from '@/lib/queries';
import { cn } from '@/lib/utils';

const QA_LEVEL_LABEL: Record<string, string> = { ready: '可发布', risk: '有风险', blocked: '阻断' };
const QA_LEVEL_TONE: Record<string, 'ok' | 'amber' | 'bad' | 'neutral'> = { ready: 'ok', risk: 'amber', blocked: 'bad' };

// 里程碑行：进度条 + 状态徽标 + 可展开的关联任务
function Row({ ms, tasks, projectId, editable, onEdit }: { ms: { id: string; name: string; due: string | null; total: number; done: number; overdue: boolean; atRisk: boolean; qa: { planName: string; level: string } | null }; tasks: { id: string; title: string; status: string }[]; projectId: string; editable: boolean; onEdit: () => void }) {
  const [open, setOpen] = useState(false);
  const pct = ms.total > 0 ? Math.round((ms.done / ms.total) * 100) : 0;
  const complete = ms.total > 0 && ms.done === ms.total;
  const bar = ms.overdue ? 'bg-bad' : ms.atRisk ? 'bg-accent' : complete ? 'bg-ok' : 'bg-cool';
  return (
    <li className="grid gap-3 rounded-card bg-paper p-4 shadow-[var(--shadow-card)]">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex min-w-0 max-w-full items-center gap-1.5 text-left text-sm font-bold text-ink hover:underline hover:decoration-rule-2 hover:underline-offset-[3px]">
          <Icon name="chev-r" className={cn('size-3.5 text-muted transition-transform duration-150', open && 'rotate-90')} />
          <span className="truncate">{ms.name}</span>
        </button>
        {ms.due && <Badge tone="line"><Icon name="calendar" /><span className="measured">{ms.due}</span></Badge>}
        {ms.qa && <Badge tone={QA_LEVEL_TONE[ms.qa.level] ?? 'neutral'} title={ms.qa.planName}>测试结论：{QA_LEVEL_LABEL[ms.qa.level] ?? ms.qa.level}（{ms.qa.planName}）</Badge>}
        {ms.overdue && <Badge tone="bad">已逾期</Badge>}
        {ms.atRisk && <Badge tone="amber">有风险</Badge>}
        {complete && <Badge tone="ok">已完成</Badge>}
        {editable && (
          <Button size="sm" variant="quiet" className="ml-auto" onClick={onEdit} data-testid="milestone-edit">修改</Button>
        )}
      </div>
      <div className="grid gap-1.5">
        <div className="flex justify-between gap-2 text-xs text-muted">
          <span>关联任务完成</span>
          <span className="font-semibold tabular-nums text-ink">{ms.done} / {ms.total}</span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-paper-3">
          <div className={cn('h-full rounded-full transition-[width] duration-500', bar)} style={{ width: `${pct}%` }} />
        </div>
      </div>
      {open && (
        <ul className="grid gap-1.5 border-t border-rule pt-3">
          {tasks.length === 0 && <li className="text-xs text-muted">还没有任务关联这个里程碑</li>}
          {tasks.map((t) => (
            <li key={t.id} className="flex items-center gap-2">
              <Badge tone={STATUS_TONE[t.status as TaskStatus] ?? 'neutral'}>{STATUS_LABEL[t.status as TaskStatus] ?? t.status}</Badge>
              <Link to="/projects/$projectId/tasks/$taskId" params={{ projectId, taskId: t.id }} className="min-w-0 flex-1 truncate text-sm text-ink-2 hover:text-ink hover:underline hover:decoration-rule-2 hover:underline-offset-[3px]">
                {t.title}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

// 里程碑板块：进度数据来自项目进展接口，编辑复用实体对话框
export function MilestonePanel({ ws, project, def, editable }: { ws: WorkstationDetail; project: ProjectDetail; def: EntityDef; editable: boolean }) {
  const status = useProjectStatus(project.id);
  const tasks = useProjectTasks(project.id);
  const entities = useWsEntities(ws.id).data?.entities ?? [];
  const [dialog, setDialog] = useState<{ row?: EntityRow } | null>(null);

  if (status.isLoading) return <Loading />;
  if (status.isError) return <ErrorState error={status.error} />;
  const milestones = status.data?.milestones ?? [];
  const byMs = new Map<string, { id: string; title: string; status: string }[]>();
  for (const t of tasks.data ?? []) {
    if (!t.milestoneId || t.status === 'cancelled') continue;
    byMs.set(t.milestoneId, [...(byMs.get(t.milestoneId) ?? []), t]);
  }
  const rowOf = (id: string) => entities.find((e) => e.id === id);
  const stats = [
    { label: def.label ?? '里程碑', icon: 'flag' as const, value: milestones.length, tone: '' },
    { label: '有风险', icon: 'alert' as const, value: milestones.filter((m) => m.atRisk).length, tone: 'text-accent' },
    { label: '已逾期', icon: 'clock' as const, value: milestones.filter((m) => m.overdue).length, tone: 'text-bad' },
    { label: '已完成', icon: 'check' as const, value: milestones.filter((m) => m.total > 0 && m.done === m.total).length, tone: 'text-ok' },
  ];

  return (
    <div className="h-full overflow-y-auto" data-testid="milestone-panel">
      <div className="flex items-center justify-between gap-3 px-5 pt-2 md:px-8">
        <p className="text-sm text-muted">{def.label ?? '里程碑'} <span className="tabular-nums">{milestones.length}</span></p>
        {editable && <Button variant="primary" onClick={() => setDialog({})}><Icon name="plus" />新建{def.label ?? '里程碑'}</Button>}
      </div>
      {milestones.length === 0 ? (
        <Empty icon="flag" title={`还没有${def.label ?? '里程碑'}`}>
          <p>{def.description}</p>
          {editable && <Button variant="primary" className="mt-3" onClick={() => setDialog({})}>新建{def.label ?? '里程碑'}</Button>}
        </Empty>
      ) : (
        <div className="grid gap-6 px-5 pb-14 pt-4 md:px-8">
          <div className="grid grid-cols-4 gap-3 max-lg:grid-cols-2">
            {stats.map((s) => (
              <div key={s.label} className="grid content-start gap-1 rounded-card bg-paper-2 p-4">
                <span className="flex items-center gap-1.5 text-xs font-medium text-muted"><Icon name={s.icon} className="size-3.5" />{s.label}</span>
                <span className={cn('text-display font-bold tabular-nums text-ink', s.value > 0 && s.tone)}>{s.value}</span>
              </div>
            ))}
          </div>
          <ol className="grid gap-3">
          {milestones.map((m) => (
            <Row
              key={m.id}
              ms={m}
              tasks={byMs.get(m.id) ?? []}
              projectId={project.id}
              editable={editable}
              onEdit={() => { const r = rowOf(m.id); if (r) setDialog({ row: r }); }}
            />
          ))}
          </ol>
        </div>
      )}
      {dialog && <EntityDialog wsId={ws.id} entityType="Milestone" def={def} row={dialog.row} onClose={() => setDialog(null)} />}
    </div>
  );
}
