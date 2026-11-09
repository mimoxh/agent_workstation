import { compareRuns, computeVerdict, flakiness, isBugOpen, isFailing, type Actor, type CaseSample } from '@aw/domain';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { artifact, qaCaseResult, qaRun, task, workstation } from '../db/schema.js';
import { git } from '../runtime/git.js';
import type { Coverage } from '../runtime/qa/reports.js';
import { baselineOf, entitiesOf, planVerdict, qaSourceOf, quarantinedKeys, type BugData, type CaseData, type PlanData, type QuarantineData, type SuiteData, type Triage } from '../usecases/qa.js';

const FINISHED = ['passed', 'failed', 'error', 'interrupted'];
const HISTORY_RUNS = 30;
const TREND_POINTS = 30;
const LOW_COVERAGE = 60;

const summary = ({ configJson, triageJson, coverageJson, ...r }: typeof qaRun.$inferSelect) => ({
  ...r,
  command: (JSON.parse(configJson) as { command: string }).command,
  triageStatus: triageJson ? (JSON.parse(triageJson) as Triage).status : null,
  coverageLines: coverageJson ? (JSON.parse(coverageJson) as Coverage).lines : null,
});

export async function listQaRuns(actor: Actor, db: DB, wsId: string, limit = 100) {
  void actor;
  return (await db.select().from(qaRun).where(eq(qaRun.workstationId, wsId)).orderBy(desc(qaRun.createdAt)).limit(limit)).map(summary);
}

export async function getQaRunDetail(actor: Actor, db: DB, id: string) {
  void actor;
  const r = (await db.select().from(qaRun).where(eq(qaRun.id, id)))[0];
  if (!r) return null;
  const results = await db.select().from(qaCaseResult).where(eq(qaCaseResult.runId, id));
  const base = await baselineOf(db, r);
  const baseRows = base ? await db.select().from(qaCaseResult).where(eq(qaCaseResult.runId, base.id)) : [];
  const comparison = baseRows.length ? compareRuns(results, baseRows) : null;
  const quarantined = await quarantinedKeys(db, r.workstationId);
  const triage = r.triageJson ? (JSON.parse(r.triageJson) as Triage) : null;
  const clusters = new Map<string, { fingerprint: string; message: string; cases: { caseKey: string; name: string; classname: string }[] }>();
  for (const c of results.filter((x) => isFailing(x.status))) {
    const fp = c.fingerprint || c.caseKey;
    const group = clusters.get(fp) ?? { fingerprint: fp, message: c.failureMessage ?? '', cases: [] };
    group.cases.push({ caseKey: c.caseKey, name: c.name, classname: c.classname });
    clusters.set(fp, group);
  }
  const newSet = new Set(comparison?.newFailures ?? []);
  return {
    run: summary(r),
    config: JSON.parse(r.configJson) as { command: string; reportPath: string; coveragePath: string | null; timeoutSec: number },
    coverage: r.coverageJson ? (JSON.parse(r.coverageJson) as Coverage) : null,
    baseline: base ? { id: base.id, commitSha: base.commitSha, createdAt: base.createdAt } : null,
    comparison: comparison && { newFailures: comparison.newFailures.length, fixed: comparison.fixed.length, stillFailing: comparison.stillFailing.length, added: comparison.added.length, removed: comparison.removed.length, fixedNames: baseRows.filter((b) => comparison.fixed.includes(b.caseKey)).map((b) => b.name) },
    results: results.map((c) => ({ id: c.id, caseKey: c.caseKey, classname: c.classname, name: c.name, status: c.status, durationMs: c.durationMs, failureMessage: c.failureMessage, failureDetail: c.failureDetail, fingerprint: c.fingerprint, isNew: newSet.has(c.caseKey), quarantined: quarantined.has(c.caseKey) })),
    clusters: [...clusters.values()].sort((a, b) => b.cases.length - a.cases.length).map((g) => ({ ...g, triage: triage?.groups.find((t) => t.fingerprint === g.fingerprint) ?? null })),
    triageStatus: triage?.status ?? null,
  };
}

export async function getCaseHistory(actor: Actor, db: DB, wsId: string, key: string, limit = 30) {
  void actor;
  const rows = await db
    .select({ status: qaCaseResult.status, commitSha: qaCaseResult.commitSha, createdAt: qaCaseResult.createdAt, durationMs: qaCaseResult.durationMs, failureMessage: qaCaseResult.failureMessage, name: qaCaseResult.name, runId: qaCaseResult.runId })
    .from(qaCaseResult)
    .where(and(eq(qaCaseResult.workstationId, wsId), eq(qaCaseResult.caseKey, key)))
    .orderBy(desc(qaCaseResult.createdAt))
    .limit(limit);
  return { history: rows, flakiness: flakiness([...rows].reverse()) };
}

