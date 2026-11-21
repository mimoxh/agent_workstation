import { execFile, spawnSync } from 'node:child_process';
import pty, { type IPty } from 'node-pty';
import { events } from '../events.js';

// 外部 harness 的终端会话：一次 run 一个 PTY，人可以随时在应用里接管输入
export interface TerminalInfo {
  id: string;
  runId: string;
  agentId: string;
  taskId: string | null;
  threadId: string | null;
  title: string;
  startedAt: string;
  alive: boolean;
  exitCode: number | null;
}

export type TerminalEvent = { type: 'data'; data: string } | { type: 'exit'; code: number | null };

interface Session extends TerminalInfo {
  pty: IPty;
  buffer: string;
  lastActive: number;
  listeners: Set<(e: TerminalEvent) => void>;
  onExit: Set<(code: number | null) => void>;
}

// 回放用的滚动历史：xterm 重连时整段重放，太大会拖慢首屏
const BUFFER_KEEP = 512 * 1024;
const sessions = new Map<string, Session>();

export function startTerminal(o: {
  id: string; runId: string; agentId: string; taskId: string | null; threadId: string | null; title: string;
  file: string; args: string[]; cwd: string; env: Record<string, string>; cols?: number; rows?: number;
}): TerminalInfo {
  const p = pty.spawn(o.file, o.args, { name: 'xterm-256color', cols: o.cols ?? 120, rows: o.rows ?? 32, cwd: o.cwd, env: o.env, useConpty: true });
  const s: Session = {
    id: o.id, runId: o.runId, agentId: o.agentId, taskId: o.taskId, threadId: o.threadId, title: o.title,
    startedAt: new Date().toISOString(), alive: true, exitCode: null,
    pty: p, buffer: '', lastActive: Date.now(), listeners: new Set(), onExit: new Set(),
  };
  sessions.set(o.id, s);
  p.onData((data) => {
    s.buffer = (s.buffer + data).slice(-BUFFER_KEEP);
    s.lastActive = Date.now();
    for (const l of s.listeners) l({ type: 'data', data });
  });
  p.onExit(({ exitCode }) => {
    if (!s.alive) return;
    s.alive = false;
    s.exitCode = exitCode;
    for (const l of s.listeners) l({ type: 'exit', code: exitCode });
    for (const f of s.onExit) f(exitCode);
    events.emit('terminal_exited', { terminalId: s.id, runId: s.runId, exitCode });
  });
  events.emit('terminal_started', { terminalId: s.id, runId: s.runId, taskId: s.taskId });
  return info(s);
}

const info = (s: Session): TerminalInfo => ({ id: s.id, runId: s.runId, agentId: s.agentId, taskId: s.taskId, threadId: s.threadId, title: s.title, startedAt: s.startedAt, alive: s.alive, exitCode: s.exitCode });

export function terminalInfo(id: string): TerminalInfo | null {
  const s = sessions.get(id);
  return s ? info(s) : null;
}

export function terminalBuffer(id: string): string | null {
  return sessions.get(id)?.buffer ?? null;
}

export function listTerminals(filter: { taskId?: string | undefined; threadId?: string | undefined; agentId?: string | undefined } = {}): TerminalInfo[] {
  return [...sessions.values()]
    .filter((s) => (!filter.taskId || s.taskId === filter.taskId) && (!filter.threadId || s.threadId === filter.threadId) && (!filter.agentId || s.agentId === filter.agentId))
    .map(info);
}

export function writeTerminal(id: string, data: string) {
  const s = sessions.get(id);
  if (!s?.alive) return false;
  s.lastActive = Date.now();
  s.pty.write(data);
  return true;
}

export function resizeTerminal(id: string, cols: number, rows: number) {
  const s = sessions.get(id);
  if (!s?.alive || cols < 2 || rows < 2) return;
  try { s.pty.resize(Math.min(cols, 500), Math.min(rows, 200)); } catch { /* exited between check and resize */ }
}

export function subscribeTerminal(id: string, fn: (e: TerminalEvent) => void): () => void {
  const s = sessions.get(id);
  if (!s) return () => {};
  s.listeners.add(fn);
  return () => { s.listeners.delete(fn); };
}

export function onTerminalExit(id: string, fn: (code: number | null) => void): () => void {
  const s = sessions.get(id);
  if (!s) return () => {};
  if (!s.alive) {
    fn(s.exitCode);
    return () => {};
  }
  s.onExit.add(fn);
  return () => { s.onExit.delete(fn); };
}

// ConPTY 的 kill 只结束根进程，harness 起的子进程（MCP、shell、构建）会留下：Windows 上先按进程树杀
const WIN = process.platform === 'win32';
const closePty = (s: Session) => { try { s.pty.kill(); } catch { /* already gone */ } };

export function killTerminal(id: string) {
  const s = sessions.get(id);
  if (!s?.alive) return false;
  if (WIN) execFile('taskkill', ['/pid', String(s.pty.pid), '/T', '/F'], { windowsHide: true }, () => closePty(s));
  else closePty(s);
  // node-pty 在 Windows 上 kill 后不一定回调 onExit：这里补齐收尾
  setTimeout(() => {
    if (!s.alive) return;
    s.alive = false;
    for (const l of s.listeners) l({ type: 'exit', code: null });
    for (const f of s.onExit) f(null);
    events.emit('terminal_exited', { terminalId: s.id, runId: s.runId, exitCode: null });
  }, 1500).unref?.();
  return true;
}

export function killTerminalsWhere(match: (t: TerminalInfo) => boolean) {
  let n = 0;
  for (const s of sessions.values()) if (s.alive && match(info(s)) && killTerminal(s.id)) n += 1;
  return n;
}

// 已结束的会话只留历史供回放；超过上限按启动时间淘汰最早的
const MAX_DEAD = 50;
export function pruneTerminals() {
  const dead = [...sessions.values()].filter((s) => !s.alive).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  for (const s of dead.slice(0, Math.max(0, dead.length - MAX_DEAD))) sessions.delete(s.id);
}

// 空闲回收：回合已经结束、长时间没人动的会话
export function reapIdleTerminals(idleMs: number, isDone: (t: TerminalInfo) => boolean) {
  const cutoff = Date.now() - idleMs;
  for (const s of sessions.values()) if (s.alive && s.lastActive < cutoff && isDone(info(s))) killTerminal(s.id);
  pruneTerminals();
}

export function killAllTerminals() {
  for (const s of sessions.values()) {
    if (!s.alive) continue;
    if (WIN) spawnSync('taskkill', ['/pid', String(s.pty.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 });
    closePty(s);
  }
}
