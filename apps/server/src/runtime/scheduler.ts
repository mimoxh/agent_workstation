import PQueue from 'p-queue';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { and, eq, inArray } from 'drizzle-orm';
import type { Actor } from '@aw/domain';
import { descendantIds, transition, type TaskStatus } from '@aw/domain';
import type { DB } from '../db/client.js';
import { agent, artifact, entity, message, proposal, reviewComment, run, task, thread, workstation } from '../db/schema.js';
import { events } from '../events.js';
import { buildPermCtx, logEvent, manifestOf } from '../usecases/core.js';
import { designContextOf } from '../usecases/designs.js';
import { pushInbox, pushRunFailure } from '../usecases/inbox.js';
import { threadAgents } from '../usecases/threads.js';
import { buildContext } from './context.js';
import { startConversation } from './conversation.js';
import { escalateTask } from './coordination.js';
import { afterTestRun, condTransition, maybeCloseParent, triggerStageAgents } from './dev_workflow.js';
import { runCommand } from './exec.js';
import { createTaskWorktree, devSettings, ensureTargetBranch, git, removeTaskWorktree, type DevSettings } from './git.js';
import { runAgent } from './loop.js';
import { parseScope, readSpecs } from './scope.js';
import { describeModules, registeredModules, relatedModules, uncoveredPaths } from './modules.js';
import { budgetBreach, describeBreach } from './budget.js';
import { fallbackRoutes, loadModels, resolveModel, sanitizeError } from './models.js';
import type { RunCtx } from './tools/index.js';
import type { AgentRow, TaskRow, ThreadRow } from './types.js';

const queue = new PQueue({ concurrency: Number(process.env.AW_RUN_CONCURRENCY ?? 2) });
// git worktree 操作串行化，避免 refs/lock 冲突
const gitLock = new PQueue({ concurrency: 1 });
const inFlight = new Set<string>();
const queued = new Set<string>();

const now = () => new Date().toISOString();
const MODULE_FILES_LIMIT = 200;
const FAILED_OUTPUT_TAIL = 800;
const THREAD_CONTEXT_MESSAGES = 30;
// 回话不是开工：这些回合不准备 worktree
const CONVERSATION_TRIGGERS = new Set(['mentioned', 'moderated', 'conclude', 'human_reply']);

function enqueueRun(key: string, job: () => Promise<void>, onError: (e: unknown) => Promise<void>) {
  queued.add(key);
  void queue.add(async () => {
    inFlight.add(key);
    try {
      await job();
    } catch (e) {
      await onError(e).catch((err: unknown) => console.error('[scheduler] run 收尾失败', sanitizeError(String(err))));
    } finally {
      inFlight.delete(key);
      queued.delete(key);
    }
  });
}

// 触发一次 run：装配上下文 → 插入 run 行 → 入队执行 loop；threadId 表示这是一次会话发言
export async function triggerRun(db: DB, agentId: string, taskId: string, trigger: string, opts: { threadId?: string; resume?: ResumePoint } = {}): Promise<{ ok: boolean; runId?: string; error?: string }> {
  const a = (await db.select().from(agent).where(eq(agent.id, agentId)))[0];
  const t = (await db.select().from(task).where(eq(task.id, taskId)))[0];
  if (!a || !t) return { ok: false, error: 'agent 或 task 不存在' };
  if (a.status === 'paused') return { ok: false, error: `${a.name} 已暂停` };
  const key = `${agentId}:${taskId}`;
  if (queued.has(key) || inFlight.has(key)) return { ok: false, error: '该 (agent, task) 已在队列中' };
  const breach = await budgetBreach(db, { projectId: t.projectId, workstationId: a.workstationId, taskId });
  if (breach) return { ok: false, error: describeBreach(breach) };
  const runId = crypto.randomUUID();
  enqueueRun(key, () => executeRun(db, runId, a, t, trigger, opts), (e) => abortRun(db, runId, a, t, 'run_failed', e instanceof Error ? e.message : String(e)));
  return { ok: true, runId };
}

