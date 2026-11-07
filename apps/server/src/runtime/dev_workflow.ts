import { and, eq, inArray, sql } from 'drizzle-orm';
import PQueue from 'p-queue';
import type { Actor, TaskStatus } from '@aw/domain';
import { transition } from '@aw/domain';
import type { DB } from '../db/client.js';
import { agent, artifact, entity, proposal, reviewComment, run, task, workstation } from '../db/schema.js';
import { events } from '../events.js';
import { git, gitOk, devSettings, ensureIntegration, removeTaskWorktree, type DevSettings } from './git.js';
import { runCommand, portEnv, type ExecResult } from './exec.js';
import { snapshotDb } from '../usecases/backup.js';
import { logEvent, manifestOf } from '../usecases/core.js';
import { pushInbox } from '../usecases/inbox.js';
import { rollupStage } from '../usecases/tasks.js';
import { postHandoff, postStatus } from '../usecases/threads.js';
import { triggerRun } from './scheduler.js';
import { runVisualCheck } from './visual.js';
import type { TaskRow } from './types.js';
import path from 'node:path';

const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();
// 连续退回超过此次数就转人工
const MAX_SEND_BACKS = 3;
const PATCH_DIFF_LIMIT = 200 * 1024;

type WorkflowCtx = { db: DB; actor: Actor; task: TaskRow };

export async function condTransition(db: DB, actor: Actor, taskId: string, ev: Parameters<typeof transition>[1], extra: Record<string, unknown> = {}) {
  const cur = (await db.select().from(task).where(eq(task.id, taskId)))[0];
  if (!cur) return null;
  const r = transition(cur.status as TaskStatus, ev);
  if (!r.ok) return null;
  const changed = await db.update(task).set({ status: r.to, ...extra }).where(and(eq(task.id, taskId), eq(task.status, cur.status)));
  if (changed.changes === 0) return null;
  await logEvent(db, actor, 'task_status_changed', 'task', taskId, { to: r.to });
  return r.to;
}

async function setStage(db: DB, actor: Actor, taskId: string, stage: string) {
  await db.update(task).set({ stage }).where(eq(task.id, taskId));
  await logEvent(db, actor, 'task_stage_changed', 'task', taskId, { stage });
  const parentId = (await db.select({ parentId: task.parentId }).from(task).where(eq(task.id, taskId)))[0]?.parentId;
  if (parentId) await rollupStage(db, actor, parentId);
}

export async function supersedePending(db: DB, taskId: string) {
  const pend = await db.select().from(proposal).where(and(eq(proposal.taskId, taskId)));
  for (const p of pend.filter((x) => x.status === 'pending' || x.status === 'changes_requested')) {
    await db.update(proposal).set({ status: 'superseded' }).where(eq(proposal.id, p.id));
  }
}

async function triggerTemplate(db: DB, wsId: string, taskId: string, templateId: string, trigger: string) {
  const a = (await db.select().from(agent).where(and(eq(agent.workstationId, wsId), eq(agent.templateId, templateId))))[0];
  if (a) await triggerRun(db, a.id, taskId, trigger);
}

async function wsSettings(db: DB, wsId: string): Promise<DevSettings> {
  const ws = (await db.select().from(workstation).where(eq(workstation.id, wsId)))[0];
  return devSettings(ws?.settingsJson ?? null);
}

const actorName = async (db: DB, actor: Actor) =>
  actor.type === 'human' ? '本地用户' : ((await db.select().from(agent).where(eq(agent.id, actor.id)))[0]?.name ?? 'Agent');

const assigneeName = async (db: DB, t: TaskRow) => {
  if (t.assigneeType === 'human') return '本地用户';
  return (t.assigneeId ? (await db.select().from(agent).where(eq(agent.id, t.assigneeId)))[0]?.name : undefined) ?? '实现者';
};

