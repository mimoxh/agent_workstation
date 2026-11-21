import { localDate } from '@aw/domain';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Empty, ErrorState, Loading } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/icons';
import { chipClass } from '@/components/ui/input';
import { useProjectStatus, useProjectTasks, type ProjectDetail, type ProjectTask } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { layoutGantt, type GanttBar } from './gantt';
import { PlanDialog, type PlanTask } from './PlanDialog';

const LABEL_W = 224;
const RULER_H = 34;
const MAX_W = 1600;

// 语义：完成=ok，问题=bad，机器在动=cool，草稿/等待=纸面
const BAR: Record<string, string> = {
  done: 'bg-ok text-ok-ink',
  cancelled: 'bg-paper-3 text-muted line-through shadow-[inset_0_0_0_1px_var(--color-rule-2)]',
  blocked: 'bg-bad text-bad-ink',
  escalated: 'bg-bad text-bad-ink',
  in_progress: 'bg-cool text-cool-ink',
  submitted: 'bg-cool text-cool-ink',
  reviewing: 'bg-cool text-cool-ink',
};
const barClass = (status: string) => BAR[status] ?? 'bg-paper-3 text-ink-2 shadow-[inset_0_0_0_1px_var(--color-rule-2)]';

function Bars({ bars, tasks, dayW, chartW, projectId }: { bars: GanttBar[]; tasks: ProjectTask[]; dayW: number; chartW: number; projectId: string }) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return (
    <>
      {bars.map((b) => {
        const waiting = ((b.task as ProjectTask).dependsOn ?? []).flatMap((id) => {
          const d = byId.get(id);
          return d && d.status !== 'done' ? [d.title] : [];
        });
        return (
          <div key={b.task.id} className="relative flex h-[42px] items-center border-b border-rule transition-colors duration-150 hover:bg-hover" style={{ width: LABEL_W + chartW }} data-testid="gantt-row">
            <div className="sticky left-0 z-10 flex h-full shrink-0 items-center gap-1.5 bg-paper px-3" style={{ width: LABEL_W }}>
              <Link to="/projects/$projectId/tasks/$taskId" params={{ projectId, taskId: b.task.id }} className="truncate text-xs text-ink-2 hover:text-ink hover:underline hover:decoration-rule-2 hover:underline-offset-[3px]">
                {b.task.title}
              </Link>
            </div>
            <Link
              to="/projects/$projectId/tasks/$taskId"
              params={{ projectId, taskId: b.task.id }}
              className={cn('absolute top-[9px] h-6 rounded-full transition-[filter,translate] duration-150 hover:brightness-110 active:translate-y-px', barClass(b.task.status), b.overdue && 'shadow-[0_0_0_2px_var(--color-paper),0_0_0_3.5px_var(--color-bad)]')}
              style={{ left: LABEL_W + b.left * dayW, width: Math.max(14, b.width * dayW) }}
              title={`${b.from} → ${b.to}`}
              data-testid="gantt-bar"
            />
            {waiting.length > 0 && (
              <span className="absolute top-[9px] flex h-6 items-center whitespace-nowrap text-[11px] font-medium text-accent" style={{ left: LABEL_W + (b.left + b.width) * dayW + 6 }}>
                等待：{waiting.join('、')}
              </span>
            )}
          </div>
        );
      })}
    </>
  );
}