// 讨论线程里的发言没有任务，run 只挂在线程上
export async function triggerThreadRun(db: DB, agentId: string, threadId: string, trigger: string): Promise<{ ok: boolean; runId?: string; error?: string }> {
  const a = (await db.select().from(agent).where(eq(agent.id, agentId)))[0];
  const th = (await db.select().from(thread).where(eq(thread.id, threadId)))[0];
  if (!a || !th) return { ok: false, error: 'agent 或线程不存在' };
  if (a.status === 'paused') return { ok: false, error: `${a.name} 已暂停` };
  const key = `${agentId}:${threadId}`;
  if (queued.has(key) || inFlight.has(key)) return { ok: false, error: '该 (agent, thread) 已在队列中' };
  const runId = crypto.randomUUID();
  enqueueRun(key, () => executeThreadRun(db, runId, a, th, trigger), (e) => abortRun(db, runId, a, null, 'run_failed', e instanceof Error ? e.message : String(e), th.id));
  return { ok: true, runId };
}

// run 没走完 loop 就失败：收尾 run（loop 已收尾则跳过）→ 任务转 blocked → 进收件箱 → 发 run_finished
async function abortRun(db: DB, runId: string, a: AgentRow, t: TaskRow | null, kind: 'run_failed' | 'blocked', reason: string, threadId?: string) {
  const error = sanitizeError(reason);
  const ended = { status: 'error', stopReason: 'error', endedAt: now(), error };
  const existing = (await db.select().from(run).where(eq(run.id, runId)))[0];
  if (existing && existing.status !== 'running') return;
  if (existing) await db.update(run).set(ended).where(eq(run.id, runId));
  else await db.insert(run).values({ id: runId, agentId: a.id, taskId: t?.id ?? null, threadId: threadId ?? null, provider: 'none', model: 'none', startedAt: now(), tokensIn: 0, tokensOut: 0, traceJson: '[]', ...ended });

  if (t) await condTransition(db, { type: 'agent', id: a.id }, t.id, 'block', { blockedReason: error });
  const projectId = t?.projectId ?? (await db.select().from(workstation).where(eq(workstation.id, a.workstationId)))[0]?.projectId;
  if (projectId && kind === 'blocked' && t) await pushInbox(db, projectId, { kind, refType: 'task', refId: t.id, payload: { reason: error } });
  else if (projectId) await pushRunFailure(db, projectId, runId, `${a.id}:${t?.id ?? threadId ?? ''}`, { reason: error });
  events.emit('run_finished', { runId, agentId: a.id, taskId: t?.id ?? null, stopReason: 'error' });
}

// 平台代建任务 worktree：返回失败原因，null 表示就绪
function prepareWorktree(db: DB, a: AgentRow, t: TaskRow, s: DevSettings): Promise<string | null> {
  return gitLock.add(async () => {
    try {
      // mock 模式不得作用于服务自身仓库（防真实仓库被测试污染）
      const isMock = process.env.AW_ENABLE_MOCK === '1' || process.env.NODE_ENV === 'test';
      if (isMock && path.resolve(s.repoPath) === path.resolve(execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim())) {
        return 'mock 模式不得作用于本仓库';
      }
      const tb = await ensureTargetBranch(s);
      if (!tb.ok) return `worktree 准备失败：${tb.error}`;
      const ref = await createTaskWorktree(s, a.workstationId, t.id);
      if (s.commands.setup) {
        const setup = await runCommand({ cwd: ref.worktree, command: s.commands.setup, timeoutSec: s.setupTimeoutSec, sandbox: s.sandbox, network: 'bridge' });
        if (setup.exitCode !== 0) return `setup 失败：\n${setup.output.slice(0, 500)}`;
      }
      // setup 通过后才落 code_ref：失败后重跑会重新准备
      await db.update(task).set({ codeRefJson: JSON.stringify(ref) }).where(eq(task.id, t.id));
      return null;
    } catch (e) {
      return `worktree 准备失败：${e instanceof Error ? e.message : String(e)}`;
    }
  });
}

