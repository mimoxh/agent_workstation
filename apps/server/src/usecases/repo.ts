import type { Actor } from '@aw/domain';
import { eq } from 'drizzle-orm';
import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import type { DB } from '../db/client.js';
import { proposal, task, workstation } from '../db/schema.js';
import { revertMerged, syncBaseIntoTarget, syncTaskBranch } from '../runtime/dev_workflow.js';
import { devSettings, git, type DevSettings } from '../runtime/git.js';
import { githubStatus, listOpenIssues, openPullRequest, publishTarget } from '../runtime/github.js';
import { acknowledgeDrift, checkRepos, repoDrift } from '../runtime/repo_watch.js';
import { logEvent } from './core.js';
import { createTaskUc } from './tasks.js';

const FILE_LIMIT = 200 * 1024;

async function settingsOf(db: DB, wsId: string): Promise<{ settings: DevSettings } | { error: string; status: 400 | 404 }> {
  const ws = (await db.select().from(workstation).where(eq(workstation.id, wsId)))[0];
  if (!ws) return { error: '工作台不存在', status: 404 };
  if (!ws.settingsJson) return { error: '该工作台未绑定代码仓库', status: 400 };
  const s = devSettings(ws.settingsJson);
  if (!s.repoPath || s.repoPath === '.') return { error: '该工作台未绑定代码仓库', status: 400 };
  return { settings: s };
}

// 目标分支在首次 run 时才创建，之前回落到 HEAD 让文件树可用
async function browseRef(s: DevSettings): Promise<string | null> {
  if ((await git(s.repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${s.targetBranch}`])).code === 0) return s.targetBranch;
  return (await git(s.repoPath, ['rev-parse', '--verify', '--quiet', 'HEAD'])).code === 0 ? 'HEAD' : null;
}

// 可浏览的版本：目标分支，或某个任务的分支（看还没合并的改动）
async function pickRef(db: DB, wsId: string, s: DevSettings, branch?: string): Promise<string | null> {
  if (!branch) return browseRef(s);
  const refs = await listBrowseRefs(db, wsId);
  if (!refs.branches.some((b) => b.branch === branch)) return null;
  return branch;
}

export async function listBrowseRefs(db: DB, wsId: string) {
  const r = await settingsOf(db, wsId);
  if ('error' in r) return { target: null, branches: [] as { branch: string; taskId: string; title: string; status: string }[] };
  const tasks = await db.select().from(task).where(eq(task.workstationId, wsId));
  const branches: { branch: string; taskId: string; title: string; status: string }[] = [];
  for (const t of tasks) {
    const ref = t.codeRefJson ? (JSON.parse(t.codeRefJson) as { branch?: string }) : null;
    if (!ref?.branch) continue;
    if ((await git(r.settings.repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${ref.branch}`])).code !== 0) continue;
    branches.push({ branch: ref.branch, taskId: t.id, title: t.title, status: t.status });
  }
  return { target: await browseRef(r.settings), branches };
}

export async function listRepoFiles(db: DB, wsId: string, dir: string, branch?: string) {
  const r = await settingsOf(db, wsId);
  if ('error' in r) return { ref: null, entries: [], error: r.error };
  const ref = await pickRef(db, wsId, r.settings, branch);
  if (!ref) return { ref: null, entries: [], error: `无法读取仓库：${r.settings.repoPath}` };
  const clean = dir.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  // 路径带尾斜杠才列目录内容，否则 ls-tree 只返回目录自身
  const out = await git(r.settings.repoPath, ['ls-tree', '-z', '-l', ref, ...(clean ? ['--', `${clean}/`] : [])]);
  if (out.code !== 0) return { ref, entries: [], error: out.stderr.trim() || '读取目录失败' };
  const entries = out.stdout
    .split('\0')
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf('\t');
      const [, type, , size] = line.slice(0, tab).trim().split(/\s+/);
      const path = line.slice(tab + 1);
      return { type: type === 'tree' ? ('tree' as const) : ('blob' as const), path, name: path.split('/').pop() ?? path, size: size && size !== '-' ? Number(size) : null };
    })
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'tree' ? -1 : 1));
  return { ref, entries, error: null };
}

export async function readRepoFile(db: DB, wsId: string, filePath: string, branch?: string) {
  const r = await settingsOf(db, wsId);
  if ('error' in r) return { kind: 'error' as const, status: r.status, error: r.error };
  const ref = await pickRef(db, wsId, r.settings, branch);
  if (!ref) return { kind: 'error' as const, status: 400 as const, error: '无法读取仓库' };
  const out = await git(r.settings.repoPath, ['show', `${ref}:${filePath.replace(/\\/g, '/')}`]);
  if (out.code !== 0) return { kind: 'error' as const, status: 404 as const, error: '文件不存在' };
  const binary = out.stdout.slice(0, 8000).includes('\0');
  return {
    kind: 'ok' as const,
    ref,
    path: filePath,
    binary,
    truncated: out.stdout.length > FILE_LIMIT,
    content: binary ? '' : out.stdout.slice(0, FILE_LIMIT),
  };
}

