import { useMutation, useQuery } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';
import { useTaskActions } from '@/components/board/actions';
import { Composer } from '@/components/chat/Composer';
import { TaskProposalsPanel } from '@/components/panels/ProposalReview';
import { TaskTestRunsPanel } from '@/components/panels/TestRuns';
import { RunTable } from '@/components/run/RunTable';
import { StreamBlocks, useLiveOutput } from '@/components/run/LiveOutput';
import { TaskHeader } from '@/components/task/TaskHeader';
import { TaskSide } from '@/components/task/TaskSide';
import { Timeline } from '@/components/timeline/Timeline';
import { Button } from '@/components/ui/button';
import { Dialog, DialogForm } from '@/components/ui/dialog';
import { Empty, ErrorState, Loading } from '@/components/ui/feedback';
import { Field, Input, Select } from '@/components/ui/input';
import { api, unwrap } from '@/lib/api';
import { nameMaps, useInbox, useProject, useTask, useTaskProposals, useTaskRuns, useTaskTestRuns, useWorkstation, type RunRow, type TaskDetail, type WsAgent } from '@/lib/queries';
import { cn } from '@/lib/utils';

const VIEWS = ['timeline', 'changes', 'tests', 'runs', 'output'] as const;
type ViewId = (typeof VIEWS)[number];

export const Route = createFileRoute('/projects/$projectId/tasks/$taskId')({
  validateSearch: (s: Record<string, unknown>): { view?: ViewId } => (VIEWS.includes(s.view as ViewId) ? { view: s.view as ViewId } : {}),
  component: TaskPage,
});

function RunsView({ taskId, projectId, runs, agents }: { taskId: string; projectId: string; runs: RunRow[]; agents: WsAgent[] }) {
  const [agentId, setAgentId] = useState('');
  const run = useMutation({
    mutationFn: async () => unwrap(await api.agents[':id'].run.$post({ param: { id: agentId }, json: { taskId } })),
  });
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-rule px-4 py-2">
        <Select className="h-8 w-44" aria-label="选择 Agent" data-testid="run-agent-select" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
          <option value="">选择 Agent…</option>
          {agents.filter((a) => a.status !== 'paused').map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </Select>
        <Button disabled={!agentId || run.isPending} onClick={() => run.mutate()} data-testid="run-agent">手动运行</Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {runs.length === 0 ? <Empty title="还没有运行记录" /> : <RunTable runs={runs} projectId={projectId} showTask={false} />}
      </div>
    </div>
  );
}