async function moduleFilesOf(worktree: string | undefined, inputJson: string | null) {
  if (!worktree) return undefined;
  const s = parseScope(inputJson);
  const r = await git(worktree, ['ls-files', '--', ...readSpecs(s)]);
  if (r.code !== 0) return undefined;
  const files = r.stdout.split('\n').filter(Boolean);
  const more = files.length > MODULE_FILES_LIMIT ? `\n…[还有 ${files.length - MODULE_FILES_LIMIT} 个文件]` : '';
  return files.length > 0 ? files.slice(0, MODULE_FILES_LIMIT).join('\n') + more : undefined;
}

async function moduleInfoOf(db: DB, t: TaskRow) {
  const scope = parseScope(t.inputJson);
  const mods = await registeredModules(db, t.workstationId);
  const related = relatedModules(scope, mods).slice(0, 20);
  const fresh = uncoveredPaths(scope, mods);
  const lines = [describeModules(related), fresh.length > 0 && mods.length > 0 ? `- 未登记的新路径：${fresh.join('、')}（设计阶段需要 ADR）` : ''].filter(Boolean);
  return lines.length > 0 ? lines.join('\n') : undefined;
}

// 最近一批验收：失败项附输出尾部（真正的报错通常在末尾）
async function lastTestRunOf(db: DB, t: TaskRow) {
  const batchId = (JSON.parse(t.resultJson ?? '{}') as { acceptance?: { batchId?: string } }).acceptance?.batchId;
  if (!batchId) return undefined;
  const rows = await db.select().from(entity).where(eq(entity.entityType, 'TestRun'));
  const lines: string[] = [];
  for (const r of rows) {
    const d = JSON.parse(r.dataJson ?? '{}') as { command?: string; status?: string; output_ref?: string; batch_id?: string };
    if (d.batch_id !== batchId) continue;
    lines.push(`${d.command}: ${d.status}`);
    if (d.status === 'passed' || !d.output_ref) continue;
    const out = (await db.select().from(artifact).where(eq(artifact.id, d.output_ref)))[0];
    if (out?.ref) lines.push(out.ref.slice(-FAILED_OUTPUT_TAIL));
  }
  return lines.length > 0 ? lines.join('\n') : undefined;
}

async function openCommentsOf(db: DB, taskId: string) {
  const ids = (await db.select({ id: proposal.id }).from(proposal).where(eq(proposal.taskId, taskId))).map((p) => p.id);
  if (ids.length === 0) return undefined;
  const rows = await db.select().from(reviewComment).where(and(inArray(reviewComment.proposalId, ids), eq(reviewComment.resolved, 0)));
  return rows.length > 0 ? rows.map((c) => `${c.path ?? '?'}${c.line ? `:${c.line}` : ''} ${c.body ?? ''}`).join('\n') : undefined;
}

// 根台的 Agent 要知道能往哪派、每种任务要填什么
async function dispatchTargetsOf(db: DB, a: AgentRow) {
  if (!(JSON.parse(a.toolsJson ?? '[]') as string[]).includes('dispatch_task')) return undefined;
  const ctx = await buildPermCtx({ type: 'agent', id: a.id }, db);
  const ids = descendantIds(ctx, a.workstationId);
  if (ids.length === 0) return undefined;
  const rows = await db.select().from(workstation).where(inArray(workstation.id, ids));
  return rows.flatMap((w) => (manifestOf(w)?.tasks ?? []).map((t) => `${w.name}(${w.id}) 任务类型 ${t.id}：${t.description}；input schema ${JSON.stringify(t.inputSchema)}`)).join('\n');
}

