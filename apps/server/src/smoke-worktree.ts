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
  await step('setup(pnpm install)', () => runCommand({ cwd: wt!.worktree, command: s.commands.setup!, timeoutSec: s.setupTimeoutSec }).then((r) => { if (r.exitCode !== 0) throw new Error(r.output.slice(-400)); }));
  await step('pnpm build', () => runCommand({ cwd: wt!.worktree, command: 'pnpm build', timeoutSec: s.commandTimeoutSec }).then((r) => { if (r.exitCode !== 0) throw new Error(r.output.slice(-400)); }));
  await step('pnpm test', () => runCommand({ cwd: wt!.worktree, command: 'pnpm test', timeoutSec: s.commandTimeoutSec }).then((r) => { if (r.exitCode !== 0) throw new Error(r.output.slice(-400)); }));
} finally {
  if (wt) {
    await step('removeTaskWorktree', () => removeTaskWorktree(s, 'smokews1', taskId));
    try { execSync(`git branch -D ${wt.branch}`, { cwd: repoPath, stdio: 'pipe' }); } catch { /* 已随 merged 检查删除 */ }
    console.log('smoke 分支已删除');
  }
}
console.log('smoke:worktree done');
