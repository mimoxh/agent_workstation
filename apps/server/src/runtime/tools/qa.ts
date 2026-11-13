import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { artifact, qaRun, workstation } from '../../db/schema.js';
import { getCaseHistory, getQaFlaky, getQaOverview, getQaRunDetail } from '../../repositories/qa.js';
import { draftBug, entitiesOf, saveCaseDrafts, savePlanSummary, saveTriage, startRun, type SuiteData, type TriageGroup } from '../../usecases/qa.js';
import type { RunCtx, ToolDef } from './index.js';

const failed = (r: { kind: string; error?: string }) => ({ error: r.error ?? `写入失败（${r.kind}）` });
const FILE_LIMIT = 60 * 1024;

async function ownRun(ctx: RunCtx, id: string) {
  const r = (await ctx.db.select().from(qaRun).where(and(eq(qaRun.id, id), eq(qaRun.workstationId, ctx.agent.workstationId))))[0];
  return r ?? null;
}

const triageGroup = z.object({
  fingerprint: z.string().describe('get_test_run 返回的错误组 fingerprint'),
  category: z.enum(['product_bug', 'test_bug', 'environment', 'flaky']),
  confidence: z.enum(['high', 'medium', 'low']),
  summary: z.string().describe('一两句话的根因判断'),
  evidence: z.string().describe('引用报错原文、文件和行、历史规律'),
  bugId: z.string().optional(),
});

const testCase = z.object({
  title: z.string(),
  module: z.string().optional(),
  priority: z.enum(['p0', 'p1', 'p2']),
  preconditions: z.string().optional(),
  steps: z.array(z.object({ action: z.string(), expected: z.string() })).min(1),
  requirement: z.string().optional(),
});