const promptOf = (a: AgentRow, manifest: ReturnType<typeof manifestOf>) => {
  const tpl = manifest?.agents.find((x) => x.id === a.templateId);
  // agent.prompt 默认存模板的 promptFile 名；不同即人工覆盖的提示词
  const custom = a.prompt && a.prompt !== tpl?.promptFile ? a.prompt : undefined;
  return { tpl, promptContent: custom ?? (tpl as { promptContent?: string } | undefined)?.promptContent };
};

// 装配一次 run 的完整上下文：角色提示词 + 任务 + Module / 分支 + 验收与审查反馈 + 线程
export async function buildRunContext(db: DB, a: AgentRow, t: TaskRow, manifest: ReturnType<typeof manifestOf>, trigger?: string) {
  const { tpl, promptContent } = promptOf(a, manifest);
  const agents = await db.select().from(agent).where(eq(agent.workstationId, a.workstationId));
  const parent = t.parentId ? (await db.select().from(task).where(eq(task.id, t.parentId)))[0] : null;
  const siblings = t.parentId ? await db.select().from(task).where(and(eq(task.parentId, t.parentId), eq(task.workstationId, a.workstationId))) : [];
  const threadRow = (await db.select().from(thread).where(and(eq(thread.kind, 'task'), eq(thread.scopeId, t.id))))[0];
  const msgs = threadRow
    ? (await db.select().from(message).where(eq(message.threadId, threadRow.id))).slice(-20)
    : [];
  const ref = t.codeRefJson ? (JSON.parse(t.codeRefJson) as { worktree?: string; branch?: string }) : null;
  const mod = (JSON.parse(t.inputJson ?? '{}') as { module?: string }).module;

  return buildContext({
    pluginDescription: manifest?.description ?? '',
    promptContent,
    agentName: a.name, agentRole: a.role, isSteward: a.isSteward === 1,
    isReviewer: tpl?.id === 'reviewer',
    stage: t.stage, templateId: a.templateId, trigger,
    agents: agents.map((x) => ({ id: x.id, name: x.name, templateId: x.templateId })),
    task: { title: t.title, intent: t.intent, inputJson: t.inputJson, acceptanceJson: t.acceptanceJson, typeId: t.typeId, blockedReason: t.blockedReason },
    parentTask: parent ? { title: parent.title, status: parent.status, intent: parent.intent } : null,
    siblingTasks: siblings.filter((s) => s.id !== t.id).map((s) => ({ title: s.title, status: s.status })),
    threadMessages: msgs.map((m) => ({ senderId: m.senderId, senderType: m.senderType, content: m.content, kind: m.kind })),
    module: mod,
    branch: ref?.branch,
    moduleFiles: await moduleFilesOf(ref?.worktree, t.inputJson),
    moduleInfo: await moduleInfoOf(db, t),
    lastTestRun: await lastTestRunOf(db, t),
    openComments: await openCommentsOf(db, t.id),
    dispatchTargets: await dispatchTargetsOf(db, a),
  });
}

// 人发消息时眼前的那份稿子，「这里」「标题」这类指代靠它落地
function focusNote(metaJson: string | null) {
  const d = (JSON.parse(metaJson ?? '{}') as { design?: { id: string; title: string; version: number } }).design;
  return d ? `正在看设计稿「${d.title}」id: ${d.id} v${d.version}` : undefined;
}

async function buildThreadContext(db: DB, a: AgentRow, th: ThreadRow, manifest: ReturnType<typeof manifestOf>, trigger: string) {
  const { promptContent } = promptOf(a, manifest);
  const members = await threadAgents(db, th);
  const names = new Map(members.map((m) => [m.id, m.name]));
  const msgs = (await db.select().from(message).where(eq(message.threadId, th.id)))
    .sort((x, y) => x.createdAt.localeCompare(y.createdAt))
    .slice(-THREAD_CONTEXT_MESSAGES);
  return buildContext({
    pluginDescription: manifest?.description ?? '',
    promptContent,
    agentName: a.name, agentRole: a.role, isSteward: a.isSteward === 1,
    stage: null, templateId: a.templateId, trigger,
    agents: members.map((x) => ({ id: x.id, name: x.name, templateId: x.templateId })),
    task: null, threadTitle: th.title ?? '讨论',
    parentTask: null, siblingTasks: [],
    threadMessages: msgs.map((m) => ({ senderId: names.get(m.senderId ?? '') ?? m.senderId, senderType: m.senderType, content: m.content, kind: m.kind, note: focusNote(m.metaJson) })),
    dispatchTargets: await dispatchTargetsOf(db, a),
    designs: manifest?.entities.Design ? await designContextOf(db, a.workstationId) : undefined,
  });
}

