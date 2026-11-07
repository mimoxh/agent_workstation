import type { TaskStatus } from '@aw/domain';
import { useMutation } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { actionLabel, isDriven, taskActions, type TaskAction } from '@/components/board/actions';
import { STATUS_LABEL, STATUS_TONE } from '@/components/board/labels';
import { moduleOf } from '@/components/board/TaskCard';
import { InboxEntry } from '@/components/inbox/InboxEntry';
import { PageIcon, Prop } from '@/components/layout/Page';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/input';
import { api, unwrap } from '@/lib/api';
import { clock, num, parseJson, seconds, shortId, when } from '@/lib/format';
import type { BoardTask, InboxRow, NameMaps, RunRow, TaskDetail, TestRun } from '@/lib/queries';
import { cn } from '@/lib/utils';

const MAX_SEND_BACKS = 3;

function Checks({ task, testRuns }: { task: BoardTask; testRuns: TestRun[] }) {
  const checks = parseJson<{ kind: string; run?: string }[]>(task.acceptanceJson, []).filter((c) => c.run);
  if (checks.length === 0) return <p className="text-sm text-muted">没有声明可执行验收</p>;
  return (
    <ul className="space-y-1" data-testid="acceptance-checks">
      {checks.map((c) => {
        const last = testRuns.find((r) => r.command === c.run);
        const passed = last?.status === 'passed';
        return (
          <li key={c.run} className="flex items-baseline gap-2 text-sm">
            <span aria-hidden className={cn('measured w-3', !last ? 'text-muted' : passed ? 'text-ok' : 'text-bad')}>{!last ? '·' : passed ? '✓' : '✗'}</span>
            <code className="min-w-0 flex-1 truncate text-ink-2">{c.run}</code>
            <span className="measured shrink-0 text-xs text-muted">{last ? `${passed ? '通过' : '失败'} ${seconds(last.duration)}` : '未运行'}</span>
          </li>
        );
      })}
    </ul>
  );
}

function StageRail({ detail }: { detail: TaskDetail }) {
  const { task, events, flow } = detail;
  const cur = flow.stages.findIndex((s) => s.id === task.stage);
  const finished = task.status === 'done';
  const enteredAt = (id: string) =>
    events.filter((e) => e.action === 'task_stage_changed' && parseJson<{ stage?: string }>(e.payloadJson, {}).stage === id).at(-1)?.createdAt;
  return (
    <ol className="flex flex-wrap items-center gap-x-3 gap-y-1" aria-label="任务阶段" data-testid="stage-rail">
      {flow.stages.map((s, i) => {
        const done = finished || i < cur;
        const here = !finished && i === cur;
        const at = enteredAt(s.id);
        return (
          <li key={s.id} aria-current={here ? 'step' : undefined} className={cn('flex items-baseline gap-1 rounded-[3px] text-sm', here ? 'bg-cool-tag px-1.5 font-medium text-cool-tag-ink' : done ? 'text-muted' : 'text-faint')}>
            {done && <span aria-hidden className="measured text-xs text-ok">✓</span>}
            {s.name}
            {at && <span className={cn('measured text-xs', here ? 'text-cool-tag-ink/70' : 'text-faint')}>{clock(at).slice(0, 5)}</span>}
          </li>
        );
      })}
    </ol>
  );
}

