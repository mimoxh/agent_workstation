// 真实仓库 worktree 冒烟：ensureTargetBranch → 任务 worktree → setup → build/test → 回收
// 用法: smoke:worktree [--ref <git ref>]（默认 targetBranch；smoke 分支 finally 里删）
import { execSync } from 'node:child_process';
import { devSettings, ensureTargetBranch, createTaskWorktree, removeTaskWorktree, git } from './runtime/git.js';
import { runCommand } from './runtime/exec.js';

const step = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
  const t0 = Date.now();
  try {
    const r = await fn();
    console.log(`${name}: ${((Date.now() - t0) / 1000).toFixed(1)}s ok`);
    return r;
  } catch (e) {
    console.log(`${name}: ${((Date.now() - t0) / 1000).toFixed(1)}s FAIL ${String(e).slice(0, 300)}`);
    throw e;
  }
};

const cmd = async (name: string, cwd: string, command: string, timeoutSec: number) => {
  const r = await runCommand({ cwd, command, timeoutSec });
  const head = r.output.slice(0, 2000);
  const tail = r.output.length > 2000 ? r.output.slice(-2000) : '';
  console.log(`--- ${name} exit=${r.exitCode} ---\n${head}${tail ? '\n...<截断>...\n' + tail : ''}`);
  if (r.exitCode !== 0) throw new Error(r.output.slice(-400));
};

const argv = process.argv.slice(2);
const refArg = argv[argv.indexOf('--ref') + 1];
const repoPath = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
const s = { ...devSettings('{}'), repoPath, targetBranch: refArg ?? 'develop', baseBranch: 'main', commands: { setup: 'pnpm install --frozen-lockfile --prefer-offline' }, commandTimeoutSec: 600, setupTimeoutSec: 600 };
const taskId = `smoke-${Date.now()}`;
let wt: { worktree: string; branch: string } | null = null;

try {
  if (refArg) {
    // --ref 模式：直接用任意 ref 建分支
    const short = taskId.slice(0, 8);
    const branch = `aw/${short}`;
    await step('branch@' + refArg, () => git(repoPath, ['branch', branch, refArg]).then((r) => { if (r.code !== 0) throw new Error(r.stderr); }));
    wt = await step('createTaskWorktree', () => createTaskWorktree({ ...s, targetBranch: branch, baseBranch: 'main' }, 'smokews1', taskId));
  } else {
    await step('ensureTargetBranch', () => ensureTargetBranch(s).then((r) => { if (!r.ok) throw new Error(r.error); }));
    wt = await step('createTaskWorktree', () => createTaskWorktree(s, 'smokews1', taskId));
  }
  const tBuild = Date.now();
  await step('setup(pnpm install)', () => cmd('setup', wt!.worktree, s.commands.setup!, s.setupTimeoutSec));
  await step('pnpm build', () => cmd('build', wt!.worktree, 'pnpm build', s.commandTimeoutSec));
  await step('assert build artifact', async () => {
    const html = wt!.worktree + '/apps/web/dist/index.html';
    const st = await import('node:fs').then((m) => m.existsSync(html) ? m.statSync(html) : null);
    if (!st || st.mtimeMs < tBuild) throw new Error('apps/web/dist/index.html 不存在或过旧——build 未真正执行');
  });
  let testOutput = '';
  await step('pnpm test', async () => {
    const r = await runCommand({ cwd: wt!.worktree, command: 'pnpm test', timeoutSec: s.commandTimeoutSec });
    testOutput = r.output;
    console.log('--- test exit=' + r.exitCode + ' ---\n' + r.output.slice(0, 2000));
    if (r.exitCode !== 0) throw new Error(r.output.slice(-400));
  });
  await step('assert test count', async () => {
    const m = testOutput.match(/Tests\s+(\d+)\s+passed/);
    if (!m || Number(m[1]) < 1) throw new Error('test 输出里没有 ' + '' + 'Tests N passed' + '' + '——test 未真正执行');
  });
} finally {
  if (wt) {
    await step('removeTaskWorktree', () => removeTaskWorktree(s, 'smokews1', taskId));
    try { execSync(`git branch -D ${wt.branch}`, { cwd: repoPath, stdio: 'pipe' }); } catch { /* 已随 merged 检查删除 */ }
    console.log('smoke 分支已删除');
  }
}
console.log('smoke:worktree done');
