import { execFile } from 'node:child_process';
import PQueue from 'p-queue';
import path from 'node:path';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import type { SandboxConfig } from './sandbox.js';

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

export async function isAncestor(cwd: string, a: string, b: string) {
  return (await git(cwd, ['merge-base', '--is-ancestor', a, b])).code === 0;
}

export interface DevSettings {
  repoPath: string;
  targetBranch: string;
  baseBranch: string;
  // serve：视觉验收前在 worktree 里起的 dev server（端口从 PORT / AW_E2E_WEB_PORT 取，url 里写 {port}）
  commands: { build?: string; test?: string; lint?: string; setup?: string; serve?: string };
  commandTimeoutSec: number;
  setupTimeoutSec: number;
  requireHumanFor: string[];
  // 远端：不配就只在本地合并；autoPush 合并 / 回滚后把目标分支推上去
  remote?: { name: string; autoPush: boolean } | undefined;
  // 配了镜像就在容器里跑命令；docker 不可用时拒绝执行，不退回宿主
  sandbox?: SandboxConfig | undefined;
}

export function devSettings(settingsJson: string | null): DevSettings {
  const s = (JSON.parse(settingsJson ?? '{}') as Record<string, unknown>);
  const commands = (s.commands ?? {}) as Record<string, string | undefined>;
  const remote = s.remote as { name?: string; autoPush?: boolean } | undefined;
  const sandbox = s.sandbox as SandboxConfig | null | undefined;
  return {
    repoPath: String(s.repoPath ?? '.'),
    targetBranch: String(s.targetBranch ?? 'develop'),
    baseBranch: String(s.baseBranch ?? 'main'),
    commands,
    commandTimeoutSec: Number(s.commandTimeoutSec ?? 120),
    setupTimeoutSec: Number(s.setupTimeoutSec ?? 600),
    requireHumanFor: Array.isArray(s.requireHumanFor) ? (s.requireHumanFor as string[]) : [],
    remote: remote?.name ? { name: remote.name, autoPush: !!remote.autoPush } : undefined,
    sandbox: sandbox?.image ? sandbox : undefined,
  };
}

const PUSH_TIMEOUT_MS = 180_000;

// 推送目标分支；凭据交给用户自己的 git 配置（credential helper / ssh），平台不碰
export async function pushTarget(s: DevSettings): Promise<{ ok: boolean; output: string }> {
  const name = s.remote?.name ?? 'origin';
  const r = await git(s.repoPath, ['push', name, `refs/heads/${s.targetBranch}:refs/heads/${s.targetBranch}`], PUSH_TIMEOUT_MS);
  return { ok: r.code === 0, output: (r.stderr || r.stdout).trim() };
}

// 从零开始的项目：目录不是仓库就 git init，没有任何提交就在基线分支上建一个空的初始提交
export async function ensureRepo(s: DevSettings): Promise<{ ok: true; created: boolean } | { ok: false; error: string }> {
  if (!path.isAbsolute(s.repoPath)) return { ok: false, error: '仓库路径必须是绝对路径' };
  // 路径写错不能悄悄建出一个新仓库：目录要先存在，且是空目录才会初始化
  if (!existsSync(s.repoPath)) return { ok: false, error: `仓库路径不存在：${s.repoPath}` };
  let created = false;
  if ((await git(s.repoPath, ['rev-parse', '--is-inside-work-tree'])).code !== 0) {
    if (readdirSync(s.repoPath).length > 0) return { ok: false, error: `不是 git 仓库且目录非空：${s.repoPath}（可在工作台设置里初始化为 git 仓库）` };
    const init = await git(s.repoPath, ['init', '-b', s.baseBranch]);
    if (init.code !== 0) return { ok: false, error: init.stderr.trim() };
    created = true;
  }
  if ((await git(s.repoPath, ['rev-parse', '--verify', '--quiet', 'HEAD'])).code !== 0) {
    const c = await git(s.repoPath, ['-c', 'user.name=aw-platform', '-c', 'user.email=platform@aw.local', 'commit', '--allow-empty', '-m', 'Initial commit']);
    if (c.code !== 0) return { ok: false, error: c.stderr.trim() };
    created = true;
  }
  return { ok: true, created };
}

export const wtRoot = (repoPath: string, wsId: string) => path.join(process.env.AW_WORKTREE_ROOT ?? path.join(repoPath, 'data', 'worktrees'), wsId.slice(0, 8));
export const integrationPath = (repoPath: string, wsId: string) => path.join(wtRoot(repoPath, wsId), '_integration');

// 主工作区检出 targetBranch → 禁止继续（会打架）
export async function ensureTargetBranch(s: DevSettings): Promise<{ ok: true } | { ok: false; error: string }> {
  const repo = await ensureRepo(s);
  if (!repo.ok) return repo;
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
