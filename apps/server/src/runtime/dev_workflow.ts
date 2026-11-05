import { and, eq } from 'drizzle-orm';
import PQueue from 'p-queue';
import type { Actor } from '@aw/domain';
import { transition } from '@aw/domain';
import type { DB } from '../db/client.js';
import { artifact, entity, inboxItem, message, proposal, project, run, task, workstation } from '../db/schema.js';
import { events } from '../events.js';
import { git, gitOk, devSettings, ensureIntegration, removeTaskWorktree, type DevSettings } from './git.js';
import { runCommand, portEnv, type ExecResult } from './exec.js';
import { logEvent, manifestOf } from '../usecases/index.js';
import { taskThreadOf } from '../usecases/threads.js';
import { triggerRun } from './scheduler.js';
import type { ToolCtx } from './tools/index.js';
import path from 'node:path';

const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();

async function condTransition(db: DB, actor: Actor, taskId: string, ev: Parameters<typeof transition>[1], extra: Record<string, unknown> = {}) {
  const cur = (await db.select().from(task).where(eq(task.id, taskId)))[0];
  if (!cur) return null;
  const r = transition(cur.status as never, ev);
  if (!r.ok) return null;
  const changed = await db.update(task).set({ status: r.to, ...extra }).where(and(eq(task.id, taskId), eq(task.status, cur.status)));
  if (changed.changes === 0) return null;
  await logEvent(db, actor, 'task_status_changed', 'task', taskId, { to: r.to });
  return r.to;
}

async function setStage(db: DB, actor: Actor, taskId: string, stage: string) {
  await db.update(task).set({ stage }).where(eq(task.id, taskId));
  await logEvent(db, actor, 'task_stage_changed', 'task', taskId, { stage });
  events.emit('task_stage_changed', { targetId: taskId, stage });
}

async function threadMsg(db: DB, taskId: string, senderId: string, content: string, kind = 'status') {
  const th = await taskThreadOf(db, taskId);
  if (!th) return;
  const m = { id: uid(), threadId: th.id, senderType: 'agent', senderId, kind, content, createdAt: now() };
  await db.insert(message).values(m);
  events.emit('message_created', m as unknown as Record<string, unknown>);
}

export async function supersedePending(db: DB, taskId: string) {
  const pend = await db.select().from(proposal).where(and(eq(proposal.taskId, taskId)));
  for (const p of pend.filter((x) => x.status === 'pending' || x.status === 'changes_requested')) {
    await db.update(proposal).set({ status: 'superseded' }).where(eq(proposal.id, p.id));
  }
}

async function triggerTemplate(db: DB, wsId: string, taskId: string, templateId: string, trigger: string) {
  const { agent } = await import('../db/schema.js');
  const a = (await db.select().from(agent).where(and(eq(agent.workstationId, wsId), eq(agent.templateId, templateId))))[0];
  if (a) await triggerRun(db, a.id, taskId, trigger);
}

async function wsSettings(db: DB, wsId: string): Promise<DevSettings> {
  const ws = (await db.select().from(workstation).where(eq(workstation.id, wsId)))[0];
  return devSettings(ws?.settingsJson ?? null);
}

// 触发 stage 的 activeAgents（跳过 assignee 本身的模板）
export async function triggerStageAgents(db: DB, taskId: string, stage: string) {
  const t = (await db.select().from(task).where(eq(task.id, taskId)))[0];
  if (!t) return;
  const ws = (await db.select().from(workstation).where(eq(workstation.id, t.workstationId)))[0];
  const manifest = ws ? manifestOf(ws) : null;
  const st = manifest?.stages?.find((s) => s.id === stage);
  const { agent } = await import('../db/schema.js');
  const assigneeTpl = t.assigneeId
    ? (await db.select().from(agent).where(eq(agent.id, t.assigneeId)))[0]?.templateId
    : null;
  for (const tpl of st?.activeAgents ?? []) {
    if (tpl === assigneeTpl) continue;
    await triggerTemplate(db, t.workstationId, taskId, tpl, 'stage_enter');
  }
}

const feedbackCount = new Map<string, number>();

