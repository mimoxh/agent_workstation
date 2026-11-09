import { caseKey, errorFingerprint, type QaRunStatus } from '@aw/domain';
import { and, desc, eq, inArray, notInArray } from 'drizzle-orm';
import PQueue from 'p-queue';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { DB } from '../../db/client.js';
import { artifact, qaCaseResult, qaRun } from '../../db/schema.js';
import { logEvent } from '../../usecases/core.js';
import { afterQaRun } from '../../usecases/qa.js';
import { isDangerous, isDependencyChange, isEnvError, portEnv, runCommand, splitCommand, WHITELIST, type ExecResult } from '../exec.js';
import { git, gitOk, wtRoot, type DevSettings } from '../git.js';
import { safePath } from '../tools/dev.js';
import { parseCoverage, parseJUnit, type Coverage, type ParsedCase } from './reports.js';

const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();
const PLATFORM = { type: 'human', id: 'local' } as const;

const REPORT_LIMIT = 20 * 1024 * 1024;
export const DEFAULT_TIMEOUT_SEC = 900;
export const KEEP_DETAIL_RUNS = 100;
const LOCKFILES = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock'];

export interface RunConfig { command: string; reportPath: string; coveragePath: string | null; timeoutSec: number }

// 套件命令没有人在旁边确认，所以比 run_command 更严：需要确认的命令一律不跑
export function commandProblem(command: string): string | null {
  const argv = splitCommand(command);
  if (!argv || argv.length === 0) return '命令不能用管道、重定向、链式写法或变量';
  if (!WHITELIST.has(argv[0]!)) return `命令 ${argv[0]} 不在白名单`;
  if (argv[0] === 'git') return '测试套件不能运行 git 命令';
  if (isDangerous(argv) || isDependencyChange(argv)) return '这条命令会改动环境或依赖，不能作为测试套件';
  return null;
}

export const reportPathProblem = (p: string) => (!p.trim() || path.isAbsolute(p) || p.replace(/\\/g, '/').split('/').includes('..') ? '报告路径必须是仓库内的相对路径' : null);

const queues = new Map<string, PQueue>();
const controllers = new Map<string, AbortController>();
const queueOf = (wsId: string) => queues.get(wsId) ?? queues.set(wsId, new PQueue({ concurrency: 1 })).get(wsId)!;

export const qaIdle = async () => {
  await Promise.all([...queues.values()].map((q) => q.onIdle()));
};

export function enqueueQaRun(db: DB, wsId: string, runId: string, settings: DevSettings) {
  const controller = new AbortController();
  controllers.set(runId, controller);
  void queueOf(wsId).add(async () => {
    try {
      await executeRun(db, runId, settings, controller.signal);
    } catch (e) {
      console.error('[qa] 运行异常', runId, String(e));
      await finish(db, runId, 'error', { error: `平台执行失败：${String(e).slice(0, 500)}` });
    } finally {
      controllers.delete(runId);
    }
  });
}

export function abortQaRun(runId: string) {
  const c = controllers.get(runId);
  if (!c) return false;
  c.abort();
  return true;
}

export const qaWorktree = (s: DevSettings, wsId: string) => path.join(wtRoot(s.repoPath, wsId), '_qa');

// 常驻的分离头 worktree：只读语义，不建分支；node_modules 留着下次用
async function checkout(s: DevSettings, wsId: string, sha: string) {
  const dir = qaWorktree(s, wsId);
  mkdirSync(path.dirname(dir), { recursive: true });
  const registered = (await git(s.repoPath, ['worktree', 'list', '--porcelain'])).stdout.split('\n').some((l) => l.startsWith('worktree ') && path.resolve(l.slice('worktree '.length).trim()) === path.resolve(dir));
  if (!registered) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    await git(s.repoPath, ['worktree', 'prune']);
    await gitOk(s.repoPath, ['worktree', 'add', '--detach', dir, sha]);
  } else {
    await gitOk(dir, ['checkout', '--detach', '--force', sha]);
  }
  await gitOk(dir, ['clean', '-fdx', '-e', 'node_modules']);
  return dir;
}

async function lockHash(s: DevSettings, sha: string) {
  for (const f of LOCKFILES) {
    const r = await git(s.repoPath, ['rev-parse', '--verify', '--quiet', `${sha}:${f}`]);
    if (r.code === 0) return r.stdout.trim();
  }
  return 'none';
}

