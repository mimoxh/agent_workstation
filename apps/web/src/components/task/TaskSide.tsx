import type { TaskStatus } from '@aw/domain';
import { Link } from '@tanstack/react-router';
import { STATUS_LABEL, STATUS_TONE } from '@/components/board/labels';
import { TeamPulse } from '@/components/team/TeamPulse';
import { Badge } from '@/components/ui/badge';
import { parseJson } from '@/lib/format';
import type { TaskDetail, WorkstationDetail } from '@/lib/queries';
import { cn } from '@/lib/utils';

function Lanes({ detail, projectId }: { detail: TaskDetail; projectId: string }) {
  const stages = detail.flow.stages;
  return (
    <section className="border-t border-rule" aria-label="子任务">
      <h2 className="px-3.5 pb-1.5 pt-3.5 text-xs font-semibold text-faint">子任务 <span className="measured text-xs">{detail.children.length}</span></h2>
      <ul data-testid="subtask-lanes">
        {detail.children.map((c) => {
          const at = stages.findIndex((s) => s.id === c.stage);
          const finished = c.status === 'done';
          return (
            <li key={c.id} className="space-y-1 border-t border-rule px-3 py-1.5">
              <div className="flex items-center gap-2">
                <Link to="/projects/$projectId/tasks/$taskId" params={{ projectId, taskId: c.id }} className="min-w-0 flex-1 truncate text-sm text-ink-2 hover:underline">{c.title}</Link>
                <Badge tone={STATUS_TONE[c.status as TaskStatus] ?? 'neutral'}>{STATUS_LABEL[c.status as TaskStatus] ?? c.status}</Badge>
              </div>
              {stages.length > 0 && (
                <span className="flex gap-1" aria-label={`阶段 ${at + 1}/${stages.length}`}>
                  {stages.map((s, i) => <i key={s.id} className={cn('h-[3px] w-4 rounded-full', finished || i < at ? 'bg-cool' : i === at ? 'bg-accent' : 'bg-rule')} />)}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Contract({ detail }: { detail: TaskDetail }) {
  const { task } = detail;
  const input = Object.entries(parseJson<Record<string, unknown>>(task.inputJson, {})).filter(([k]) => k !== 'title');
  const ref = parseJson<{ branch?: string; worktree?: string; merge_sha?: string } | null>(task.codeRefJson, null);
  if (input.length === 0 && !ref) return null;
  const rows: [string, string][] = [
    ...input.map(([k, v]): [string, string] => [k, typeof v === 'string' ? v : JSON.stringify(v)]),
    ...(ref?.branch ? ([['分支', ref.branch]] as [string, string][]) : []),
    ...(ref?.worktree ? ([['worktree', ref.worktree]] as [string, string][]) : []),
    ...(ref?.merge_sha ? ([['合并提交', ref.merge_sha.slice(0, 10)]] as [string, string][]) : []),
  ];
  return (
    <section className="border-t border-rule px-3 py-2.5" aria-label="契约与代码">
      <h2 className="pb-1.5 text-xs font-semibold text-faint">契约与代码</h2>
      <dl className="space-y-1">
        {rows.map(([k, v]) => (
          <div key={k} className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-2 text-xs">
            <dt className="text-muted">{k}</dt>
            <dd className="min-w-0 break-words"><code className="text-ink-2">{v}</code></dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function RelatedPanels({ detail, ws, projectId }: { detail: TaskDetail; ws: WorkstationDetail | undefined; projectId: string }) {
  const stage = detail.flow.stages.find((s) => s.id === detail.task.stage);
  const panels = (stage?.activePanels ?? []).flatMap((id) => ws?.blocks.filter((b) => b.panelId === id) ?? []);
  if (panels.length === 0) return null;
  return (
    <section className="border-t border-rule px-3 py-2.5" aria-label="本阶段相关板块">
      <h2 className="pb-1.5 text-xs font-semibold text-faint">本阶段相关板块</h2>
      <div className="flex flex-wrap gap-1.5">
        {panels.map((b) => (
          <Link key={b.id} to="/projects/$projectId/ws/$wsId" params={{ projectId, wsId: detail.flow.workstationId }} search={{ panel: b.panelId ?? '' }} className="rounded-chip bg-tag px-1.5 py-0.5 text-xs text-tag-ink hover:bg-paper-3">
            {b.name}
          </Link>
        ))}
      </div>
    </section>
  );
}

// 任务协作室右栏：谁在参与、子任务走到哪、契约写了什么
export function TaskSide({ detail, ws, projectId, names }: { detail: TaskDetail; ws: WorkstationDetail | undefined; projectId: string; names: Record<string, string> }) {
  const stage = detail.flow.stages.find((s) => s.id === detail.task.stage);
  const home = new Set([detail.flow.workstationId, detail.task.workstationId]);
  return (
    <aside className="flex h-full min-h-0 w-[19rem] shrink-0 flex-col overflow-y-auto border-l border-rule bg-paper max-lg:hidden" aria-label="参与者与子任务">
      <TeamPulse projectId={projectId} names={names} only={(a) => home.has(a.workstationId)} {...(stage ? { highlightTemplates: stage.activeAgents } : {})} />
      {detail.children.length > 0 && <Lanes detail={detail} projectId={projectId} />}
      <RelatedPanels detail={detail} ws={ws} projectId={projectId} />
      <Contract detail={detail} />
    </aside>
  );
}