export interface ResumePoint { runId: string; step: number }

interface TraceEntry { type: string; toolCalls?: { id: string; name: string; args: unknown }[]; name?: string; result?: unknown }

// 从某一步重试：把那一步之前的模型调用和工具结果按原样回放进对话，停在完整的一轮上
export function replayMessages(trace: TraceEntry[], upTo: number) {
  const out: { role: string; content: unknown }[] = [];
  for (let i = 0; i < upTo && i < trace.length; i++) {
    const step = trace[i]!;
    const calls = step.type === 'model' ? (step.toolCalls ?? []) : [];
    if (calls.length === 0) continue;
    const results = trace.slice(i + 1, i + 1 + calls.length);
    if (i + calls.length >= upTo || results.some((r) => r.type !== 'tool')) break;
    out.push({ role: 'assistant', content: calls.map((c) => ({ type: 'tool-call', toolCallId: c.id, toolName: c.name, input: c.args })) });
    out.push({ role: 'tool', content: calls.map((c, k) => ({ type: 'tool-result', toolCallId: c.id, toolName: c.name, output: { type: 'json', value: results[k]!.result ?? null } })) });
  }
  return out;
}

async function executeRun(db: DB, runId: string, a: AgentRow, t: TaskRow, trigger: string, opts: { threadId?: string; resume?: ResumePoint }) {
  const { threadId } = opts;
  await loadModels();
  const ws = (await db.select().from(workstation).where(eq(workstation.id, a.workstationId)))[0];
  const manifest = ws ? manifestOf(ws) : null;
  const tpl = manifest?.agents.find((x) => x.id === a.templateId);
  const route = resolveModel(a.modelJson, tpl?.model);
  const providerName = route?.id.split(':')[0] ?? 'none';
  const modelName = route?.id.split(':').slice(1).join(':') ?? 'none';

  // 排队期间任务可能已推进（stage / worktree），以最新行为准
  let fresh = (await db.select().from(task).where(eq(task.id, t.id)))[0] ?? t;

  // agent 指派的任务：run 开始时平台代为 accept + start（状态机 + 条件更新）
  if (trigger === 'task_assigned' && fresh.assigneeType === 'agent') {
    for (const ev of ['accept', 'start'] as const) {
      const cur = (await db.select().from(task).where(eq(task.id, t.id)))[0];
      if (!cur) break;
      const r = transition(cur.status as TaskStatus, ev);
      if (!r.ok) break;
      const changed = await db.update(task).set({ status: r.to }).where(and(eq(task.id, t.id), eq(task.status, cur.status)));
      if (changed.changes === 0) break;
      fresh = (await db.select().from(task).where(eq(task.id, t.id)))[0] ?? cur;
      await logEvent(db, { type: 'agent', id: a.id }, 'task_status_changed', 'task', t.id, { to: r.to, auto: true });
    }
  }

  await db.insert(run).values({
    id: runId, agentId: a.id, taskId: t.id, threadId: threadId ?? null, status: 'running',
    provider: providerName, model: modelName, startedAt: now(), trigger,
    tokensIn: 0, tokensOut: 0, traceJson: '[]',
  });
  const runRow = (await db.select().from(run).where(eq(run.id, runId)))[0]!;

  if (!route) {
    await abortRun(db, runId, a, fresh, 'run_failed', '没有可用的模型 provider');
    return;
  }

  // 有 apply_patch 的 assignee agent：还没有 worktree 就由平台代建，失败不启动 Agent
  const s = ws ? devSettings(ws.settingsJson) : null;
  if (s && !CONVERSATION_TRIGGERS.has(trigger) && fresh.assigneeType === 'agent' && fresh.assigneeId === a.id && !fresh.codeRefJson && (JSON.parse(a.toolsJson ?? '[]') as string[]).includes('apply_patch')) {
    const failure = await prepareWorktree(db, a, fresh, s);
    if (failure) {
      await abortRun(db, runId, a, fresh, 'blocked', failure);
      return;
    }
    fresh = (await db.select().from(task).where(eq(task.id, t.id)))[0] ?? fresh;
  }

  const actor: Actor = { type: 'agent', id: a.id };
  const th = threadId ? (await db.select().from(thread).where(eq(thread.id, threadId)))[0] : null;
  const ctx: RunCtx = { db, actor, permCtx: await buildPermCtx(actor, db), agent: a, task: fresh, thread: th ?? null, run: runRow };
  const { system, messages } = await buildRunContext(db, a, fresh, manifest, trigger);

  const source = opts.resume ? (await db.select().from(run).where(eq(run.id, opts.resume.runId)))[0] : undefined;
  const replay = source && opts.resume ? replayMessages(JSON.parse(source.traceJson ?? '[]') as TraceEntry[], opts.resume.step) : [];
  await runAgent({
    db, ctx, route, fallbacks: fallbackRoutes(route), system,
    messages: [...messages.map((m) => ({ role: 'user' as const, content: m.content })), ...replay] as never,
    agentRow: a, taskRow: fresh,
    pluginDefaultTokens: manifest?.defaults?.taskBudget?.tokens,
    pluginDefaultMinutes: manifest?.defaults?.taskBudget?.minutes,
  });
}

