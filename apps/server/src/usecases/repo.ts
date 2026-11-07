import { eq } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { workstation } from '../db/schema.js';
import { devSettings, git, type DevSettings } from '../runtime/git.js';

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

export async function listRepoFiles(db: DB, wsId: string, dir: string) {
  const r = await settingsOf(db, wsId);
  if ('error' in r) return { ref: null, entries: [], error: r.error };
  const ref = await browseRef(r.settings);
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

export async function readRepoFile(db: DB, wsId: string, filePath: string) {
  const r = await settingsOf(db, wsId);
  if ('error' in r) return { kind: 'error' as const, status: r.status, error: r.error };
  const ref = await browseRef(r.settings);
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

export async function repoStatus(db: DB, wsId: string) {
  const r = await settingsOf(db, wsId);
  if ('error' in r) return { ok: false, error: r.error, branch: null, targetExists: false, baseExists: false };
  const s = r.settings;
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
  return { ok: error === null, error, branch, targetExists, baseExists };
}
