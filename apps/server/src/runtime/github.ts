import { execFile } from 'node:child_process';
import { git, pushTarget, type DevSettings } from './git.js';

// GitHub 走用户本机已登录的 gh CLI：平台不保存 token，凭据与权限都是用户自己的
const GH_TIMEOUT_MS = 60_000;

function gh(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile('gh', args, { cwd, windowsHide: true, timeout: GH_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const e = err as { code?: number | string } | null;
      const missing = e?.code === 'ENOENT';
      resolve({ code: e ? (typeof e.code === 'number' ? e.code : 1) : 0, stdout: String(stdout), stderr: missing ? '本机没有安装 gh（GitHub CLI）' : String(stderr) });
    });
  });
}

const firstLine = (s: string) => s.trim().split('\n')[0] ?? '';

export async function githubStatus(s: DevSettings) {
  const remote = s.remote?.name ?? 'origin';
  const url = (await git(s.repoPath, ['remote', 'get-url', remote])).stdout.trim() || null;
  const auth = await gh(s.repoPath, ['auth', 'status']);
  const ahead = url
    ? Number((await git(s.repoPath, ['rev-list', '--count', `refs/remotes/${remote}/${s.targetBranch}..refs/heads/${s.targetBranch}`])).stdout.trim()) || null
    : null;
  return { remote, url, github: !!url && /github\.com[:/]/.test(url), ghReady: auth.code === 0, ghError: auth.code === 0 ? null : firstLine(auth.stderr || auth.stdout), unpushed: ahead };
}

export async function publishTarget(s: DevSettings) {
  const r = await pushTarget(s);
  return r.ok ? { ok: true as const } : { ok: false as const, error: `推送失败：${firstLine(r.output)}` };
}

// 目标分支 → 基线分支的 PR；已经有开着的就直接返回它
export async function openPullRequest(s: DevSettings): Promise<{ url: string; created: boolean } | { error: string }> {
  const pushed = await publishTarget(s);
  if (!pushed.ok) return { error: pushed.error };
  const existing = await gh(s.repoPath, ['pr', 'list', '--head', s.targetBranch, '--base', s.baseBranch, '--state', 'open', '--json', 'url', '--limit', '1']);
  if (existing.code !== 0) return { error: firstLine(existing.stderr) || '读取 PR 失败' };
  const open = JSON.parse(existing.stdout || '[]') as { url: string }[];
  if (open[0]) return { url: open[0].url, created: false };
  const merges = (await git(s.repoPath, ['log', '--merges', '--format=- %s', `refs/heads/${s.baseBranch}..refs/heads/${s.targetBranch}`])).stdout.trim();
  const body = `由 Agent Workstation 合并的任务：\n\n${merges || '（无合并记录）'}`;
  const c = await gh(s.repoPath, ['pr', 'create', '--base', s.baseBranch, '--head', s.targetBranch, '--title', `Merge ${s.targetBranch} into ${s.baseBranch}`, '--body', body]);
  if (c.code !== 0) return { error: firstLine(c.stderr) || '创建 PR 失败' };
  return { url: firstLine(c.stdout), created: true };
}

export interface GithubIssue { number: number; title: string; body: string; url: string; labels: { name: string }[] }

export async function listOpenIssues(s: DevSettings, limit = 30): Promise<{ issues: GithubIssue[] } | { error: string }> {
  const r = await gh(s.repoPath, ['issue', 'list', '--state', 'open', '--limit', String(limit), '--json', 'number,title,body,url,labels']);
  if (r.code !== 0) return { error: firstLine(r.stderr) || '读取 Issue 失败' };
  return { issues: JSON.parse(r.stdout || '[]') as GithubIssue[] };
}