async function recentRuns(db: DB, wsId: string) {
  return db.select().from(qaRun).where(and(eq(qaRun.workstationId, wsId), inArray(qaRun.status, ['passed', 'failed']))).orderBy(desc(qaRun.createdAt)).limit(400);
}

async function flakyOf(db: DB, wsId: string) {
  const runs = await recentRuns(db, wsId);
  const perSuite = new Map<string, string[]>();
  for (const r of runs) {
    const ids = perSuite.get(r.suiteId) ?? [];
    if (ids.length < HISTORY_RUNS) perSuite.set(r.suiteId, [...ids, r.id]);
  }
  const ids = [...perSuite.values()].flat();
  if (ids.length === 0) return [];
  const rows = await db
    .select({ caseKey: qaCaseResult.caseKey, name: qaCaseResult.name, classname: qaCaseResult.classname, suiteId: qaCaseResult.suiteId, status: qaCaseResult.status, commitSha: qaCaseResult.commitSha, createdAt: qaCaseResult.createdAt, runId: qaCaseResult.runId })
    .from(qaCaseResult)
    .where(inArray(qaCaseResult.runId, ids));
  const byCase = new Map<string, typeof rows>();
  for (const r of rows) byCase.set(r.caseKey, [...(byCase.get(r.caseKey) ?? []), r]);
  const out: { caseKey: string; name: string; classname: string; suiteId: string; flips: number; flipRate: number; sameCommit: boolean; runs: number; strip: { status: string; runId: string }[] }[] = [];
  for (const [caseKey, list] of byCase) {
    const sorted = list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const f = flakiness(sorted as CaseSample[]);
    if (!f.flaky) continue;
    const last = sorted.at(-1)!;
    out.push({ caseKey, name: last.name, classname: last.classname, suiteId: last.suiteId, flips: f.flips, flipRate: f.flipRate, sameCommit: f.sameCommit, runs: f.runs, strip: sorted.slice(-20).map((s) => ({ status: s.status, runId: s.runId })) });
  }
  return out.sort((a, b) => b.flipRate - a.flipRate);
}

export async function getQaFlaky(actor: Actor, db: DB, wsId: string) {
  void actor;
  const [flaky, quarantine] = await Promise.all([flakyOf(db, wsId), entitiesOf<QuarantineData>(db, wsId, 'TestQuarantine')]);
  const active = quarantine.filter((q) => q.data.status !== 'released');
  return {
    flaky: flaky.map((f) => {
      const q = active.find((x) => x.data.case_key === f.caseKey);
      return { ...f, quarantineId: q?.row.id ?? null, quarantineVersion: q?.row.version ?? null, reason: q?.data.reason ?? null };
    }),
    quarantined: active.filter((q) => !flaky.some((f) => f.caseKey === q.data.case_key)).map((q) => ({ id: q.row.id, version: q.row.version, name: q.data.name, caseKey: q.data.case_key, reason: q.data.reason ?? null })),
  };
}

async function latestBySuite(db: DB, wsId: string, target: string | null) {
  const rows = await db.select().from(qaRun).where(and(eq(qaRun.workstationId, wsId), inArray(qaRun.status, FINISHED))).orderBy(desc(qaRun.createdAt)).limit(400);
  const onTarget = new Map<string, typeof rows[number]>();
  const any = new Map<string, typeof rows[number]>();
  for (const r of rows) {
    if (!any.has(r.suiteId)) any.set(r.suiteId, r);
    if (r.ref === target && !onTarget.has(r.suiteId)) onTarget.set(r.suiteId, r);
  }
  return [...new Set(any.keys())].map((id) => onTarget.get(id) ?? any.get(id)!);
}