async function executeThreadRun(db: DB, runId: string, a: AgentRow, th: ThreadRow, trigger: string) {
  await loadModels();
  const ws = (await db.select().from(workstation).where(eq(workstation.id, a.workstationId)))[0];
  const manifest = ws ? manifestOf(ws) : null;
  const route = resolveModel(a.modelJson, manifest?.agents.find((x) => x.id === a.templateId)?.model);
  await db.insert(run).values({
    id: runId, agentId: a.id, threadId: th.id, status: 'running',
    provider: route?.id.split(':')[0] ?? 'none', model: route?.id.split(':').slice(1).join(':') ?? 'none', startedAt: now(), trigger,
    tokensIn: 0, tokensOut: 0, traceJson: '[]',
  });
  if (!route) {
    await abortRun(db, runId, a, null, 'run_failed', '没有可用的模型 provider', th.id);
    return;
  }
  const runRow = (await db.select().from(run).where(eq(run.id, runId)))[0]!;
  const actor: Actor = { type: 'agent', id: a.id };
  const ctx: RunCtx = { db, actor, permCtx: await buildPermCtx(actor, db), agent: a, task: null, thread: th, run: runRow };
  const { system, messages } = await buildThreadContext(db, a, th, manifest, trigger);
  await runAgent({
    db, ctx, route, fallbacks: fallbackRoutes(route), system,
    messages: messages.map((m) => ({ role: 'user' as const, content: m.content })),
    agentRow: a, taskRow: null, projectId: ws?.projectId,
    pluginDefaultTokens: manifest?.defaults?.taskBudget?.tokens,
    pluginDefaultMinutes: manifest?.defaults?.taskBudget?.minutes,
  });
}