// 锁文件没变就不重装；装失败不写标记，下次还会重试
async function ensureSetup(s: DevSettings, wsId: string, dir: string, sha: string): Promise<ExecResult | null> {
  if (!s.commands.setup) return null;
  const stamp = `${dir}.setup`;
  const hash = await lockHash(s, sha);
  if (existsSync(stamp) && readFileSync(stamp, 'utf8') === hash && existsSync(path.join(dir, 'node_modules'))) return null;
  const res = await runCommand({ cwd: dir, command: s.commands.setup, timeoutSec: s.setupTimeoutSec, env: portEnv(wsId.slice(0, 8)), sandbox: s.sandbox, network: 'bridge' });
  if (res.exitCode === 0 && !res.timedOut) writeFileSync(stamp, hash);
  return res;
}

function readReport(worktree: string, rel: string): { content: string } | { missing: true } | { error: string } {
  const abs = safePath(worktree, rel);
  if (!abs) return { error: `报告路径不合法：${rel}` };
  if (!existsSync(abs)) return { missing: true };
  if (statSync(abs).size > REPORT_LIMIT) return { error: `报告超过 ${REPORT_LIMIT / 1024 / 1024}MB：${rel}` };
  return { content: readFileSync(abs, 'utf8') };
}

const uniqueNames = (cases: ParsedCase[]) => {
  const seen = new Map<string, number>();
  return cases.map((c) => {
    const k = `${c.classname}\0${c.name}`;
    const n = (seen.get(k) ?? 0) + 1;
    seen.set(k, n);
    return n === 1 ? c : { ...c, name: `${c.name} #${n}` };
  });
};

interface FinishFields { error?: string | undefined; envError?: boolean | undefined; durationMs?: number | undefined; outputArtifactId?: string | undefined; coverage?: Coverage | null | undefined; counts?: { total: number; passed: number; failed: number; errored: number; skipped: number } | undefined }

async function finish(db: DB, runId: string, status: QaRunStatus, f: FinishFields) {
  const r = await db.update(qaRun).set({
    status,
    error: f.error ?? null,
    envError: f.envError ? 1 : 0,
    finishedAt: now(),
    ...(f.durationMs !== undefined ? { durationMs: f.durationMs } : {}),
    ...(f.outputArtifactId ? { outputArtifactId: f.outputArtifactId } : {}),
    ...(f.coverage ? { coverageJson: JSON.stringify(f.coverage) } : {}),
    ...(f.counts ?? {}),
  }).where(and(eq(qaRun.id, runId), inArray(qaRun.status, ['queued', 'running'])));
  if (r.changes === 0) return;
  await logEvent(db, PLATFORM, 'qa_run_finished', 'qa_run', runId, { status });
  await afterQaRun(db, runId);
}

async function saveOutput(db: DB, wsId: string, text: string) {
  const id = uid();
  await db.insert(artifact).values({ id, workstationId: wsId, type: 'test_output', name: 'qa_output', ref: text.slice(0, 32000), createdAt: now() });
  return id;
}

async function saveCases(db: DB, run: typeof qaRun.$inferSelect, cases: ParsedCase[]) {
  const rows = uniqueNames(cases).map((c) => ({
    id: uid(), runId: run.id, workstationId: run.workstationId, suiteId: run.suiteId,
    caseKey: caseKey(run.suiteId, c.classname, c.name), classname: c.classname, name: c.name, status: c.status, durationMs: c.durationMs,
    failureMessage: c.failureMessage, failureDetail: c.failureDetail, fingerprint: c.failureMessage === null ? null : errorFingerprint(c.failureMessage),
    commitSha: run.commitSha, createdAt: run.createdAt,
  }));
  for (let i = 0; i < rows.length; i += 200) await db.insert(qaCaseResult).values(rows.slice(i, i + 200));
}