// 进入 stage 时唤醒声明了 stage_enter 的 activeAgents；activeAgents 只表示本阶段可参与，实现者由指派驱动
export async function triggerStageAgents(db: DB, taskId: string, stage: string) {
  const t = (await db.select().from(task).where(eq(task.id, taskId)))[0];
  if (!t) return;
  const ws = (await db.select().from(workstation).where(eq(workstation.id, t.workstationId)))[0];
  const manifest = ws ? manifestOf(ws) : null;
  const st = manifest?.stages?.find((s) => s.id === stage);
  for (const id of st?.activeAgents ?? []) {
    if (manifest?.agents.find((a) => a.id === id)?.triggers?.includes('stage_enter')) {
      await triggerTemplate(db, t.workstationId, taskId, id, 'stage_enter');
    }
  }
}

export async function sendBack(db: DB, ctx: { actor: Actor }, taskId: string, note: string) {
  const row = (await db.update(task).set({ feedbackCount: sql`${task.feedbackCount} + 1` }).where(eq(task.id, taskId)).returning({ n: task.feedbackCount, projectId: task.projectId }))[0];
  if (!row) return;
  const cur = (await db.select().from(task).where(eq(task.id, taskId)))[0]!;
  const to = await assigneeName(db, cur);
  if (row.n > MAX_SEND_BACKS) {
    // 次数用尽：退回实现后转 blocked 等人处理；计数清零，人解除阻塞后重新计
    const reason = `连续退回超过 ${MAX_SEND_BACKS} 次，需要人工介入。最后一次：${note.slice(0, 500)}`;
    await condTransition(db, ctx.actor, taskId, 'send_back', { stage: 'implement' });
    await condTransition(db, ctx.actor, taskId, 'block', { blockedReason: reason, feedbackCount: 0 });
    await pushInbox(db, row.projectId, { kind: 'blocked', refType: 'task', refId: taskId, payload: { reason } });
    await postStatus(db, taskId, reason);
    return;
  }
  await condTransition(db, ctx.actor, taskId, 'send_back');
  await setStage(db, ctx.actor, taskId, 'implement');
  await postHandoff(db, taskId, note, { from: await actorName(db, ctx.actor), to, next: '修订后重新提交' });
  const t = (await db.select().from(task).where(eq(task.id, taskId)))[0];
  if (t?.assigneeType === 'agent' && t.assigneeId) await triggerRun(db, t.assigneeId, taskId, 'feedback');
}

// 提交 = 分支快照成代码提案；Agent 工具和人工接管共用
export async function submitChange(ctx: WorkflowCtx, summary: string): Promise<{ error: string } | { proposalId: string; head_sha: string }> {
  const { db, actor } = ctx;
  const ref = ctx.task.codeRefJson ? (JSON.parse(ctx.task.codeRefJson) as { worktree: string; base_sha: string }) : null;
  if (!ref?.worktree) return { error: '任务没有 worktree' };
  const status = await git(ref.worktree, ['status', '--porcelain']);
  if (status.stdout.trim()) return { error: '存在未提交改动' };
  const count = await git(ref.worktree, ['rev-list', '--count', `${ref.base_sha}..HEAD`]);
  if (Number(count.stdout.trim()) < 1) return { error: '分支未领先 base' };
  const head = (await gitOk(ref.worktree, ['rev-parse', 'HEAD'])).stdout.trim();
  const d = (await git(ref.worktree, ['diff', `${ref.base_sha}..HEAD`])).stdout;
  const pid = uid();
  await supersedePending(db, ctx.task.id);
  await db.insert(proposal).values({
    id: pid, taskId: ctx.task.id, workstationId: ctx.task.workstationId, targetType: 'code', baseVersion: 0,
    patchJson: d.length > PATCH_DIFF_LIMIT ? `${d.slice(0, PATCH_DIFF_LIMIT)}\n…[truncated]` : d,
    reason: summary, authorType: actor.type, authorId: actor.id,
    status: 'pending', createdAt: now(),
  });
  await db.update(task).set({ codeRefJson: JSON.stringify({ ...ref, head_sha: head }) }).where(eq(task.id, ctx.task.id));
  await logEvent(db, actor, 'proposal_created', 'proposal', pid, { kind: 'code' });
  await afterSubmit(ctx, pid, summary);
  return { proposalId: pid, head_sha: head };
}