async function sendBack(db: DB, ctx: { actor: Actor }, taskId: string, note: string) {
  const n = (feedbackCount.get(taskId) ?? 0) + 1;
  feedbackCount.set(taskId, n);
  if (n > 3) {
    const p = await db.select().from(project).where(eq(project.id, (await db.select().from(task).where(eq(task.id, taskId)))[0]?.projectId ?? ''));
    await db.insert(inboxItem).values({ id: uid(), workspaceId: p[0]?.workspaceId ?? 'default', projectId: (await db.select().from(task).where(eq(task.id, taskId)))[0]?.projectId ?? null, kind: 'blocked', refType: 'task', refId: taskId, status: 'open', createdAt: now() });
    return;
  }
  await condTransition(db, ctx.actor, taskId, 'send_back');
  await setStage(db, ctx.actor, taskId, 'implement');
  await threadMsg(db, taskId, 'platform', note);
  const t = (await db.select().from(task).where(eq(task.id, taskId)))[0];
  if (t?.assigneeType === 'agent' && t.assigneeId) await triggerRun(db, t.assigneeId, taskId, 'feedback');
}

// submit_change → submitted + stage=test + 触发 test-engineer
export async function afterSubmit(ctx: ToolCtx, proposalId: string) {
  void proposalId;
  await condTransition(ctx.db, ctx.actor, ctx.task.id, 'submit');
  await setStage(ctx.db, ctx.actor, ctx.task.id, 'test');
  await triggerTemplate(ctx.db, ctx.agent.workstationId, ctx.task.id, 'test-engineer', 'stage_enter');
}

// review_change → approve: stage=merge 或 requireHuman；request_changes → send_back
export async function afterReview(ctx: ToolCtx, proposalId: string, decision: 'approve' | 'request_changes') {
  if (decision === 'request_changes') {
    await sendBack(ctx.db, ctx, ctx.task.id, '审查要求修改，回退到实现阶段');
    return;
  }
  const s = await wsSettings(ctx.db, ctx.agent.workstationId);
  await setStage(ctx.db, ctx.actor, ctx.task.id, 'merge');
  if (s.requireHumanFor.includes('merge')) {
    const p = await ctx.db.select().from(project).where(eq(project.id, ctx.task.projectId));
    await ctx.db.insert(inboxItem).values({ id: uid(), workspaceId: p[0]?.workspaceId ?? 'default', projectId: ctx.task.projectId, kind: 'proposal_review', refType: 'proposal', refId: proposalId, status: 'open', createdAt: now() });
    return;
  }
  enqueueMerge(ctx.db, ctx.actor, ctx.task.id);
}

// ===== 验收 =====
interface Check { kind: string; run?: string }

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
      dataJson: JSON.stringify({ command: c.run, status, duration: res.durationMs / 1000, output_ref: aid, commit_sha: head, batch_id: batchId }),
      createdByType: 'system', createdById: 'platform', createdAt: now(), updatedAt: now(),
    });
    results.push({ command: c.run!, status, duration: res.durationMs / 1000, output: res.output });
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
  const { allPassed, results } = await runAcceptance(db, t.workstationId!, ref.worktree, checks, s.commandTimeoutSec, taskId);
  await condTransition(db, actor, taskId, 'begin_review');
  if (allPassed) {
    await setStage(db, actor, taskId, 'review');
    await triggerTemplate(db, t.workstationId, taskId, 'reviewer', 'stage_enter');
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
    void queueOf(s.repoPath).add(() => doMerge(db, actor, taskId, s));
  })();
}

