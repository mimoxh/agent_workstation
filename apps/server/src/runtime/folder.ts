import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { project, workstation } from '../db/schema.js';

const FILE_LIMIT = 60 * 1024;
const SEARCH_FILE_LIMIT = 1024 * 1024;
const SEARCH_MAX_MATCHES = 80;
const SEARCH_MAX_FILES = 5000;
const LIST_CAP = 500;
const IGNORED = new Set(['.git', 'node_modules']);

export type FolderResult = { ok: true; root: string } | { ok: false; error: string };

// 设置页 / 新建项目时校验绑定路径：必须是一个存在的绝对路径文件夹
export function checkFolder(p: string): FolderResult {
  if (!path.isAbsolute(p)) return { ok: false, error: '文件夹路径必须是绝对路径' };
  const root = path.resolve(p);
  if (!fs.existsSync(root)) return { ok: false, error: `文件夹不存在：${root}` };
  if (!fs.statSync(root).isDirectory()) return { ok: false, error: `不是文件夹：${root}` };
  return { ok: true, root };
}

async function folderRootOf(db: DB, projectId: string): Promise<FolderResult> {
  const p = (await db.select().from(project).where(eq(project.id, projectId)))[0];
  if (!p?.folderPath) return { ok: false, error: '项目还没有绑定文件夹' };
  if (!fs.existsSync(p.folderPath) || !fs.statSync(p.folderPath).isDirectory()) return { ok: false, error: `文件夹不存在：${p.folderPath}` };
  return { ok: true, root: p.folderPath };
}

// ws → project.folderPath：Agent 工具与提案审批共用这一个出口
export async function projectFolderOf(db: DB, wsId: string): Promise<FolderResult> {
  const ws = (await db.select().from(workstation).where(eq(workstation.id, wsId)))[0];
  if (!ws) return { ok: false, error: '项目还没有绑定文件夹' };
  return folderRootOf(db, ws.projectId);
}

export async function projectFolderRoot(db: DB, projectId: string): Promise<FolderResult> {
  return folderRootOf(db, projectId);
}

// 相对路径 → 根内绝对路径：挡住 ..、绝对路径、NUL，以及符号链接逃逸
export function resolveInside(root: string, rel: string, opts: { forFile?: boolean } = {}): { ok: true; abs: string; rel: string } | { ok: false; error: string } {
  const clean = String(rel).replace(/\\/g, '/').replace(/^\.?\/+/, '');
  const segments = clean.split('/').filter((s) => s !== '' && s !== '.');
  if (clean.includes('\0') || segments.includes('..') || path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) return { ok: false, error: '路径不合法' };
  if (opts.forFile && segments.length === 0) return { ok: false, error: '路径不合法' };
  const abs = path.resolve(root, ...segments);
  const rootAbs = path.resolve(root);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) return { ok: false, error: '路径不合法' };
  // 符号链接逃逸：目标或其最近的已存在祖先落回真实路径后再比
  let probe = abs;
  while (!fs.existsSync(probe) && probe !== rootAbs) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  try {
    const real = fs.realpathSync(probe);
    const realRoot = fs.realpathSync(rootAbs);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return { ok: false, error: '路径不合法' };
  } catch {
    return { ok: false, error: '路径不合法' };
  }
  return { ok: true, abs, rel: segments.join('/') };
}

export function listFolder(root: string, dir: string): { ok: true; entries: { name: string; path: string; type: 'dir' | 'file'; size: number | null }[]; truncated: boolean } | { ok: false; error: string } {
  const r = resolveInside(root, dir);
  if (!r.ok) return { ok: false, error: r.error };
  let st: fs.Stats;
  try {
    st = fs.statSync(r.abs);
  } catch {
    return { ok: false, error: '目录不存在' };
  }
  if (!st.isDirectory()) return { ok: false, error: '不是目录' };
  const entries = fs
    .readdirSync(r.abs, { withFileTypes: true })
    .filter((d) => !IGNORED.has(d.name))
    .map((d) => {
      const rel = r.rel ? `${r.rel}/${d.name}` : d.name;
      const dir_ = d.isDirectory();
      let size: number | null = null;
      if (!dir_) {
        try {
          size = fs.statSync(path.join(r.abs, d.name)).size;
        } catch {
          size = null;
        }
      }
      return { name: d.name, path: rel, type: dir_ ? ('dir' as const) : ('file' as const), size };
    })
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
  return { ok: true, entries: entries.slice(0, LIST_CAP), truncated: entries.length > LIST_CAP };
}

const isBinary = (buf: Buffer) => buf.subarray(0, 8000).includes(0);

export function readFolderFile(root: string, rel: string): { ok: true; path: string; content: string; size: number; binary: boolean; truncated: boolean } | { ok: false; error: string } {
  const r = resolveInside(root, rel, { forFile: true });
  if (!r.ok) return { ok: false, error: r.error };
  let st: fs.Stats;
  try {
    st = fs.statSync(r.abs);
  } catch {
    return { ok: false, error: '文件不存在' };
  }
  if (!st.isFile()) return { ok: false, error: '不是文件' };
  const buf = fs.readFileSync(r.abs);
  const binary = isBinary(buf);
  const text = binary ? '' : buf.toString('utf8');
  return { ok: true, path: r.rel, content: text.slice(0, FILE_LIMIT), size: st.size, binary, truncated: text.length > FILE_LIMIT };
}

// 朴素的子串搜索：大小写敏感，跳过二进制与超大文件
export function searchFolder(root: string, query: string): { ok: true; matches: string[]; more: number } | { ok: false; error: string } {
  const matches: string[] = [];
  let extra = 0;
  let walked = 0;
  const walk = (dir: string, relBase: string): boolean => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if (IGNORED.has(d.name)) continue;
      const rel = relBase ? `${relBase}/${d.name}` : d.name;
      const abs = path.join(dir, d.name);
      if (d.isDirectory()) {
        if (!walk(abs, rel)) return false;
      } else if (d.isFile()) {
        if (++walked > SEARCH_MAX_FILES) return false;
        let st: fs.Stats;
        try {
          st = fs.statSync(abs);
        } catch {
          continue;
        }
        if (st.size > SEARCH_FILE_LIMIT) continue;
        const buf = fs.readFileSync(abs);
        if (isBinary(buf)) continue;
        const lines = buf.toString('utf8').split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (!lines[i]!.includes(query)) continue;
          if (matches.length >= SEARCH_MAX_MATCHES) extra++;
          else matches.push(`${rel}:${i + 1}: ${lines[i]!.trim().slice(0, 300)}`);
        }
      }
    }
    return true;
  };
  walk(path.resolve(root), '');
  return { ok: true, matches, more: extra };
}

export const hashContent = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
