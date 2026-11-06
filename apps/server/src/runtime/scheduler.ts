import PQueue from 'p-queue';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { and, eq, inArray, like } from 'drizzle-orm';
import type { Actor, PermCtx } from '@aw/domain';
import { transition } from '@aw/domain';
import type { DB } from '../db/client.js';
import { agent, artifact, entity, message, proposal, reviewComment, run, task, thread, workstation } from '../db/schema.js';
import { events } from '../events.js';
import { createTaskWorktree, devSettings, ensureTargetBranch, git, type DevSettings } from './git.js';
import { buildPermCtx, logEvent, manifestOf } from '../usecases/index.js';
import { buildContext } from './context.js';
import { runCommand } from './exec.js';
import { runAgent } from './loop.js';
import { loadModels, resolveModel, sanitizeError } from './models.js';
import type { ToolCtx } from './tools/index.js';
import type { AgentRow, TaskRow } from './types.js';

const queue = new PQueue({ concurrency: Number(process.env.AW_RUN_CONCURRENCY ?? 2) });
// git worktree 操作串行化，避免 refs/lock 冲突
const gitLock = new PQueue({ concurrency: 1 });
const inFlight = new Set<string>();
const queued = new Set<string>();

const now = () => new Date().toISOString();
const MODULE_FILES_LIMIT = 200;
const FAILED_OUTPUT_TAIL = 800;

// 触发一次 run：装配上下文 → 插入 run 行 → 入队执行 loop
export async function triggerRun(db: DB, agentId: string, taskId: string, trigger: string): Promise<{ ok: boolean; runId?: string; error?: string }> {
  const a = (await db.select().from(agent).where(eq(agent.id, agentId)))[0];
  const t = (await db.select().from(task).where(eq(task.id, taskId)))[0];
  if (!a || !t) return { ok: false, error: 'agent 或 task 不存在' };
  const key = `${agentId}:${taskId}`;
  if (queued.has(key) || inFlight.has(key)) return { ok: false, error: '该 (agent, task) 已在队列中' };
  queued.add(key);

  const runId = crypto.randomUUID();
  void queue.add(async () => {
    inFlight.add(key);
    try {
      await executeRun(db, runId, a, t, trigger);
    } catch (e) {
      await abortRun(db, runId, a, t, 'run_failed', e instanceof Error ? e.message : String(e))
        .catch((err: unknown) => console.error('[scheduler] run 收尾失败', sanitizeError(String(err))));
    } finally {
      inFlight.delete(key);
      queued.delete(key);
    }
  });
  return { ok: true, runId };
}