function StageSelect({ detail }: { detail: TaskDetail }) {
  const { task, flow } = detail;
  const advance = useMutation({
    mutationFn: async (stage: string) => unwrap(await api.tasks[':id'].stage.$post({ param: { id: task.id }, json: { stage } })),
  });
  if (flow.stages.length === 0 || !['in_progress', 'reviewing'].includes(task.status)) return null;
  return (
    <Select
      className="h-7 w-28 text-xs"
      aria-label="推进阶段"
      data-testid="stage-select"
      value={task.stage ?? ''}
      disabled={advance.isPending}
      onChange={(e) => advance.mutate(e.target.value)}
    >
      {flow.stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
    </Select>
  );
}

function CounterNote({ task }: { task: BoardTask }) {
  const result = parseJson<{ reason?: string; counter?: { input?: Record<string, unknown>; acceptance?: { run?: string }[] } }>(task.resultJson, {});
  if (!result.reason) return null;
  return (
    <section className="rounded-[4px] bg-accent-soft px-4 py-3 text-sm text-ink-2" aria-label="目标台的回复">
      <p className="text-xs text-muted">{task.status === 'countered' ? '反提案' : '目标台回复'}</p>
      <p className="whitespace-pre-wrap">{result.reason}</p>
      {result.counter?.input && <p className="mt-1 text-muted">建议输入 <code>{JSON.stringify(result.counter.input)}</code></p>}
      {result.counter?.acceptance && <p className="mt-1 text-muted">建议验收 {result.counter.acceptance.map((c) => <code key={c.run} className="mr-2">{c.run}</code>)}</p>}
      {task.status === 'countered' && <p className="mt-1 text-xs text-muted">点「重新派发」会采纳以上改动。</p>}
    </section>
  );
}

// 任务头：这件事是什么、走到哪、能不能信、现在该做什么
export function TaskHeader({
  detail,
  projectId,
  names,
  runs,
  testRuns,
  proposalCount,
  inbox,
  pendingAction,
  canDispatch,
  canAssign,
  onAction,
}: {
  detail: TaskDetail;
  projectId: string;
  names: NameMaps;
  runs: RunRow[];
  testRuns: TestRun[];
  proposalCount: number;
  inbox: InboxRow[];
  pendingAction: boolean;
  canDispatch: boolean;
  canAssign: boolean;
  onAction: (a: TaskAction) => void;
}) {
  const { task, children, parent, flow } = detail;
  const status = task.status as TaskStatus;
  const module = moduleOf(task);
  const usage = parseJson<{ tokensIn?: number; tokensOut?: number }>(task.usageJson, {});
  const used = (usage.tokensIn ?? 0) + (usage.tokensOut ?? 0);
  const running = runs.filter((r) => r.status === 'running').length;
  const actions = taskActions(task, { canDispatch, canAssign });
  const assignee =
    task.assigneeType === 'workstation' ? `${names.ws[task.workstationId] ?? ''} → ${names.ws[task.assigneeId ?? ''] ?? '工作台'}`
    : task.assigneeType === 'agent' ? (names.agent[task.assigneeId ?? ''] ?? 'Agent')
    : task.assigneeType === 'human' ? '本地用户接管中'
    : '未指派';

  return (
    <header className="pt-8" data-testid="task-header">
      <PageIcon icon="doc" />
      <div className="mt-3 flex flex-wrap items-end gap-x-3 gap-y-2">
        <h1 className="min-w-0 flex-1 break-words text-page font-bold tracking-tight text-ink">{task.title}</h1>
        {actions.length > 0 && (
          <div className="flex flex-wrap gap-1.5 pb-1.5" data-testid="task-actions">
            {actions.map((a, i) => {
              const cancel = a.kind === 'event' && a.event === 'cancel';
              return (
                <Button key={actionLabel(a)} variant={cancel ? 'quiet' : i === 0 && !isDriven(task) ? 'primary' : 'default'} disabled={pendingAction} onClick={() => onAction(a)}>
                  {actionLabel(a)}
                </Button>
              );
            })}
          </div>
        )}
      </div>
      {task.intent && <p className="mt-1.5 text-[0.95rem] text-ink-2">{task.intent}</p>}
      <div className="mt-4 space-y-px border-b border-rule pb-3">
        <Prop icon="status" label="状态"><Badge tone={STATUS_TONE[status] ?? 'neutral'} data-testid="task-status">{STATUS_LABEL[status] ?? task.status}</Badge></Prop>
        {flow.stages.length > 0 && (
          <Prop icon="stage" label="阶段">
            <StageRail detail={detail} />
            <StageSelect detail={detail} />
          </Prop>
        )}
        <Prop icon="person" label="负责">{assignee}</Prop>
        <Prop icon="coin" label="用量">
          <span className="measured text-ink-2" data-testid="task-usage">{num(used)}{flow.budget?.tokens ? ` / ${num(flow.budget.tokens)}` : ''} tok</span>
          <span className="text-muted">退回 <span className="measured">{task.feedbackCount} / {MAX_SEND_BACKS}</span></span>
        </Prop>
        {module && <Prop icon="files" label="范围"><code className="text-ink-2">{module}</code></Prop>}
        {parent && <Prop icon="link" label="父任务"><Link to="/projects/$projectId/tasks/$taskId" params={{ projectId, taskId: parent.id }} className="font-medium text-ink underline decoration-rule-2 underline-offset-[3px] hover:decoration-ink">{parent.title}</Link></Prop>}
        <Prop icon="check" label="验收"><Checks task={task} testRuns={testRuns} /></Prop>
        <Prop icon="board" label="关联">
          <span className="text-muted">子任务 <span className="measured text-ink-2">{children.length}</span></span>
          <span className="text-muted">提案 <span className="measured text-ink-2">{proposalCount}</span></span>
          <span className="text-muted">运行 <span className="measured text-ink-2">{runs.length}</span>{running > 0 && <span className="text-cool">（{running} 在跑）</span>}</span>
        </Prop>
        <Prop icon="info" label="编号">
          <span className="measured text-xs text-muted">{shortId(task.id)}</span>
          {task.typeId && <span className="measured text-xs text-muted">{task.typeId}</span>}
          <span className="text-xs text-muted">{when(task.createdAt)}</span>
        </Prop>
      </div>
      <div className="mt-3 space-y-2 empty:hidden">
        <CounterNote task={task} />
        {task.blockedReason && (
          <p className="whitespace-pre-wrap rounded-[4px] bg-accent-soft px-4 py-3 text-sm text-ink-2" data-testid="blocked-reason">{task.blockedReason}</p>
        )}
        {inbox.length > 0 && (
          <div className="divide-y divide-rule rounded-[4px] border border-rule-2" aria-label="待你确认">
            {inbox.map((i) => <InboxEntry key={i.id} item={i} projectId={projectId} />)}
          </div>
        )}
      </div>
    </header>
  );
}