// 跨工作台甘特图：行=任务（按工作台分组），列=天，竖线=今天与里程碑
export function GanttPanel({ project }: { project: ProjectDetail }) {
  const tasks = useProjectTasks(project.id);
  const status = useProjectStatus(project.id);
  const [all, setAll] = useState(false);
  const [plan, setPlan] = useState<PlanTask | null>(null);

  if (tasks.isLoading) return <Loading />;
  if (tasks.isError) return <ErrorState error={tasks.error} />;

  const rows = (tasks.data ?? []).filter((t) => all || !t.parentId);
  const today = status.data?.today ?? localDate();
  const layout = layoutGantt({ tasks: rows, milestones: status.data?.milestones ?? [], today });
  const dayW = Math.max(5, Math.min(24, Math.floor(MAX_W / layout.days)));
  const chartW = layout.days * dayW;
  const step = Math.ceil(layout.days / 24);
  const wsName = new Map(project.workstations.map((w) => [w.id, w.name]));
  const dated = new Set(layout.bars.map((b) => b.task.id));
  const undated = rows.filter((t) => !dated.has(t.id));
  const groups = [...new Set(layout.bars.map((b) => b.task.workstationId))];
  const ruler = Array.from({ length: Math.ceil(layout.days / step) }, (_, i) => {
    const day = new Date((layout.start + i * step) * 24 * 60 * 60 * 1000).toISOString().slice(5, 10);
    return { pos: i * step, day };
  });

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="gantt-panel">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-5 pt-2 md:px-8">
        <button type="button" aria-pressed={all} onClick={() => setAll(!all)} className={chipClass(all)} data-testid="gantt-subtasks">
          显示子任务
        </button>
        <span className="text-xs text-muted tabular-nums">{layout.bars.length} 个排期任务 · {layout.days} 天</span>
        <span className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
          <span className="flex items-center gap-1.5"><i className="size-2.5 rounded-full bg-ok" />完成</span>
          <span className="flex items-center gap-1.5"><i className="size-2.5 rounded-full bg-cool" />在动</span>
          <span className="flex items-center gap-1.5"><i className="size-2.5 rounded-full bg-bad" />受阻</span>
          <span className="flex items-center gap-1.5"><i className="size-2.5 rounded-full bg-paper-3 shadow-[inset_0_0_0_1px_var(--color-rule-2)]" />待开始</span>
        </span>
      </div>
      <div className="grid min-h-0 flex-1 content-start gap-4 overflow-y-auto px-5 pb-14 pt-3 md:px-8">
        <div className="max-w-full overflow-x-auto rounded-card bg-paper shadow-[var(--shadow-card)]">
          <div className="relative pb-2" style={{ width: LABEL_W + chartW + 40 }}>
            <div className="relative border-b border-rule" style={{ width: LABEL_W + chartW, height: RULER_H }}>
              {ruler.map((r) => (
                <span key={r.pos} className="measured absolute bottom-0 top-0 whitespace-nowrap border-l border-rule pl-1.5 pt-2.5 text-[11px] text-muted" style={{ left: LABEL_W + r.pos * dayW }}>
                  {r.day}
                </span>
              ))}
            </div>
            {groups.length === 0 && <Empty icon="gantt" title="还没有排期的任务" className="min-h-0 py-10"><p>给任务设截止日期后会出现在这里</p></Empty>}
            {groups.map((wsId) => (
              <div key={wsId}>
                <p className="sticky left-0 z-10 w-fit bg-paper px-3 pb-1 pt-3.5 text-xs font-semibold text-muted">{wsName.get(wsId) ?? wsId}</p>
                <Bars bars={layout.bars.filter((b) => b.task.workstationId === wsId)} tasks={rows} dayW={dayW} chartW={chartW} projectId={project.id} />
              </div>
            ))}
            {layout.milestones.map((m) => (
              <div key={m.id} className="pointer-events-none absolute bottom-2 w-px bg-accent" style={{ top: RULER_H, left: LABEL_W + m.pos * dayW + dayW / 2 }} data-testid="gantt-milestone">
                <span className="absolute left-[5px] top-1 flex items-center gap-1 whitespace-nowrap text-[11px] font-semibold text-accent">
                  <i className="size-[9px] shrink-0 rotate-45 rounded-[2px] bg-accent" />{m.name}
                </span>
              </div>
            ))}
            {layout.today !== null && layout.today >= 0 && layout.today < layout.days && (
              <div className="pointer-events-none absolute bottom-2 w-px bg-cool" style={{ top: RULER_H, left: LABEL_W + layout.today * dayW + dayW / 2 }} data-testid="gantt-today">
                <span className="absolute left-[5px] top-1 whitespace-nowrap text-[11px] font-semibold text-cool">今天</span>
              </div>
            )}
          </div>
        </div>
        {undated.length > 0 && (
          <div className="overflow-hidden rounded-card bg-paper shadow-[var(--shadow-card)]" data-testid="gantt-undated">
            <p className="flex items-center gap-2 border-b border-rule px-4 py-3 text-sm font-bold text-ink">未排期 <span className="font-medium tabular-nums text-muted">{undated.length}</span></p>
            <ul>
              {undated.map((t) => (
                <li key={t.id} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 border-b border-rule px-4 py-2.5 last:border-b-0 hover:bg-hover">
                  <Link to="/projects/$projectId/tasks/$taskId" params={{ projectId: project.id, taskId: t.id }} className="truncate text-sm font-medium text-ink hover:underline hover:decoration-rule-2 hover:underline-offset-[3px]">
                    {t.title}
                  </Link>
                  <span className="text-xs text-muted">{wsName.get(t.workstationId) ?? ''}</span>
                  <Button size="sm" onClick={() => setPlan(t)} data-testid="gantt-plan"><Icon name="calendar" />排期</Button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      {plan && <PlanDialog projectId={project.id} task={plan} onClose={() => setPlan(null)} />}
    </div>
  );
}