export async function getQaOverview(actor: Actor, db: DB, wsId: string) {
  void actor;
  const source = await qaSourceOf(db, wsId);
  const target = source.ok ? source.settings.targetBranch : null;
  const suiteRows = await entitiesOf<SuiteData>(db, wsId, 'TestSuite');
  const live = new Set(suiteRows.map((s) => s.row.id));
  const latest = (await latestBySuite(db, wsId, target)).filter((r) => live.has(r.suiteId));
  const results = latest.length ? await db.select({ runId: qaCaseResult.runId, caseKey: qaCaseResult.caseKey, status: qaCaseResult.status, name: qaCaseResult.name }).from(qaCaseResult).where(inArray(qaCaseResult.runId, latest.map((r) => r.id))) : [];
  const quarantine = await quarantinedKeys(db, wsId);
  const flaky = await flakyOf(db, wsId);
  const flakyOpen = flaky.filter((f) => !quarantine.has(f.caseKey));
  const bugs = await entitiesOf<BugData>(db, wsId, 'BugReport');
  const openBugs = bugs.filter((b) => isBugOpen(b.data.status ?? 'open'));
  const coverages = latest.map((r) => (r.coverageJson ? (JSON.parse(r.coverageJson) as Coverage).lines : null)).filter((v): v is number => v !== null);
  const coverage = coverages.length ? Math.min(...coverages) : null;
  const verdict = computeVerdict({
    runs: latest.map((r) => ({ suite: r.suiteName, status: r.status, passed: r.passed, failed: results.filter((x) => x.runId === r.id && isFailing(x.status) && !quarantine.has(x.caseKey)).length, commitSha: r.commitSha })),
    openBugs: openBugs.map((b) => ({ severity: b.data.severity })), flaky: flakyOpen.length, coverage,
  });
  const history = (await db.select({ id: qaRun.id, status: qaRun.status, passed: qaRun.passed, total: qaRun.total, skipped: qaRun.skipped, createdAt: qaRun.createdAt, suiteName: qaRun.suiteName, commitSha: qaRun.commitSha }).from(qaRun).where(and(eq(qaRun.workstationId, wsId), inArray(qaRun.status, ['passed', 'failed']))).orderBy(desc(qaRun.createdAt)).limit(TREND_POINTS)).reverse();
  const running = await db.select({ id: qaRun.id, suiteName: qaRun.suiteName, status: qaRun.status }).from(qaRun).where(and(eq(qaRun.workstationId, wsId), inArray(qaRun.status, ['queued', 'running'])));
  const drafts = (await entitiesOf<CaseData>(db, wsId, 'TestCase')).filter((c) => c.data.status === 'draft').length;
  const plans = await entitiesOf<PlanData>(db, wsId, 'TestPlan');
  const attention = [
    ...latest.filter((r) => r.status === 'failed' || r.status === 'error' || r.status === 'interrupted').map((r) => ({ kind: 'run' as const, tone: 'bad' as const, id: r.id, text: r.status === 'failed' ? `「${r.suiteName}」${r.failed + r.errored} 个用例失败` : `「${r.suiteName}」没有跑完：${r.error ?? r.status}` })),
    ...openBugs.filter((b) => b.data.status === 'open' || b.data.status === 'reopened').map((b) => ({ kind: 'bug' as const, tone: 'bad' as const, id: b.row.id, text: `${b.data.severity.toUpperCase()} 缺陷待派发：${b.data.title}` })),
    ...bugs.filter((b) => b.data.status === 'draft').map((b) => ({ kind: 'bug' as const, tone: 'amber' as const, id: b.row.id, text: `缺陷草稿待确认：${b.data.title}` })),
    ...bugs.filter((b) => b.data.status === 'verifying' && !b.data.case_key).map((b) => ({ kind: 'bug' as const, tone: 'amber' as const, id: b.row.id, text: `修复待人工验证：${b.data.title}` })),
    ...(flakyOpen.length ? [{ kind: 'flaky' as const, tone: 'amber' as const, id: '', text: `${flakyOpen.length} 个不稳定用例待处理` }] : []),
    ...(drafts ? [{ kind: 'cases' as const, tone: 'amber' as const, id: '', text: `${drafts} 条用例草稿待审核` }] : []),
    ...plans.filter((p) => p.data.status === 'running').map((p) => ({ kind: 'plan' as const, tone: 'amber' as const, id: p.row.id, text: `测试计划进行中：${p.data.name}` })),
  ];
  return {
    source: source.ok ? { ok: true as const, workstationId: source.workstationId, name: source.name, targetBranch: source.settings.targetBranch, repoPath: source.settings.repoPath } : { ok: false as const, error: source.error },
    suites: suiteRows.map((s) => ({ id: s.row.id, name: s.data.name, last: latest.find((r) => r.suiteId === s.row.id) ?? null })).map((s) => ({ id: s.id, name: s.name, last: s.last ? summary(s.last) : null })),
    verdict, coverage, flaky: flakyOpen.length,
    openBugs: { total: openBugs.length, blocking: openBugs.filter((b) => b.data.severity === 'p0' || b.data.severity === 'p1').length },
    trend: history.map((h) => ({ id: h.id, status: h.status, rate: h.total - h.skipped > 0 ? h.passed / (h.total - h.skipped) : 0, at: h.createdAt, suite: h.suiteName, commit: h.commitSha })),
    running, attention,
  };
}