// run 没走完 loop 就失败：收尾 run（loop 已收尾则跳过）→ 任务转 blocked → 进收件箱 → 发 run_finished
async function abortRun(db: DB, runId: string, a: AgentRow, t: TaskRow, kind: 'run_failed' | 'blocked', reason: string) {
  const error = sanitizeError(reason);
  const ended = { status: 'error', stopReason: 'error', endedAt: now(), error };
  const existing = (await db.select().from(run).where(eq(run.id, runId)))[0];
  if (existing && existing.status !== 'running') return;
  if (existing) await db.update(run).set(ended).where(eq(run.id, runId));
  else await db.insert(run).values({ id: runId, agentId: a.id, taskId: t.id, provider: 'none', model: 'none', startedAt: now(), tokensIn: 0, tokensOut: 0, traceJson: '[]', ...ended });

  const { condTransition, pushInbox } = await import('./dev_workflow.js');
  await condTransition(db, { type: 'agent', id: a.id }, t.id, 'block', { blockedReason: error });
  const ref = kind === 'blocked' ? { refType: 'task', refId: t.id } : { refType: 'run', refId: runId };
  await pushInbox(db, t.projectId, { kind, ...ref, payload: { reason: error } });
  events.emit('inbox_created', { kind, refId: ref.refId });
  events.emit('run_finished', { runId, agentId: a.id, taskId: t.id, stopReason: 'error' });
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
      if (!tb.ok) return tb.error;
      const ref = await createTaskWorktree(s, a.workstationId, t.id);
      if (s.commands.setup) {
        const setup = await runCommand({ cwd: ref.worktree, command: s.commands.setup, timeoutSec: s.setupTimeoutSec });
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

async function moduleFilesOf(worktree: string | undefined, mod: string | undefined) {
  if (!worktree || !mod) return undefined;
  const r = await git(worktree, ['ls-files', '--', mod]);
  if (r.code !== 0) return undefined;
  const files = r.stdout.split('\n').filter(Boolean);
  const more = files.length > MODULE_FILES_LIMIT ? `\n…[还有 ${files.length - MODULE_FILES_LIMIT} 个文件]` : '';
  return files.length > 0 ? files.slice(0, MODULE_FILES_LIMIT).join('\n') + more : undefined;
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

// 装配一次 run 的完整上下文：角色提示词 + 任务 + Module / 分支 + 验收与审查反馈 + 线程
export async function buildRunContext(db: DB, a: AgentRow, t: TaskRow, manifest: ReturnType<typeof manifestOf>) {
  const tpl = manifest?.agents.find((x) => x.id === a.templateId);
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
    promptContent: (tpl as { promptContent?: string } | undefined)?.promptContent,
    agentName: a.name, agentRole: a.role, isSteward: a.isSteward === 1,
    isReviewer: tpl?.id === 'reviewer',
    stage: t.stage, templateId: a.templateId,
    agents: agents.map((x) => ({ id: x.id, name: x.name, templateId: x.templateId })),
    task: { title: t.title, intent: t.intent, inputJson: t.inputJson, acceptanceJson: t.acceptanceJson, typeId: t.typeId },
    parentTask: parent ? { title: parent.title, status: parent.status, intent: parent.intent } : null,
    siblingTasks: siblings.filter((s) => s.id !== t.id).map((s) => ({ title: s.title, status: s.status })),
    threadMessages: msgs.map((m) => ({ senderId: m.senderId, senderType: m.senderType, content: m.content, kind: m.kind })),
    module: mod,
    branch: ref?.branch,
    moduleFiles: await moduleFilesOf(ref?.worktree, mod),
    lastTestRun: await lastTestRunOf(db, t),
    openComments: await openCommentsOf(db, t.id),
  });
}

async function executeRun(db: DB, runId: string, a: AgentRow, t: TaskRow, trigger: string) {
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
      const r = transition(cur.status as never, ev);
      if (!r.ok) break;
      const changed = await db.update(task).set({ status: r.to }).where(and(eq(task.id, t.id), eq(task.status, cur.status)));
      if (changed.changes === 0) break;
      fresh = (await db.select().from(task).where(eq(task.id, t.id)))[0] ?? cur;
      await logEvent(db, { type: 'agent', id: a.id }, 'task_status_changed', 'task', t.id, { to: r.to, auto: true });
    }
  }

  await db.insert(run).values({
    id: runId, agentId: a.id, taskId: t.id, status: 'running',
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
  if (s && fresh.assigneeType === 'agent' && fresh.assigneeId === a.id && !fresh.codeRefJson && (JSON.parse(a.toolsJson ?? '[]') as string[]).includes('apply_patch')) {
    const failure = await prepareWorktree(db, a, fresh, s);
    if (failure) {
      await abortRun(db, runId, a, fresh, 'blocked', failure);
      return;
    }
    fresh = (await db.select().from(task).where(eq(task.id, t.id)))[0] ?? fresh;
  }

  const actor: Actor = { type: 'agent', id: a.id };
  const permCtx: PermCtx = await buildPermCtx(actor, db);
  const ctx: ToolCtx = { db, actor, permCtx, agent: a, task: fresh, run: runRow };
  const { system, messages } = await buildRunContext(db, a, fresh, manifest);

  await runAgent({
    db, ctx, route, system,
    messages: messages.map((m) => ({ role: 'user' as const, content: m.content })),
    agentRow: a, taskRow: fresh,
    pluginDefaultTokens: manifest?.defaults?.taskBudget?.tokens,
    pluginDefaultMinutes: manifest?.defaults?.taskBudget?.minutes,
  });
}

// 订阅事件总线；AW_AUTORUN=0 时不订阅
export function startScheduler(db: DB) {
  if (process.env.AW_AUTORUN === '0') return;

  events.on('task_assigned', async (p) => {
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

  // stage 流转 → 触发该 stage activeAgents
  events.on('task_stage_changed', async (p) => {
    const { triggerStageAgents } = await import('./dev_workflow.js');
    await triggerStageAgents(db, String(p.targetId), String(p.stage));
  });

  // test-engineer run 结束 → 平台跑验收
  events.on('run_finished', async (p) => {
    const r = (await db.select().from(run).where(eq(run.id, String(p.runId))))[0];
    if (!r?.agentId || !r.taskId) return;
    const a = (await db.select().from(agent).where(eq(agent.id, r.agentId)))[0];
    if (a?.templateId === 'test-engineer') {
      const { afterTestRun } = await import('./dev_workflow.js');
      await afterTestRun(db, r.taskId, r.id);
    }
  });

  // 任务终态 → 回收 worktree + 父任务收口
  events.on('task_status_changed', async (p) => {
    const to = String((p as Record<string, unknown>).to ?? '');
    if (!['done', 'cancelled'].includes(to)) return;
    const t = (await db.select().from(task).where(eq(task.id, String(p.targetId))))[0];
    if (!t) return;
    const ws = (await db.select().from(workstation).where(eq(workstation.id, t.workstationId)))[0];
    if (t.codeRefJson && ws) {
      const { removeTaskWorktree } = await import('./git.js');
      await removeTaskWorktree(devSettings(ws.settingsJson), t.workstationId, t.id);
    }
    const { maybeCloseParent } = await import('./dev_workflow.js');
    await maybeCloseParent(db, t.parentId);
  });

  // @提及：人发的线程消息含 @Agent名 → 触发
  events.on('message_created', async (p) => {
    if (p.senderType !== 'human') return;
    const content = String(p.content ?? '');
    const th = (await db.select().from(thread).where(eq(thread.id, String(p.threadId))))[0];
    if (!th) return;
    const taskId = th.scopeType === 'task' ? th.scopeId : null;
    if (!taskId) return;
    const agents = await db.select().from(agent);
    for (const a of agents) {
      if (!content.includes(`@${a.name}`)) continue;
      const ws = (await db.select().from(workstation).where(eq(workstation.id, a.workstationId)))[0];
      const tpl = ws ? manifestOf(ws)?.agents.find((x) => x.id === a.templateId) : null;
      if (tpl?.triggers?.includes('mentioned')) await triggerRun(db, a.id, taskId, 'mentioned');
    }
  });
}

export const scheduler = {
  idle: () => queue.onIdle(),
  trigger: (db: DB, agentId: string, taskId: string, trigger: string) => triggerRun(db, agentId, taskId, trigger),
};

export { like };
