import { bugTransition, compareRuns, computeVerdict, isBugOpen, isFailing, reconcileBug, type Actor, type BugEvent, type VerdictCriteria } from '@aw/domain';
import { and, desc, eq, gte, inArray, isNull, ne } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { artifact, entity, eventLog, proposal, qaCaseResult, qaRun, task, workstation } from '../db/schema.js';
import { devSettings, git, isAncestor, type DevSettings } from '../runtime/git.js';
import { abortQaRun, commandProblem, DEFAULT_TIMEOUT_SEC, enqueueQaRun, reportPathProblem, type RunConfig } from '../runtime/qa/runner.js';
import { logEvent } from './core.js';
import { createEntity, updateEntity } from './entities.js';
import { pushInbox } from './inbox.js';
import { createTaskUc } from './tasks.js';
import { PLATFORM as PLATFORM_SENDER, postMessage, postStatus, postThreadMessage, wsThreadOf } from './threads.js';

const now = () => new Date().toISOString();
const PLATFORM = { type: 'human', id: 'local' } as const;
const err = (error: string, status: 400 | 404 | 409 = 400) => ({ kind: 'error' as const, status, error });

export interface SuiteData { name: string; command: string; report_path: string; coverage_path?: string | null | undefined; timeout_sec?: number | null | undefined; auto_run?: boolean | null | undefined; schedule?: 'off' | 'hourly' | 'every6h' | 'daily' | null | undefined; schedule_at?: string | null | undefined; description?: string | null | undefined }
export interface CaseData { title: string; module?: string; priority?: string; status?: string; preconditions?: string; steps?: { action: string; expected: string }[]; requirement?: string; automation_key?: string; automation_name?: string; handoff?: HandoffRecord }
export interface ManualResult { status: 'passed' | 'failed' | 'blocked' | 'skipped'; note?: string | undefined; at: string }
export interface PlanData { name: string; version?: string; ref?: string; status?: 'draft' | 'running' | 'signed'; suites?: string[]; cases?: string[]; criteria?: Partial<VerdictCriteria>; manual_results?: Record<string, ManualResult>; run_ids?: Record<string, string>; summary?: string; milestone?: string | null | undefined; signoff?: { at: string; level: string; note?: string | undefined; artifactId: string; override: boolean } }
export interface BugData { title: string; severity: string; status?: string; module?: string; steps?: string; expected?: string; actual?: string; run_id?: string; case_key?: string; case_name?: string; handoff?: HandoffRecord; verifying_since?: string; note?: string }
export interface HandoffRecord { taskId: string; workstationId: string; artifactId: string }
export interface QuarantineData { name: string; case_key: string; reason?: string; status?: string }
export interface TriageGroup { fingerprint: string; category: 'product_bug' | 'test_bug' | 'environment' | 'flaky'; confidence: 'high' | 'medium' | 'low'; summary: string; evidence: string; bugId?: string | undefined }
export interface Triage { status: 'requested' | 'done'; requestedAt?: string; groups: TriageGroup[] }

type EntityRow = typeof entity.$inferSelect;
export const dataOf = <T,>(row: EntityRow) => JSON.parse(row.dataJson ?? '{}') as T;

export async function entitiesOf<T>(db: DB, wsId: string, type: string) {
  const rows = await db.select().from(entity).where(and(eq(entity.workstationId, wsId), eq(entity.entityType, type)));
  return rows.map((row) => ({ row, data: dataOf<T>(row) }));
}

const typedEntity = async (db: DB, id: string, type: string) => {
  const row = (await db.select().from(entity).where(eq(entity.id, id)))[0];
  return row?.entityType === type ? row : null;
};

export type QaSource = { ok: true; workstationId: string; name: string; settings: DevSettings } | { ok: false; error: string };

// 测试台不单独配仓库：读绑定的开发台设置，开发台改了这里自动跟上
export async function qaSourceOf(db: DB, wsId: string): Promise<QaSource> {
  const ws = (await db.select().from(workstation).where(eq(workstation.id, wsId)))[0];
  if (!ws) return { ok: false, error: '工作台不存在' };
  const devs = (await db.select().from(workstation).where(and(eq(workstation.projectId, ws.projectId), eq(workstation.pluginId, 'dev')))).filter((w) => w.settingsJson);
  if (devs.length === 0) return { ok: false, error: '这个项目还没有开发工作台，先挂载一个并绑定仓库' };
  const wanted = (JSON.parse(ws.settingsJson ?? '{}') as { sourceWorkstationId?: string }).sourceWorkstationId;
  const source = devs.find((d) => d.id === wanted) ?? devs[0]!;
  const settings = devSettings(source.settingsJson);
  if (!settings.repoPath || settings.repoPath === '.') return { ok: false, error: `开发台「${source.name}」还没有绑定仓库` };
  return { ok: true, workstationId: source.id, name: source.name, settings };
}

