import type { TaskStatus } from '@aw/domain';
import { useMutation } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { STATUS_LABEL, STATUS_TONE } from '@/components/board/labels';
import { PlanDialog } from '@/components/pm/PlanDialog';
import { TeamPulse } from '@/components/team/TeamPulse';
import { setDock } from '@/components/workstation/dock';
import { isDockBlock } from '@/components/workstation/home';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/icons';
import { chipClass } from '@/components/ui/input';
import { api, unwrap } from '@/lib/api';
import { parseJson } from '@/lib/format';
import { useTaskQuality, type TaskDetail, type WorkstationDetail } from '@/lib/queries';
import { cn } from '@/lib/utils';

const SECTION = 'grid gap-2.5 border-t border-rule px-4 py-4';
const HEAD = 'flex items-center gap-2 text-sm font-bold text-ink';
const KV = 'grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm';

function Lanes({ detail, projectId }: { detail: TaskDetail; projectId: string }) {
  const stages = detail.flow.stages;
  return (
    <section className={SECTION} aria-label="子任务">
      <h2 className={HEAD}>子任务 <span className="font-medium tabular-nums text-muted">{detail.children.length}</span></h2>
      <ul className="grid gap-1.5" data-testid="subtask-lanes">
        {detail.children.map((c) => {
          const at = stages.findIndex((s) => s.id === c.stage);
          const finished = c.status === 'done';
          return (
            <li key={c.id} className="grid gap-1.5 rounded-chip bg-paper-2 px-2.5 py-2 transition-colors duration-150 hover:bg-paper-3">
              <div className="flex items-center gap-2">
                <Link to="/projects/$projectId/tasks/$taskId" params={{ projectId, taskId: c.id }} className="min-w-0 flex-1 truncate text-sm text-ink-2 hover:text-ink hover:underline">{c.title}</Link>
                <Badge tone={STATUS_TONE[c.status as TaskStatus] ?? 'neutral'}>{STATUS_LABEL[c.status as TaskStatus] ?? c.status}</Badge>
              </div>
              {stages.length > 0 && (
                <span className="flex gap-[3px]" aria-label={`阶段 ${at + 1}/${stages.length}`}>
                  {stages.map((s, i) => <i key={s.id} className={cn('h-[3px] w-4 rounded-[2px]', finished || i < at ? 'bg-cool' : i === at ? 'bg-accent' : 'bg-rule-2')} />)}
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
    <section className={SECTION} aria-label="契约与代码">
      <h2 className={HEAD}>契约与代码</h2>
      <dl className={KV}>
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
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
    <section className={SECTION} aria-label="本阶段相关板块">
      <h2 className={HEAD}>本阶段相关板块</h2>
      <div className="flex flex-wrap gap-1.5">
        {panels.map((b) =>
          // 右侧栏的板块就地打开，不离开任务页
          isDockBlock(b) ? (
            <button key={b.id} type="button" onClick={() => setDock(b.panelId)} className={chipClass(false)} data-testid={`related-dock-${b.panelId}`}>
              {b.name}
            </button>
          ) : (
            <Link key={b.id} to="/projects/$projectId/ws/$wsId" params={{ projectId, wsId: detail.flow.workstationId }} search={{ panel: b.panelId ?? '' }} className={chipClass(false)}>
              {b.name}
            </Link>
          ),
        )}
      </div>
    </section>
  );
}

function DepList({ label, rows, projectId }: { label: string; rows: { id: string; title: string; status: string }[]; projectId: string }) {
  if (rows.length === 0) return null;
  return (
    <div className="grid gap-1.5">
      <p className="text-xs text-muted">{label}</p>
      <ul className="grid gap-1.5">
        {rows.map((d) => (
          <li key={d.id} className="flex items-center gap-2 rounded-chip bg-paper-2 px-2.5 py-[7px] transition-colors duration-150 hover:bg-paper-3">
            <Link to="/projects/$projectId/tasks/$taskId" params={{ projectId, taskId: d.id }} className="min-w-0 flex-1 truncate text-sm text-ink-2 hover:text-ink hover:underline">{d.title}</Link>
            <Badge tone={STATUS_TONE[d.status as TaskStatus] ?? 'neutral'}>{STATUS_LABEL[d.status as TaskStatus] ?? d.status}</Badge>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Plan({ detail, projectId }: { detail: TaskDetail; projectId: string }) {
  const { task } = detail;
  const [edit, setEdit] = useState(false);
  const terminal = task.status === 'done' || task.status === 'cancelled';
  return (
    <section className={SECTION} aria-label="计划">
      <div className="flex items-center justify-between gap-2">
        <h2 className={HEAD}>计划</h2>
        {!terminal && <Button size="sm" variant="quiet" className="-my-1" onClick={() => setEdit(true)} data-testid="plan-edit"><Icon name="edit" />编辑</Button>}
      </div>
      <dl className={KV}>
        {([
          ['开始', task.startAt],
          ['截止', task.dueAt],
          ['里程碑', detail.milestone?.name],
        ] as [string, string | null | undefined][]).map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted">{k}</dt>
            <dd className="min-w-0 break-words">{v ? <span className="tabular-nums">{v}</span> : <span className="text-faint">—</span>}</dd>
          </div>
        ))}
      </dl>
      <DepList label="前置" rows={detail.dependsOn} projectId={projectId} />
      <DepList label="后续" rows={detail.dependents} projectId={projectId} />
      {edit && (
        <PlanDialog
          projectId={projectId}
          task={{ id: task.id, title: task.title, startAt: task.startAt, dueAt: task.dueAt, milestoneId: task.milestoneId, dependsOn: detail.dependsOn.map((d) => d.id) }}
          onClose={() => setEdit(false)}
        />
      )}
    </section>
  );
}

// 合并后本台的测试套件有没有在这次合并之上的提交跑过；回归失败可以直接回滚
function PostMerge({ detail, projectId }: { detail: TaskDetail; projectId: string }) {
  const { task } = detail;
  const merged = !!parseJson<{ merge_sha?: string } | null>(task.codeRefJson, null)?.merge_sha;
  const q = useTaskQuality(task.id, merged);
  const revert = useMutation({
    mutationFn: async (reason: string) => unwrap(await api.tasks[':id'].revert.$post({ param: { id: task.id }, json: reason ? { reason } : {} })),
    onSuccess: (r) => toast(`已回滚，回滚提交 ${r.revertSha.slice(0, 8)}`, 'ok'),
  });
  if (!merged || !q.data || !q.data.merged || q.data.sources.length === 0) return null;
  const data = q.data;
  const anyFailed = data.sources.some((s) => s.suites.some((x) => x.run && x.run.status !== 'passed'));
  const askRevert = () => {
    const reason = window.prompt('回滚这次合并：会在目标分支上生成一个反向提交。原因（可选）', '');
    if (reason !== null) revert.mutate(reason.trim());
  };
  return (
    <section className={SECTION} aria-label="合并后回归">
      <div className="flex items-center justify-between gap-2">
        <h2 className={HEAD}>合并后回归</h2>
        {anyFailed && !data.reverted && <Button size="sm" variant="danger" className="-my-1" disabled={revert.isPending} onClick={askRevert} data-testid="postmerge-revert">{revert.isPending ? '回滚中…' : '回滚此合并'}</Button>}
      </div>
      {data.reverted && <p className="text-xs text-muted">这次合并已回滚</p>}
      {data.sources.map((src) => (
        <div key={src.qaWorkstationId}>
          <ul className="grid gap-1.5">
            {src.suites.map((s) => (
              <li key={s.suiteId} className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm text-ink-2">{s.name}</span>
                {s.run && (
                  <Link to="/projects/$projectId/ws/$wsId" params={{ projectId, wsId: src.qaWorkstationId }} search={{ panel: 'runs', item: s.run.id }} className="measured shrink-0 text-xs font-medium text-cool hover:underline">
                    {s.run.passed}/{s.run.total}
                  </Link>
                )}
                {!s.autoRun ? (
                  <Badge tone="neutral">未开启自动运行</Badge>
                ) : s.run ? s.run.status === 'passed' ? (
                  <Badge tone="ok">通过</Badge>
                ) : (
                  <Badge tone="bad">{s.run.status === 'error' ? '异常' : '失败'}</Badge>
                ) : (
                  <Badge tone="neutral">等待回归</Badge>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

// 任务协作室右栏：谁在参与、子任务走到哪、契约写了什么
export function TaskSide({ detail, ws, projectId, names }: { detail: TaskDetail; ws: WorkstationDetail | undefined; projectId: string; names: Record<string, string> }) {
  const stage = detail.flow.stages.find((s) => s.id === detail.task.stage);
  const home = new Set([detail.flow.workstationId, detail.task.workstationId]);
  return (
    <aside className="flex h-full min-h-0 w-[19rem] shrink-0 flex-col overflow-y-auto border-l border-rule bg-paper pb-4 max-lg:hidden" aria-label="参与者与子任务">
      <TeamPulse projectId={projectId} names={names} only={(a) => home.has(a.workstationId)} {...(stage ? { highlightTemplates: stage.activeAgents } : {})} />
      {detail.children.length > 0 && <Lanes detail={detail} projectId={projectId} />}
      <Plan detail={detail} projectId={projectId} />
      <PostMerge detail={detail} projectId={projectId} />
      <RelatedPanels detail={detail} ws={ws} projectId={projectId} />
      <Contract detail={detail} />
    </aside>
  );
}