// 二进制读取（截图基线）：git() 按文本返回，图片会被破坏
export async function readRepoBlob(db: DB, wsId: string, filePath: string, branch?: string): Promise<{ ok: true; data: Buffer; ref: string } | { ok: false; error: string }> {
  const r = await settingsOf(db, wsId);
  if ('error' in r) return { ok: false, error: r.error };
  const ref = await pickRef(db, wsId, r.settings, branch);
  if (!ref) return { ok: false, error: branch ? `分支不可浏览：${branch}` : '无法读取仓库' };
  const spec = `${ref}:${filePath.replace(/\\/g, '/').replace(/^\.?\/+/, '')}`;
  return new Promise((resolve) => {
    execFile('git', ['cat-file', 'blob', spec], { cwd: r.settings.repoPath, encoding: 'buffer', maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      resolve(err ? { ok: false, error: `基线不存在：${spec}` } : { ok: true, data: stdout, ref });
    });
  });
}

export async function repoStatus(db: DB, wsId: string) {
  const r = await settingsOf(db, wsId);
  if ('error' in r) return { ok: false, error: r.error, branch: null, targetExists: false, baseExists: false };
  const s = r.settings;
  const drift = repoDrift(wsId);
  // 空目录 / 没有提交的新仓库：第一次运行时平台会 init 并建初始提交（脚手架任务从这里开始）
  if (!existsSync(s.repoPath)) return { ok: false, error: `仓库路径不存在：${s.repoPath}`, branch: null, targetExists: false, baseExists: false };
  const fresh = readdirSync(s.repoPath).length === 0;
  const isRepo = !fresh && (await git(s.repoPath, ['rev-parse', '--is-inside-work-tree'])).code === 0;
  if (fresh || (isRepo && (await git(s.repoPath, ['rev-parse', '--verify', '--quiet', 'HEAD'])).code !== 0)) {
    return { ok: true, error: null, branch: null, targetExists: false, baseExists: false, empty: true, drift };
  }
  const head = await git(s.repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (head.code !== 0) return { ok: false, error: `不是可用的 git 仓库：${s.repoPath}`, branch: null, targetExists: false, baseExists: false };
  const branch = head.stdout.trim();
  const has = async (b: string) => (await git(s.repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${b}`])).code === 0;
  const targetExists = await has(s.targetBranch);
  const baseExists = await has(s.baseBranch);
  // 与 ensureTargetBranch 同一条规则：目标分支不能被主工作区检出
  const conflict = branch === s.targetBranch ? `目标分支 ${s.targetBranch} 被主工作区检出，Agent 无法建 worktree` : null;
  const missing = !targetExists && !baseExists ? `基线分支 ${s.baseBranch} 不存在，无法创建目标分支` : null;
  const error = conflict ?? missing;
  return { ok: error === null, error, branch, targetExists, baseExists, empty: false, drift };
}

// ===== 漂移 / 同步 / 回滚 / GitHub：路由层薄封装，返回统一 { kind } =====
type Fail = { kind: 'error'; status: 400 | 404 | 409; error: string };
const bad = (error: string, status: 400 | 404 | 409 = 409): Fail => ({ kind: 'error', status, error });

export async function syncBase(actor: Actor, db: DB, wsId: string) {
  const r = await settingsOf(db, wsId);
  if ('error' in r) return bad(r.error, r.status);
  const out = await syncBaseIntoTarget(db, actor, wsId);
  if ('error' in out) return bad(out.error);
  acknowledgeDrift(wsId);
  await checkRepos(db);
  return { kind: 'ok' as const, ...out };
}

export function ackDrift(wsId: string) {
  acknowledgeDrift(wsId);
  return { kind: 'ok' as const };
}

export async function revertTask(actor: Actor, db: DB, taskId: string, reason?: string) {
  const out = await revertMerged(db, actor, taskId, reason);
  return 'error' in out ? bad(out.error) : { kind: 'ok' as const, revertSha: out.revert_sha };
}

export async function syncTask(db: DB, taskId: string) {
  const t = (await db.select().from(task).where(eq(task.id, taskId)))[0];
  if (!t) return bad('任务不存在', 404);
  if (t.assigneeType === 'agent' && t.status === 'in_progress') return bad('Agent 正在这个分支上工作，让它调用 sync_branch，或先接管任务');
  const out = await syncTaskBranch(db, taskId);
  return 'error' in out ? bad(out.error) : { kind: 'ok' as const, ...out };
}

// 任务分支相对目标分支的位置：落后多少、是否停在合并中、提交后有没有人再改过
export async function taskBranchStatus(db: DB, taskId: string) {
  const t = (await db.select().from(task).where(eq(task.id, taskId)))[0];
  const ref = t?.codeRefJson ? (JSON.parse(t.codeRefJson) as { worktree?: string; branch?: string; head_sha?: string; merge_sha?: string; revert_sha?: string }) : null;
  if (!t || !ref) return null;
  const base = { branch: ref.branch ?? null, mergeSha: ref.merge_sha ?? null, revertSha: ref.revert_sha ?? null };
  if (!ref.worktree || !existsSync(ref.worktree) || ref.merge_sha) return { ...base, live: false, behind: 0, ahead: 0, merging: false, conflicts: [] as string[], movedAfterSubmit: false };
  const s = devSettings((await db.select().from(workstation).where(eq(workstation.id, t.workstationId)))[0]?.settingsJson ?? null);
  const count = async (range: string) => Number((await git(ref.worktree!, ['rev-list', '--count', range])).stdout.trim()) || 0;
  const merging = (await git(ref.worktree, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).code === 0;
  const conflicts = merging ? (await git(ref.worktree, ['diff', '--name-only', '--diff-filter=U'])).stdout.split('\n').filter(Boolean) : [];
  const head = (await git(ref.worktree, ['rev-parse', 'HEAD'])).stdout.trim();
  const submittedOpen = (await db.select().from(proposal).where(eq(proposal.taskId, taskId))).some((p) => ['pending', 'approved'].includes(p.status));
  return {
    ...base,
    live: true,
    behind: await count(`HEAD..${s.targetBranch}`),
    ahead: await count(`${s.targetBranch}..HEAD`),
    merging,
    conflicts,
    movedAfterSubmit: submittedOpen && !!ref.head_sha && head !== ref.head_sha,
  };
}

export async function remoteStatus(db: DB, wsId: string) {
  const r = await settingsOf(db, wsId);
  if ('error' in r) return { remote: null, url: null, github: false, ghReady: false, ghError: r.error, unpushed: null };
  return githubStatus(r.settings);
}

export async function pushWorkstation(actor: Actor, db: DB, wsId: string) {
  const r = await settingsOf(db, wsId);
  if ('error' in r) return bad(r.error, r.status);
  const out = await publishTarget(r.settings);
  if (!out.ok) return bad(out.error);
  await logEvent(db, actor, 'workstation_pushed', 'workstation', wsId, { branch: r.settings.targetBranch });
  return { kind: 'ok' as const };
}

export async function createPullRequest(actor: Actor, db: DB, wsId: string) {
  const r = await settingsOf(db, wsId);
  if ('error' in r) return bad(r.error, r.status);
  const out = await openPullRequest(r.settings);
  if ('error' in out) return bad(out.error);
  await logEvent(db, actor, 'workstation_pr_opened', 'workstation', wsId, { url: out.url, created: out.created });
  return { kind: 'ok' as const, ...out };
}

const issueKind = (labels: { name: string }[]) => {
  const names = labels.map((l) => l.name.toLowerCase());
  if (names.some((n) => n.includes('bug'))) return 'bug';
  if (names.some((n) => n.includes('dep'))) return 'deps';
  if (names.some((n) => ['chore', 'refactor', 'docs'].some((k) => n.includes(k)))) return 'chore';
  return 'feature';
};

// Issue → 草稿任务：module 先给整个仓库，派发前由人或架构师收窄；已导入过的跳过
export async function importIssues(actor: Actor, db: DB, wsId: string) {
  const r = await settingsOf(db, wsId);
  if ('error' in r) return bad(r.error, r.status);
  const out = await listOpenIssues(r.settings);
  if ('error' in out) return bad(out.error);
  const existing = await db.select({ inputJson: task.inputJson }).from(task).where(eq(task.workstationId, wsId));
  const known = new Set(existing.map((t) => (JSON.parse(t.inputJson ?? '{}') as { issue_url?: string }).issue_url).filter(Boolean));
  let created = 0;
  for (const i of out.issues) {
    if (known.has(i.url)) continue;
    const res = await createTaskUc(actor, db, wsId, {
      title: i.title,
      intent: `${i.body.slice(0, 2000)}\n\n来源：${i.url}`.trim(),
      typeId: 'dev.issue',
      input: { kind: issueKind(i.labels), priority: 'p2', module: '.', issue_url: i.url, issue_number: i.number },
    });
    if (res.kind === 'ok') created++;
  }
  await logEvent(db, actor, 'workstation_issues_imported', 'workstation', wsId, { created, seen: out.issues.length });
  return { kind: 'ok' as const, created, skipped: out.issues.length - created };
}
