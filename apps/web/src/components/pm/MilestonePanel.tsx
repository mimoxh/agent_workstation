import type { TaskStatus } from '@aw/domain';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { STATUS_LABEL, STATUS_TONE } from '@/components/board/labels';
import { EntityDialog, type EntityDef } from '@/components/panels/EntityPanel';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Empty, ErrorState, Loading } from '@/components/ui/feedback';
import { useProjectStatus, useProjectTasks, useWsEntities, type EntityRow, type ProjectDetail, type WorkstationDetail } from '@/lib/queries';
import { cn } from '@/lib/utils';

const QA_LEVEL_LABEL: Record<string, string> = { ready: '可发布', risk: '有风险', blocked: '阻断' };
const QA_LEVEL_TONE: Record<string, 'ok' | 'amber' | 'bad' | 'neutral'> = { ready: 'ok', risk: 'amber', blocked: 'bad' };

// 里程碑行：进度条 + 状态徽标 + 可展开的关联任务
function Row({ ms, tasks, projectId, editable, onEdit }: { ms: { id: string; name: string; due: string | null; total: number; done: number; overdue: boolean; atRisk: boolean; qa: { planName: string; level: string } | null }; tasks: { id: string; title: string; status: string }[]; projectId: string; editable: boolean; onEdit: () => void }) {
  const [open, setOpen] = useState(false);
  const pct = ms.total > 0 ? Math.round((ms.done / ms.total) * 100) : 0;
  return (
    <li className="relative border-b border-l border-rule border-l-rule-2 py-3 pl-5 before:absolute before:-left-1 before:top-5 before:size-[7px] before:rounded-full before:bg-cool">
      <div className="flex items-center gap-3">
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="min-w-0 flex-1 truncate text-left text-md text-ink hover:underline">
          {ms.name}
        </button>
        {ms.due && <span className="measured text-xs text-muted">{ms.due}</span>}
        {ms.qa && <Badge tone={QA_LEVEL_TONE[ms.qa.level] ?? 'neutral'} title={ms.qa.planName}>测试结论：{QA_LEVEL_LABEL[ms.qa.level] ?? ms.qa.level}（{ms.qa.planName}）</Badge>}
        {ms.overdue && <Badge tone="bad">已逾期</Badge>}
        {ms.atRisk && <Badge tone="amber">有风险</Badge>}
        {ms.total > 0 && ms.done === ms.total && <Badge tone="ok">已完成</Badge>}
        {editable && (
          <Button size="sm" variant="quiet" onClick={onEdit} data-testid="milestone-edit">修改</Button>
        )}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-paper-3">
          <i className={cn('block h-full rounded-full', ms.overdue ? 'bg-bad' : 'bg-ok')} style={{ width: `${pct}%` }} />
        </span>
        <span className="measured shrink-0 text-xs text-muted">{ms.done}/{ms.total}</span>
      </div>
      {open && (
        <ul className="mt-2 space-y-1 pl-2">
          {tasks.length === 0 && <li className="text-xs text-muted">还没有任务关联这个里程碑</li>}
          {tasks.map((t) => (
            <li key={t.id} className="flex items-center gap-2">
              <Link to="/projects/$projectId/tasks/$taskId" params={{ projectId, taskId: t.id }} className="min-w-0 flex-1 truncate text-sm text-ink-2 hover:underline">
                {t.title}
              </Link>
              <Badge tone={STATUS_TONE[t.status as TaskStatus] ?? 'neutral'}>{STATUS_LABEL[t.status as TaskStatus] ?? t.status}</Badge>
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

  return (
    <div className="h-full overflow-y-auto" data-testid="milestone-panel">
      <div className="flex items-center justify-between px-6 pt-4">
        <p className="text-sm text-muted">{def.label ?? '里程碑'} <span className="measured">{milestones.length}</span></p>
        {editable && <Button variant="primary" onClick={() => setDialog({})}>新建{def.label ?? '里程碑'}</Button>}
      </div>
      {milestones.length === 0 ? (
        <Empty title={`还没有${def.label ?? '里程碑'}`}>
          <p>{def.description}</p>
          {editable && <Button variant="primary" className="mt-3" onClick={() => setDialog({})}>新建{def.label ?? '里程碑'}</Button>}
        </Empty>
      ) : (
        <ol className="px-6 py-3">
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
      )}
      {dialog && <EntityDialog wsId={ws.id} entityType="Milestone" def={def} row={dialog.row} onClose={() => setDialog(null)} />}
    </div>
  );
}