// submit_change → submitted + stage=test；test-engineer 由 stage 事件唤醒
async function afterSubmit(ctx: WorkflowCtx, proposalId: string, summary: string) {
  await condTransition(ctx.db, ctx.actor, ctx.task.id, 'submit');
  await postHandoff(ctx.db, ctx.task.id, `提交改动：${summary}`, { from: await actorName(ctx.db, ctx.actor), to: '测试工程师', next: '跑验收', refs: { proposalId } });
  await setStage(ctx.db, ctx.actor, ctx.task.id, 'test');
}

// review_change → approve: stage=merge 或 requireHuman；request_changes → send_back
export async function afterReview(ctx: Pick<WorkflowCtx, 'db' | 'actor' | 'task'> & { agent: { workstationId: string } }, proposalId: string, decision: 'approve' | 'request_changes') {
  if (decision === 'request_changes') {
    await sendBack(ctx.db, ctx, ctx.task.id, '审查要求修改，回退到实现阶段');
    return;
  }
  // 审查通过即视为此前意见已处理，不再进入后续上下文
  const ids = (await ctx.db.select({ id: proposal.id }).from(proposal).where(eq(proposal.taskId, ctx.task.id))).map((p) => p.id);
  if (ids.length > 0) await ctx.db.update(reviewComment).set({ resolved: 1 }).where(inArray(reviewComment.proposalId, ids));
  const s = await wsSettings(ctx.db, ctx.agent.workstationId);
  const needHuman = s.requireHumanFor.includes('merge');
  await postHandoff(ctx.db, ctx.task.id, needHuman ? '审查通过，等你确认入队合并' : '审查通过，进入串行合并队列', { from: await actorName(ctx.db, ctx.actor), to: needHuman ? '本地用户' : '合并队列', next: '合并', refs: { proposalId } });
  await setStage(ctx.db, ctx.actor, ctx.task.id, 'merge');
  if (needHuman) {
    await pushInbox(ctx.db, ctx.task.projectId, { kind: 'proposal_review', refType: 'proposal', refId: proposalId });
    return;
  }
  enqueueMerge(ctx.db, ctx.actor, ctx.task.id);
}

// ===== 验收 =====
interface Check { kind: string; run?: string; url?: string; baseline?: string; maxDiff?: number }