export async function getQaCoverage(actor: Actor, db: DB, wsId: string) {
  void actor;
  const source = await qaSourceOf(db, wsId);
  const target = source.ok ? source.settings.targetBranch : null;
  const latest = (await db.select().from(qaRun).where(and(eq(qaRun.workstationId, wsId), inArray(qaRun.status, ['passed', 'failed']))).orderBy(desc(qaRun.createdAt)).limit(400)).filter((r) => r.coverageJson);
  const bySuite = new Map<string, typeof latest>();
  for (const r of latest) bySuite.set(r.suiteId, [...(bySuite.get(r.suiteId) ?? []), r]);
  const suites = [];
  for (const [suiteId, list] of bySuite) {
    const cur = list.find((r) => r.ref === target) ?? list[0]!;
    const prev = list.find((r) => r.createdAt < cur.createdAt && r.commitSha !== cur.commitSha) ?? null;
    const c = JSON.parse(cur.coverageJson!) as Coverage;
    const p = prev ? (JSON.parse(prev.coverageJson!) as Coverage) : null;
    let changed: string[] = [];
    if (prev && source.ok) {
      const d = await git(source.settings.repoPath, ['diff', '--name-only', prev.commitSha, cur.commitSha]);
      if (d.code === 0) changed = d.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
    }
    const prevByPath = new Map((p?.files ?? []).map((f) => [f.path, f.lines]));
    suites.push({
      suiteId, suiteName: cur.suiteName, runId: cur.id, commitSha: cur.commitSha,
      lines: c.lines, branches: c.branches, functions: c.functions, statements: c.statements, delta: c.lines !== null && p?.lines != null ? c.lines - p.lines : null,
      trend: [...list].reverse().slice(-TREND_POINTS).map((r) => ({ at: r.createdAt, lines: (JSON.parse(r.coverageJson!) as Coverage).lines })),
      files: c.files.map((f) => ({ ...f, prev: prevByPath.get(f.path) ?? null })),
      changedLow: c.files.filter((f) => changed.includes(f.path) && f.lines !== null && f.lines < LOW_COVERAGE).map((f) => ({ path: f.path, lines: f.lines })),
      threshold: LOW_COVERAGE,
    });
  }
  return { suites };
}

export async function getAutomatedCases(actor: Actor, db: DB, wsId: string) {
  void actor;
  const source = await qaSourceOf(db, wsId);
  const latest = await latestBySuite(db, wsId, source.ok ? source.settings.targetBranch : null);
  if (latest.length === 0) return [];
  const rows = await db.select({ caseKey: qaCaseResult.caseKey, name: qaCaseResult.name, classname: qaCaseResult.classname, status: qaCaseResult.status, runId: qaCaseResult.runId, suiteId: qaCaseResult.suiteId }).from(qaCaseResult).where(inArray(qaCaseResult.runId, latest.map((r) => r.id)));
  return rows;
}

export async function getQaPlanDetail(actor: Actor, db: DB, wsId: string, id: string) {
  void actor;
  const plan = (await entitiesOf<PlanData>(db, wsId, 'TestPlan')).find((p) => p.row.id === id);
  if (!plan) return null;
  const v = await planVerdict(db, wsId, plan.data);
  const report = plan.data.signoff ? (await db.select().from(artifact).where(eq(artifact.id, plan.data.signoff.artifactId)))[0]?.ref ?? null : null;
  return { verdict: v.verdict, manual: v.manual, coverage: v.coverage, openBugs: v.openBugs, runs: v.runs.map(summary), report };
}

export async function bugTaskStatuses(actor: Actor, db: DB, wsId: string) {
  void actor;
  const ids = (await entitiesOf<BugData>(db, wsId, 'BugReport')).flatMap((b) => (b.data.handoff ? [b.data.handoff.taskId] : []));
  const caseIds = (await entitiesOf<CaseData>(db, wsId, 'TestCase')).flatMap((c) => (c.data.handoff ? [c.data.handoff.taskId] : []));
  const all = [...ids, ...caseIds];
  if (all.length === 0) return {};
  const rows = await db.select({ id: task.id, status: task.status, stage: task.stage, title: task.title }).from(task).where(inArray(task.id, all));
  return Object.fromEntries(rows.map((r) => [r.id, r]));
}

export async function listQaSources(actor: Actor, db: DB, projectId: string) {
  void actor;
  return (await db.select({ id: workstation.id, name: workstation.name, settingsJson: workstation.settingsJson }).from(workstation).where(and(eq(workstation.projectId, projectId), eq(workstation.pluginId, 'dev')))).map((w) => ({ id: w.id, name: w.name }));
}

export async function qaContextOf(db: DB, wsId: string) {
  const o = await getQaOverview({ type: 'human', id: 'local' }, db, wsId);
  const lines = [`结论：${o.verdict.level}；通过率：${o.verdict.passRate === null ? '无数据' : `${(o.verdict.passRate * 100).toFixed(1)}%`}；未关闭缺陷 ${o.openBugs.total}（阻断级 ${o.openBugs.blocking}）；不稳定用例 ${o.flaky}`];
  if (!o.source.ok) lines.push(o.source.error);
  for (const s of o.suites) lines.push(`- 套件 ${s.name}（id: ${s.id}）：${s.last ? `${s.last.status}，${s.last.passed}/${s.last.total}，运行 id ${s.last.id}` : '还没运行过'}`);
  return lines.join('\n');
}
