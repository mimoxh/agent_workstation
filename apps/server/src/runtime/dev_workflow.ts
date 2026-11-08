import { and, eq, inArray, sql } from 'drizzle-orm';
import PQueue from 'p-queue';
import type { Actor, TaskStatus } from '@aw/domain';
import { transition } from '@aw/domain';
import type { DB } from '../db/client.js';
import { agent, artifact, entity, proposal, reviewComment, run, task, workstation } from '../db/schema.js';
import { events } from '../events.js';
import { git, gitOk, devSettings, ensureIntegration, removeTaskWorktree, pushTarget, type DevSettings } from './git.js';
import { runCommand, portEnv, isEnvError, type ExecResult } from './exec.js';
import { snapshotDb } from '../usecases/backup.js';
import { logEvent, manifestOf } from '../usecases/core.js';
import { pushInbox } from '../usecases/inbox.js';
import { rollupStage } from '../usecases/tasks.js';
import { postHandoff, postStatus } from '../usecases/threads.js';
import { triggerRun } from './scheduler.js';
import { resolveUrl, runVisualCheck, withServer, type VisualResult } from './visual.js';
import type { TaskRow } from './types.js';
import type { SandboxConfig } from './sandbox.js';
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
export interface AcceptanceExec { serve?: string | undefined; sandbox?: SandboxConfig | undefined }
export const acceptanceExec = (s: DevSettings): AcceptanceExec => ({ serve: s.commands.serve, sandbox: s.sandbox });
export interface AcceptanceResult { command: string; status: string; duration: number; output: string; env: boolean }

const envSummary = (results: AcceptanceResult[]) => results.filter((r) => r.env).map((r) => `${r.command}: ${r.output.trim().slice(0, 300)}`).join('\n');

// 验收跑不起来是环境问题（命令不存在、服务起不来）：退回实现者没用，转 blocked 等人修环境
async function blockForEnvironment(db: DB, taskId: string, where: string, results: AcceptanceResult[]) {
  const actor: Actor = { type: 'human', id: 'local' };
  const t = (await db.select().from(task).where(eq(task.id, taskId)))[0];
  if (!t) return;
  const reason = `${where}时验收环境出错，不是改动本身的问题（不计退回次数）。修好环境后解除阻塞，实现者重新提交即可再次验收：\n${envSummary(results)}`;
  // 已审过的提案作废：重新提交后要走一遍新的测试与评审
  await db.update(proposal).set({ status: 'superseded' }).where(and(eq(proposal.taskId, taskId), eq(proposal.status, 'approved')));
  await condTransition(db, actor, taskId, 'begin_review');
  await condTransition(db, actor, taskId, 'send_back', { stage: 'implement' });
  await condTransition(db, actor, taskId, 'block', { blockedReason: reason.slice(0, 2000) });
  await pushInbox(db, t.projectId, { kind: 'blocked', refType: 'task', refId: taskId, payload: { reason, environment: true } });
  await postStatus(db, taskId, reason);
}

