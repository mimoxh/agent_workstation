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
import { toast } from '@/components/ui/feedback';
import { Select } from '@/components/ui/input';
import { api, unwrap } from '@/lib/api';
import { clock, num, parseJson, seconds, shortId, when } from '@/lib/format';
import { useQaGateSuites, useTaskBranch, type BoardTask, type Gate, type InboxRow, type NameMaps, type RunRow, type TaskDetail, type TestRun } from '@/lib/queries';
import { cn } from '@/lib/utils';

const MAX_SEND_BACKS = 3;

function Checks({ task, testRuns }: { task: BoardTask; testRuns: TestRun[] }) {
  const checks = parseJson<{ kind: string; run?: string; suite?: string; url?: string }[]>(task.acceptanceJson, []).filter((c) => c.run || (c.kind === 'qa_suite' && c.suite) || (c.kind === 'design_match' && c.url));
  const gates = useQaGateSuites(task.workstationId).data ?? [];
  const suiteName = (id: string) => gates.find((s) => s.id === id)?.name ?? id;
  if (checks.length === 0) return <p className="text-sm text-muted">没有声明可执行验收</p>;
  return (
    <ul className="space-y-1" data-testid="acceptance-checks">
      {checks.map((c) => {
        const suite = c.kind === 'qa_suite' && c.suite;
        const match = c.kind === 'design_match';
        const label = suite ? `QA 套件「${suiteName(c.suite!)}」` : match ? `设计稿对比 ${c.url}` : c.run!;
        const last = testRuns.find((r) => r.command === (suite ? `qa:${suiteName(c.suite!)}` : match ? `design_match ${c.url}` : c.run));
        const passed = last?.status === 'passed';
        return (
          <li key={c.run ?? c.suite ?? c.url} className="flex items-baseline gap-2 text-sm">
            <span aria-hidden className={cn('measured w-3', !last ? 'text-muted' : passed ? 'text-ok' : 'text-bad')}>{!last ? '·' : passed ? '✓' : '✗'}</span>
            <code className="min-w-0 flex-1 truncate text-ink-2">{label}</code>
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
          <li key={s.id} aria-current={here ? 'step' : undefined} className={cn('flex items-baseline gap-1 rounded-chip text-sm', here ? 'bg-cool-tag px-1.5 font-medium text-cool-tag-ink' : done ? 'text-muted' : 'text-faint')}>
            {done && <span aria-hidden className="measured text-xs text-ok">✓</span>}
            {s.name}
            {at && <span className={cn('measured text-xs', here ? 'text-cool-tag-ink/70' : 'text-faint')}>{clock(at).slice(0, 5)}</span>}
          </li>
        );
      })}
    </ol>
  );
}

const GATE_ERROR = '未满足阶段门禁';