export async function runAcceptance(db: DB, wsId: string, worktree: string, checks: Check[], timeoutSec: number, taskId?: string): Promise<{ allPassed: boolean; results: { command: string; status: string; duration: number; output: string }[] }> {
  const head = (await git(worktree, ['rev-parse', 'HEAD'])).stdout.trim();
  const batchId = uid();
  const results: { command: string; status: string; duration: number; output: string }[] = [];
  for (const c of checks.filter((x) => x.kind === 'command' && x.run)) {
    let res: ExecResult;
    try {
      res = await runCommand({ cwd: worktree, command: c.run!, timeoutSec, env: portEnv(path.basename(worktree)) });
    } catch (e) {
      res = { exitCode: -1, durationMs: 0, output: String(e), truncated: false, timedOut: false };
    }
    const status = res.timedOut || res.exitCode === -1 ? 'error' : res.exitCode === 0 ? 'passed' : 'failed';
    const aid = uid();
    await db.insert(artifact).values({ id: aid, workstationId: wsId, taskId: taskId ?? null, type: 'test_output', name: 'test_output', ref: res.output.slice(0, 32000), createdAt: now() });
    await db.insert(entity).values({
      id: uid(), workstationId: wsId, entityType: 'TestRun', version: 1,
      dataJson: JSON.stringify({ command: c.run, status, duration: res.durationMs / 1000, output_ref: aid, commit_sha: head, batch_id: batchId, task_id: taskId ?? null }),
      createdByType: 'system', createdById: 'platform', createdAt: now(), updatedAt: now(),
    });
    results.push({ command: c.run!, status, duration: res.durationMs / 1000, output: res.output });
  }
  for (const c of checks.filter((x) => x.kind === 'visual' && x.url && x.baseline)) {
    const started = Date.now();
    const v = await runVisualCheck(worktree, { url: c.url!, baseline: c.baseline!, maxDiff: c.maxDiff ?? 0.02 });
    const command = `visual ${c.url}`;
    const duration = (Date.now() - started) / 1000;
    const aid = uid();
    await db.insert(artifact).values({ id: aid, workstationId: wsId, taskId: taskId ?? null, type: 'test_output', name: 'visual', ref: v.output, metaJson: JSON.stringify({ shot: v.shot, ratio: v.ratio }), createdAt: now() });
    await db.insert(entity).values({
      id: uid(), workstationId: wsId, entityType: 'TestRun', version: 1,
      dataJson: JSON.stringify({ command, status: v.status, duration, output_ref: aid, commit_sha: head, batch_id: batchId, task_id: taskId ?? null }),
      createdByType: 'system', createdById: 'platform', createdAt: now(), updatedAt: now(),
    });
    results.push({ command, status: v.status, duration, output: v.output });
  }
  const allPassed = results.every((r) => r.status === 'passed');
  if (taskId) {
    const t = (await db.select().from(task).where(eq(task.id, taskId)))[0];
    const rj = t?.resultJson ? JSON.parse(t.resultJson) as Record<string, unknown> : {};
    rj.acceptance = { batchId, passed: allPassed, at: now() };
    await db.update(task).set({ resultJson: JSON.stringify(rj) }).where(eq(task.id, taskId));
  }
  return { allPassed, results };
}

// 守卫：读 task.resultJson.acceptance（最近一次验收批次），无记录返回 null
export async function lastAcceptancePassed(db: DB, wsId: string, taskId?: string): Promise<boolean | null> {
  if (taskId) {
    const t = (await db.select().from(task).where(eq(task.id, taskId)))[0];
    const acc = t?.resultJson ? (JSON.parse(t.resultJson) as { acceptance?: { passed?: boolean } }).acceptance : undefined;
    return acc?.passed ?? null;
  }
  const rows = await db.select().from(entity).where(and(eq(entity.workstationId, wsId), eq(entity.entityType, 'TestRun')));
  if (rows.length === 0) return null;
  const latest = rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]!;
  const batchId = (JSON.parse(latest.dataJson ?? '{}') as { batch_id?: string }).batch_id;
  const batch = rows.filter((r) => (JSON.parse(r.dataJson ?? '{}') as { batch_id?: string }).batch_id === batchId);
  return batch.every((r) => (JSON.parse(r.dataJson ?? '{}') as { status: string }).status === 'passed');
}

// test-engineer stage_enter run 结束 → 平台跑验收 → begin_review → 全过 stage=review 触发 reviewer，否则 send_back
// runId 用于确认是该任务在 test stage 下的 stage_enter run（手动运行/其他任务的 run 不触发）
export async function afterTestRun(db: DB, taskId: string, runId?: string) {
  const t = (await db.select().from(task).where(eq(task.id, taskId)))[0];
  if (!t || t.stage !== 'test') return;
  if (runId) {
    const r = (await db.select().from(run).where(eq(run.id, runId)))[0];
    if (!r || r.taskId !== taskId || r.trigger !== 'stage_enter') return;
  }
  const s = await wsSettings(db, t.workstationId);
  const checks = JSON.parse(t.acceptanceJson ?? '[]') as Check[];
  const ref = t.codeRefJson ? JSON.parse(t.codeRefJson) as { worktree: string } : null;
  if (!ref?.worktree) return;
  const actor: Actor = { type: 'human', id: 'local' };
  const { allPassed, results } = await runAcceptance(db, t.workstationId, ref.worktree, checks, s.commandTimeoutSec, taskId);
  await condTransition(db, actor, taskId, 'begin_review');
  if (allPassed) {
    await postHandoff(db, taskId, `验收通过（${results.length} 项），交给审查`, { from: '测试工程师', to: '审查', next: '独立审阅 diff' });
    await setStage(db, actor, taskId, 'review');
  } else {
    const fails = results.filter((r) => r.status !== 'passed').map((r) => `${r.command}: ${r.status}\n${r.output.slice(0, 300)}`).join('\n');
    await sendBack(db, { actor }, taskId, `验收未通过，回退到实现阶段：\n${fails}`);
  }
}

