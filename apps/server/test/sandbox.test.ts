import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Fake = EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; pid: undefined };

const cp = vi.hoisted(() => ({
  behave: (() => {}) as (c: unknown) => void,
  spawn: vi.fn(),
  execFile: vi.fn(),
}));

vi.mock('node:child_process', async (orig) => ({ ...(await orig<typeof import('node:child_process')>()), spawn: cp.spawn, execFile: cp.execFile }));

import { isEnvError, runCommand, startBackground } from '../src/runtime/exec.js';

const sandbox = { image: 'aw-runner:1' };
const dir = mkdtempSync(path.join(tmpdir(), 'aw-sandbox-'));
writeFileSync(path.join(dir, '.git'), 'gitdir: /host/repo/.git/worktrees/x\n');

const close = (code: number | null) => (c: Fake) => setImmediate(() => c.emit('close', code, null));
const lastSpawn = () => cp.spawn.mock.calls.at(-1) as [string, string[], { shell?: boolean; env: Record<string, string> }];
const flag = (args: string[], name: string) => args[args.indexOf(name) + 1];

beforeEach(() => {
  cp.spawn.mockReset();
  cp.execFile.mockReset();
  cp.behave = close(0) as (c: unknown) => void;
  cp.spawn.mockImplementation(() => {
    const c = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), pid: undefined }) as Fake;
    cp.behave(c);
    return c;
  });
});

describe('容器沙箱', () => {
  it('命令进一次性容器：不经 shell、断网、去权限、只挂 worktree、.git 只读、不带宿主环境', async () => {
    process.env.AW_SECRET_FOR_TEST = 'x';
    const r = await runCommand({ cwd: dir, command: 'pnpm test', timeoutSec: 5, env: { AW_E2E_WEB_PORT: '8901' }, sandbox });
    expect(r.exitCode).toBe(0);
    const [bin, args, opts] = lastSpawn();
    expect(bin).toBe('docker');
    expect(opts.shell).toBeUndefined();
    expect(args.slice(0, 3)).toEqual(['run', '--rm', '--init']);
    expect(flag(args, '--network')).toBe('none');
    expect(flag(args, '--cap-drop')).toBe('ALL');
    expect(flag(args, '--security-opt')).toBe('no-new-privileges');
    expect(args).toContain('--read-only');
    const mounts = args.flatMap((a, i) => (a === '-v' ? [args[i + 1]!] : []));
    expect(mounts).toEqual([`${dir}:/workspace`, `${dir}/.git:/workspace/.git:ro`]);
    expect(args).toContain('AW_E2E_WEB_PORT=8901');
    expect(args.join(' ')).not.toContain('AW_SECRET_FOR_TEST');
    expect(args.slice(-3)).toEqual(['aw-runner:1', 'pnpm', 'test']);
    delete process.env.AW_SECRET_FOR_TEST;
  });

  it('只有装依赖才联网；调用方可以显式放开（setup）', async () => {
    await runCommand({ cwd: dir, command: 'pnpm add zod', timeoutSec: 5, sandbox });
    expect(flag(lastSpawn()[1], '--network')).toBe('bridge');
    await runCommand({ cwd: dir, command: 'node build.js', timeoutSec: 5, sandbox, network: 'bridge' });
    expect(flag(lastSpawn()[1], '--network')).toBe('bridge');
  });

  it('git 留在宿主且只放行只读子命令', async () => {
    for (const command of ['git commit -m x', 'git config core.hooksPath x', 'git -c alias.x=y status', 'git push origin main', 'git diff --output=x', 'git grep -Ovim a']) {
      const r = await runCommand({ cwd: dir, command, timeoutSec: 5, sandbox });
      expect(r.exitCode, command).toBe(-1);
      expect(r.output, command).toContain('沙箱模式');
    }
    expect(cp.spawn).not.toHaveBeenCalled();
    await runCommand({ cwd: dir, command: 'git status', timeoutSec: 5, sandbox });
    expect(lastSpawn()[0]).not.toBe('docker');
  });

  it('docker 不可用时算环境错误，绝不退回宿主执行', async () => {
    cp.behave = ((c: Fake) => setImmediate(() => c.emit('error', new Error('spawn docker ENOENT')))) as (c: unknown) => void;
    const missing = await runCommand({ cwd: dir, command: 'node a.js', timeoutSec: 5, sandbox });
    expect(cp.spawn).toHaveBeenCalledTimes(1);
    expect(lastSpawn()[0]).toBe('docker');
    expect(isEnvError(missing)).toBe(true);
    expect(missing.output).toContain('容器沙箱');
    for (const code of [125, 126, 127]) {
      cp.behave = close(code) as (c: unknown) => void;
      expect(isEnvError(await runCommand({ cwd: dir, command: 'node a.js', timeoutSec: 5, sandbox })), String(code)).toBe(true);
    }
  });

  it('容器里的命令失败仍是普通失败', async () => {
    cp.behave = close(1) as (c: unknown) => void;
    const r = await runCommand({ cwd: dir, command: 'node a.js', timeoutSec: 5, sandbox });
    expect(r.exitCode).toBe(1);
    expect(isEnvError(r)).toBe(false);
  });

  it('超时删除容器，而不只是杀掉 docker 客户端', async () => {
    cp.behave = ((c: Fake) => setTimeout(() => c.emit('close', 137, null), 1300)) as (c: unknown) => void;
    const r = await runCommand({ cwd: dir, command: 'node a.js', timeoutSec: 1, sandbox });
    expect(r.timedOut).toBe(true);
    const name = flag(lastSpawn()[1], '--name');
    expect(cp.execFile.mock.calls[0]!.slice(0, 2)).toEqual(['docker', ['rm', '-f', name]]);
  });

  it('镜像名不合法时拒绝执行', async () => {
    const r = await runCommand({ cwd: dir, command: 'node a.js', timeoutSec: 5, sandbox: { image: '--privileged' } });
    expect(r.exitCode).toBe(-1);
    expect(cp.spawn).not.toHaveBeenCalled();
  });

  it('常驻服务只把端口发布到本机回环，stop 删除容器', () => {
    cp.behave = () => {};
    const p = startBackground({ cwd: dir, command: 'pnpm dev', env: { PORT: '8901' }, sandbox, publish: ['8901'] });
    expect(p.ok).toBe(true);
    const args = lastSpawn()[1];
    expect(flag(args, '-p')).toBe('127.0.0.1:8901:8901');
    expect(flag(args, '--network')).toBe('bridge');
    if (p.ok) p.stop();
    expect(cp.execFile.mock.calls[0]![1]).toEqual(['rm', '-f', flag(args, '--name')]);
  });

  it('没配镜像时行为不变', async () => {
    await runCommand({ cwd: dir, command: 'node a.js', timeoutSec: 5 });
    expect(lastSpawn()[0]).not.toBe('docker');
  });
});