function StageSelect({ detail }: { detail: TaskDetail }) {
  const { task, flow } = detail;
  const advance = useMutation({
    mutationFn: async ({ stage, force }: { stage: string; force?: boolean }) =>
      unwrap(await api.tasks[':id'].stage.$post({ param: { id: task.id }, json: { stage, ...(force ? { force } : {}) } })),
    meta: { silent: true },
    // 门禁没过时让人决定是否越过；越过会记进事件日志
    onError: (e, v) => {
      if (!v.force && e.message.startsWith(GATE_ERROR) && window.confirm(`${e.message}\n\n仍要推进吗？这次越过会记录在任务日志里。`)) {
        advance.mutate({ stage: v.stage, force: true });
      } else if (!e.message.startsWith(GATE_ERROR) || v.force) {
        toast(e.message);
      }
    },
  });
  if (flow.stages.length === 0 || !['in_progress', 'reviewing'].includes(task.status)) return null;
  return (
    <Select
      className="h-7 w-28 text-xs"
      aria-label="推进阶段"
      data-testid="stage-select"
      value={task.stage ?? ''}
      disabled={advance.isPending}
      onChange={(e) => advance.mutate({ stage: e.target.value })}
    >
      {flow.stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
    </Select>
  );
}

// 离开当前阶段前要满足的条件；人工检查项可以就地确认
function Gates({ detail }: { detail: TaskDetail }) {
  const { task, flow } = detail;
  const confirm = useMutation({
    mutationFn: async (g: Gate) => unwrap(await api.tasks[':id'].gates.confirm.$post({ param: { id: task.id }, json: { stage: g.stage, index: g.index } })),
  });
  if (flow.gates.length === 0 || !['in_progress', 'reviewing'].includes(task.status)) return null;
  return (
    <ul className="space-y-1" data-testid="stage-gates">
      {flow.gates.map((g) => (
        <li key={`${g.stage}-${g.index}`} className="flex items-baseline gap-2 text-sm">
          <span aria-hidden className={cn('measured w-3', g.met ? 'text-ok' : 'text-accent')}>{g.met ? '✓' : '·'}</span>
          <span className={cn('min-w-0 flex-1', g.met ? 'text-muted' : 'text-ink-2')}>{g.text}</span>
          {!g.met && g.confirmable && (
            <Button size="sm" variant="quiet" disabled={confirm.isPending} onClick={() => confirm.mutate(g)} data-testid="gate-confirm">确认</Button>
          )}
          {!g.met && !g.confirmable && <span className="shrink-0 text-xs text-muted">平台判定</span>}
        </li>
      ))}
    </ul>
  );
}

// 代码任务的分支：落后多少、是否卡在冲突里；合并后可以回滚
function BranchState({ task }: { task: TaskDetail['task'] }) {
  const q = useTaskBranch(task.id, !!task.codeRefJson);
  const sync = useMutation({
    mutationFn: async () => unwrap(await api.tasks[':id'].sync.$post({ param: { id: task.id } })),
    onSuccess: (r) => toast(r.status === 'up_to_date' ? '已是最新' : r.status === 'merged' ? '已同步目标分支' : `同步后有冲突：${r.files.join('、')}`, r.status === 'conflicts' ? 'bad' : 'ok'),
  });
  const revert = useMutation({
    mutationFn: async (reason: string) => unwrap(await api.tasks[':id'].revert.$post({ param: { id: task.id }, json: reason ? { reason } : {} })),
    onSuccess: (r) => toast(`已回滚，回滚提交 ${r.revertSha.slice(0, 8)}`, 'ok'),
  });
  const b = q.data?.branch;
  if (!b) return null;
  const askRevert = () => {
    const reason = window.prompt('回滚这次合并：会在目标分支上生成一个反向提交。原因（可选）', '');
    if (reason !== null) revert.mutate(reason.trim());
  };
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm" data-testid="task-branch">
      {b.branch && <code className="text-ink-2">{b.branch}</code>}
      {b.revertSha ? (
        <span className="text-muted">已回滚 <span className="measured">{b.revertSha.slice(0, 8)}</span></span>
      ) : b.mergeSha ? (
        <>
          <span className="text-muted">已合并 <span className="measured">{b.mergeSha.slice(0, 8)}</span></span>
          <Button size="sm" variant="quiet" disabled={revert.isPending} onClick={askRevert} data-testid="task-revert">{revert.isPending ? '回滚中…' : '回滚'}</Button>
        </>
      ) : b.live ? (
        <>
          <span className={b.behind > 0 ? 'text-accent' : 'text-muted'}>
            {b.behind > 0 ? `落后目标分支 ${b.behind} 个提交` : '与目标分支同步'}
            <span className="text-muted">，领先 <span className="measured">{b.ahead}</span></span>
          </span>
          {b.merging && <span className="text-bad">合并中{b.conflicts.length > 0 ? `，冲突：${b.conflicts.join('、')}` : '，冲突已解决待提交'}</span>}
          {b.movedAfterSubmit && <span className="text-bad">提交提案后分支又被改过，合并时会退回</span>}
          {b.behind > 0 && !b.merging && (
            <Button size="sm" variant="quiet" disabled={sync.isPending} onClick={() => sync.mutate()} data-testid="task-sync">{sync.isPending ? '同步中…' : '同步'}</Button>
          )}
        </>
      ) : null}
    </div>
  );
}

function CounterNote({ task }: { task: BoardTask }) {
  const result = parseJson<{ reason?: string; counter?: { input?: Record<string, unknown>; acceptance?: { run?: string }[] } }>(task.resultJson, {});
  if (!result.reason) return null;
  return (
    <section className="rounded-chip bg-accent-soft px-4 py-3 text-sm text-ink-2" aria-label="目标台的回复">
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
        {flow.gates.length > 0 && ['in_progress', 'reviewing'].includes(task.status) && (
          <Prop icon="flag" label="门禁"><Gates detail={detail} /></Prop>
        )}
        {task.codeRefJson && <Prop icon="branch" label="分支"><BranchState task={task} /></Prop>}
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
          <p className="whitespace-pre-wrap rounded-chip bg-accent-soft px-4 py-3 text-sm text-ink-2" data-testid="blocked-reason">{task.blockedReason}</p>
        )}
        {inbox.length > 0 && (
          <div className="divide-y divide-rule rounded-chip border border-rule-2" aria-label="待你确认">
            {inbox.map((i) => <InboxEntry key={i.id} item={i} projectId={projectId} />)}
          </div>
        )}
      </div>
    </header>
  );
}