// 明细只留最近的；运行摘要长期保留，趋势图不受影响
async function pruneDetails(db: DB, wsId: string, suiteId: string) {
  const keep = await db.select({ id: qaRun.id }).from(qaRun).where(and(eq(qaRun.workstationId, wsId), eq(qaRun.suiteId, suiteId))).orderBy(desc(qaRun.createdAt)).limit(KEEP_DETAIL_RUNS);
  if (keep.length < KEEP_DETAIL_RUNS) return;
  await db.delete(qaCaseResult).where(and(eq(qaCaseResult.workstationId, wsId), eq(qaCaseResult.suiteId, suiteId), notInArray(qaCaseResult.runId, keep.map((k) => k.id))));
}

async function executeRun(db: DB, runId: string, s: DevSettings, signal: AbortSignal) {
  const run = (await db.select().from(qaRun).where(eq(qaRun.id, runId)))[0];
  if (run?.status !== 'queued') return;
  await db.update(qaRun).set({ status: 'running', startedAt: now() }).where(eq(qaRun.id, runId));
  await logEvent(db, PLATFORM, 'qa_run_started', 'qa_run', runId, {});
  const cfg = JSON.parse(run.configJson) as RunConfig;
  const wsId = run.workstationId;

  let dir: string;
  try {
    dir = await checkout(s, wsId, run.commitSha);
  } catch (e) {
    return finish(db, runId, 'error', { error: `检出 ${run.commitSha.slice(0, 8)} 失败：${String(e).slice(0, 500)}`, envError: true });
  }
  const setup = await ensureSetup(s, wsId, dir, run.commitSha);
  if (setup && (setup.exitCode !== 0 || setup.timedOut)) {
    return finish(db, runId, 'error', { error: '安装依赖失败', envError: true, outputArtifactId: await saveOutput(db, wsId, setup.output) });
  }
  if (signal.aborted) return finish(db, runId, 'canceled', {});

  const res = await runCommand({
    cwd: dir, command: cfg.command, timeoutSec: cfg.timeoutSec, sandbox: s.sandbox, signal,
    env: { ...portEnv(wsId.slice(0, 8)), PLAYWRIGHT_JUNIT_OUTPUT_NAME: cfg.reportPath },
  });
  const outputArtifactId = await saveOutput(db, wsId, res.output);
  const base = { durationMs: res.durationMs, outputArtifactId };
  if (signal.aborted) return finish(db, runId, 'canceled', base);
  if (res.timedOut) return finish(db, runId, 'error', { ...base, error: `超过 ${cfg.timeoutSec} 秒未结束` });
  if (isEnvError(res)) return finish(db, runId, 'error', { ...base, error: '命令没能运行起来', envError: true });

  const report = readReport(dir, cfg.reportPath);
  if ('error' in report) return finish(db, runId, 'error', { ...base, error: report.error });
  if ('missing' in report) return finish(db, runId, 'error', { ...base, error: `命令结束了，但没有生成报告 ${cfg.reportPath}（退出码 ${res.exitCode}）` });
  let cases: ParsedCase[];
  try {
    cases = parseJUnit(report.content);
  } catch (e) {
    return finish(db, runId, 'error', { ...base, error: `报告解析失败：${String(e).slice(0, 300)}` });
  }
  if (cases.length === 0) return finish(db, runId, 'error', { ...base, error: '报告里没有用例' });

  let coverage: Coverage | null = null;
  if (cfg.coveragePath) {
    const c = readReport(dir, cfg.coveragePath);
    if ('content' in c) {
      try {
        coverage = parseCoverage(c.content, dir);
      } catch (e) {
        console.error('[qa] 覆盖率解析失败', runId, String(e));
      }
    }
  }
  await saveCases(db, run, cases);
  await pruneDetails(db, wsId, run.suiteId);
  const counts = {
    total: cases.length,
    passed: cases.filter((c) => c.status === 'passed').length,
    failed: cases.filter((c) => c.status === 'failed').length,
    errored: cases.filter((c) => c.status === 'error').length,
    skipped: cases.filter((c) => c.status === 'skipped').length,
  };
  const hasFailures = counts.failed + counts.errored > 0;
  // 退出码非 0 却没有失败用例：很可能是报告之后才崩的，不能算通过
  if (res.exitCode !== 0 && !hasFailures) return finish(db, runId, 'error', { ...base, counts, coverage, error: `退出码 ${res.exitCode}，但报告里没有失败用例` });
  await finish(db, runId, hasFailures ? 'failed' : 'passed', { ...base, counts, coverage });
}