async function doMerge(db: DB, actor: Actor, taskId: string, s: DevSettings) {
  const t = (await db.select().from(task).where(eq(task.id, taskId)))[0];
  if (!t?.codeRefJson) return;
  const ref = JSON.parse(t.codeRefJson) as { worktree: string; branch: string; base_sha: string };
  const integ = await ensureIntegration(s, t.workstationId);
  const p = (await db.select().from(proposal).where(and(eq(proposal.taskId, taskId), eq(proposal.status, 'approved')))).pop();

  // 1. 干净 + targetBranch
  const cur = (await git(integ, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
  const dirty = (await git(integ, ['status', '--porcelain'])).stdout.trim();
  if (cur !== s.targetBranch || dirty) {
    await threadMsg(db, taskId, 'platform', `integration worktree 不干净（branch=${cur}），合并中止`);
    await sendBack(db, { actor }, taskId, '合并中止：integration worktree 状态异常');
    return;
  }
  // 2. merge --no-commit
  const m = await git(integ, ['-c', 'user.name=aw-platform', '-c', 'user.email=platform@aw.local', 'merge', '--no-ff', '--no-commit', ref.branch]);
  if (m.code !== 0) {
    await git(integ, ['merge', '--abort']);
    if (p) await db.update(proposal).set({ status: 'conflicted' }).where(eq(proposal.id, p.id));
    const conflicted = (await git(integ, ['diff', '--name-only', '--diff-filter=U'])).stdout.trim();
    await sendBack(db, { actor }, taskId, `合并冲突，回退到实现阶段。冲突文件：${conflicted || '未知'}。stderr: ${m.stderr.slice(0, 300)}`);
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
  const { allPassed, results } = await runAcceptance(db, t.workstationId!, integ, checks, s.commandTimeoutSec, taskId);
  if (!allPassed) {
    await git(integ, ['merge', '--abort']);
    const fails = results.filter((r) => r.status !== 'passed').map((r) => `${r.command}: ${r.output.slice(0, 300)}`).join('\n');
    await sendBack(db, { actor }, taskId, `合并后验收未通过：\n${fails}`);
    return;
  }
  // 4. commit + proposal merged + task approve + 回收
  await gitOk(integ, ['-c', 'user.name=aw-platform', '-c', 'user.email=platform@aw.local', 'commit', '--no-edit', '-m', `Merge ${ref.branch}: ${t.title} (task ${taskId.slice(0, 8)})`]);
  const mergeSha = (await gitOk(integ, ['rev-parse', 'HEAD'])).stdout.trim();
  if (p) {
    await db.update(proposal).set({ status: 'merged' }).where(eq(proposal.id, p.id));
  }
  await db.update(task).set({ codeRefJson: JSON.stringify({ ...ref, merge_sha: mergeSha }) }).where(eq(task.id, taskId));
  await logEvent(db, actor, 'proposal_merged', 'proposal', p?.id ?? '', { merge_sha: mergeSha });
  await condTransition(db, actor, taskId, 'approve');
  await removeTaskWorktree(s, t.workstationId, taskId);
  events.emit('inbox_created', { kind: 'merged', refId: taskId });
  await maybeCloseParent(db, t.parentId);
}

// ===== 父任务收口 =====
export async function maybeCloseParent(db: DB, parentId: string | null) {
  if (!parentId) return;
  const children = await db.select().from(task).where(eq(task.parentId, parentId));
  const terminal = ['done', 'cancelled', 'rejected'];
  if (children.length === 0 || !children.every((c) => terminal.includes(c.status))) return;
  if (!children.some((c) => c.status === 'done')) return;
  const parent = (await db.select().from(task).where(eq(task.id, parentId)))[0];
  if (!parent) return;
  const actor: Actor = { type: 'human', id: 'local' };
  const sub = await condTransition(db, actor, parentId, 'submit');
  if (!sub) return;
  await condTransition(db, actor, parentId, 'begin_review');
  // 父任务 acceptance 在 integration worktree（targetBranch HEAD）
  const s = await wsSettings(db, parent.workstationId === parent.assigneeId ? parent.assigneeId! : parent.workstationId);
  const targetWs = parent.assigneeType === 'workstation' ? parent.assigneeId! : parent.workstationId;
  const integ = await ensureIntegration(await wsSettings(db, targetWs), targetWs);
  const checks = JSON.parse(parent.acceptanceJson ?? '[]') as Check[];
  const { allPassed } = await runAcceptance(db, targetWs, integ, checks, s.commandTimeoutSec, parentId);
  if (allPassed) {
    await condTransition(db, actor, parentId, 'approve');
    const steward = (await db.select().from((await import('../db/schema.js')).agent).where(and(eq((await import('../db/schema.js')).agent.workstationId, targetWs), eq((await import('../db/schema.js')).agent.isSteward, 1))))[0];
    await threadMsg(db, parentId, steward?.id ?? 'platform', '全部子任务完成，父任务验收通过，已收尾。');
  } else {
    const p = await db.select().from(project).where(eq(project.id, parent.projectId));
    await db.insert(inboxItem).values({ id: uid(), workspaceId: p[0]?.workspaceId ?? 'default', projectId: parent.projectId, kind: 'blocked', refType: 'task', refId: parentId, status: 'open', createdAt: now() });
  }
}

export { mergeQueues, feedbackCount };