async function defaultRef(s: DevSettings) {
  return (await git(s.repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${s.targetBranch}`])).code === 0 ? s.targetBranch : 'HEAD';
}

const REF = /^[\w][\w./@-]*$/;

async function resolveCommit(s: DevSettings, ref: string) {
  if (!REF.test(ref)) return null;
  const r = await git(s.repoPath, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  return r.code === 0 ? r.stdout.trim() : null;
}

export function configOf(d: SuiteData): RunConfig | { error: string } {
  const bad = commandProblem(d.command) ?? reportPathProblem(d.report_path) ?? (d.coverage_path ? reportPathProblem(d.coverage_path) : null);
  if (bad) return { error: bad };
  return { command: d.command, reportPath: d.report_path, coveragePath: d.coverage_path || null, timeoutSec: Number(d.timeout_sec) > 0 ? Number(d.timeout_sec) : DEFAULT_TIMEOUT_SEC };
}

// 人保存套件时就校验，不等到运行才发现命令不能用
export async function saveSuite(actor: Actor, db: DB, wsId: string, input: { id?: string | undefined; baseVersion?: number | undefined; data: SuiteData }) {
  const cfg = configOf(input.data);
  if ('error' in cfg) return err(cfg.error);
  const data = input.data as unknown as Record<string, unknown>;
  if (!input.id) return createEntity(actor, db, wsId, { entityType: 'TestSuite', data, reason: '新建套件' });
  const row = await typedEntity(db, input.id, 'TestSuite');
  if (row?.workstationId !== wsId) return err('套件不存在', 404);
  return updateEntity(actor, db, input.id, { data, baseVersion: input.baseVersion ?? row.version, reason: '修改套件' });
}

export async function startRun(actor: Actor, db: DB, wsId: string, input: { suiteId: string; ref?: string | undefined; trigger: 'human' | 'agent' | 'auto' | 'plan' | 'retry' | 'schedule' | 'acceptance'; retryOf?: string | undefined; planId?: string | undefined; commitSha?: string | undefined }) {
  const row = await typedEntity(db, input.suiteId, 'TestSuite');
  if (!row || row.workstationId !== wsId) return err('套件不存在', 404);
  const suite = dataOf<SuiteData>(row);
  const cfg = configOf(suite);
  if ('error' in cfg) return err(`套件「${suite.name}」：${cfg.error}`);
  const source = await qaSourceOf(db, wsId);
  if (!source.ok) return err(source.error);
  const ref = input.ref?.trim() || (await defaultRef(source.settings));
  const commitSha = input.commitSha ?? (await resolveCommit(source.settings, ref));
  if (!commitSha) return err(`找不到分支或提交：${ref}`);
  const id = crypto.randomUUID();
  await db.insert(qaRun).values({
    id, workstationId: wsId, suiteId: row.id, suiteName: suite.name, configJson: JSON.stringify(cfg), planId: input.planId ?? null, ref, commitSha, status: 'queued',
    trigger: input.trigger, actorType: actor.type, actorId: actor.id, retryOf: input.retryOf ?? null, createdAt: now(),
  });
  await logEvent(db, actor, 'qa_run_queued', 'qa_run', id, { suiteId: row.id, ref, trigger: input.trigger });
  enqueueQaRun(db, wsId, id, source.settings);
  return { kind: 'ok' as const, id, commitSha, ref };
}

// 重跑钉在同一提交：结果不一致正好暴露不稳定用例
export async function retryRun(actor: Actor, db: DB, runId: string) {
  const r = (await db.select().from(qaRun).where(eq(qaRun.id, runId)))[0];
  if (!r) return err('运行不存在', 404);
  if (r.status === 'queued' || r.status === 'running') return err('这次运行还没结束');
  return startRun(actor, db, r.workstationId, { suiteId: r.suiteId, ref: r.ref, commitSha: r.commitSha, trigger: 'retry', retryOf: r.id });
}

export async function cancelQaRun(actor: Actor, db: DB, runId: string) {
  const r = (await db.select().from(qaRun).where(eq(qaRun.id, runId)))[0];
  if (!r) return err('运行不存在', 404);
  if (r.status !== 'queued' && r.status !== 'running') return err('这次运行已经结束');
  if (!abortQaRun(runId)) {
    await db.update(qaRun).set({ status: 'canceled', finishedAt: now() }).where(eq(qaRun.id, runId));
    await logEvent(db, actor, 'qa_run_finished', 'qa_run', runId, { status: 'canceled' });
    return { kind: 'ok' as const };
  }
  if (r.status === 'queued') {
    await db.update(qaRun).set({ status: 'canceled', finishedAt: now() }).where(and(eq(qaRun.id, runId), eq(qaRun.status, 'queued')));
    await logEvent(db, actor, 'qa_run_finished', 'qa_run', runId, { status: 'canceled' });
  }
  return { kind: 'ok' as const };
}

export async function recoverQaRuns(db: DB) {
  const stale = await db.select({ id: qaRun.id }).from(qaRun).where(inArray(qaRun.status, ['queued', 'running']));
  if (stale.length === 0) return 0;
  await db.update(qaRun).set({ status: 'interrupted', error: '服务重启，这次运行被中断', finishedAt: now() }).where(inArray(qaRun.id, stale.map((s) => s.id)));
  return stale.length;
}

async function previousRun(db: DB, r: typeof qaRun.$inferSelect) {
  const rows = await db.select().from(qaRun).where(and(eq(qaRun.workstationId, r.workstationId), eq(qaRun.suiteId, r.suiteId), inArray(qaRun.status, ['passed', 'failed']), ne(qaRun.trigger, 'acceptance'))).orderBy(desc(qaRun.createdAt)).limit(40);
  const earlier = rows.filter((x) => x.id !== r.id && x.createdAt < r.createdAt);
  return earlier.find((x) => x.ref === r.ref) ?? earlier[0] ?? null;
}
export { previousRun as baselineOf };

export async function afterQaRun(db: DB, runId: string) {
  const r = (await db.select().from(qaRun).where(eq(qaRun.id, runId)))[0];
  if (!r) return;
  await reconcileBugs(db, r.workstationId);
  if ((r.trigger !== 'auto' && r.trigger !== 'schedule') || r.status !== 'failed') return;
  const base = await previousRun(db, r);
  const [cur, prev] = await Promise.all([
    db.select({ caseKey: qaCaseResult.caseKey, status: qaCaseResult.status }).from(qaCaseResult).where(eq(qaCaseResult.runId, r.id)),
    base ? db.select({ caseKey: qaCaseResult.caseKey, status: qaCaseResult.status }).from(qaCaseResult).where(eq(qaCaseResult.runId, base.id)) : Promise.resolve([]),
  ]);
  const added = compareRuns(cur, prev).newFailures.length;
  if (added === 0) return;
  const ws = (await db.select().from(workstation).where(eq(workstation.id, r.workstationId)))[0];
  const source = await qaSourceOf(db, r.workstationId);
  const suspects: { taskId: string; title: string }[] = [];
  if (source.ok) {
    // 可疑范围：本次运行提交里包含的合并、且基线提交还不包含，且未回滚过
    const done = await db.select().from(task).where(and(eq(task.workstationId, source.workstationId), eq(task.status, 'done'))).orderBy(desc(task.createdAt)).limit(50);
    for (const cand of done) {
      const cr = cand.codeRefJson ? (JSON.parse(cand.codeRefJson) as { merge_sha?: string; revert_sha?: string }) : null;
      if (!cr?.merge_sha || cr.revert_sha) continue;
      if (!(await isAncestor(source.settings.repoPath, cr.merge_sha, r.commitSha))) continue;
      if (base && (await isAncestor(source.settings.repoPath, cr.merge_sha, base.commitSha))) continue;
      suspects.push({ taskId: cand.id, title: cand.title });
    }
  }
  if (ws) await pushInbox(db, ws.projectId, { kind: 'qa_regression', refType: 'qa_run', refId: r.id, payload: { reason: `自动回归「${r.suiteName}」在 ${r.commitSha.slice(0, 7)} 新增 ${added} 个失败`, suspects } });
  for (const s of suspects) await postStatus(db, s.taskId, `自动回归「${r.suiteName}」在 ${r.commitSha.slice(0, 7)} 新增 ${added} 个失败，这次合并在可疑范围内`);
}

// 合并后的质量回声：这个任务合进去之后，绑定同一开发台的各测试套件有没有在它之上的提交跑过
export async function taskQuality(db: DB, taskId: string) {
  const t = (await db.select().from(task).where(eq(task.id, taskId)))[0];
  if (!t) return null;
  const ref = t.codeRefJson ? (JSON.parse(t.codeRefJson) as { merge_sha?: string; revert_sha?: string }) : {};
  if (!ref.merge_sha) return { merged: false as const };
  const ps = await db.select({ id: proposal.id }).from(proposal).where(eq(proposal.taskId, taskId));
  let mergedAt: string | null = null;
  if (ps.length) {
    const ev = (await db.select({ createdAt: eventLog.createdAt }).from(eventLog)
      .where(and(eq(eventLog.action, 'proposal_merged'), eq(eventLog.targetType, 'proposal'), inArray(eventLog.targetId, ps.map((p) => p.id))))
      .orderBy(desc(eventLog.createdAt)).limit(1))[0];
    mergedAt = ev?.createdAt ?? null;
  }
  const qaWss = await db.select().from(workstation).where(and(eq(workstation.projectId, t.projectId), eq(workstation.pluginId, 'qa')));
  const sources = [];
  for (const ws of qaWss) {
    const source = await qaSourceOf(db, ws.id);
    if (!source.ok || source.workstationId !== t.workstationId) continue;
    const suites = await entitiesOf<SuiteData>(db, ws.id, 'TestSuite');
    const rows = [];
    for (const s of suites) {
      const runs = await db.select().from(qaRun)
        .where(and(eq(qaRun.workstationId, ws.id), eq(qaRun.suiteId, s.row.id), inArray(qaRun.status, ['passed', 'failed', 'error']), ...(mergedAt ? [gte(qaRun.createdAt, mergedAt)] : [])))
        .orderBy(qaRun.createdAt).limit(50);
      let hit: (typeof runs)[number] | null = null;
      for (const run of runs) {
        if (await isAncestor(source.settings.repoPath, ref.merge_sha, run.commitSha)) { hit = run; break; }
      }
      rows.push({ suiteId: s.row.id, name: s.data.name, autoRun: s.data.auto_run !== false, run: hit ? { id: hit.id, status: hit.status, passed: hit.passed, failed: hit.failed, total: hit.total, commitSha: hit.commitSha } : null });
    }
    sources.push({ qaWorkstationId: ws.id, name: ws.name, suites: rows });
  }
  return { merged: true as const, mergeSha: ref.merge_sha, reverted: !!ref.revert_sha, sources };
}

export async function reconcileBugs(db: DB, wsId: string) {
  const bugs = (await entitiesOf<BugData>(db, wsId, 'BugReport')).filter((b) => b.data.status === 'fixing' || b.data.status === 'verifying');
  if (bugs.length === 0) return;
  const source = await qaSourceOf(db, wsId);
  for (const b of bugs) {
    const dev = b.data.handoff ? (await db.select().from(task).where(eq(task.id, b.data.handoff.taskId)))[0] : undefined;
    let caseStatus: string | null = null;
    // 只认验证开始之后、在目标分支上的结果：旧提交的结果说明不了修复
    if (b.data.status === 'verifying' && b.data.case_key && b.data.verifying_since && source.ok) {
      const rows = await db
        .select({ status: qaCaseResult.status, createdAt: qaCaseResult.createdAt, ref: qaRun.ref })
        .from(qaCaseResult)
        .innerJoin(qaRun, eq(qaCaseResult.runId, qaRun.id))
        .where(and(eq(qaCaseResult.workstationId, wsId), eq(qaCaseResult.caseKey, b.data.case_key)))
        .orderBy(desc(qaCaseResult.createdAt))
        .limit(5);
      const hit = rows.find((x) => x.createdAt > b.data.verifying_since! && x.ref === source.settings.targetBranch);
      caseStatus = hit?.status ?? null;
    }
    const event = reconcileBug({ status: b.data.status!, devTaskStatus: dev?.status ?? null, caseStatus });
    if (event) await applyBugEvent(PLATFORM, db, b.row, b.data, event, event === 'verify_fail' ? '回归仍未通过，或开发任务被取消' : '自动对账');
  }
}

async function applyBugEvent(actor: Actor, db: DB, row: EntityRow, data: BugData, event: BugEvent, reason: string, patch: Partial<BugData> = {}) {
  const next = bugTransition(data.status ?? 'open', event);
  if (!next) return err(`当前状态不能执行这个操作`);
  const fields: BugData = { ...data, ...patch, status: next, ...(event === 'dev_done' ? { verifying_since: now() } : {}) };
  return updateEntity(actor, db, row.id, { data: fields as unknown as Record<string, unknown>, baseVersion: row.version, reason });
}

export async function transitionBug(actor: Actor, db: DB, id: string, event: BugEvent, note?: string) {
  const row = await typedEntity(db, id, 'BugReport');
  if (!row) return err('缺陷不存在', 404);
  const data = dataOf<BugData>(row);
  // 人点“已修好待验证”时也要记下验证起点
  return applyBugEvent(actor, db, row, data, event, note || '人工操作', note ? { note } : {});
}

async function handoffTarget(db: DB, wsId: string, targetId?: string) {
  const ws = (await db.select().from(workstation).where(eq(workstation.id, wsId)))[0];
  const source = await qaSourceOf(db, wsId);
  const id = targetId ?? (source.ok ? source.workstationId : undefined);
  const target = id ? (await db.select().from(workstation).where(eq(workstation.id, id)))[0] : undefined;
  if (!ws || !target || target.projectId !== ws.projectId || target.pluginId !== 'dev') return null;
  return { ws, target };
}

async function freeze(db: DB, wsId: string, type: string, name: string, body: string, meta: Record<string, unknown>) {
  const id = crypto.randomUUID();
  await db.insert(artifact).values({ id, workstationId: wsId, type, name, ref: body, metaJson: JSON.stringify(meta), createdAt: now() });
  return id;
}

interface HandoffInput { targetWorkstationId?: string | undefined; module: string; priority: 'p0' | 'p1' | 'p2'; note?: string | undefined }

// 测试台不写代码：把当时的事实冻结进任务描述和 Artifact，由开发台走自己的流程
export async function handoffBug(actor: Actor, db: DB, id: string, input: HandoffInput) {
  const row = await typedEntity(db, id, 'BugReport');
  if (!row) return err('缺陷不存在', 404);
  const d = dataOf<BugData>(row);
  if (!bugTransition(d.status ?? 'open', 'dispatch')) return err('只有待修或重开的缺陷可以派给开发台');
  const place = await handoffTarget(db, row.workstationId, input.targetWorkstationId);
  if (!place) return err('只能交接给同一项目的开发工作台');
  const body = [
    `测试台「${place.ws.name}」确认的缺陷（${d.severity.toUpperCase()}）：${d.title}`,
    d.case_name ? `失败用例：${d.case_name}` : '',
    d.run_id ? `测试运行：${d.run_id}` : '',
    d.steps ? `复现步骤：\n${d.steps}` : '',
    d.expected ? `期望：${d.expected}` : '',
    d.actual ? `实际：${d.actual}` : '',
    input.note ? `备注：${input.note}` : '',
  ].filter(Boolean).join('\n');
  const artifactId = await freeze(db, row.workstationId, 'qa_handoff', d.title, body, { bugId: id, version: row.version });
  const r = await createTaskUc(actor, db, place.target.id, {
    title: `修复缺陷：${d.title}`, intent: body, typeId: 'dev.issue',
    input: { kind: 'bug', priority: input.priority, module: input.module },
    acceptance: [{ kind: 'manual', text: d.case_name ? `用例「${d.case_name}」在回归中通过` : `按复现步骤验证缺陷已修复：${d.title}` }],
  });
  if (r.kind !== 'ok') return r;
  const taskId = r.task!.id;
  const done = await applyBugEvent(actor, db, row, d, 'dispatch', `交给${place.target.name}`, { handoff: { taskId, workstationId: place.target.id, artifactId } });
  if (done.kind !== 'ok') return done;
  await logEvent(db, actor, 'entity_handoff', 'entity', id, { taskId, artifactId });
  return { kind: 'ok' as const, taskId };
}

export async function handoffCase(actor: Actor, db: DB, id: string, input: HandoffInput) {
  const row = await typedEntity(db, id, 'TestCase');
  if (!row) return err('用例不存在', 404);
  const d = dataOf<CaseData>(row);
  if (d.handoff) return err('这条用例已经交接过了');
  const place = await handoffTarget(db, row.workstationId, input.targetWorkstationId);
  if (!place) return err('只能交接给同一项目的开发工作台');
  const steps = (d.steps ?? []).map((s, i) => `${i + 1}. ${s.action} → ${s.expected}`).join('\n');
  const body = [`为测试台用例补自动化：${d.title}`, d.preconditions ? `前置条件：${d.preconditions}` : '', steps ? `步骤：\n${steps}` : '', d.requirement ? `需求来源：${d.requirement}` : '', input.note ? `备注：${input.note}` : ''].filter(Boolean).join('\n');
  const artifactId = await freeze(db, row.workstationId, 'qa_handoff', d.title, body, { caseId: id, version: row.version });
  const r = await createTaskUc(actor, db, place.target.id, {
    title: `补自动化：${d.title}`, intent: body, typeId: 'dev.issue',
    input: { kind: 'chore', priority: input.priority, module: input.module },
    acceptance: [{ kind: 'manual', text: `测试覆盖用例「${d.title}」的全部步骤，并在测试台的回归里能看到结果` }],
  });
  if (r.kind !== 'ok') return r;
  const taskId = r.task!.id;
  const saved = await updateEntity(actor, db, id, { data: { ...d, handoff: { taskId, workstationId: place.target.id, artifactId } } as unknown as Record<string, unknown>, baseVersion: row.version, reason: `交给${place.target.name}` });
  if (saved.kind !== 'ok') return saved;
  return { kind: 'ok' as const, taskId };
}

// 自动化用例的最新结果：先扣掉隔离的，再算结论
export async function quarantinedKeys(db: DB, wsId: string) {
  return new Set((await entitiesOf<QuarantineData>(db, wsId, 'TestQuarantine')).filter((q) => q.data.status !== 'released').map((q) => q.data.case_key));
}

export async function planRuns(db: DB, plan: PlanData) {
  const ids = Object.values(plan.run_ids ?? {});
  return ids.length ? db.select().from(qaRun).where(inArray(qaRun.id, ids)) : [];
}

export async function planVerdict(db: DB, wsId: string, plan: PlanData) {
  const runs = await planRuns(db, plan);
  const quarantine = await quarantinedKeys(db, wsId);
  const results = runs.length ? await db.select({ runId: qaCaseResult.runId, caseKey: qaCaseResult.caseKey, status: qaCaseResult.status }).from(qaCaseResult).where(inArray(qaCaseResult.runId, runs.map((r) => r.id))) : [];
  const openBugs = (await entitiesOf<BugData>(db, wsId, 'BugReport')).filter((b) => isBugOpen(b.data.status ?? 'open')).map((b) => ({ severity: b.data.severity }));
  const manualIds = plan.cases ?? [];
  const manual = { failed: manualIds.filter((c) => ['failed', 'blocked'].includes(plan.manual_results?.[c]?.status ?? '')).length, pending: manualIds.filter((c) => !plan.manual_results?.[c]).length };
  const coverage = runs.map((r) => (r.coverageJson ? (JSON.parse(r.coverageJson) as { lines: number | null }).lines : null)).find((v) => v !== null && v !== undefined) ?? null;
  const verdict = computeVerdict({
    runs: runs.map((r) => {
      const own = results.filter((x) => x.runId === r.id);
      return { suite: r.suiteName, status: r.status, passed: r.passed, failed: own.filter((x) => isFailing(x.status) && !quarantine.has(x.caseKey)).length, commitSha: r.commitSha };
    }),
    openBugs, flaky: 0, coverage, manual, criteria: plan.criteria,
  });
  return { verdict, runs, manual, coverage, openBugs: openBugs.length };
}

export async function startPlan(actor: Actor, db: DB, id: string) {
  const row = await typedEntity(db, id, 'TestPlan');
  if (!row) return err('测试计划不存在', 404);
  const d = dataOf<PlanData>(row);
  if (d.status === 'signed') return err('计划已经签字，不能再运行');
  const run_ids: Record<string, string> = {};
  const source = await qaSourceOf(db, row.workstationId);
  if (!source.ok) return err(source.error);
  // 一个计划钉在一个提交上，各套件的结果才能放在一起看
  const ref = d.ref?.trim() || (await defaultRef(source.settings));
  const commitSha = await resolveCommit(source.settings, ref);
  if (!commitSha) return err(`找不到分支或提交：${ref}`);
  for (const suiteId of d.suites ?? []) {
    const r = await startRun(actor, db, row.workstationId, { suiteId, ref, commitSha, trigger: 'plan', planId: id });
    if (r.kind !== 'ok') return r;
    run_ids[suiteId] = r.id;
  }
  const saved = await updateEntity(actor, db, id, { data: { ...d, status: 'running', run_ids } as unknown as Record<string, unknown>, baseVersion: row.version, reason: '开始执行' });
  return saved.kind === 'ok' ? { kind: 'ok' as const, runs: Object.keys(run_ids).length } : saved;
}

export async function recordManualResult(actor: Actor, db: DB, id: string, caseId: string, input: { status: ManualResult['status']; note?: string | undefined }) {
  const row = await typedEntity(db, id, 'TestPlan');
  if (!row) return err('测试计划不存在', 404);
  const d = dataOf<PlanData>(row);
  if (d.status === 'signed') return err('计划已经签字');
  if (!(d.cases ?? []).includes(caseId)) return err('这条用例不在计划里');
  const manual_results = { ...d.manual_results, [caseId]: { status: input.status, note: input.note, at: now() } };
  return updateEntity(actor, db, id, { data: { ...d, manual_results } as unknown as Record<string, unknown>, baseVersion: row.version, reason: '记录手工结果' });
}

const VERDICT_TEXT: Record<string, string> = { ready: '可发布', risk: '有风险', blocked: '阻断', unknown: '未知' };

export async function signPlan(actor: Actor, db: DB, id: string, input: { note?: string | undefined; override?: boolean | undefined }) {
  const row = await typedEntity(db, id, 'TestPlan');
  if (!row) return err('测试计划不存在', 404);
  const d = dataOf<PlanData>(row);
  if (d.status === 'signed') return err('计划已经签字');
  const { verdict, runs, manual } = await planVerdict(db, row.workstationId, d);
  if (runs.length === 0 && (d.cases ?? []).length === 0) return err('计划里还没有执行内容');
  if (runs.some((r) => r.status === 'queued' || r.status === 'running')) return err('还有运行没结束');
  if (verdict.level === 'blocked' && !input.override) return err('结论是阻断，确认放行需要勾选并写明原因');
  if (input.override && !input.note?.trim()) return err('放行阻断项必须写明原因');
  const md = [
    `# ${d.name}${d.version ? ` · ${d.version}` : ''}`,
    `结论：**${VERDICT_TEXT[verdict.level]}**${verdict.passRate === null ? '' : ` · 通过率 ${(verdict.passRate * 100).toFixed(1)}%`}`,
    input.override ? `人工放行：${input.note}` : input.note ? `签字备注：${input.note}` : '',
    verdict.reasons.length ? `## 风险与阻断\n${verdict.reasons.map((r) => `- ${r.text}`).join('\n')}` : '',
    runs.length ? `## 运行\n${runs.map((r) => `- ${r.suiteName} @ ${r.commitSha.slice(0, 7)}：${r.status}（${r.passed} 通过 / ${r.failed + r.errored} 失败 / ${r.skipped} 跳过）`).join('\n')}` : '',
    (d.cases ?? []).length ? `## 手工用例\n已执行 ${(d.cases ?? []).length - manual.pending} / ${(d.cases ?? []).length}，未通过 ${manual.failed}` : '',
    d.summary ? `## 摘要\n${d.summary}` : '',
  ].filter(Boolean).join('\n\n');
  const artifactId = await freeze(db, row.workstationId, 'qa_report', d.name, md, { planId: id, version: row.version + 1, verdict });
  const signoff = { at: now(), level: verdict.level, note: input.note, artifactId, override: !!input.override };
  const saved = await updateEntity(actor, db, id, { data: { ...d, status: 'signed', signoff } as unknown as Record<string, unknown>, baseVersion: row.version, reason: '签字' });
  if (saved.kind !== 'ok') return saved;
  await announcePlanSigned(db, row.workstationId, id, d, verdict.level, verdict.passRate, input, artifactId);
  return saved;
}

// 签字同步到根工作台：项目经理在进展报告里引用里程碑的测试结论
async function announcePlanSigned(db: DB, qaWsId: string, planId: string, d: PlanData, level: string, passRate: number | null, input: { note?: string | undefined; override?: boolean | undefined }, artifactId: string) {
  const qaWs = (await db.select().from(workstation).where(eq(workstation.id, qaWsId)))[0];
  const root = qaWs ? (await db.select().from(workstation).where(and(eq(workstation.projectId, qaWs.projectId), isNull(workstation.parentId))))[0] : null;
  if (!root) return;
  const milestone = d.milestone ? (await db.select().from(entity).where(eq(entity.id, d.milestone)))[0] : null;
  const milestoneName = milestone ? (dataOf<{ name?: string }>(milestone).name ?? d.milestone) : null;
  const text = `测试计划「${d.name}」已签字：结论 ${VERDICT_TEXT[level] ?? '未知'} · 通过率 ${passRate === null ? '无数据' : `${(passRate * 100).toFixed(1)}%`}${input.override ? ` · 人工放行：${input.note}` : ''}${milestoneName ? ` · 里程碑「${milestoneName}」` : ''}`;
  const th = await wsThreadOf(db, root.id);
  await postMessage(db, th.id, PLATFORM_SENDER, text, 'decision', { planId, qaWorkstationId: qaWsId, level, artifactId, milestoneId: d.milestone ?? null });
  await logEvent(db, PLATFORM, 'qa_plan_signed', 'entity', planId, { level, milestoneId: d.milestone ?? null });
}

export async function requestTriage(actor: Actor, db: DB, runId: string) {
  const r = (await db.select().from(qaRun).where(eq(qaRun.id, runId)))[0];
  if (!r) return err('运行不存在', 404);
  if (r.failed + r.errored === 0) return err('这次运行没有失败用例');
  const triage: Triage = { status: 'requested', requestedAt: now(), groups: [] };
  await db.update(qaRun).set({ triageJson: JSON.stringify(triage) }).where(eq(qaRun.id, runId));
  await logEvent(db, actor, 'qa_run_triage', 'qa_run', runId, {});
  const th = await wsThreadOf(db, r.workstationId);
  await postThreadMessage(actor, db, th.id, `@失败分析 分析测试运行 ${runId}（${r.suiteName} @ ${r.commitSha.slice(0, 7)}，${r.failed + r.errored} 个失败）`);
  return { kind: 'ok' as const };
}

export async function saveTriage(actor: Actor, db: DB, runId: string, wsId: string, groups: TriageGroup[]) {
  const r = (await db.select().from(qaRun).where(eq(qaRun.id, runId)))[0];
  if (r?.workstationId !== wsId) return err('运行不存在', 404);
  const prev = r.triageJson ? (JSON.parse(r.triageJson) as Triage).groups : [];
  const merged = [...prev.filter((p) => !groups.some((g) => g.fingerprint === p.fingerprint)), ...groups];
  await db.update(qaRun).set({ triageJson: JSON.stringify({ status: 'done', groups: merged } satisfies Triage) }).where(eq(qaRun.id, runId));
  await logEvent(db, actor, 'qa_run_triage', 'qa_run', runId, { groups: groups.length });
  return { kind: 'ok' as const, groups: merged.length };
}

export const draftBug = (actor: Actor, db: DB, wsId: string, data: Omit<BugData, 'status'>) => createEntity(actor, db, wsId, { entityType: 'BugReport', data: { ...data, status: 'draft' }, reason: 'Agent 起草' });

export async function saveCaseDrafts(actor: Actor, db: DB, wsId: string, cases: Omit<CaseData, 'status'>[]) {
  const ids: string[] = [];
  for (const c of cases) {
    const r = await createEntity(actor, db, wsId, { entityType: 'TestCase', data: { ...c, status: 'draft' }, reason: 'Agent 起草' });
    if (r.kind !== 'ok') return r;
    ids.push(r.id);
  }
  return { kind: 'ok' as const, ids };
}

export async function savePlanSummary(actor: Actor, db: DB, wsId: string, id: string, summary: string) {
  const row = await typedEntity(db, id, 'TestPlan');
  if (row?.workstationId !== wsId) return err('测试计划不存在', 404);
  const d = dataOf<PlanData>(row);
  if (d.status === 'signed') return err('计划已经签字');
  return updateEntity(actor, db, id, { data: { ...d, summary } as unknown as Record<string, unknown>, baseVersion: row.version, reason: '更新结论摘要' });
}

let ticking = false;

// 跟仓库巡检同节奏：先对账缺陷（把验证起点定在排新运行之前），再给开了自动运行的套件排上目标分支的新提交
export async function qaTick(db: DB) {
  if (ticking) return;
  ticking = true;
  try {
    for (const ws of await db.select().from(workstation).where(eq(workstation.pluginId, 'qa'))) {
      try {
        await reconcileBugs(db, ws.id);
        const suites = (await entitiesOf<SuiteData>(db, ws.id, 'TestSuite')).filter((s) => s.data.auto_run);
        if (suites.length === 0) continue;
        const source = await qaSourceOf(db, ws.id);
        if (!source.ok) continue;
        const target = source.settings.targetBranch;
        const head = await resolveCommit(source.settings, target);
        if (!head) continue;
        for (const s of suites) {
          const seen = await db.select({ id: qaRun.id }).from(qaRun).where(and(eq(qaRun.workstationId, ws.id), eq(qaRun.suiteId, s.row.id), eq(qaRun.commitSha, head))).limit(1);
          if (seen.length === 0) await startRun(PLATFORM, db, ws.id, { suiteId: s.row.id, ref: target, commitSha: head, trigger: 'auto' });
        }
      } catch (e) {
        console.error('[qa-tick]', ws.id, String(e));
      }
    }
  } finally {
    ticking = false;
  }
}
