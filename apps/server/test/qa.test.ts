import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createDb, migrateDb, type DB } from '../src/db/client.js';
import { seed } from '../src/db/seed.js';
import { agent, artifact, entity, inboxItem, pluginInstall, qaRun, task, workstation } from '../src/db/schema.js';
import { loadPlugins } from '../src/plugins.js';
import { conversationIdle } from '../src/runtime/conversation.js';
import { loadModels } from '../src/runtime/models.js';
import { parseCoverage, parseJUnit } from '../src/runtime/qa/reports.js';
import { qaIdle } from '../src/runtime/qa/runner.js';
import { scheduler, startScheduler } from '../src/runtime/scheduler.js';
import { zodToJson } from '../src/runtime/loop.js';
import { executeTool, toolSchemasFor, type RunCtx } from '../src/runtime/tools/index.js';
import { buildPermCtx, mountWorkstation } from '../src/usecases/index.js';
import { qaTick, recoverQaRuns } from '../src/usecases/qa.js';
import { createFixtureRepo } from './fixtures.js';

const HUMAN = { type: 'human', id: 'local' } as const;

let db: DB;
let app: ReturnType<typeof createApp>['app'];
let wsId: string;
let devId: string;
let repo: string;
let stop: () => void;

const req = (method: string, p: string, body?: unknown) =>
  app.request(p, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const json = async <T = Record<string, never>>(r: Response | Promise<Response>) => (await (await r).json()) as T & { error?: string };
const g = (...args: string[]) => execFileSync('git', ['-c', 'core.longpaths=true', '-c', 'user.name=f', '-c', 'user.email=f@f.local', ...args], { cwd: repo, windowsHide: true, stdio: 'pipe' });

const SCRIPT = `const fs = require('fs');
const c = JSON.parse(fs.readFileSync('cases.json', 'utf8'));
let flip = false;
if (c.flakyFile) { flip = fs.existsSync(c.flakyFile); if (flip) fs.rmSync(c.flakyFile); else fs.writeFileSync(c.flakyFile, '1'); }
let x = '<?xml version="1.0"?><testsuites><testsuite name="s">';
for (const t of c.cases) {
  const fail = t.flaky ? (flip ? 'flaky boom' : null) : t.fail;
  x += '<testcase classname="a" name="' + t.name + '" time="0.01">' + (fail ? '<failure message="' + fail + '">stack of ' + t.name + '</failure>' : '') + '</testcase>';
}
x += '</testsuite></testsuites>';
if (!c.noReport) fs.writeFileSync('report.xml', x);
if (c.coverage) fs.writeFileSync('coverage.json', JSON.stringify({ total: { lines: { pct: c.coverage } }, 'src/a.ts': { lines: { pct: 40 } } }));
process.exit(c.exit ?? (c.cases.some((t) => t.fail) ? 1 : 0));
`;

interface Case { name: string; fail?: string; flaky?: boolean }
function commit(cases: Case[], extra: Record<string, unknown> = {}) {
  writeFileSync(path.join(repo, 'cases.json'), JSON.stringify({ cases, ...extra }));
  g('add', '-A');
  g('commit', '-m', `cases ${Date.now()}`);
  return g('rev-parse', 'HEAD').toString().trim();
}

async function suite(data: Record<string, unknown> = {}) {
  const r = await json<{ id: string }>(req('POST', `/api/workstations/${wsId}/entities`, { entityType: 'TestSuite', data: { name: '单测', command: 'node run.js', report_path: 'report.xml', ...data } }));
  return r.id;
}

async function run(suiteId: string, ref?: string) {
  const r = await json<{ id: string }>(req('POST', `/api/workstations/${wsId}/qa/runs`, { suiteId, ...(ref ? { ref } : {}) }));
  if (!r.id) throw new Error(r.error ?? '发起失败');
  await qaIdle();
  return r.id;
}

interface Detail { run: { status: string; total: number; passed: number; failed: number; error: string | null; commitSha: string }; comparison: { newFailures: number; fixed: number; stillFailing: number; fixedNames: string[] } | null; clusters: { fingerprint: string; cases: unknown[]; triage: { category: string } | null }[]; results: { name: string; status: string; caseKey: string; isNew: boolean; quarantined: boolean }[]; triageStatus: string | null; coverage: { lines: number } | null }
const detail = (id: string) => json<Detail>(req('GET', `/api/qa-runs/${id}`));
interface Overview { verdict: { level: string; reasons: { text: string }[] }; flaky: number; openBugs: { total: number; blocking: number }; suites: { id: string }[]; attention: { text: string }[]; trend: unknown[]; source: { ok: boolean } }
const overview = () => json<Overview>(req('GET', `/api/workstations/${wsId}/qa/overview`));

const agentOf = async (templateId: string) => (await db.select().from(agent).where(and(eq(agent.workstationId, wsId), eq(agent.templateId, templateId))))[0]!;
async function call(name: string, args: Record<string, unknown>, template = 'failure-analyst') {
  const a = await agentOf(template);
  const actor = { type: 'agent', id: a.id } as const;
  const ctx: RunCtx = { db, actor, permCtx: await buildPermCtx(actor, db), agent: a, task: null, run: { id: 'r' } as never };
  return (await executeTool(ctx, name, args)) as Record<string, unknown> & { error?: string };
}

async function settle() {
  for (let quiet = 0; quiet < 3;) {
    await new Promise((r) => setTimeout(r, 20));
    await scheduler.idle();
    quiet = conversationIdle() ? quiet + 1 : 0;
  }
}

beforeEach(async () => {
  process.env.AW_ENABLE_MOCK = '1';
  process.env.AW_DEFAULT_MODEL = 'mock:scripted';
  repo = createFixtureRepo();
  writeFileSync(path.join(repo, 'run.js'), SCRIPT);
  g('checkout', '-b', 'develop');
  process.env.AW_SEED_REPO_PATH = repo;
  process.env.AW_WORKTREE_ROOT = path.join(tmpdir(), `aw-qa-wt-${Date.now()}-${Math.floor(Math.random() * 1e4)}`);
  commit([{ name: 'a' }, { name: 'b' }]);
  loadPlugins();
  const r = createDb(':memory:');
  db = r.db;
  migrateDb(r.sqlite);
  await seed(db);
  app = createApp(db).app;
  const root = (await db.select().from(workstation).where(eq(workstation.pluginId, 'pm')))[0]!;
  devId = (await db.select().from(workstation).where(eq(workstation.pluginId, 'dev')))[0]!.id;
  const m = await mountWorkstation(HUMAN, db, { projectId: 'proj-aw', parentId: root.id, pluginId: 'qa', name: '测试', settings: { sourceWorkstationId: devId } });
  if (m.kind !== 'ok') throw new Error(m.error);
  wsId = m.id;
  await loadModels();
  stop = startScheduler(db);
});

afterEach(async () => {
  stop();
  await qaIdle();
  delete process.env.AW_SEED_REPO_PATH;
  try {
    rmSync(process.env.AW_WORKTREE_ROOT!, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  } catch { /* Windows 句柄未释放时留给系统清理 */ }
  delete process.env.AW_WORKTREE_ROOT;
});

describe('报告解析', () => {
  it('读出通过、失败、错误、跳过和嵌套套件', () => {
    const cases = parseJUnit(`<testsuites><testsuite name="s"><testcase classname="c" name="ok" time="1.5"/><testcase name="bad"><failure message="boom &amp; bust">trace</failure></testcase><testcase name="err"><error>crash\nmore</error></testcase><testcase name="skip"><skipped/></testcase><testsuite name="inner"><testcase name="n"/></testsuite></testsuite></testsuites>`);
    expect(cases.map((c) => c.status)).toEqual(['passed', 'failed', 'error', 'skipped', 'passed']);
    expect(cases[0]).toMatchObject({ classname: 'c', durationMs: 1500 });
    expect(cases[1]).toMatchObject({ classname: 's', failureMessage: 'boom & bust', failureDetail: 'trace' });
    expect(cases[2]!.failureMessage).toBe('crash');
    expect(cases[4]!.classname).toBe('inner');
  });
  it('不展开 DOCTYPE 实体', () => {
    const bomb = `<!DOCTYPE x [<!ENTITY a "AAAAAAAAAA">]><testsuites><testsuite name="s"><testcase name="&a;"/></testsuite></testsuites>`;
    expect(parseJUnit(bomb)[0]!.name).toBe('&a;');
  });
  it('不是 JUnit 就报错', () => expect(() => parseJUnit('<html></html>')).toThrow());
  it('读 coverage-summary 和 lcov，路径转成相对', () => {
    const root = 'C:\\wt\\_qa';
    const s = parseCoverage(JSON.stringify({ total: { lines: { pct: 80 }, branches: { pct: 'Unknown' } }, 'C:\\wt\\_qa\\src\\a.ts': { lines: { pct: 50 } } }), root);
    expect(s).toMatchObject({ lines: 80, branches: null, files: [{ path: 'src/a.ts', lines: 50 }] });
    const l = parseCoverage('SF:src/b.ts\nLF:10\nLH:5\nBRF:4\nBRH:1\nend_of_record\nSF:src/c.ts\nLF:10\nLH:10\nend_of_record\n', root);
    expect(l).toMatchObject({ lines: 75, branches: 25, files: [{ path: 'src/b.ts', lines: 50 }, { path: 'src/c.ts', lines: 100 }] });
  });
});

describe('运行闭环', () => {
  it('通过的运行：钉住提交，逐用例入库', async () => {
    const id = await run(await suite());
    const d = await detail(id);
    expect(d.run).toMatchObject({ status: 'passed', total: 2, passed: 2, failed: 0 });
    expect(d.run.commitSha).toBe(g('rev-parse', 'develop').toString().trim());
    expect(d.results.map((r) => r.name).sort()).toEqual(['a', 'b']);
    expect((await overview()).verdict.level).toBe('ready');
  });

  it('失败的运行：按错误聚类，并与基线对比', async () => {
    const s = await suite();
    await run(s);
    commit([{ name: 'a', fail: 'expected 1 to be 2' }, { name: 'b', fail: 'expected 3 to be 4' }, { name: 'c', fail: 'other' }]);
    const d = await detail(await run(s));
    expect(d.run.status).toBe('failed');
    expect(d.clusters.map((c) => c.cases.length)).toEqual([2, 1]);
    expect(d.comparison).toMatchObject({ newFailures: 3, fixed: 0 });
    expect(d.results.find((r) => r.name === 'a')!.isNew).toBe(true);
    expect((await overview()).verdict.level).toBe('blocked');

    commit([{ name: 'a' }, { name: 'b', fail: 'expected 3 to be 4' }]);
    const next = await detail(await run(s));
    expect(next.comparison).toMatchObject({ newFailures: 0, fixed: 1, stillFailing: 1, fixedNames: ['a'] });
  });

  it('没有报告、退出码与报告矛盾都不算通过', async () => {
    const s = await suite();
    commit([{ name: 'a' }], { noReport: true });
    expect((await detail(await run(s))).run).toMatchObject({ status: 'error' });
    commit([{ name: 'a' }], { exit: 3 });
    const d = await detail(await run(s));
    expect(d.run.status).toBe('error');
    expect(d.run.error).toContain('退出码 3');
  });

  it('读取覆盖率', async () => {
    commit([{ name: 'a' }], { coverage: 72 });
    const s = await suite({ coverage_path: 'coverage.json' });
    expect((await detail(await run(s))).coverage).toMatchObject({ lines: 72 });
    const cov = await json<{ suites: { lines: number; files: unknown[] }[] }>(req('GET', `/api/workstations/${wsId}/qa/coverage`));
    expect(cov.suites[0]).toMatchObject({ lines: 72 });
  });

  it.each([
    ['npx vitest run', '环境或依赖'],
    ['git status', 'git'],
    ['node run.js | cat', '管道'],
    ['bash run.sh', '白名单'],
    ['pnpm add lodash', '环境或依赖'],
  ])('拒绝命令 %s', async (command, hint) => {
    const r = await json(req('POST', `/api/workstations/${wsId}/qa/runs`, { suiteId: await suite({ command }) }));
    expect(r.error).toContain(hint);
  });

  it('报告路径不能逃出仓库', async () => {
    const r = await json(req('POST', `/api/workstations/${wsId}/qa/runs`, { suiteId: await suite({ report_path: '../../secret.xml' }) }));
    expect(r.error).toContain('相对路径');
  });

  it('不存在的分支和非法 ref 被拒绝', async () => {
    const s = await suite();
    expect((await json(req('POST', `/api/workstations/${wsId}/qa/runs`, { suiteId: s, ref: 'nope' }))).error).toContain('找不到');
    expect((await json(req('POST', `/api/workstations/${wsId}/qa/runs`, { suiteId: s, ref: '--output=/tmp/x' }))).error).toContain('找不到');
  });

  it('运行时用发起时的命令快照', async () => {
    const s = await suite();
    const id = await run(s);
    const row = (await db.select().from(entity).where(eq(entity.id, s)))[0]!;
    await req('PATCH', `/api/entities/${s}`, { data: { ...JSON.parse(row.dataJson!), command: 'node other.js' }, baseVersion: row.version });
    const d = await json<{ config: { command: string } }>(req('GET', `/api/qa-runs/${id}`));
    expect(d.config.command).toBe('node run.js');
  });

  it('启动恢复把残留运行标成中断', async () => {
    await db.insert(qaRun).values({ id: 'stale', workstationId: wsId, suiteId: 's', suiteName: 'n', configJson: '{}', ref: 'x', commitSha: 'y', status: 'running', trigger: 'human', createdAt: new Date().toISOString() });
    expect(await recoverQaRuns(db)).toBe(1);
    expect((await db.select().from(qaRun).where(eq(qaRun.id, 'stale')))[0]).toMatchObject({ status: 'interrupted' });
  });

  it('没有开发台时给出明确提示', async () => {
    await db.update(workstation).set({ settingsJson: null }).where(eq(workstation.id, devId));
    expect((await overview()).source.ok).toBe(false);
  });
});

describe('不稳定与隔离', () => {
  it('同一提交重跑结果不同判为不稳定；隔离后不计入结论', async () => {
    commit([{ name: 'a' }, { name: 'wobbly', flaky: true }], { flakyFile: path.join(tmpdir(), `aw-flaky-${Date.now()}`) });
    const s = await suite();
    const first = await run(s);
    const retried = await json<{ id: string }>(req('POST', `/api/qa-runs/${first}/retry`));
    await qaIdle();
    const [a, b] = await Promise.all([detail(first), detail(retried.id)]);
    expect(a.run.commitSha).toBe(b.run.commitSha);
    expect([a.run.status, b.run.status].sort()).toEqual(['failed', 'passed']);

    interface Flaky { flaky: { caseKey: string; name: string; sameCommit: boolean; quarantineId: string | null }[] }
    const f = await json<Flaky>(req('GET', `/api/workstations/${wsId}/qa/flaky`));
    expect(f.flaky).toMatchObject([{ name: 'wobbly', sameCommit: true, quarantineId: null }]);
    expect((await overview()).flaky).toBe(1);

    await req('POST', `/api/workstations/${wsId}/entities`, { entityType: 'TestQuarantine', data: { name: 'wobbly', case_key: f.flaky[0]!.caseKey, reason: '时序', status: 'active' } });
    const o = await overview();
    expect(o.flaky).toBe(0);
    expect(o.verdict.reasons.some((r) => r.text.includes('不稳定'))).toBe(false);
  });
});

describe('缺陷闭环', () => {
  const bugOf = async (id: string) => JSON.parse((await db.select().from(entity).where(eq(entity.id, id)))[0]!.dataJson!) as { status: string; handoff?: { taskId: string } };

  async function createBug(extra: Record<string, unknown> = {}) {
    const r = await json<{ id: string }>(req('POST', `/api/workstations/${wsId}/entities`, { entityType: 'BugReport', data: { title: '登录崩溃', severity: 'p1', status: 'draft', steps: '点登录', ...extra } }));
    return r.id;
  }

  it('确认 → 派给开发台 → 开发完成 → 回归通过自动验证', async () => {
    const s = await suite();
    commit([{ name: 'a', fail: 'boom' }]);
    const failing = await detail(await run(s));
    const key = failing.results[0]!.caseKey;
    const id = await createBug({ case_key: key, case_name: 'a' });

    expect((await json(req('POST', `/api/qa-bugs/${id}/handoff`, { module: 'src/', priority: 'p1' }))).error).toContain('待修');
    await req('POST', `/api/qa-bugs/${id}/transition`, { event: 'confirm' });
    expect((await overview()).verdict.level).toBe('blocked');

    const h = await json<{ taskId: string }>(req('POST', `/api/qa-bugs/${id}/handoff`, { module: 'src/', priority: 'p1' }));
    expect(await bugOf(id)).toMatchObject({ status: 'fixing' });
    const t = (await db.select().from(task).where(eq(task.id, h.taskId)))[0]!;
    expect(t).toMatchObject({ workstationId: devId, typeId: 'dev.issue', status: 'draft' });
    expect(t.intent).toContain('点登录');

    await run(s);
    expect((await bugOf(id)).status).toBe('fixing');

    await db.update(task).set({ status: 'done' }).where(eq(task.id, h.taskId));
    await qaTick(db);
    expect((await bugOf(id)).status).toBe('verifying');

    // 验证开始前的提交不算：换到功能分支的结果也不算
    g('branch', 'feature');
    await run(s, 'feature');
    expect((await bugOf(id)).status).toBe('verifying');

    commit([{ name: 'a' }]);
    await run(s);
    expect((await bugOf(id)).status).toBe('verified');
    expect((await overview()).openBugs.total).toBe(0);
  });

  it('回归仍失败就重开', async () => {
    const s = await suite();
    commit([{ name: 'a', fail: 'boom' }]);
    const key = (await detail(await run(s))).results[0]!.caseKey;
    const id = await createBug({ case_key: key, status: 'open' });
    const h = await json<{ taskId: string }>(req('POST', `/api/qa-bugs/${id}/handoff`, { module: 'src/', priority: 'p1' }));
    await db.update(task).set({ status: 'done' }).where(eq(task.id, h.taskId));
    await qaTick(db);
    await run(s);
    expect((await bugOf(id)).status).toBe('reopened');
  });

  it('没关联用例的缺陷停在待验证，由人确认', async () => {
    const id = await createBug({ status: 'open' });
    const h = await json<{ taskId: string }>(req('POST', `/api/qa-bugs/${id}/handoff`, { module: 'src/', priority: 'p2' }));
    await db.update(task).set({ status: 'done' }).where(eq(task.id, h.taskId));
    await qaTick(db);
    expect((await bugOf(id)).status).toBe('verifying');
    await req('POST', `/api/qa-bugs/${id}/transition`, { event: 'verify_pass' });
    expect((await bugOf(id)).status).toBe('verified');
  });

  it('用例补自动化走开发台，且只能交接一次', async () => {
    const c = await json<{ id: string }>(req('POST', `/api/workstations/${wsId}/entities`, { entityType: 'TestCase', data: { title: '登录', status: 'active', steps: [{ action: '点', expected: '进' }] } }));
    const h = await json<{ taskId: string }>(req('POST', `/api/qa-cases/${c.id}/handoff`, { module: 'test/', priority: 'p2' }));
    expect((await db.select().from(task).where(eq(task.id, h.taskId)))[0]!.title).toBe('补自动化：登录');
    expect((await json(req('POST', `/api/qa-cases/${c.id}/handoff`, { module: 'test/', priority: 'p2' }))).error).toContain('交接过');
  });
});

describe('测试计划', () => {
  async function plan(data: Record<string, unknown>) {
    return (await json<{ id: string }>(req('POST', `/api/workstations/${wsId}/entities`, { entityType: 'TestPlan', data: { name: 'v1 回归', status: 'draft', ...data } }))).id;
  }
  interface PlanDetail { verdict: { level: string }; manual: { failed: number; pending: number }; runs: { status: string; commitSha: string }[]; report: string | null }
  const planDetail = (id: string) => json<PlanDetail>(req('GET', `/api/workstations/${wsId}/qa/plans/${id}`));

  it('跑套件、记手工结果、签字冻结报告；签字后不可再动', async () => {
    const s = await suite();
    const c = (await json<{ id: string }>(req('POST', `/api/workstations/${wsId}/entities`, { entityType: 'TestCase', data: { title: '手工', status: 'active' } }))).id;
    const id = await plan({ suites: [s], cases: [c] });
    await req('POST', `/api/qa-plans/${id}/start`);
    await qaIdle();
    let d = await planDetail(id);
    expect(d.runs).toMatchObject([{ status: 'passed' }]);
    expect(d).toMatchObject({ manual: { pending: 1 }, verdict: { level: 'risk' } });

    expect((await json(req('POST', `/api/qa-plans/${id}/manual`, { caseId: 'nope', status: 'passed' }))).error).toContain('不在计划');
    await req('POST', `/api/qa-plans/${id}/manual`, { caseId: c, status: 'passed' });
    d = await planDetail(id);
    expect(d.verdict.level).toBe('ready');

    expect((await req('POST', `/api/qa-plans/${id}/sign`, { note: '可以发' })).status).toBe(200);
    d = await planDetail(id);
    expect(d.report).toContain('可发布');
    expect((await db.select().from(artifact).where(eq(artifact.type, 'qa_report')))).toHaveLength(1);
    expect((await json(req('POST', `/api/qa-plans/${id}/start`))).error).toContain('签字');
  });

  it('阻断时不能直接签字，放行必须写原因', async () => {
    commit([{ name: 'a', fail: 'boom' }]);
    const id = await plan({ suites: [await suite()] });
    await req('POST', `/api/qa-plans/${id}/start`);
    await qaIdle();
    expect((await json(req('POST', `/api/qa-plans/${id}/sign`, {}))).error).toContain('阻断');
    expect((await json(req('POST', `/api/qa-plans/${id}/sign`, { override: true }))).error).toContain('原因');
    expect((await req('POST', `/api/qa-plans/${id}/sign`, { override: true, note: '已知问题' })).status).toBe(200);
    expect((await planDetail(id)).report).toContain('人工放行：已知问题');
  });

  it('计划内的套件钉在同一提交', async () => {
    const id = await plan({ suites: [await suite(), await suite({ name: '二' })] });
    await req('POST', `/api/qa-plans/${id}/start`);
    await qaIdle();
    const d = await planDetail(id);
    expect(new Set(d.runs.map((r) => r.commitSha)).size).toBe(1);
  });
});

describe('自动回归', () => {
  it('目标分支新提交只跑一次；新增失败进收件箱', async () => {
    const s = await suite({ auto_run: true });
    await qaTick(db);
    await qaIdle();
    await qaTick(db);
    await qaIdle();
    expect(await db.select().from(qaRun).where(eq(qaRun.suiteId, s))).toHaveLength(1);

    commit([{ name: 'a', fail: 'boom' }, { name: 'b' }]);
    await qaTick(db);
    await qaIdle();
    expect(await db.select().from(qaRun).where(eq(qaRun.suiteId, s))).toHaveLength(2);
    expect(await db.select().from(inboxItem).where(eq(inboxItem.kind, 'qa_regression'))).toHaveLength(1);
  });
});

describe('Agent 工具', () => {
  it('Agent 只能按 id 运行，结果由平台记录', async () => {
    const s = await suite();
    const r = await call('run_test_suite', { suiteId: s, command: 'bash evil.sh' }, 'qa-lead');
    expect(r.status).toBe('queued');
    await qaIdle();
    const row = (await db.select().from(qaRun).where(eq(qaRun.id, r.runId as string)))[0]!;
    expect(row).toMatchObject({ trigger: 'agent', status: 'passed' });
    expect(JSON.parse(row.configJson).command).toBe('node run.js');
  });

  it.each(['qa-lead', 'case-designer', 'failure-analyst'])('%s 没有写代码、跑命令、改实体的工具', async (template) => {
    const tools = JSON.parse((await agentOf(template)).toolsJson!) as string[];
    for (const denied of ['apply_patch', 'git_commit', 'run_command', 'propose_entity']) expect(tools).not.toContain(denied);
  });

  it('所有 Agent 工具都已实现，并能转成模型可用的 JSON Schema', async () => {
    for (const template of ['qa-lead', 'case-designer', 'failure-analyst']) {
      const names = JSON.parse((await agentOf(template)).toolsJson!) as string[];
      const schemas = toolSchemasFor(names);
      expect(schemas.map((s) => s.name).sort()).toEqual([...names].sort());
      for (const s of schemas) expect(zodToJson(s.parameters)).toMatchObject({ type: 'object' });
    }
  });

  it('保存套件时就校验命令', async () => {
    const r = await json(req('POST', `/api/workstations/${wsId}/qa/suites`, { data: { name: 'x', command: 'npx evil', report_path: 'r.xml' } }));
    expect(r.error).toContain('环境或依赖');
    const ok = await json<{ id: string }>(req('POST', `/api/workstations/${wsId}/qa/suites`, { data: { name: 'x', command: 'node run.js', report_path: 'report.xml' } }));
    expect(ok.id).toBeTruthy();
  });

  it('失败分析工具读运行、存判断、起草缺陷', async () => {
    commit([{ name: 'a', fail: 'expected 1 to be 2' }]);
    const id = await run(await suite());
    const r = await call('get_test_run', { runId: id }) as { groups: { fingerprint: string; cases: { caseKey: string; detail: string }[] }[] };
    expect(r.groups[0]!.cases[0]!.detail).toContain('stack of a');
    await call('save_triage', { runId: id, groups: [{ fingerprint: r.groups[0]!.fingerprint, category: 'product_bug', confidence: 'high', summary: '算错', evidence: 'expected 1 to be 2' }] });
    expect((await detail(id)).clusters[0]!.triage).toMatchObject({ category: 'product_bug' });
    const bug = await call('draft_bug', { title: '算错', severity: 'p2', steps: 's', expected: 'e', actual: 'a', run_id: id });
    expect(JSON.parse((await db.select().from(entity).where(eq(entity.id, bug.bugId as string)))[0]!.dataJson!)).toMatchObject({ status: 'draft' });
  });

  it('跨工作台的运行读不到', async () => {
    await db.insert(qaRun).values({ id: 'other', workstationId: devId, suiteId: 's', suiteName: 'n', configJson: '{"command":"x"}', ref: 'x', commitSha: 'y', status: 'passed', trigger: 'human', createdAt: new Date().toISOString() });
    expect((await call('get_test_run', { runId: 'other' })).error).toContain('不存在');
    expect((await call('save_triage', { runId: 'other', groups: [{ fingerprint: 'f', category: 'flaky', confidence: 'low', summary: 's', evidence: 'e' }] })).error).toContain('不存在');
  });

  it('用例草稿不直接入库，读代码不能越界', async () => {
    expect(await call('save_test_cases', { cases: [{ title: 't', priority: 'p1', steps: [{ action: 'a', expected: 'b' }] }] }, 'case-designer')).toMatchObject({ saved: 1, status: 'draft' });
    expect(await call('read_repo_file', { path: 'package.json' }, 'case-designer')).toMatchObject({ path: 'package.json' });
    expect((await call('read_repo_file', { path: '../secret' }, 'case-designer')).error).toBeTruthy();
    expect((await call('read_repo_file', { path: 'a', ref: '--upload-pack=x' }, 'case-designer')).error).toBeTruthy();
    expect(await call('search_repo', { query: 'fixture' }, 'case-designer')).toMatchObject({ more: 0 });
  });

  it('点“AI 分析”后失败分析 Agent 写回判断', async () => {
    commit([{ name: 'a', fail: 'expected 1 to be 2' }]);
    const id = await run(await suite());
    expect((await req('POST', `/api/qa-runs/${id}/triage`)).status).toBe(200);
    expect((await detail(id)).triageStatus).not.toBeNull();
    await settle();
    const d = await detail(id);
    expect(d.triageStatus).toBe('done');
    expect(d.clusters[0]!.triage).toMatchObject({ category: 'product_bug' });
  });
});

describe('插件登记', () => {
  it('老库重启后补上新插件的登记', async () => {
    await db.delete(pluginInstall).where(eq(pluginInstall.pluginId, 'qa'));
    await seed(db);
    expect(await db.select().from(pluginInstall).where(eq(pluginInstall.pluginId, 'qa'))).toHaveLength(1);
  });
});