// ===== 合并队列（每仓库并发 1）=====
const mergeQueues = new Map<string, PQueue>();
const queueOf = (repo: string) => mergeQueues.get(repo) ?? mergeQueues.set(repo, new PQueue({ concurrency: 1 })).get(repo)!;

export function enqueueMerge(db: DB, actor: Actor, taskId: string) {
  void (async () => {
    const t = (await db.select().from(task).where(eq(task.id, taskId)))[0];
    if (!t) return;
    const s = await wsSettings(db, t.workstationId);
    await queueOf(s.repoPath).add(() => doMerge(db, actor, taskId, s).catch(async (e) => {
      // 合并任务异常不能静默：任务必须脱离 reviewing/merge，否则永久卡住
      await sendBack(db, { actor }, taskId, `合并异常：${String(e).slice(0, 300)}`);
    }));
  })().catch((e: unknown) => console.error('[merge] 入队失败', taskId, String(e)));
}

async function doMerge(db: DB, actor: Actor, taskId: string, s: DevSettings) {
  const t = (await db.select().from(task).where(eq(task.id, taskId)))[0];
  if (!t?.codeRefJson || t.status === 'done') return;
  const ref = JSON.parse(t.codeRefJson) as { worktree: string; branch: string; base_sha: string };
  const integ = await ensureIntegration(s, t.workstationId);
  const p = (await db.select().from(proposal).where(and(eq(proposal.taskId, taskId), eq(proposal.status, 'approved')))).pop();

  // 1. 干净 + targetBranch
  const cur = (await git(integ, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
  const dirty = (await git(integ, ['status', '--porcelain'])).stdout.trim();
  if (cur !== s.targetBranch || dirty) {
    await postStatus(db, taskId, `integration worktree 不干净（branch=${cur}），合并中止`);
    await sendBack(db, { actor }, taskId, '合并中止：integration worktree 状态异常');
    return;
  }
  await snapshotDb(db, taskId);
  // 2. merge --no-commit
  const m = await git(integ, ['-c', 'user.name=aw-platform', '-c', 'user.email=platform@aw.local', 'merge', '--no-ff', '--no-commit', ref.branch]);
  if (m.code !== 0) {
    // 必须在 abort 之前取：abort 后索引已干净；git 的冲突说明也写在 stdout
    const conflicted = (await git(integ, ['diff', '--name-only', '--diff-filter=U'])).stdout.trim().split('\n').filter(Boolean);
    await git(integ, ['merge', '--abort']);
    if (p) await db.update(proposal).set({ status: 'conflicted' }).where(eq(proposal.id, p.id));
    const detail = (m.stderr.trim() || m.stdout.trim()).slice(0, 300);
    await sendBack(db, { actor }, taskId, `合并冲突，回退到实现阶段。冲突文件：${conflicted.join('、') || '未知'}。${detail}`);
    return;
  }
  // 3. setup + 验收
  if (s.commands.setup) {
    const setup = await runCommand({ cwd: integ, command: s.commands.setup, timeoutSec: s.setupTimeoutSec, env: portEnv('_integration') });
    if (setup.exitCode !== 0) {
      await git(integ, ['merge', '--abort']);
      await sendBack(db, { actor }, taskId, `合并后 setup 失败：\n${setup.output.slice(0, 300)}`);
      return;
    }
  }
  const checks = JSON.parse(t.acceptanceJson ?? '[]') as Check[];
  const { allPassed, results } = await runAcceptance(db, t.workstationId, integ, checks, s.commandTimeoutSec, taskId);
  if (!allPassed) {
    await git(integ, ['merge', '--abort']);
    const fails = results.filter((r) => r.status !== 'passed').map((r) => `${r.command}: ${r.output.slice(0, 300)}`).join('\n');
    await sendBack(db, { actor }, taskId, `合并后验收未通过：\n${fails}`);
    return;
  }
  // 4. commit + proposal merged + task approve + 回收
  const pending = (await git(integ, ['status', '--porcelain'])).stdout.trim();
  if (pending) {
    await gitOk(integ, ['-c', 'user.name=aw-platform', '-c', 'user.email=platform@aw.local', 'commit', '--no-edit', '-m', `Merge ${ref.branch}: ${t.title} (task ${taskId.slice(0, 8)})`]);
  }
  const mergeSha = (await gitOk(integ, ['rev-parse', 'HEAD'])).stdout.trim();
  if (p) {
    await db.update(proposal).set({ status: 'merged' }).where(eq(proposal.id, p.id));
  }
  await db.update(task).set({ codeRefJson: JSON.stringify({ ...ref, merge_sha: mergeSha }) }).where(eq(task.id, taskId));
  await logEvent(db, actor, 'proposal_merged', 'proposal', p?.id ?? '', { merge_sha: mergeSha });
  await postHandoff(db, taskId, `已合并到 ${s.targetBranch}（${mergeSha.slice(0, 8)}）`, { from: '合并队列', to: 'steward', refs: { merge_sha: mergeSha } });
  await condTransition(db, actor, taskId, 'approve');
  await removeTaskWorktree(s, t.workstationId, taskId);
  events.emit('inbox_created', { kind: 'merged', refId: taskId });
  await maybeCloseParent(db, t.parentId);
}

// ===== 父任务收口 =====
export async function maybeCloseParent(db: DB, parentId: string | null) {
  if (!parentId) return;
  const actor: Actor = { type: 'human', id: 'local' };
  await rollupStage(db, actor, parentId);
  const children = await db.select().from(task).where(eq(task.parentId, parentId));
  const terminal = ['done', 'cancelled', 'rejected'];
  if (children.length === 0 || !children.every((c) => terminal.includes(c.status))) return;
  if (!children.some((c) => c.status === 'done')) return;
  const parent = (await db.select().from(task).where(eq(task.id, parentId)))[0];
  if (!parent) return;
  const sub = await condTransition(db, actor, parentId, 'submit');
  if (!sub) return;
  await condTransition(db, actor, parentId, 'begin_review');
  // 父任务 acceptance 在 integration worktree（targetBranch HEAD）
  const targetWs = parent.assigneeType === 'workstation' ? parent.assigneeId! : parent.workstationId;
  const s = await wsSettings(db, targetWs);
  const integ = await ensureIntegration(s, targetWs);
  const checks = JSON.parse(parent.acceptanceJson ?? '[]') as Check[];
  const { allPassed } = await runAcceptance(db, targetWs, integ, checks, s.commandTimeoutSec, parentId);
  const steward = (await db.select().from(agent).where(and(eq(agent.workstationId, targetWs), eq(agent.isSteward, 1))))[0];
  if (allPassed) {
    await condTransition(db, actor, parentId, 'approve');
    await postHandoff(db, parentId, '全部子任务完成，主任务验收通过，已收尾。', { from: steward?.name ?? '工作台', to: '根工作台' });
  } else {
    await pushInbox(db, parent.projectId, { kind: 'blocked', refType: 'task', refId: parentId, payload: { reason: '全部子任务已完成，但主任务验收未通过' } });
  }
}

export { mergeQueues };
