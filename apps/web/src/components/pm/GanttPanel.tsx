import { localDate } from '@aw/domain';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Empty, ErrorState, Loading } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/icons';
import { useProjectStatus, useProjectTasks, type ProjectDetail, type ProjectTask } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { layoutGantt, type GanttBar } from './gantt';
import { PlanDialog, type PlanTask } from './PlanDialog';

const LABEL_W = 224;
const MAX_W = 1600;

// 语义：完成=ok，问题=bad，机器在动=cool，草稿/等待=纸面
const BAR: Record<string, string> = {
  done: 'bg-ok text-primary-ink',
  cancelled: 'bg-faint text-primary-ink line-through',
  blocked: 'bg-bad text-primary-ink',
  escalated: 'bg-bad text-primary-ink',
  in_progress: 'bg-cool text-primary-ink',
  submitted: 'bg-cool text-primary-ink',
  reviewing: 'bg-cool text-primary-ink',
};
const barClass = (status: string) => BAR[status] ?? 'bg-paper-3 text-ink-2 border border-rule-2';

function Bars({ bars, tasks, dayW, projectId }: { bars: GanttBar[]; tasks: ProjectTask[]; dayW: number; projectId: string }) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return (
    <>
      {bars.map((b) => {
        const waiting = ((b.task as ProjectTask).dependsOn ?? []).flatMap((id) => {
          const d = byId.get(id);
          return d && d.status !== 'done' ? [d.title] : [];
        });
        return (
          <div key={b.task.id} className="relative flex h-8 items-center border-b border-rule/60" style={{ width: LABEL_W + 1 }} data-testid="gantt-row">
            <div className="sticky left-0 z-10 flex h-full shrink-0 items-center gap-1.5 bg-paper px-3" style={{ width: LABEL_W }}>
              <Link to="/projects/$projectId/tasks/$taskId" params={{ projectId, taskId: b.task.id }} className="truncate text-xs text-ink-2 hover:underline">
                {b.task.title}
              </Link>
            </div>
            <Link
              to="/projects/$projectId/tasks/$taskId"
              params={{ projectId, taskId: b.task.id }}
              className={cn('absolute top-1.5 h-5 rounded-pill px-2 text-[11px] leading-5 hover:brightness-110', barClass(b.task.status), b.overdue && 'shadow-[0_0_0_1.5px_var(--color-bad)]')}
              style={{ left: LABEL_W + b.left * dayW, width: Math.max(14, b.width * dayW) }}
              title={`${b.from} → ${b.to}`}
              data-testid="gantt-bar"
            />
            {waiting.length > 0 && (
              <span className="absolute top-1.5 whitespace-nowrap text-[11px] leading-5 text-accent" style={{ left: LABEL_W + (b.left + b.width) * dayW + 6 }}>
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
      <div className="flex items-center gap-3 px-6 pt-3">
        <button type="button" aria-pressed={all} onClick={() => setAll(!all)} className="rounded-pill px-2 py-0.5 text-xs text-muted aria-pressed:bg-paper-3 aria-pressed:text-ink" data-testid="gantt-subtasks">
          显示子任务
        </button>
        <span className="measured text-xs text-muted">{layout.bars.length} 个排期任务 · {layout.days} 天</span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-6 py-3">
        <div className="relative" style={{ width: LABEL_W + chartW + 40 }}>
          <div className="relative flex h-7 items-end border-b border-rule" style={{ width: LABEL_W + chartW }}>
            {ruler.map((r) => (
              <span key={r.pos} className="measured absolute pb-0.5 text-[10px] text-faint" style={{ left: LABEL_W + r.pos * dayW }}>
                {r.day}
              </span>
            ))}
          </div>
          {groups.length === 0 && <Empty title="还没有排期的任务" className="py-8"><p>给任务设截止日期后会出现在这里</p></Empty>}
          {groups.map((wsId) => (
            <div key={wsId}>
              <p className="sticky left-0 z-10 w-fit bg-paper px-3 pb-1 pt-3 text-xs font-semibold text-faint">{wsName.get(wsId) ?? wsId}</p>
              <Bars bars={layout.bars.filter((b) => b.task.workstationId === wsId)} tasks={rows} dayW={dayW} projectId={project.id} />
            </div>
          ))}
          {layout.milestones.map((m) => (
            <div key={m.id} className="pointer-events-none absolute bottom-0 top-7 w-px bg-accent" style={{ left: LABEL_W + m.pos * dayW + dayW / 2 }} data-testid="gantt-milestone">
              <span className="absolute -left-1 top-0 flex items-center gap-0.5 whitespace-nowrap text-[10px] font-medium text-accent">
                <Icon name="flag" className="size-2.5" />{m.name}
              </span>
            </div>
          ))}
          {layout.today !== null && layout.today >= 0 && layout.today < layout.days && (
            <div className="pointer-events-none absolute bottom-0 top-7 w-px bg-cool" style={{ left: LABEL_W + layout.today * dayW + dayW / 2 }} data-testid="gantt-today">
              <span className="absolute -left-1 top-0 whitespace-nowrap text-[10px] text-cool">今天</span>
            </div>
          )}
          {undated.length > 0 && (
            <div className="border-t border-rule pt-3" data-testid="gantt-undated">
              <p className="pb-1 text-xs font-semibold text-faint">未排期 <span className="measured">{undated.length}</span></p>
              <ul>
                {undated.map((t) => (
                  <li key={t.id} className="flex items-center gap-2 py-1">
                    <Link to="/projects/$projectId/tasks/$taskId" params={{ projectId: project.id, taskId: t.id }} className="min-w-0 flex-1 truncate text-sm text-ink-2 hover:underline">
                      {t.title}
                    </Link>
                    <span className="shrink-0 text-xs text-muted">{wsName.get(t.workstationId) ?? ''}</span>
                    <Button size="sm" variant="quiet" onClick={() => setPlan(t)} data-testid="gantt-plan">排期</Button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
      {plan && <PlanDialog projectId={project.id} task={plan} onClose={() => setPlan(null)} />}
    </div>
  );
}