export const qaTools: Record<string, ToolDef> = {
  qa_overview: {
    taskless: true,
    description: '本台的质量现状：发布结论及原因、各套件最新结果、未关闭缺陷、不稳定用例、待处理事项',
    right: 'observe',
    parameters: z.object({}),
    execute: async (ctx) => ({ ...(await getQaOverview(ctx.actor, ctx.db, ctx.agent.workstationId)), trend: undefined }),
  },
  list_test_suites: {
    taskless: true,
    description: '列出本台的测试套件。运行套件要用这里的 id',
    right: 'observe',
    parameters: z.object({}),
    execute: async (ctx) => ({ suites: (await entitiesOf<SuiteData>(ctx.db, ctx.agent.workstationId, 'TestSuite')).map((s) => ({ id: s.row.id, name: s.data.name, command: s.data.command, description: s.data.description ?? null })) }),
  },
  run_test_suite: {
    taskless: true,
    description: '按 id 发起一个已审定的测试套件，异步执行，结果由平台解析。不能传命令',
    right: 'invoke',
    parameters: z.object({ suiteId: z.string(), ref: z.string().optional().describe('分支或提交，默认目标分支') }),
    execute: async (ctx, a) => {
      const r = await startRun(ctx.actor, ctx.db, ctx.agent.workstationId, { suiteId: String(a.suiteId), ref: a.ref as string | undefined, trigger: 'agent' });
      return r.kind === 'ok' ? { runId: r.id, commit: r.commitSha.slice(0, 8), ref: r.ref, status: 'queued' } : failed(r);
    },
  },
  get_test_run: {
    taskless: true,
    description: '读取一次运行：状态、计数、与基线的对比、按错误指纹聚类的失败（含报错原文）',
    right: 'observe',
    resultLimit: 40 * 1024,
    parameters: z.object({ runId: z.string() }),
    execute: async (ctx, a) => {
      if (!(await ownRun(ctx, String(a.runId)))) return { error: '运行不存在' };
      const d = await getQaRunDetail(ctx.actor, ctx.db, String(a.runId));
      if (!d) return { error: '运行不存在' };
      const failing = d.results.filter((r) => r.status === 'failed' || r.status === 'error');
      return {
        run: { id: d.run.id, suite: d.run.suiteName, status: d.run.status, ref: d.run.ref, commit: d.run.commitSha, total: d.run.total, passed: d.run.passed, failed: d.run.failed, errored: d.run.errored, skipped: d.run.skipped, error: d.run.error },
        comparison: d.comparison,
        groups: d.clusters.map((g) => ({
          fingerprint: g.fingerprint, message: g.message, triage: g.triage,
          cases: g.cases.slice(0, 20).map((c) => {
            const hit = failing.find((f) => f.caseKey === c.caseKey);
            return { caseKey: c.caseKey, name: c.name, classname: c.classname, isNew: hit?.isNew ?? false, quarantined: hit?.quarantined ?? false, detail: hit?.failureDetail?.slice(0, 1500) ?? null };
          }),
          more: Math.max(0, g.cases.length - 20),
        })),
      };
    },
  },
  get_case_history: {
    taskless: true,
    description: '读取一个自动化用例最近的结果和不稳定指标',
    right: 'observe',
    parameters: z.object({ caseKey: z.string() }),
    execute: async (ctx, a) => {
      const h = await getCaseHistory(ctx.actor, ctx.db, ctx.agent.workstationId, String(a.caseKey));
      return { flakiness: h.flakiness, history: h.history.map((x) => ({ status: x.status, commit: x.commitSha.slice(0, 8), at: x.createdAt, message: x.failureMessage?.slice(0, 300) ?? null })) };
    },
  },
  list_flaky_tests: {
    taskless: true,
    description: '列出被判定为不稳定的用例及隔离状态',
    right: 'observe',
    parameters: z.object({}),
    execute: async (ctx) => {
      const f = await getQaFlaky(ctx.actor, ctx.db, ctx.agent.workstationId);
      return { flaky: f.flaky.map((x) => ({ ...x, strip: undefined })), quarantined: f.quarantined };
    },
  },
  save_triage: {
    taskless: true,
    description: '保存一次运行的失败分析：每个错误组的类别、置信度和证据',
    right: 'propose',
    parameters: z.object({ runId: z.string(), groups: z.array(triageGroup).min(1) }),
    execute: async (ctx, a) => {
      const r = await saveTriage(ctx.actor, ctx.db, String(a.runId), ctx.agent.workstationId, a.groups as TriageGroup[]);
      return r.kind === 'ok' ? { groups: r.groups } : failed(r);
    },
  },
  save_test_cases: {
    taskless: true,
    description: '把一批用例保存为草稿，等人审核',
    right: 'propose',
    parameters: z.object({ cases: z.array(testCase).min(1).max(50) }),
    execute: async (ctx, a) => {
      const r = await saveCaseDrafts(ctx.actor, ctx.db, ctx.agent.workstationId, a.cases as { title: string }[]);
      return r.kind === 'ok' ? { saved: r.ids.length, status: 'draft' } : failed(r);
    },
  },
  draft_bug: {
    taskless: true,
    description: '起草一个缺陷，由人确认后才进入待修',
    right: 'propose',
    parameters: z.object({
      title: z.string(),
      severity: z.enum(['p0', 'p1', 'p2', 'p3']),
      module: z.string().optional(),
      steps: z.string().describe('复现步骤'),
      expected: z.string(),
      actual: z.string(),
      run_id: z.string().optional(),
      case_key: z.string().optional(),
      case_name: z.string().optional(),
    }),
    execute: async (ctx, a) => {
      const r = await draftBug(ctx.actor, ctx.db, ctx.agent.workstationId, a as { title: string; severity: string });
      return r.kind === 'ok' ? { bugId: r.id, status: 'draft' } : failed(r);
    },
  },
  read_design_snapshot: {
    taskless: true,
    description: '读取设计交接快照：冻结的整页 HTML、备注和设计稿元信息',
    right: 'observe',
    resultLimit: FILE_LIMIT * 2,
    parameters: z.object({ artifactId: z.string().describe('交接消息里的快照 artifactId') }),
    execute: async (ctx, a) => {
      const row = (await ctx.db.select().from(artifact).where(eq(artifact.id, String(a.artifactId))))[0];
      const me = (await ctx.db.select().from(workstation).where(eq(workstation.id, ctx.agent.workstationId)))[0];
      const from = row ? (await ctx.db.select().from(workstation).where(eq(workstation.id, row.workstationId!)))[0] : undefined;
      if (!row || row.type !== 'design_handoff' || !from || !me || from.projectId !== me.projectId) return { error: '设计交接快照不存在' };
      const meta = JSON.parse(row.metaJson ?? '{}') as { designId?: string; version?: number; brief?: string | null; note?: string | null };
      return { title: row.name, html: row.ref ?? '', note: meta.note ?? meta.brief ?? null, designId: meta.designId ?? null, version: meta.version ?? null };
    },
  },
  save_plan_summary: {
    taskless: true,
    description: '更新测试计划的结论摘要。发布与否由人签字决定',
    right: 'propose',
    parameters: z.object({ planId: z.string(), summary: z.string() }),
    execute: async (ctx, a) => {
      const r = await savePlanSummary(ctx.actor, ctx.db, ctx.agent.workstationId, String(a.planId), String(a.summary));
      return r.kind === 'ok' ? { saved: true } : failed(r);
    },
  },
};
