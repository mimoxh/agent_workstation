import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createDb } from '../src/db/client.js';
import { runCommand } from '../src/runtime/exec.js';
import { liveSnapshot, startLive } from '../src/runtime/live_output.js';

const uniq = () => `t-${crypto.randomUUID()}`;

describe('命令实时输出', () => {
  it('runCommand 的 onOutput 逐块收到 stdout 与 stderr', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'aw-live-'));
    writeFileSync(path.join(dir, 'out.js'), 'process.stdout.write("a");process.stderr.write("b");process.stdout.write("c")');
    const chunks: string[] = [];
    const r = await runCommand({ cwd: dir, command: 'node out.js', timeoutSec: 10, onOutput: (c) => chunks.push(c) });
    expect(r.exitCode).toBe(0);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.join('')).toContain('abc');
  });

  it('注册表：快照、每 channel 只留 5 条、文本截到 64K', () => {
    const ch = `task:${uniq()}`;
    const s = startLive(ch, 'seed');
    s.write('hello');
    s.finish(0);
    let snap = liveSnapshot(ch);
    expect(snap).toHaveLength(1);
    expect(snap[0]).toMatchObject({ label: 'seed', text: 'hello', done: true, exitCode: 0 });
    for (let i = 0; i < 6; i++) startLive(ch, `cmd${i}`).finish(i);
    snap = liveSnapshot(ch);
    expect(snap).toHaveLength(5);
    expect(snap[0]!.label).toBe('cmd1');
    const big = startLive(ch, 'big');
    big.write('x'.repeat(70 * 1024));
    big.finish(null);
    const last = liveSnapshot(ch).at(-1)!;
    expect(last.text.length).toBeLessThanOrEqual(64 * 1024);
    expect(last.exitCode).toBeNull();
    expect(liveSnapshot(`qa:${uniq()}`)).toEqual([]);
  });

  it('SSE：连接先收快照再收增量，非法 channel 返回 400', async () => {
    const app = createApp(createDb(':memory:').db).app;
    const channel = `task:${uniq()}`;
    const history = startLive(channel, 'old');
    history.write('in-snapshot');
    history.finish(0);

    const res = await app.request(`/api/live/${channel}`);
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let text = '';
    const until = async (needle: string) => {
      while (!text.includes(needle)) {
        const { value, done } = await reader.read();
        if (done) break;
        text += dec.decode(value);
      }
    };
    await until('snapshot');
    expect(text).toContain('in-snapshot');

    const live = startLive(channel, 'new-cmd');
    live.write('fresh-chunk');
    await until('fresh-chunk');
    live.finish(3);
    await until('"exitCode":3');
    expect(text).toContain('"exitCode":3');
    await reader.cancel();

    expect((await app.request('/api/live/bad:x')).status).toBe(400);
  });
});
