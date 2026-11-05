import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';

export interface ExecResult { exitCode: number; durationMs: number; output: string; truncated: boolean; timedOut: boolean }

const OUTPUT_LIMIT = 32 * 1024;
const HEAD_KEEP = 8 * 1024;
const TAIL_KEEP = 24 * 1024;

const WHITELIST = new Set(['pnpm', 'npm', 'npx', 'node', 'git', 'tsc', 'vitest', 'playwright']);
const FORBIDDEN_CHARS = /[|&;<>`$%^\\\n]/;

// 把命令切分为 argv，支持双引号
export function splitCommand(command: string): string[] | null {
  if (FORBIDDEN_CHARS.test(command)) return null;
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  for (const ch of command) {
    if (ch === '"') { inQ = !inQ; continue; }
    if (/\s/.test(ch) && !inQ) {
      if (cur) { out.push(cur); cur = ''; }
    } else cur += ch;
  }
  if (inQ) return null;
  if (cur) out.push(cur);
  return out;
}

export function isDangerous(argv: string[]): boolean {
  const [cmd, ...rest] = argv;
  if (!cmd) return false;
  if (cmd === 'npx') return true;
  if (cmd === 'node' && rest.some((a) => ['-e', '--eval', '-p'].includes(a))) return true;
  if ((cmd === 'npm' || cmd === 'pnpm')) {
    if (rest.includes('publish')) return true;
    if (['add', 'remove', 'update', 'install'].includes(rest[0] ?? '') && rest.length > 1) return true;
  }
  if (cmd === 'git') {
    if (rest.includes('push')) return true;
    if (rest.includes('reset') && rest.includes('--hard')) return true;
    if (rest.includes('clean')) return true;
    if (rest.includes('checkout') && rest.includes('--')) return true;
    if (rest.some((a) => a === '--force' || a === '-f')) return true;
  }
  return false;
}

function scrubEnv(extra?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(k)) continue;
    if (k.startsWith('AW_')) continue;
    // pnpm/npm 注入的变量会干扰子进程的工作区/过滤解析（npm_config_filter → --filter），必须剔除
    if (/^npm_|^pnpm_|^PNPM_/i.test(k) || k === 'INIT_CWD') continue;
    // GIT_CONFIG_* 是 git -c 的内部传递机制变量，残留半套（有 COUNT 无 KEY）会让子 git 报 missing config key
    if (k.startsWith('GIT_CONFIG')) continue;
    if (v !== undefined) out[k] = v;
  }
  return { ...out, ...(extra ?? {}) };
}

// 端口槽位：worktree 按短 id 分配 n，integration 用 n=0
export function portEnv(worktreeKey: string): Record<string, string> {
  let n = 0;
  if (worktreeKey !== '_integration') {
    n = (parseInt(worktreeKey.slice(0, 4), 16) % 50) + 1;
  }
  return { AW_E2E_API_PORT: String(8900 + 2 * n), AW_E2E_WEB_PORT: String(8901 + 2 * n) };
}

export function runCommand(opts: { cwd: string; command: string; timeoutSec: number; env?: Record<string, string> }): Promise<ExecResult> {
  if (!opts.cwd || !path.isAbsolute(opts.cwd)) {
    return Promise.resolve({ exitCode: -1, durationMs: 0, output: 'cwd 缺失或不是绝对路径', truncated: false, timedOut: false });
  }
  const argv = splitCommand(opts.command);
  if (!argv || argv.length === 0) {
    return Promise.resolve({ exitCode: -1, durationMs: 0, output: '不支持管道/重定向/链式命令/变量展开', truncated: false, timedOut: false });
  }
  if (!WHITELIST.has(argv[0]!)) {
    return Promise.resolve({ exitCode: -1, durationMs: 0, output: `命令 ${argv[0]} 不在白名单`, truncated: false, timedOut: false });
  }
  const isWin = process.platform === 'win32';
  const cmdLine = isWin ? `${argv.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}` : '';
  const t0 = Date.now();
  return new Promise((resolve) => {
    const env = scrubEnv(opts.env);
    const child = isWin
      ? spawn(cmdLine, [], { cwd: opts.cwd, env, shell: true, windowsHide: true })
      : spawn(argv[0]!, argv.slice(1), { cwd: opts.cwd, env, windowsHide: true });
    let out = '';
    child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { out += d.toString(); });
    let killed = false;
    const timer = setTimeout(() => { killed = true; killTree(child.pid); }, opts.timeoutSec * 1000);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ exitCode: -1, durationMs: Date.now() - t0, output: String(e), truncated: false, timedOut: false });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const timedOut = killed || signal === 'SIGTERM' || signal === 'SIGKILL';
      resolve({ exitCode: code ?? -1, durationMs: Date.now() - t0, output: clip(out), truncated: out.length > OUTPUT_LIMIT, timedOut });
    });
  });
}

function killTree(pid?: number) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true });
    else process.kill(-pid, 'SIGKILL');
  } catch { /* already dead */ }
}

function clip(out: string): string {
  if (out.length <= OUTPUT_LIMIT) return out;
  return `${out.slice(0, HEAD_KEEP)}\n…[truncated ${out.length - OUTPUT_LIMIT} chars]…\n${out.slice(-TAIL_KEEP)}`;
}

export { WHITELIST, FORBIDDEN_CHARS, path };