export async function runAcceptance(db: DB, wsId: string, worktree: string, checks: Check[], timeoutSec: number, taskId?: string, exec: AcceptanceExec = {}): Promise<{ allPassed: boolean; envError: boolean; results: AcceptanceResult[] }> {
  const head = (await git(worktree, ['rev-parse', 'HEAD'])).stdout.trim();
  const batchId = uid();
  const results: AcceptanceResult[] = [];
  for (const c of checks.filter((x) => x.kind === 'command' && x.run)) {
    let res: ExecResult;
    try {
      res = await runCommand({ cwd: worktree, command: c.run!, timeoutSec, env: portEnv(path.basename(worktree)), sandbox: exec.sandbox });
    } catch (e) {
      res = { exitCode: -1, durationMs: 0, output: String(e), truncated: false, timedOut: false };
    }
    const env = res.exitCode !== 0 && isEnvError(res);
    const status = res.timedOut || env ? 'error' : res.exitCode === 0 ? 'passed' : 'failed';
    const aid = uid();
    await db.insert(artifact).values({ id: aid, workstationId: wsId, taskId: taskId ?? null, type: 'test_output', name: 'test_output', ref: res.output.slice(0, 32000), createdAt: now() });
    await db.insert(entity).values({
      id: uid(), workstationId: wsId, entityType: 'TestRun', version: 1,
      dataJson: JSON.stringify({ command: c.run, status, duration: res.durationMs / 1000, output_ref: aid, commit_sha: head, batch_id: batchId, task_id: taskId ?? null, ...(env ? { env_error: true } : {}) }),
      createdByType: 'system', createdById: 'platform', createdAt: now(), updatedAt: now(),
    });
    results.push({ command: c.run!, status, duration: res.durationMs / 1000, output: res.output, env });
  }
  const visuals = checks.filter((x) => x.kind === 'visual' && x.url && x.baseline);
  const ports = portEnv(path.basename(worktree));
  const visualOut: { c: Check; v: VisualResult; duration: number }[] = [];
  if (visuals.length > 0) {
    const served = await withServer({ cwd: worktree, command: exec.serve, sandbox: exec.sandbox, env: ports, probeUrl: resolveUrl(visuals[0]!.url!, ports) }, async () => {
      for (const c of visuals) {
        const started = Date.now();
        const v = await runVisualCheck(worktree, { url: resolveUrl(c.url!, ports), baseline: c.baseline!, maxDiff: c.maxDiff ?? 0.02 });
        visualOut.push({ c, v, duration: (Date.now() - started) / 1000 });
      }
    });
    if (!served.ok) {
      for (const c of visuals) visualOut.push({ c, v: { status: 'error', ratio: null, output: served.error, shot: null, env: true }, duration: 0 });
    }
  }
  for (const { c, v, duration } of visualOut) {
    const command = `visual ${c.url}`;
    const aid = uid();
    await db.insert(artifact).values({ id: aid, workstationId: wsId, taskId: taskId ?? null, type: 'test_output', name: 'visual', ref: v.output, metaJson: JSON.stringify({ shot: v.shot, ratio: v.ratio }), createdAt: now() });
    await db.insert(entity).values({
      id: uid(), workstationId: wsId, entityType: 'TestRun', version: 1,
      dataJson: JSON.stringify({ command, status: v.status, duration, output_ref: aid, commit_sha: head, batch_id: batchId, task_id: taskId ?? null }),
      createdByType: 'system', createdById: 'platform', createdAt: now(), updatedAt: now(),
    });
    results.push({ command, status: v.status, duration, output: v.output, env: v.env === true });
  }
  const allPassed = results.every((r) => r.status === 'passed');
  if (taskId) {
    const t = (await db.select().from(task).where(eq(task.id, taskId)))[0];
    const rj = t?.resultJson ? JSON.parse(t.resultJson) as Record<string, unknown> : {};
    rj.acceptance = { batchId, passed: allPassed, at: now() };
    await db.update(task).set({ resultJson: JSON.stringify(rj) }).where(eq(task.id, taskId));
  }
  return { allPassed, envError: results.some((r) => r.env), results };
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
  const { allPassed, envError, results } = await runAcceptance(db, t.workstationId, ref.worktree, checks, s.commandTimeoutSec, taskId, acceptanceExec(s));
  if (envError) {
    await blockForEnvironment(db, taskId, '测试阶段', results);
    return;
  }
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

// 队列只在内存里：入队时在任务上落一个标记，合并结束（成功 / 退回 / 异常）才清掉，重启时据此重新入队
async function markMergeQueued(db: DB, taskId: string, on: boolean) {
  const t = (await db.select().from(task).where(eq(task.id, taskId)))[0];
  if (!t) return;
  const rj = t.resultJson ? (JSON.parse(t.resultJson) as Record<string, unknown>) : {};
  if (on) rj.mergeQueued = now();
  else delete rj.mergeQueued;
  await db.update(task).set({ resultJson: JSON.stringify(rj) }).where(eq(task.id, taskId));
}

export function enqueueMerge(db: DB, actor: Actor, taskId: string) {
  void (async () => {
    const t = (await db.select().from(task).where(eq(task.id, taskId)))[0];
    if (!t) return;
    const s = await wsSettings(db, t.workstationId);
    await markMergeQueued(db, taskId, true);
    await queueOf(s.repoPath).add(async () => {
      try {
        await doMerge(db, actor, taskId, s);
      } catch (e) {
        // 合并任务异常不能静默：任务必须脱离 reviewing/merge，否则永久卡住
        await sendBack(db, { actor }, taskId, `合并异常：${String(e).slice(0, 300)}`);
      } finally {
        await markMergeQueued(db, taskId, false);
      }
    });
  })().catch((e: unknown) => console.error('[merge] 入队失败', taskId, String(e)));
}

// 启动恢复：上次进程退出时还排在队里（或正在合并）的任务重新入队；integration worktree 里残留的半截合并先清掉
export async function recoverMergeQueue(db: DB): Promise<string[]> {
  const actor: Actor = { type: 'human', id: 'local' };
  const recovered: string[] = [];
  for (const t of await db.select().from(task)) {
    const rj = t.resultJson ? (JSON.parse(t.resultJson) as { mergeQueued?: string }) : {};
    if (!rj.mergeQueued) continue;
    const approved = (await db.select().from(proposal).where(and(eq(proposal.taskId, t.id), eq(proposal.status, 'approved')))).length > 0;
    if (t.status === 'done' || !approved) {
      await markMergeQueued(db, t.id, false);
      continue;
    }
    const s = await wsSettings(db, t.workstationId);
    try {
      const integ = await ensureIntegration(s, t.workstationId);
      if (await inMerge(integ)) await git(integ, ['merge', '--abort']);
    } catch (e) {
      console.error('[merge] 恢复时清理 integration 失败', t.id, String(e));
    }
    await postStatus(db, t.id, '服务重启，合并重新入队');
    enqueueMerge(db, actor, t.id);
    recovered.push(t.id);
  }
  return recovered;
}

const PLATFORM = ['-c', 'user.name=aw-platform', '-c', 'user.email=platform@aw.local'];

type CodeRef = { worktree: string; branch: string; base_sha: string; head_sha?: string; merge_sha?: string; revert_sha?: string };

const inMerge = async (wt: string) => (await git(wt, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).code === 0;

// 把目标分支最新进展合进任务分支：干净合入直接提交；有冲突就停在合并中，冲突标记留给实现者解决后 git_commit
// base_sha 前移到目标分支 HEAD，之后的 diff / 提案 / 范围校验只看任务自己的改动
export async function syncTaskBranch(db: DB, taskId: string): Promise<
  { error: string } | { status: 'up_to_date' } | { status: 'merged'; base_sha: string } | { status: 'conflicts'; base_sha: string; files: string[] }
> {
  const t = (await db.select().from(task).where(eq(task.id, taskId)))[0];
  const ref = t?.codeRefJson ? (JSON.parse(t.codeRefJson) as CodeRef) : null;
  if (!t || !ref?.worktree) return { error: '任务没有 worktree' };
  const s = await wsSettings(db, t.workstationId);
  if (await inMerge(ref.worktree)) {
    const left = (await git(ref.worktree, ['diff', '--name-only', '--diff-filter=U'])).stdout.split('\n').filter(Boolean);
    return { error: `上次同步还在合并中，先解决冲突并 git_commit：${left.join('、') || '（冲突已解决，直接提交）'}` };
  }
  if ((await git(ref.worktree, ['status', '--porcelain'])).stdout.trim()) return { error: '存在未提交改动，先 git_commit 再同步' };
  const target = (await gitOk(ref.worktree, ['rev-parse', s.targetBranch])).stdout.trim();
  if ((await git(ref.worktree, ['merge-base', '--is-ancestor', target, 'HEAD'])).code === 0) return { status: 'up_to_date' };
  const m = await git(ref.worktree, [...PLATFORM, 'merge', '--no-edit', '-m', `Sync ${s.targetBranch} into ${ref.branch}`, target]);
  await db.update(task).set({ codeRefJson: JSON.stringify({ ...ref, base_sha: target }) }).where(eq(task.id, taskId));
  await logEvent(db, { type: 'human', id: 'local' }, 'task_branch_synced', 'task', taskId, { base_sha: target, clean: m.code === 0 });
  if (m.code === 0) return { status: 'merged', base_sha: target };
  const files = (await git(ref.worktree, ['diff', '--name-only', '--diff-filter=U'])).stdout.split('\n').filter(Boolean);
  if (files.length === 0) {
    await git(ref.worktree, ['merge', '--abort']);
    await db.update(task).set({ codeRefJson: JSON.stringify(ref) }).where(eq(task.id, taskId));
    return { error: `同步失败：${(m.stderr || m.stdout).trim().slice(0, 300)}` };
  }
  return { status: 'conflicts', base_sha: target, files };
}

async function doMerge(db: DB, actor: Actor, taskId: string, s: DevSettings) {
  const t = (await db.select().from(task).where(eq(task.id, taskId)))[0];
  if (!t?.codeRefJson || t.status === 'done') return;
  const ref = JSON.parse(t.codeRefJson) as CodeRef;
  const integ = await ensureIntegration(s, t.workstationId);
  const p = (await db.select().from(proposal).where(and(eq(proposal.taskId, taskId), eq(proposal.status, 'approved')))).pop();

  // 0. 审过的是 head_sha；之后分支又有提交（手动 commit 等）就不能直接合，否则会带进没审过的代码
  const branchHead = (await git(integ, ['rev-parse', `refs/heads/${ref.branch}`])).stdout.trim();
  if (ref.head_sha && branchHead && branchHead !== ref.head_sha) {
    if (p) await db.update(proposal).set({ status: 'superseded' }).where(eq(proposal.id, p.id));
    await sendBack(db, { actor }, taskId, `提案提交后分支 ${ref.branch} 又有新提交（${branchHead.slice(0, 8)}，审过的是 ${ref.head_sha.slice(0, 8)}），需要重新 submit_change 再走测试与评审`);
    return;
  }

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
    // 冲突不再只退回：先把目标分支合进任务分支，冲突标记留在 worktree 里交给实现者解决
    const synced = await syncTaskBranch(db, taskId).catch((e: unknown) => ({ error: String(e) }));
    const how = 'error' in synced
      ? `自动同步失败（${synced.error}），请先调用 sync_branch。`
      : synced.status === 'conflicts'
        ? `平台已把 ${s.targetBranch} 合进你的分支，冲突留在这些文件里：${synced.files.join('、')}。用 read_file 看冲突标记，apply_patch 改成正确结果，git_commit 完成合并后 submit_change。`
        : `平台已把 ${s.targetBranch} 干净地合进你的分支，确认验收仍通过后直接 submit_change。`;
    await sendBack(db, { actor }, taskId, `合并冲突，回退到实现阶段。冲突文件：${conflicted.join('、') || '未知'}。${how}\n${detail}`);
    return;
  }
  // 3. setup + 验收
  if (s.commands.setup) {
    const setup = await runCommand({ cwd: integ, command: s.commands.setup, timeoutSec: s.setupTimeoutSec, env: portEnv('_integration'), sandbox: s.sandbox, network: 'bridge' });
    if (setup.exitCode !== 0) {
      await git(integ, ['merge', '--abort']);
      await sendBack(db, { actor }, taskId, `合并后 setup 失败：\n${setup.output.slice(0, 300)}`);
      return;
    }
  }
  const checks = JSON.parse(t.acceptanceJson ?? '[]') as Check[];
  const { allPassed, envError, results } = await runAcceptance(db, t.workstationId, integ, checks, s.commandTimeoutSec, taskId, acceptanceExec(s));
  if (envError) {
    await git(integ, ['merge', '--abort']);
    await blockForEnvironment(db, taskId, '合并后', results);
    return;
  }
  if (!allPassed) {
    await git(integ, ['merge', '--abort']);
    const fails = results.filter((r) => r.status !== 'passed').map((r) => `${r.command}: ${r.output.slice(0, 300)}`).join('\n');
    await sendBack(db, { actor }, taskId, `合并后验收未通过：\n${fails}`);
    return;
  }
  // 4. commit + proposal merged + task approve + 回收
  // --no-ff 下 MERGE_HEAD 存在就要提交，即使内容没变也留一个合并提交，回滚才有对象
  if (await inMerge(integ)) {
    await gitOk(integ, [...PLATFORM, 'commit', '--no-edit', '-m', `Merge ${ref.branch}: ${t.title} (task ${taskId.slice(0, 8)})`]);
  }
  const mergeSha = (await gitOk(integ, ['rev-parse', 'HEAD'])).stdout.trim();
  notePlatformHead(t.workstationId, mergeSha);
  if (p) {
    await db.update(proposal).set({ status: 'merged' }).where(eq(proposal.id, p.id));
  }
  await db.update(task).set({ codeRefJson: JSON.stringify({ ...ref, merge_sha: mergeSha }) }).where(eq(task.id, taskId));
  await logEvent(db, actor, 'proposal_merged', 'proposal', p?.id ?? '', { merge_sha: mergeSha });
  await postHandoff(db, taskId, `已合并到 ${s.targetBranch}（${mergeSha.slice(0, 8)}）`, { from: '合并队列', to: 'steward', refs: { merge_sha: mergeSha } });
  await condTransition(db, actor, taskId, 'approve');
  await removeTaskWorktree(s, t.workstationId, taskId);
  events.emit('inbox_created', { kind: 'merged', refId: taskId });
  if (s.remote?.autoPush) await afterMergePush(db, taskId, s);
  await maybeCloseParent(db, t.parentId);
}

// 目标分支被平台移动过（合并 / 回滚 / 同步）：告诉漂移检测这是自己人干的
const platformHeads = new Map<string, string>();
export const notePlatformHead = (wsId: string, sha: string) => platformHeads.set(wsId, sha);
export const platformHeadOf = (wsId: string) => platformHeads.get(wsId);

async function afterMergePush(db: DB, taskId: string, s: DevSettings) {
  const r = await pushTarget(s).catch((e: unknown) => ({ ok: false as const, output: String(e) }));
  await postStatus(db, taskId, r.ok ? `已推送 ${s.targetBranch} 到 ${s.remote?.name ?? 'origin'}` : `自动推送失败：${r.output.slice(0, 300)}`);
}

// ===== 回滚：在 integration worktree 里 revert 合并提交，走同一条串行队列 =====
export async function revertMerged(db: DB, actor: Actor, taskId: string, reason?: string): Promise<{ error: string } | { revert_sha: string }> {
  const t = (await db.select().from(task).where(eq(task.id, taskId)))[0];
  const ref = t?.codeRefJson ? (JSON.parse(t.codeRefJson) as CodeRef) : null;
  if (!t || !ref) return { error: '任务不存在或不是代码任务' };
  if (!ref.merge_sha) return { error: '这个任务还没有合并，没有可回滚的提交' };
  if (ref.revert_sha) return { error: `已回滚过（${ref.revert_sha.slice(0, 8)}）` };
  const s = await wsSettings(db, t.workstationId);
  return queueOf(s.repoPath).add(async () => {
    const integ = await ensureIntegration(s, t.workstationId);
    if ((await git(integ, ['status', '--porcelain'])).stdout.trim()) return { error: 'integration worktree 不干净，无法回滚' };
    const parents = (await gitOk(integ, ['rev-list', '--parents', '-n', '1', ref.merge_sha!])).stdout.trim().split(' ');
    const reachable = (await git(integ, ['merge-base', '--is-ancestor', ref.merge_sha!, 'HEAD'])).code === 0;
    if (!reachable) return { error: `合并提交 ${ref.merge_sha!.slice(0, 8)} 不在 ${s.targetBranch} 上` };
    // 平台合并一律 --no-ff；不是合并提交说明分支内容早已在目标分支里，单独回滚会误伤别的提交
    if (parents.length <= 2) return { error: '这次合并没有产生合并提交，无法单独回滚' };
    const r = await git(integ, [...PLATFORM, 'revert', '--no-edit', '-m', '1', ref.merge_sha!]);
    if (r.code !== 0) {
      await git(integ, ['revert', '--abort']);
      return { error: `回滚冲突：之后的改动依赖这次合并，需要人工处理。${(r.stderr || r.stdout).trim().slice(0, 300)}` };
    }
    const sha = (await gitOk(integ, ['rev-parse', 'HEAD'])).stdout.trim();
    notePlatformHead(t.workstationId, sha);
    await db.update(task).set({ codeRefJson: JSON.stringify({ ...ref, revert_sha: sha }) }).where(eq(task.id, taskId));
    const p = (await db.select().from(proposal).where(and(eq(proposal.taskId, taskId), eq(proposal.status, 'merged')))).pop();
    if (p) await db.update(proposal).set({ status: 'reverted' }).where(eq(proposal.id, p.id));
    await logEvent(db, actor, 'task_reverted', 'task', taskId, { merge_sha: ref.merge_sha, revert_sha: sha, reason: reason ?? null });
    await postHandoff(db, taskId, `已回滚合并 ${ref.merge_sha!.slice(0, 8)}（回滚提交 ${sha.slice(0, 8)}）${reason ? `：${reason}` : ''}`, { from: await actorName(db, actor), to: 'steward', refs: { revert_sha: sha } });
    if (s.remote?.autoPush) await afterMergePush(db, taskId, s);
    return { revert_sha: sha };
  });
}

// ===== 同步基线：把 baseBranch 的新提交（人在主分支上的手动提交）合进 targetBranch =====
export async function syncBaseIntoTarget(db: DB, actor: Actor, wsId: string): Promise<{ error: string } | { status: 'up_to_date' | 'merged'; sha?: string }> {
  const s = await wsSettings(db, wsId);
  return queueOf(s.repoPath).add(async () => {
    const integ = await ensureIntegration(s, wsId);
    if ((await git(integ, ['status', '--porcelain'])).stdout.trim()) return { error: 'integration worktree 不干净' };
    const base = (await git(integ, ['rev-parse', '--verify', `refs/heads/${s.baseBranch}`])).stdout.trim();
    if (!base) return { error: `基线分支 ${s.baseBranch} 不存在` };
    if ((await git(integ, ['merge-base', '--is-ancestor', base, 'HEAD'])).code === 0) return { status: 'up_to_date' as const };
    const m = await git(integ, [...PLATFORM, 'merge', '--no-edit', '-m', `Sync ${s.baseBranch} into ${s.targetBranch}`, base]);
    if (m.code !== 0) {
      const files = (await git(integ, ['diff', '--name-only', '--diff-filter=U'])).stdout.split('\n').filter(Boolean);
      await git(integ, ['merge', '--abort']);
      return { error: `${s.baseBranch} 与 ${s.targetBranch} 冲突：${files.join('、') || (m.stderr || m.stdout).trim().slice(0, 300)}。需要在主仓库手动合并` };
    }
    const sha = (await gitOk(integ, ['rev-parse', 'HEAD'])).stdout.trim();
    notePlatformHead(wsId, sha);
    await logEvent(db, actor, 'workstation_base_synced', 'workstation', wsId, { sha });
    return { status: 'merged' as const, sha };
  });
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
  const { allPassed } = await runAcceptance(db, targetWs, integ, checks, s.commandTimeoutSec, parentId, acceptanceExec(s));
  const steward = (await db.select().from(agent).where(and(eq(agent.workstationId, targetWs), eq(agent.isSteward, 1))))[0];
  if (allPassed) {
    await condTransition(db, actor, parentId, 'approve');
    await postHandoff(db, parentId, '全部子任务完成，主任务验收通过，已收尾。', { from: steward?.name ?? '工作台', to: '根工作台' });
  } else {
    await pushInbox(db, parent.projectId, { kind: 'blocked', refType: 'task', refId: parentId, payload: { reason: '全部子任务已完成，但主任务验收未通过' } });
  }
}

export { mergeQueues };