// 订阅事件总线；AW_AUTORUN=0 时不订阅
export function startScheduler(db: DB): () => void {
  if (process.env.AW_AUTORUN === '0') return () => {};
  const offs: (() => void)[] = [startConversation(db)];
  const on: typeof events.on = (action, handler) => {
    const off = events.on(action, handler);
    offs.push(off);
    return off;
  };

  on('task_assigned', async (p) => {
    const taskId = p.targetId as string;
    if (p.assigneeType === 'agent' && typeof p.assigneeId === 'string') {
      await triggerRun(db, p.assigneeId, taskId, 'task_assigned');
      return;
    }
    if (p.assigneeType === 'workstation' && typeof p.assigneeId === 'string') {
      const ws = (await db.select().from(workstation).where(eq(workstation.id, p.assigneeId)))[0];
      const manifest = ws ? manifestOf(ws) : null;
      const stewardTpl = manifest?.steward;
      const tpl = manifest?.agents.find((x) => x.id === stewardTpl);
      if (!tpl?.triggers?.includes('task_assigned')) return;
      const steward = (await db.select().from(agent).where(and(eq(agent.workstationId, p.assigneeId), eq(agent.isSteward, 1))))[0];
      if (steward) await triggerRun(db, steward.id, taskId, 'task_assigned');
    }
  });

  // stage 流转 → 触发该 stage activeAgents；汇总出来的父任务 stage 不是真实进入
  on('task_stage_changed', async (p) => {
    if (p.rollup) return;
    await triggerStageAgents(db, String(p.targetId), String(p.stage));
  });

  // 子任务阻塞 → steward 分诊
  on('task_block_triage', async (p) => {
    const r = await triggerRun(db, String(p.stewardId), String(p.taskId), 'block_triage');
    if (!r.ok) await escalateTask(db, { type: 'agent', id: String(p.stewardId) }, String(p.taskId), 'steward 无法分诊');
  });

  on('run_finished', async (p) => {
    const r = (await db.select().from(run).where(eq(run.id, String(p.runId))))[0];
    if (!r?.agentId || !r.taskId) return;
    const a = (await db.select().from(agent).where(eq(agent.id, r.agentId)))[0];
    // test-engineer run 结束 → 平台跑验收
    if (a?.templateId === 'test-engineer' && p.stopReason !== 'cancelled') await afterTestRun(db, r.taskId, r.id);
    // I5：steward 分诊完没给结果，阻塞也不能悬着；看它做过什么，任务可能已因别的原因再次阻塞
    if (r.trigger === 'block_triage') {
      const steps = JSON.parse(r.traceJson ?? '[]') as { name?: string; error?: string }[];
      const handled = steps.some((x) => (x.name === 'resolve_block' || x.name === 'escalate_block') && !x.error);
      const t = (await db.select().from(task).where(eq(task.id, r.taskId)))[0];
      if (!handled && t?.status === 'blocked') await escalateTask(db, { type: 'agent', id: r.agentId }, t.id, 'steward 没有解除这个阻塞');
    }
  });

  // 解除阻塞 → 交回给 assignee 继续干
  on('task_resumed', async (p) => {
    const t = (await db.select().from(task).where(eq(task.id, String(p.targetId))))[0];
    if (t?.assigneeType === 'agent' && t.assigneeId) await triggerRun(db, t.assigneeId, t.id, 'feedback');
  });

  // 任务终态 → 回收 worktree + 父任务收口
  on('task_status_changed', async (p) => {
    const to = String((p as Record<string, unknown>).to ?? '');
    if (!['done', 'cancelled'].includes(to)) return;
    const t = (await db.select().from(task).where(eq(task.id, String(p.targetId))))[0];
    if (!t) return;
    const ws = (await db.select().from(workstation).where(eq(workstation.id, t.workstationId)))[0];
    if (t.codeRefJson && ws) await removeTaskWorktree(devSettings(ws.settingsJson), t.workstationId, t.id);
    await maybeCloseParent(db, t.parentId);
  });

  return () => { for (const off of offs) off(); };
}

export const scheduler = {
  idle: () => queue.onIdle(),
  trigger: (db: DB, agentId: string, taskId: string, trigger: string) => triggerRun(db, agentId, taskId, trigger),
};
