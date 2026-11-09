import { spawn, execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { dockerBin, dockerRunArgs, sandboxGitDenied, SANDBOX_IMAGE, type SandboxConfig, type SandboxNetwork } from './sandbox.js';

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

// 包管理器的增删改依赖：add / remove / update / install <pkg>，以及 up / upgrade / rm 等别名
export function isDependencyChange(argv: string[]): boolean {
  const [cmd, sub] = argv;
  if (cmd !== 'pnpm' && cmd !== 'npm') return false;
  return ['add', 'remove', 'rm', 'uninstall', 'update', 'up', 'upgrade', 'install', 'i'].includes(sub ?? '') && !argv.includes('publish');
}

// 环境问题（命令不存在、不在白名单、cwd 不对）不是代码的错：退回实现者也修不好，应该转人
// 只看输出开头：shell 找不到命令时报错在第一行；构建 / 测试自己的 "not found" 不算
const SHELL_MISSING = /^[^\n]*(is not recognized as an internal or external command|: command not found|: not found$)/m;
export function isEnvError(res: ExecResult): boolean {
  if (res.timedOut) return false;
  if (res.exitCode === 127 || res.exitCode === 9009) return true;
  // -1：平台没能把命令跑起来（spawn 失败、白名单、cwd、命令格式），或进程被外部信号杀掉
  if (res.exitCode === -1) return true;
  return res.exitCode === 1 && SHELL_MISSING.test(res.output.trimStart().split('\n').slice(0, 2).join('\n'));
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

type Launch = { cwd: string; command: string; env?: Record<string, string> | undefined; sandbox?: SandboxConfig | undefined; network?: SandboxNetwork | undefined; publish?: string[] | undefined };

function preflight(opts: Launch): { argv: string[] } | { error: string } {
  if (!opts.cwd || !path.isAbsolute(opts.cwd)) return { error: 'cwd 缺失或不是绝对路径' };
  const argv = splitCommand(opts.command);
  if (!argv || argv.length === 0) return { error: '不支持管道/重定向/链式命令/变量展开' };
  if (!WHITELIST.has(argv[0]!)) return { error: `命令 ${argv[0]} 不在白名单` };
  if (opts.sandbox) {
    if (!SANDBOX_IMAGE.test(opts.sandbox.image)) return { error: `容器沙箱镜像名不合法：${opts.sandbox.image}` };
    if (argv[0] === 'git') {
      const denied = sandboxGitDenied(argv);
      if (denied) return { error: denied };
    }
  }
  return { argv };
}

function launch(opts: Launch, argv: string[]) {
  const detached = process.platform !== 'win32';
  if (opts.sandbox && argv[0] !== 'git') {
    const name = `aw-${crypto.randomUUID()}`;
    const uid = process.getuid?.();
    const args = dockerRunArgs({
      name, sandbox: opts.sandbox, cwd: opts.cwd, argv, env: opts.env, publish: opts.publish,
      network: opts.network ?? (isDependencyChange(argv) || argv[0] === 'npx' ? 'bridge' : 'none'),
      gitFile: existsSync(path.join(opts.cwd, '.git')),
      user: uid === undefined ? undefined : `${uid}:${process.getgid?.() ?? uid}`,
    });
    const child = spawn(dockerBin(), args, { cwd: opts.cwd, env: scrubEnv(), windowsHide: true, detached });
    return {
      child, sandboxed: true,
      // 杀 docker 客户端不会停容器，必须按名字删
      kill: () => {
        execFile(dockerBin(), ['rm', '-f', name], { windowsHide: true, timeout: 30_000 }, () => {});
        killTree(child.pid);
      },
    };
  }
  const env = scrubEnv(opts.env);
  const child = process.platform === 'win32'
    ? spawn(argv.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' '), [], { cwd: opts.cwd, env, shell: true, windowsHide: true })
    : spawn(argv[0]!, argv.slice(1), { cwd: opts.cwd, env, windowsHide: true, detached });
  return { child, sandboxed: false, kill: () => killTree(child.pid) };
}

// docker run 自身失败的退出码（守护进程 / 镜像 / 入口不可用）统一成 127，验收按环境错误处理
const dockerExit = (code: number) => ([125, 126, 127].includes(code) ? 127 : code);
const launchError = (sandboxed: boolean, e: unknown) => (sandboxed ? `容器沙箱启动失败（docker 不可用？）：${String(e)}` : String(e));

export function runCommand(opts: Launch & { timeoutSec: number; signal?: AbortSignal | undefined }): Promise<ExecResult> {
  const pre = preflight(opts);
  if ('error' in pre) return Promise.resolve({ exitCode: -1, durationMs: 0, output: pre.error, truncated: false, timedOut: false });
  const t0 = Date.now();
  return new Promise((resolve) => {
    const { child, sandboxed, kill } = launch(opts, pre.argv);
    let out = '';
    child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { out += d.toString(); });
    let killed = false;
    const stop = () => { killed = true; kill(); };
    const timer = setTimeout(stop, opts.timeoutSec * 1000);
    if (opts.signal?.aborted) stop();
    else opts.signal?.addEventListener('abort', stop, { once: true });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ exitCode: -1, durationMs: Date.now() - t0, output: launchError(sandboxed, e), truncated: false, timedOut: false });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const timedOut = killed || signal === 'SIGTERM' || signal === 'SIGKILL';
      const exitCode = code === null ? -1 : sandboxed ? dockerExit(code) : code;
      resolve({ exitCode, durationMs: Date.now() - t0, output: clip(out), truncated: out.length > OUTPUT_LIMIT, timedOut });
    });
  });
}

// 常驻进程（视觉验收用的 dev server）：同样走白名单，返回 stop；输出只留尾部用于报错
export function startBackground(opts: Launch): { ok: true; stop: () => void; tail: () => string; exited: () => number | null } | { ok: false; error: string } {
  const pre = preflight(opts);
  if ('error' in pre) return { ok: false, error: pre.error };
  // 沙箱里的服务要被宿主浏览器访问，只能走 bridge；端口只发布到回环
  const { child, sandboxed, kill } = launch({ ...opts, network: 'bridge' }, pre.argv);
  let out = '';
  let code: number | null = null;
  const keep = (d: Buffer) => { out = (out + d.toString()).slice(-4096); };
  child.stdout?.on('data', keep);
  child.stderr?.on('data', keep);
  child.on('close', (c) => { code = c ?? -1; });
  child.on('error', (e) => { out += launchError(sandboxed, e); code = -1; });
  return { ok: true, stop: kill, tail: () => out, exited: () => code };
}

function killTree(pid?: number) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true, stdio: 'ignore' });
    else process.kill(-pid, 'SIGKILL');
  } catch { /* already dead */ }
}

function clip(out: string): string {
  if (out.length <= OUTPUT_LIMIT) return out;
  return `${out.slice(0, HEAD_KEEP)}\n…[truncated ${out.length - OUTPUT_LIMIT} chars]…\n${out.slice(-TAIL_KEEP)}`;
}

export { WHITELIST, FORBIDDEN_CHARS, path };
