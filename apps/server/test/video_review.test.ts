import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { and, eq } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createDb, migrateDb, type DB } from '../src/db/client.js';
import { seed } from '../src/db/seed.js';
import { agent, artifact, message, videoRender, workstation } from '../src/db/schema.js';
import { loadPlugins } from '../src/plugins.js';
import { writeModelConfig } from '../src/runtime/config.js';
import { ffmpegAvailable, ffmpegBin } from '../src/runtime/media/ffmpeg.js';
import { mediaDir } from '../src/runtime/media/storage.js';
import { writeWav } from '../src/runtime/media/wav.js';
import { loadModels } from '../src/runtime/models.js';
import { executeTool, type RunCtx } from '../src/runtime/tools/index.js';
import { renderCounters, videoRenderIdle } from '../src/runtime/video_render.js';
import { buildPermCtx, createVideo, getVideo, mountWorkstation, renderableShot, replaceStoryboard, saveScript, saveVideoReview, updateShot } from '../src/usecases/index.js';
import { wsThreadOf } from '../src/usecases/threads.js';

const HUMAN = { type: 'human', id: 'local' } as const;

let db: DB;
let app: ReturnType<typeof createApp>['app'];
let wsId: string;

const req = (method: string, p: string, body?: unknown) =>
  app.request(p, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const json = async <T = Record<string, unknown>>(r: Response | Promise<Response>) => (await (await r).json()) as T & { error?: string };
const upload = (name: string, bytes: Uint8Array) => {
  const fd = new FormData();
  fd.append('file', new File([new Uint8Array(bytes)], name));
  return app.request(`/api/workstations/${wsId}/media`, { method: 'POST', body: fd });
};

const HAS_CHROMIUM = await chromium.launch().then(async (b) => { await b.close(); return true; }).catch(() => false);
const CAN_RENDER = HAS_CHROMIUM && ffmpegAvailable();

const html = (label: string, color = '#246') => `<!doctype html><html><head><style>body{margin:0;background:${color}}h1{position:absolute;top:200px;left:40px;color:#fff;font:700 48px sans-serif;animation:m 1s linear both}@keyframes m{from{opacity:.2}to{opacity:1}}</style></head><body><h1>${label}</h1></body></html>`;
const overflow = '<!doctype html><html><head><style>body{margin:0;background:#123}h1{position:absolute;left:900px;top:100px;margin:0;color:#fff;font:700 120px sans-serif;white-space:nowrap}</style></head><body><h1>这一行标题太长了会超出画面</h1></body></html>';

async function newVideo(shots: Parameters<typeof replaceStoryboard>[4]['shots'], extra: Record<string, unknown> = {}) {
  const r = await createVideo(HUMAN, db, wsId, { title: '审片测试', resolution: '720p', fps: 24, ...extra });
  if (r.kind !== 'ok') throw new Error(r.error);
  const sb = await replaceStoryboard(HUMAN, db, wsId, r.id, { shots });
  if (sb.kind !== 'ok') throw new Error(sb.error);
  return { id: r.id, shots: sb.shots.map((s) => s.id) };
}

const agentOf = async (tpl: string) => (await db.select().from(agent).where(and(eq(agent.workstationId, wsId), eq(agent.templateId, tpl))))[0]!;
async function call(tpl: string, name: string, args: Record<string, unknown>) {
  const a = await agentOf(tpl);
  const actor = { type: 'agent', id: a.id } as const;
  const ctx: RunCtx = { db, actor, permCtx: await buildPermCtx(actor, db), agent: a, task: null, run: { id: 'r' } as never };
  return (await executeTool(ctx, name, args)) as Record<string, unknown> & { error?: string };
}

const video = async (id: string) => (await getVideo(db, wsId, id, { includeHtml: false }))!;
const check = async (id: string, gate: string) => (await video(id)).gate.checks.find((c) => c.id === gate)!;

// 低频正弦当背景音乐（110Hz）：和 mock 配音（440Hz）分得开，低通后只剩音乐
function bgmWav(seconds: number, amp = 0.5, rate = 48000) {
  const n = Math.round(seconds * rate);
  const s = new Int16Array(n);
  for (let i = 0; i < n; i++) s[i] = Math.round(Math.sin((2 * Math.PI * 110 * i) / rate) * amp * 32767);
  return new Uint8Array(writeWav(s, rate));
}

// 一段时间里低频（背景音乐）的 RMS，dB
function bassRms(file: string, start: number, dur: number): number {
  const r = spawnSync(ffmpegBin(), ['-hide_banner', '-nostats', '-ss', String(start), '-t', String(dur), '-i', file, '-vn', '-af', 'lowpass=f=200,lowpass=f=200,astats=metadata=0', '-f', 'null', '-'], { encoding: 'utf8', windowsHide: true });
  const text = r.stderr.slice(r.stderr.lastIndexOf('Overall'));
  const m = /RMS level dB:\s*(-?[\d.]+|-inf)/.exec(text);
  if (!m) throw new Error(`astats 没有输出：${r.stderr.slice(-400)}`);
  return m[1] === '-inf' ? -Infinity : Number(m[1]);
}

const sha = (f: string) => createHash('sha256').update(fs.readFileSync(f)).digest('hex');

beforeEach(async () => {
  process.env.AW_ENABLE_MOCK = '1';
  process.env.AW_DEFAULT_MODEL = 'mock:scripted';
  writeModelConfig({ providers: [], chain: [], prices: {} });
  loadPlugins();
  const r = createDb(':memory:');
  db = r.db;
  migrateDb(r.sqlite);
  await seed(db);
  app = createApp(db).app;
  const rootId = (await db.select().from(workstation).where(eq(workstation.pluginId, 'pm')))[0]!.id;
  const m = await mountWorkstation(HUMAN, db, { projectId: 'proj-aw', parentId: rootId, pluginId: 'video', name: '视频' });
  if (m.kind !== 'ok') throw new Error(m.error);
  wsId = m.id;
  await loadModels();
});

afterEach(async () => {
  await videoRenderIdle();
  delete process.env.AW_RENDER_CONCURRENCY;
});

describe('审片与状态', () => {
  it('内容哈希：改讲解稿不变，改旁白会变；拿旧哈希保存结论 409，用新哈希通过后 approved', async () => {
    const v = await newVideo([{ title: '一', narration: '第一句。', html: html('一') }, { title: '二', narration: '第二句。', html: html('二'), transition: 'fade' }]);
    const h0 = (await video(v.id)).contentHash;
    expect(h0).toMatch(/^[0-9a-f]{64}$/);
    await saveScript(HUMAN, db, wsId, v.id, { script: '# 新稿' });
    expect((await video(v.id)).contentHash).toBe(h0);
    await updateShot(HUMAN, db, wsId, v.shots[0]!, { narration: '第一句改了。' });
    const h1 = (await video(v.id)).contentHash;
    expect(h1).not.toBe(h0);
    const stale = await call('video-reviewer', 'save_video_review', { id: v.id, contentHash: h0, verdict: 'pass', summary: '好' });
    expect(stale.error).toContain('重新 read_video');
    expect((await video(v.id)).status).toBe('storyboarded');
    const read = await call('video-reviewer', 'read_video', { id: v.id });
    expect(read.contentHash).toBe(h1);
    const ok = await call('video-reviewer', 'save_video_review', { id: v.id, contentHash: h1, verdict: 'pass', summary: '画面和旁白一致' });
    expect(ok).toMatchObject({ verdict: 'pass', status: 'approved' });
    const after = await video(v.id);
    expect(after.review).toMatchObject({ verdict: 'pass', contentHash: h1 });
    expect(after.reviewFresh).toBe(true);
    expect(after.gate.checks.find((c) => c.id === 'review')!.ok).toBe(true);
  });

  it('请求审片：状态审片中并 @ 审片；内容一改回到 storyboarded；通过后再改，审片作废', async () => {
    const v = await newVideo([{ title: '一', narration: '你好。', html: html('一') }]);
    const r = await req('POST', `/api/videos/${v.id}/request-review`, { note: '重点看字号' });
    expect(r.status).toBe(200);
    expect((await video(v.id)).status).toBe('reviewing');
    const th = await wsThreadOf(db, wsId);
    const msgs = await db.select().from(message).where(eq(message.threadId, th.id));
    expect(msgs.some((m) => !!m.content?.startsWith('@审片 ') && !!m.content?.includes(`video: ${v.id}`) && !!m.content?.includes('重点看字号'))).toBe(true);
    await updateShot(HUMAN, db, wsId, v.shots[0]!, { html: html('一改') });
    expect((await video(v.id)).status).toBe('storyboarded');

    const cur = await video(v.id);
    expect((await saveVideoReview(HUMAN, db, wsId, { id: v.id, contentHash: cur.contentHash, verdict: 'pass', summary: 'ok' })).kind).toBe('ok');
    expect((await video(v.id)).status).toBe('approved');
    await updateShot(HUMAN, db, wsId, v.shots[0]!, { duration: 3 });
    const edited = await video(v.id);
    expect(edited.status).toBe('storyboarded');
    expect(edited.reviewFresh).toBe(false);
    expect(edited.gate.checks.find((c) => c.id === 'review')!.detail).toContain('重新审片');

    const fail = await saveVideoReview(HUMAN, db, wsId, { id: v.id, contentHash: edited.contentHash, verdict: 'fail', summary: '不行' });
    expect(fail).toMatchObject({ kind: 'ok', status: 'storyboarded' });
  });

  it('评论：钉在镜头和时间点上（可带元素）；阻断评论挡门禁，解决后放行；删镜头连评论一起删', async () => {
    const v = await newVideo([{ title: '一', narration: '你好。', html: html('一'), duration: 3 }, { title: '二', html: html('二'), duration: 2 }]);
    const bad = await req('POST', `/api/videos/${v.id}/comments`, { shot: v.shots[0], body: 'x', selector: 'h1[onclick=alert(1)]' });
    expect(bad.status).toBe(400);
    expect((await req('POST', `/api/videos/${v.id}/comments`, { shot: 'nope', body: 'x' })).status).toBe(404);
    const c1 = await json<{ id: string; time: number; version: number }>(req('POST', `/api/videos/${v.id}/comments`, { shot: v.shots[0], time: 99, body: '标题太小', severity: 'block', selector: 'body > h1:nth-child(1)', anchor: '一' }));
    expect(c1.time).toBe(3);
    expect(c1.version).toBe(1);
    expect((await check(v.id, 'comments')).ok).toBe(false);
    const listed = await json<{ comments: { id: string; selector: string; status: string; by: { type: string } }[] }>(req('GET', `/api/videos/${v.id}/comments`));
    expect(listed.comments[0]).toMatchObject({ id: c1.id, selector: 'body > h1:nth-child(1)', status: 'open', by: { type: 'human' } });
    expect((await video(v.id)).shots[0]!.comments).toEqual({ open: 1, block: 1 });

    const res = await call('video-director', 'resolve_shot_comments', { ids: [c1.id], note: '字号加大到 96px' });
    expect(res.resolved).toBe(1);
    expect((await check(v.id, 'comments')).ok).toBe(true);
    const after = await json<{ comments: { status: string; note: string }[] }>(req('GET', `/api/videos/${v.id}/comments`));
    expect(after.comments[0]).toMatchObject({ status: 'resolved', note: '字号加大到 96px' });

    const c2 = await call('video-reviewer', 'comment_shot', { shotId: v.shots[1], time: 1, body: '这里空了', severity: 'block' });
    expect(c2.error).toBeUndefined();
    expect((await check(v.id, 'comments')).ok).toBe(false);
    await replaceStoryboard(HUMAN, db, wsId, v.id, { shots: [{ id: v.shots[0] }] });
    const left = await json<{ comments: { id: string }[] }>(req('GET', `/api/videos/${v.id}/comments`));
    expect(left.comments.map((c) => c.id)).toEqual([c1.id]);
    expect((await check(v.id, 'comments')).ok).toBe(true);
  });

  it('门禁：Agent 出片被拦（没有越过的口子）；人不填原因 409，填原因放行并留痕', async () => {
    const v = await newVideo([{ title: '一', narration: '门禁测试。', html: html('一'), duration: 1 }]);
    const denied = await call('video-director', 'render_video', { videoId: v.id });
    expect(denied.error).toContain('门禁');
    const human = await req('POST', `/api/videos/${v.id}/renders`, {});
    expect(human.status).toBe(409);
    expect((await json(human)).error).toContain('请填写原因');
    if (!CAN_RENDER) return;
    const ok = await req('POST', `/api/videos/${v.id}/renders`, { override: '客户急要' });
    expect(ok.status).toBe(201);
    const created = await json<{ id: string; override: { reason: string; failed: string[] } }>(ok);
    expect(created.override.reason).toBe('客户急要');
    expect(created.override.failed.join()).toContain('还没有审片结论');
    const row = (await db.select().from(videoRender).where(eq(videoRender.id, created.id)))[0]!;
    expect(JSON.parse(row.settingsJson).override.reason).toBe('客户急要');
    await videoRenderIdle();
    expect((await video(v.id)).status).toBe('storyboarded');
  }, 60_000);
});

describe('风格', () => {
  it('调色板注入成镜头的 CSS 变量；改风格让审片作废；非法值 400；风格里关掉配音后门禁不要求配音', async () => {
    const v = await newVideo([{ title: '一', narration: '你好。', html: html('一') }]);
    const cur = await video(v.id);
    await saveVideoReview(HUMAN, db, wsId, { id: v.id, contentHash: cur.contentHash, verdict: 'pass', summary: 'ok' });
    expect((await video(v.id)).status).toBe('approved');
    expect((await renderableShot(db, v.shots[0]!))!.doc).not.toContain('data-aw-style');

    const put = await req('PUT', `/api/workstations/${wsId}/video-style`, { palette: { accent: '#ff3300' }, fonts: { heading: 'Georgia' }, subtitle: { size: 'l', background: 'shadow' } });
    expect(put.status).toBe(200);
    const doc = (await renderableShot(db, v.shots[0]!))!.doc;
    expect(doc).toContain('--aw-accent:#ff3300');
    expect(doc).toContain('--aw-font-heading:Georgia, ');
    const after = await video(v.id);
    expect(after.contentHash).not.toBe(cur.contentHash);
    expect(after.status).toBe('storyboarded');

    expect((await req('PUT', `/api/workstations/${wsId}/video-style`, { palette: { bg: 'red;}body{display:none' } })).status).toBe(400);
    expect((await req('PUT', `/api/workstations/${wsId}/video-style`, { bgm: 'nope' })).status).toBe(400);
    const style = await json<{ palette: Record<string, string>; subtitle: { size: string }; bgmVolume: number; ducking: boolean }>(req('GET', `/api/workstations/${wsId}/video-style`));
    expect(style).toMatchObject({ palette: { accent: '#ff3300' }, subtitle: { size: 'l' }, bgmVolume: 0.15, ducking: true });
    const read = await call('motion-designer', 'read_video_style', {});
    expect((read.cssVars as Record<string, string>)['--aw-accent']).toBe('#ff3300');

    expect((await check(v.id, 'voice')).ok).toBe(false);
    await call('video-director', 'update_video_style', { voice: { off: true } });
    const off = await video(v.id);
    expect(off.voiceOn).toBe(false);
    expect(off.gate.checks.find((c) => c.id === 'voice')!.ok).toBe(true);
  });

  it('背景音乐上传：只收 mp3/wav/m4a/ogg，文件头要对得上，30MB 以内；列得出来，能设进风格', async () => {
    expect((await upload('a.txt', new TextEncoder().encode('hello world!'))).status).toBe(400);
    const wav = bgmWav(1.5);
    const mismatch = await upload('a.mp3', wav);
    expect(mismatch.status).toBe(400);
    expect((await json(mismatch)).error).toContain('不一致');
    expect((await upload('empty.wav', new Uint8Array())).status).toBe(400);
    expect((await upload('noise.ogg', new Uint8Array(64).fill(7))).status).toBe(400);
    const big = new Uint8Array(30 * 1024 * 1024 + 10);
    big.set(wav.subarray(0, 44));
    expect((await upload('big.wav', big)).status).toBe(413);
    if (!ffmpegAvailable()) return;
    const ok = await upload('背景 音乐.wav', wav);
    expect(ok.status).toBe(201);
    const m = await json<{ id: string; duration: number; format: string }>(ok);
    expect(m.format).toBe('wav');
    expect(m.duration).toBeCloseTo(1.5, 1);
    const a = (await db.select().from(artifact).where(eq(artifact.id, m.id)))[0]!;
    expect(a.type).toBe('audio');
    expect(JSON.parse(a.metaJson!).kind).toBe('bgm');
    expect(path.dirname(a.ref!)).toBe(mediaDir(db, 'bgm'));
    expect((await req('GET', `/api/media/${m.id}`)).headers.get('content-type')).toBe('audio/wav');
    const list = await json<{ media: { id: string; name: string }[] }>(req('GET', `/api/workstations/${wsId}/media`));
    expect(list.media).toEqual([expect.objectContaining({ id: m.id, name: '背景 音乐' })]);
    const put = await json<{ bgm: string }>(req('PUT', `/api/workstations/${wsId}/video-style`, { bgm: m.id, bgmVolume: 0.2 }));
    expect(put.bgm).toBe(m.id);
  });
});

describe.skipIf(!CAN_RENDER)('出片：背景音乐、画面问题、并行', () => {
  it('背景音乐循环铺满全片；说话时被压低（ducking），关掉压低时不压', async () => {
    const m = await json<{ id: string }>(upload('bgm.wav', bgmWav(1.5)));
    await req('PUT', `/api/workstations/${wsId}/video-style`, { bgm: m.id, bgmVolume: 0.3, ducking: true });
    const v = await newVideo([
      { title: '说话', narration: '这是一段专门用来测试背景音乐压低效果的旁白文字。', html: html('说话'), duration: 3.5 },
      { title: '安静', html: html('安静', '#333'), duration: 3.5 },
    ]);
    await req('POST', `/api/videos/${v.id}/voice`, {});
    const render = async () => {
      const r = await json<{ id: string; error?: string }>(req('POST', `/api/videos/${v.id}/renders`, { subtitles: 'off', override: '测试背景音乐' }));
      expect(r.error).toBeUndefined();
      await videoRenderIdle();
      const view = await json<{ status: string; error: string | null; bgm: { ducking: boolean } | null; output: { artifactId: string } }>(req('GET', `/api/video-renders/${r.id}`));
      expect(view.error).toBeNull();
      expect(view.status).toBe('succeeded');
      return { file: (await db.select().from(artifact).where(eq(artifact.id, view.output.artifactId)))[0]!.ref!, bgm: view.bgm };
    };
    const ducked = await render();
    expect(ducked.bgm).toMatchObject({ ducking: true });
    const talk = bassRms(ducked.file, 1.2, 1.6);
    const quiet = bassRms(ducked.file, 4.2, 1.6);
    expect(quiet).toBeGreaterThan(-30);
    expect(quiet - talk).toBeGreaterThan(4);

    await req('PUT', `/api/workstations/${wsId}/video-style`, { ducking: false });
    const flat = await render();
    expect(Math.abs(bassRms(flat.file, 1.2, 1.6) - bassRms(flat.file, 4.2, 1.6))).toBeLessThan(1.5);
  }, 120_000);

  it('画面问题：溢出的文字进出片 warnings（带镜头）和 Shot.issues；view_shot 也会记', async () => {
    const v = await newVideo([{ title: '溢出', html: overflow, duration: 1 }, { title: '正常', html: html('正常'), duration: 1 }]);
    const view = await call('motion-designer', 'view_shot', { id: v.shots[0], times: [0.5] });
    expect((view.issues as string[]).some((i) => i.includes('文字超出画面'))).toBe(true);
    const shot0 = (await video(v.id)).shots[0]!;
    expect(shot0.issues.some((i) => i.includes('文字超出画面'))).toBe(true);

    const r = await json<{ id: string }>(req('POST', `/api/videos/${v.id}/renders`, { subtitles: 'off', override: '测试' }));
    await videoRenderIdle();
    const out = await json<{ status: string; warnings: string[]; shotIssues: { shotId: string; items: string[] }[] }>(req('GET', `/api/video-renders/${r.id}`));
    expect(out.status).toBe('succeeded');
    expect(out.warnings.some((w) => w.startsWith('镜头 1「溢出」：文字超出画面'))).toBe(true);
    expect(out.warnings.some((w) => w.includes('「正常」'))).toBe(false);
    expect(out.shotIssues.map((x) => x.shotId)).toEqual([v.shots[0]]);

    // 片段复用时问题从缓存旁的记录里读回来
    const again = await json<{ id: string }>(req('POST', `/api/videos/${v.id}/renders`, { subtitles: 'off', override: '测试' }));
    await videoRenderIdle();
    expect((await json<{ warnings: string[] }>(req('GET', `/api/video-renders/${again.id}`))).warnings.some((w) => w.includes('文字超出画面'))).toBe(true);
  }, 120_000);

  it('并行渲染：多个镜头同时渲染、共用一个浏览器；片段和串行渲染逐字节一致', async () => {
    const v = await newVideo([
      { title: '一', html: html('一'), duration: 1 },
      { title: '二', html: html('二', '#462'), duration: 1, transition: 'fade' },
      { title: '三', html: html('三', '#624'), duration: 1 },
    ], { title: `并行 ${crypto.randomUUID()}` });
    process.env.AW_RENDER_CONCURRENCY = '3';
    renderCounters.peak = 0;
    const before = { ...renderCounters };
    const cache = mediaDir(db, 'cache');
    const existing = new Set(fs.readdirSync(cache));
    const r1 = await json<{ id: string }>(req('POST', `/api/videos/${v.id}/renders`, { subtitles: 'burn', override: '测试' }));
    await videoRenderIdle();
    expect((await json<{ status: string }>(req('GET', `/api/video-renders/${r1.id}`))).status).toBe('succeeded');
    expect(renderCounters.browsers - before.browsers).toBe(1);
    expect(renderCounters.sessions - before.sessions).toBe(3);
    expect(renderCounters.peak).toBeGreaterThanOrEqual(2);
    const made = fs.readdirSync(cache).filter((f) => f.endsWith('.mp4') && !existing.has(f));
    expect(made).toHaveLength(3);
    const parallel = Object.fromEntries(made.map((f) => [f, sha(path.join(cache, f))]));

    for (const f of made) fs.rmSync(path.join(cache, f));
    process.env.AW_RENDER_CONCURRENCY = '1';
    renderCounters.peak = 0;
    const r2 = await json<{ id: string }>(req('POST', `/api/videos/${v.id}/renders`, { subtitles: 'burn', override: '测试' }));
    await videoRenderIdle();
    expect((await json<{ status: string }>(req('GET', `/api/video-renders/${r2.id}`))).status).toBe('succeeded');
    expect(renderCounters.peak).toBe(1);
    expect(Object.fromEntries(made.map((f) => [f, sha(path.join(cache, f))]))).toEqual(parallel);

    const mid = { ...renderCounters };
    await json(req('POST', `/api/videos/${v.id}/renders`, { subtitles: 'burn', override: '测试' }));
    await videoRenderIdle();
    expect(renderCounters.reused - mid.reused).toBe(3);
    expect(renderCounters.browsers).toBe(mid.browsers);
  }, 180_000);
});
