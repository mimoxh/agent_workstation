import { execFile } from 'node:child_process';
import PQueue from 'p-queue';
import path from 'node:path';
import { existsSync, mkdirSync, rmSync } from 'node:fs';

export interface GitResult { code: number; stdout: string; stderr: string; argv: string[]; ms: number; timedOut?: boolean }

const GIT_TIMEOUT_MS = 120_000;

// git 写操作（index.lock）按进程串行化，避免并发 worktree 互踩
const gitMutex = new PQueue({ concurrency: 1 });

// 所有 git 调用统一入口，带超时并记录 argv
export function git(cwd: string, args: string[], timeoutMs = GIT_TIMEOUT_MS): Promise<GitResult> {
  return gitMutex.add(() => gitRaw(cwd, args, timeoutMs));
}

function gitRaw(cwd: string, args: string[], timeoutMs = GIT_TIMEOUT_MS): Promise<GitResult> {
  const argv = ['-c', 'core.longpaths=true', ...args];
  const t0 = Date.now();
  return new Promise((resolve) => {
    const child = execFile('git', argv, { cwd, windowsHide: true, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const e = err as { code?: number; killed?: boolean; signal?: string } | null;
      resolve({
        code: e?.killed ? -1 : (e?.code ?? 0),
        stdout: String(stdout), stderr: String(stderr), argv, ms: Date.now() - t0,
        ...(e?.killed ? { timedOut: true } : {}),
      });
    });
    child.unref?.();
  });
}

export async function gitOk(cwd: string, args: string[], timeoutMs?: number) {
  const r = await git(cwd, args, timeoutMs);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} 失败: ${r.stderr.trim() || r.stdout.trim()}`);
  return r;
}

export interface DevSettings {
  repoPath: string;
  targetBranch: string;
  baseBranch: string;
  commands: { build?: string; test?: string; lint?: string; setup?: string };
  commandTimeoutSec: number;
  setupTimeoutSec: number;
  requireHumanFor: string[];
}

export function devSettings(settingsJson: string | null): DevSettings {
  const s = (JSON.parse(settingsJson ?? '{}') as Record<string, unknown>);
  const commands = (s.commands ?? {}) as Record<string, string | undefined>;
  return {
    repoPath: String(s.repoPath ?? '.'),
    targetBranch: String(s.targetBranch ?? 'develop'),
    baseBranch: String(s.baseBranch ?? 'main'),
    commands,
    commandTimeoutSec: Number(s.commandTimeoutSec ?? 120),
    setupTimeoutSec: Number(s.setupTimeoutSec ?? 600),
    requireHumanFor: Array.isArray(s.requireHumanFor) ? (s.requireHumanFor as string[]) : [],
  };
}

export const wtRoot = (repoPath: string, wsId: string) => path.join(process.env.AW_WORKTREE_ROOT ?? path.join(repoPath, 'data', 'worktrees'), wsId.slice(0, 8));
export const integrationPath = (repoPath: string, wsId: string) => path.join(wtRoot(repoPath, wsId), '_integration');

// 主工作区检出 targetBranch → 禁止继续（会打架）
export async function ensureTargetBranch(s: DevSettings): Promise<{ ok: true } | { ok: false; error: string }> {
  const cur = (await gitOk(s.repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
  if (cur === s.targetBranch) return { ok: false, error: `目标分支 ${s.targetBranch} 被主工作区检出` };
  const exists = await git(s.repoPath, ['rev-parse', '--verify', `refs/heads/${s.targetBranch}`]);
  if (exists.code !== 0) {
    await gitOk(s.repoPath, ['branch', s.targetBranch, s.baseBranch]);
  }
  return { ok: true };
}

export async function ensureIntegration(s: DevSettings, wsId: string): Promise<string> {
  const p = integrationPath(s.repoPath, wsId);
  const probe = await git(p, ['rev-parse', '--is-inside-work-tree']);
  if (probe.code !== 0) {
    mkdirSync(path.dirname(p), { recursive: true });
    const add = await git(s.repoPath, ['worktree', 'add', p, s.targetBranch]);
    if (add.code !== 0) {
      // 'already used by worktree'：已有 worktree 检出 targetBranch（残留注册）→ prune 后复用或重试
      await git(s.repoPath, ['worktree', 'prune']);
      const list = (await git(s.repoPath, ['worktree', 'list', '--porcelain'])).stdout;
      const existing = list.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9)).find((w) => w.endsWith('_integration'));
      if (existing && (await git(existing, ['rev-parse', '--is-inside-work-tree'])).code === 0) return existing;
      await gitOk(s.repoPath, ['worktree', 'add', p, s.targetBranch]);
    }
  }
  return p;
}

// 任务 worktree：aw/<taskId8> 基于 targetBranch HEAD
export async function createTaskWorktree(s: DevSettings, wsId: string, taskId: string): Promise<{ worktree: string; branch: string; base_sha: string }> {
  const root = wtRoot(s.repoPath, wsId);
  mkdirSync(root, { recursive: true });
  const short = taskId.slice(0, 8);
  const branch = `aw/${short}`;
  const dir = path.join(root, short);
  const base = (await gitOk(s.repoPath, ['rev-parse', s.targetBranch])).stdout.trim();
  const exists = await git(s.repoPath, ['rev-parse', '--verify', `refs/heads/${branch}`]);
  if (exists.code !== 0) await gitOk(s.repoPath, ['branch', branch, s.targetBranch]);
  // 目录存在但未注册（上次删除残留的僵尸目录）：probe 不能只信 rev-parse，必须查 worktree list
  // git 在 Windows 上输出正斜杠路径，比较前要规范化
  const registered = (await git(s.repoPath, ['worktree', 'list', '--porcelain'])).stdout.split('\n').some((l) => l.startsWith('worktree ') && path.resolve(l.slice('worktree '.length)) === path.resolve(dir));
  if (!registered && existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
  const probe = await git(dir, ['rev-parse', '--is-inside-work-tree']);
  if (probe.code !== 0) await gitOk(s.repoPath, ['worktree', 'add', dir, branch]);
  return { worktree: dir, branch, base_sha: base };
}

export async function removeTaskWorktree(s: DevSettings, wsId: string, taskId: string) {
  const dir = path.join(wtRoot(s.repoPath, wsId), taskId.slice(0, 8));
  await git(s.repoPath, ['worktree', 'remove', '--force', dir]);
  // 分支已并入 targetBranch 才删，否则保留
  const merged = await git(s.repoPath, ['branch', '--merged', s.targetBranch]);
  if (merged.stdout.split('\n').map((l) => l.trim().replace(/^\* /, '')).includes(`aw/${taskId.slice(0, 8)}`)) {
    await git(s.repoPath, ['branch', '-D', `aw/${taskId.slice(0, 8)}`]);
  }
}
