import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { task, workstation } from '../db/schema.js';
import { portEnv, startBackground } from './exec.js';
import { devSettings } from './git.js';
import { reachable } from './visual.js';

// 任务 worktree 的实时预览：serve 命令后台常驻，人停手 10 分钟后自动回收
interface Preview {
  proc: { stop: () => void; tail: () => string; exited: () => number | null };
  url: string;
  port: string;
  worktree: string;
  startedAt: number;
  lastSeen: number;
  status: 'starting' | 'running' | 'failed';
  error?: string;
}

const previews = new Map<string, Preview>();
const MAX_PREVIEWS = 3;
const IDLE_MS = 10 * 60 * 1000;
const SERVE_WAIT_MS = Number(process.env.AW_SERVE_WAIT_MS ?? 90_000);

const active = () => [...previews.values()].filter((p) => p.status !== 'failed');

const view = (p: Preview) => ({ status: p.status, url: p.url, ...(p.error ? { error: p.error } : {}), log: p.proc.tail().slice(-2000) });

async function pollReady(p: Preview, probeUrl: string) {
  const deadline = Date.now() + SERVE_WAIT_MS;
  while (p.status === 'starting') {
    const code = p.proc.exited();
    if (code !== null) {
      p.status = 'failed';
      p.error = `serve 进程提前退出（${code}）：\n${p.proc.tail().slice(-1000)}`;
      return;
    }
    if (await reachable(probeUrl)) {
      p.status = 'running';
      return;
    }
    if (Date.now() > deadline) {
      p.status = 'failed';
      p.error = `等待 ${probeUrl} 超时（${SERVE_WAIT_MS / 1000}s）：\n${p.proc.tail().slice(-1000)}`;
      p.proc.stop();
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

export async function startPreview(db: DB, taskId: string) {
  const t = (await db.select().from(task).where(eq(task.id, taskId)))[0];
  if (!t) return { kind: 'not_found' as const, status: 404 as const, error: '任务不存在' };
  const ws = (await db.select().from(workstation).where(eq(workstation.id, t.workstationId)))[0];
  if (!ws || ws.pluginId !== 'dev' || ws.status === 'archived') return { kind: 'error' as const, status: 400 as const, error: '只能在开发任务上预览' };
  const cur = previews.get(taskId);
  if (cur && cur.status !== 'failed') {
    cur.lastSeen = Date.now();
    return { kind: 'ok' as const, ...view(cur) };
  }
  const ref = t.codeRefJson ? (JSON.parse(t.codeRefJson) as { worktree?: string }) : null;
  if (!ref?.worktree || !fs.existsSync(ref.worktree)) return { kind: 'error' as const, status: 409 as const, error: '任务还没有工作区（开始实现后才有）' };
  const s = devSettings(ws.settingsJson);
  if (!s.commands.serve) return { kind: 'error' as const, status: 400 as const, error: '先在工作台设置里配置「视觉验收服务」命令' };
  if (active().length >= MAX_PREVIEWS) return { kind: 'error' as const, status: 409 as const, error: '同时最多 3 个预览，先停掉一个' };
  const ports = portEnv(path.basename(ref.worktree));
  const webPort = ports.AW_E2E_WEB_PORT ?? '';
  const proc = startBackground({ cwd: ref.worktree, command: s.commands.serve, env: { ...ports, PORT: webPort }, sandbox: s.sandbox, publish: [webPort] });
  if (!proc.ok) return { kind: 'error' as const, status: 400 as const, error: `serve 命令无法启动：${proc.error}` };
  const p: Preview = { proc, url: `http://localhost:${webPort}/`, port: webPort, worktree: ref.worktree, startedAt: Date.now(), lastSeen: Date.now(), status: 'starting' };
  previews.set(taskId, p);
  void pollReady(p, p.url);
  return { kind: 'ok' as const, ...view(p) };
}

export function previewStatus(taskId: string) {
  const p = previews.get(taskId);
  if (!p) return { status: 'stopped' as const };
  if (p.status === 'starting' && p.proc.exited() !== null) {
    p.status = 'failed';
    p.error = `serve 进程提前退出（${p.proc.exited()}）：\n${p.proc.tail().slice(-1000)}`;
  }
  p.lastSeen = Date.now();
  return view(p);
}

export function stopPreview(taskId: string) {
  const p = previews.get(taskId);
  if (!p) return;
  previews.delete(taskId);
  p.proc.stop();
}

// 验收要在同一个 worktree 起自己的 serve：端口槽位相同，先停预览
export function stopPreviewForWorktree(taskId: string, worktree: string) {
  if (previews.get(taskId)?.worktree === worktree) stopPreview(taskId);
}

export function stopAllPreviews() {
  for (const id of [...previews.keys()]) stopPreview(id);
}

const reaper = setInterval(() => {
  const now = Date.now();
  for (const [id, p] of previews) if (now - p.lastSeen > IDLE_MS) stopPreview(id);
}, 60_000);
reaper.unref?.();
process.on('exit', stopAllPreviews);
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, () => {
    stopAllPreviews();
    process.exit(sig === 'SIGINT' ? 130 : 143);
  });
}