function SubmitDialog({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const [summary, setSummary] = useState('');
  const submit = useMutation({
    meta: { silent: true },
    mutationFn: async () => unwrap(await api.tasks[':id']['submit-change'].$post({ param: { id: taskId }, json: { summary: summary.trim() } })),
    onSuccess: onClose,
  });
  return (
    <Dialog title="提交我的改动" onClose={onClose} testId="submit-dialog">
      <DialogForm error={submit.error?.message} submitting={submit.isPending} submitLabel="提交" canSubmit={!!summary.trim()} onSubmit={() => submit.mutate()} onCancel={onClose}>
        <Field label="改动说明" required hint="在 worktree 里提交好 commit 后再点这里，改动会进入测试 → 评审 → 合并">
          <Input autoFocus value={summary} onChange={(e) => setSummary(e.target.value)} data-testid="submit-summary" />
        </Field>
      </DialogForm>
    </Dialog>
  );
}

// 人随时可以插手：打断在跑的 run、接管任务、改完交还
function InterventionActions({ detail, running }: { detail: TaskDetail; running: boolean }) {
  const { task } = detail;
  const [submitting, setSubmitting] = useState(false);
  const param = { param: { id: task.id } };
  const interrupt = useMutation({ mutationFn: async () => unwrap(await api.tasks[':id'].interrupt.$post(param)) });
  const takeover = useMutation({ mutationFn: async () => unwrap(await api.tasks[':id'].takeover.$post(param)) });
  const release = useMutation({ mutationFn: async () => unwrap(await api.tasks[':id'].release.$post({ ...param, json: {} })) });
  const canTakeOver = task.assigneeType === 'agent' && ['in_progress', 'blocked', 'escalated'].includes(task.status);
  const held = task.assigneeType === 'human';
  return (
    <>
      {running && <Button size="sm" variant="quiet" disabled={interrupt.isPending} onClick={() => interrupt.mutate()} data-testid="task-interrupt">打断</Button>}
      {canTakeOver && <Button size="sm" variant="quiet" disabled={takeover.isPending} onClick={() => takeover.mutate()} data-testid="task-takeover">接管</Button>}
      {held && <Button size="sm" variant="quiet" disabled={release.isPending} onClick={() => release.mutate()} data-testid="task-release">交还</Button>}
      {held && task.codeRefJson && <Button size="sm" onClick={() => setSubmitting(true)} data-testid="task-submit">提交改动</Button>}
      {submitting && <SubmitDialog taskId={task.id} onClose={() => setSubmitting(false)} />}
    </>
  );
}

function TaskComposer({ detail, running }: { detail: TaskDetail; running: boolean }) {
  const th = useQuery({ queryKey: ['thread', 'task', detail.task.id], queryFn: async () => unwrap(await api.tasks[':id'].thread.$get({ param: { id: detail.task.id } })) });
  if (!th.data) return null;
  const held = detail.task.assigneeType === 'human';
  return (
    <Composer
      threadId={th.data.thread.id}
      wide
      hint={held ? '你正在接管这个任务，Agent 不会被唤醒，@ 可以点名求助' : '说话默认给负责这件事的成员，@ 可以点名任何参与者'}
      actions={<InterventionActions detail={detail} running={running} />}
    />
  );
}

function TaskPage() {
  const { projectId, taskId } = Route.useParams();
  const { view = 'timeline' } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const detail = useTask(taskId);
  const project = useProject(projectId);
  const ownerWsId = detail.data?.task.workstationId;
  const execWsId = detail.data?.flow.workstationId;
  const owner = useWorkstation(ownerWsId);
  const exec = useWorkstation(execWsId);
  const runs = useTaskRuns(taskId);
  const proposals = useTaskProposals(taskId);
  const testRuns = useTaskTestRuns(taskId);
  const inbox = useInbox(projectId);
  const actions = useTaskActions(project.data, ownerWsId);
  const liveStreams = useLiveOutput(`task:${taskId}`);

  if (detail.isLoading) return <Loading />;
  if (detail.isError || !detail.data) return <ErrorState error={detail.error ?? new Error('任务不存在')} />;

  const d = detail.data;
  const names = nameMaps(project.data);
  const runRows = runs.data ?? [];
  const proposalRows = proposals.data ?? [];
  const testRows = testRuns.data ?? [];
  const stageNames = Object.fromEntries(d.flow.stages.map((s) => [s.id, s.name]));
  const labels: Record<ViewId, ReactNode> = {
    timeline: '时间线',
    changes: <>改动 <span className="measured text-xs">{proposalRows.length}</span></>,
    tests: <>验收 <span className="measured text-xs">{testRows.length}</span></>,
    runs: <>运行 <span className="measured text-xs">{runRows.length}</span></>,
    output: '实时输出',
  };
  const liveRunning = liveStreams.some((s) => !s.done);

  return (
    <div className="flex h-full min-h-0" data-testid="task-page">
      <section className="flex min-w-0 flex-1 flex-col" aria-label="协作">
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="px-5 md:px-10 lg:px-14">
            <div className="mx-auto max-w-[54rem]">
              <TaskHeader
                detail={d}
                projectId={projectId}
                names={names}
                runs={runRows}
                testRuns={testRows.filter((r) => r.taskId === taskId)}
                proposalCount={proposalRows.length}
                inbox={(inbox.data ?? []).filter((i) => i.taskId === taskId)}
                pendingAction={actions.pendingId === taskId}
                canDispatch={actions.canDispatch}
                canAssign={actions.canAssign}
                onAction={(a) => actions.run(a, d.task)}
              />
              <nav className="mt-5 flex gap-0.5 border-b border-rule" role="tablist" aria-label="任务视图">
                {VIEWS.map((v) => (
                  <button
                    key={v}
                    type="button"
                    role="tab"
                    aria-selected={view === v}
                    data-testid={`task-view-${v}`}
                    onClick={() => void navigate({ search: v === 'timeline' ? {} : { view: v } })}
                    className={cn('relative h-9 px-2.5 text-sm transition-colors duration-150 after:absolute after:inset-x-1.5 after:-bottom-px after:h-0.5 after:bg-ink', view === v ? 'font-medium text-ink after:opacity-100' : 'text-muted after:opacity-0 hover:text-ink')}
                  >
                    {labels[v]}
                  </button>
                ))}
                {liveRunning && view !== 'output' && (
                  <button type="button" onClick={() => void navigate({ search: { view: 'output' } })} className="ml-auto h-9 px-2.5 text-xs font-medium text-cool hover:underline" data-testid="task-live-link">
                    命令运行中 · 查看输出
                  </button>
                )}
              </nav>
            </div>
          </div>
          <div className={view === 'timeline' ? '' : 'px-1 py-2 md:px-6'}>
            {view === 'timeline' && <Timeline taskId={taskId} projectId={projectId} names={names.agent} stages={stageNames} embedded />}
            {view === 'changes' && <TaskProposalsPanel taskId={taskId} projectId={projectId} />}
            {view === 'tests' && <TaskTestRunsPanel taskId={taskId} projectId={projectId} />}
            {view === 'runs' && <RunsView taskId={taskId} projectId={projectId} runs={runRows} agents={[...(owner.data?.agents ?? []), ...(exec.data && exec.data.id !== owner.data?.id ? exec.data.agents : [])]} />}
            {view === 'output' && <div className="px-4 md:px-10 lg:px-14"><div className="mx-auto max-w-[54rem]"><StreamBlocks streams={liveStreams} /></div></div>}
          </div>
        </div>
        <TaskComposer detail={d} running={runRows.some((r) => r.status === 'running')} />
      </section>
      <TaskSide detail={d} ws={exec.data} projectId={projectId} names={names.agent} />
      {actions.dialogs}
    </div>
  );
}
