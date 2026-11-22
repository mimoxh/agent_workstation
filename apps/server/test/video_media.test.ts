import { and, eq } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createDb, migrateDb, type DB } from '../src/db/client.js';
import { seed } from '../src/db/seed.js';
import { agent, artifact, message, run, videoRender, workstation } from '../src/db/schema.js';
import { loadPlugins } from '../src/plugins.js';
import { writeModelConfig } from '../src/runtime/config.js';
import { ffmpegAvailable, ffprobe } from '../src/runtime/media/ffmpeg.js';
import { mediaDir, parseRange } from '../src/runtime/media/storage.js';
import { loadModels } from '../src/runtime/models.js';
import { executeTool, type RunCtx } from '../src/runtime/tools/index.js';
import { recoverVideoRenders, renderCounters, videoRenderIdle } from '../src/runtime/video_render.js';
import { buildPermCtx, createVideo, getVideo, mountWorkstation, replaceStoryboard, saveVideoReview, updateShot } from '../src/usecases/index.js';
import { wsThreadOf } from '../src/usecases/threads.js';

const HUMAN = { type: 'human', id: 'local' } as const;

let db: DB;
let app: ReturnType<typeof createApp>['app'];
let wsId: string;

const req = (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) =>
  app.request(p, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const json = async <T = Record<string, unknown>>(r: Response | Promise<Response>) => (await (await r).json()) as T & { error?: string };

const HAS_CHROMIUM = await chromium.launch().then(async (b) => { await b.close(); return true; }).catch(() => false);
const CAN_RENDER = HAS_CHROMIUM && ffmpegAvailable();
if (!CAN_RENDER) console.log('[video_media.test] 没有 ffmpeg 或 Chromium，出片用例跳过');

const html = (label: string, color = '#246') => `<!doctype html><html><head><style>body{margin:0;background:${color}}#b{position:absolute;left:40px;top:60px;width:120px;height:120px;background:#fc3;animation:m 2s linear forwards}@keyframes m{to{transform:translateX(600px)}}h1{position:absolute;top:300px;left:40px;color:#fff;font:700 48px sans-serif}</style></head><body><div id="b"></div><h1>${label}</h1></body></html>`;

async function newVideo(shots: Parameters<typeof replaceStoryboard>[4]['shots'], extra: Record<string, unknown> = {}) {
  const r = await createVideo(HUMAN, db, wsId, { title: '出片测试', resolution: '720p', ...extra });
  if (r.kind !== 'ok') throw new Error(r.error);
  const sb = await replaceStoryboard(HUMAN, db, wsId, r.id, { shots });
  if (sb.kind !== 'ok') throw new Error(sb.error);
  return { id: r.id, shots: sb.shots.map((s) => s.id) };
}

const director = async () => (await db.select().from(agent).where(and(eq(agent.workstationId, wsId), eq(agent.templateId, 'video-director'))))[0]!;
async function call(name: string, args: Record<string, unknown>) {
  const a = await director();
  const actor = { type: 'agent', id: a.id } as const;
  const ctx: RunCtx = { db, actor, permCtx: await buildPermCtx(actor, db), agent: a, task: null, run: { id: 'r' } as never };
  return (await executeTool(ctx, name, args)) as Record<string, unknown> & { error?: string };
}

// 配音 + 审片通过：出片门禁四项都过
async function approve(videoId: string) {
  await req('POST', `/api/videos/${videoId}/voice`, {});
  const v = (await getVideo(db, wsId, videoId, { includeHtml: false }))!;
  const r = await saveVideoReview(HUMAN, db, wsId, { id: videoId, contentHash: v.contentHash, verdict: 'pass', summary: '测试通过' });
  if (r.kind !== 'ok') throw new Error(r.error);
  return r;
}

const setBudget = async (costMicros: number) => {
  const ws = (await db.select().from(workstation).where(eq(workstation.id, wsId)))[0]!;
  await db.update(workstation).set({ settingsJson: JSON.stringify({ ...JSON.parse(ws.settingsJson ?? '{}'), budget: { costMicros } }) }).where(eq(workstation.id, wsId));
};

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
});

describe('配音', () => {
  it('mock 配音：没旁白跳过；配过的不重配；改旁白后过期只重配那一个；force 全部重配；时长跟配音走', async () => {
    const v = await newVideo([{ title: 'A', narration: '第一句旁白，大家好。' }, { title: 'B', narration: '第二句。', duration: 5 }, { title: 'C' }]);
    const r1 = await json<{ voiced: { shotId: string; duration: number }[]; skipped: { reason: string }[]; provider: string }>(req('POST', `/api/videos/${v.id}/voice`, {}));
    expect(r1.error).toBeUndefined();
    expect(r1.provider).toBe('mock');
    expect(r1.voiced).toHaveLength(2);
    expect(r1.skipped).toEqual([{ shotId: v.shots[2], reason: 'no_narration' }]);
    let d = (await getVideo(db, wsId, v.id))!;
    const a = d.shots[0]!;
    expect(a.audio).toMatchObject({ state: 'fresh', format: 'wav', provider: 'mock' });
    expect(a.durationSource).toBe('audio');
    expect(a.duration).toBe(Math.ceil((a.audio!.duration + 0.3) * 10) / 10);
    expect(d.shots[1]).toMatchObject({ duration: 5, durationSource: 'set' });

    const r2 = await json<{ voiced: unknown[]; skipped: { reason: string }[] }>(req('POST', `/api/videos/${v.id}/voice`, {}));
    expect(r2.voiced).toHaveLength(0);
    expect(r2.skipped.filter((s) => s.reason === 'fresh')).toHaveLength(2);

    await updateShot(HUMAN, db, wsId, v.shots[0]!, { narration: '改过的旁白，长一点点，再长一点点。' });
    d = (await getVideo(db, wsId, v.id))!;
    expect(d.shots[0]!.audio?.state).toBe('stale');
    expect(d.shots[0]!.durationSource).toBe('estimate');
    expect(d.lint.some((l) => l.rule === 'audio_stale')).toBe(true);
    const r3 = await json<{ voiced: { shotId: string }[] }>(req('POST', `/api/videos/${v.id}/voice`, {}));
    expect(r3.voiced.map((x) => x.shotId)).toEqual([v.shots[0]]);

    const r4 = await json<{ voiced: unknown[] }>(req('POST', `/api/videos/${v.id}/voice`, { force: true }));
    expect(r4.voiced).toHaveLength(2);

    // 换音色 = 全部过期
    await req('PATCH', `/api/videos/${v.id}`, { voice: { voice: 'other', speed: 1.5 }, baseVersion: d.latestVersion });
    d = (await getVideo(db, wsId, v.id))!;
    expect(d.shots.filter((s) => s.audio?.state === 'stale')).toHaveLength(2);
    expect(d.voice).toMatchObject({ provider: 'mock', voice: 'other', speed: 1.5 });
  });

  it('花费记成 trigger=media 的 run，挂在 steward 名下；预算用完 409 并停在当前镜头', async () => {
    writeModelConfig({ providers: [], chain: [], prices: {}, media: [{ name: 'mock', kind: 'tts', protocol: 'mock', price: { perMillionChars: 1000 } }] });
    const v = await newVideo([{ title: 'A', narration: '一二三四五' }, { title: 'B', narration: '六七八' }]);
    const r = await json<{ costMicros: number }>(req('POST', `/api/videos/${v.id}/voice`, {}));
    expect(r.costMicros).toBe(8000);
    const runs = await db.select().from(run).where(eq(run.trigger, 'media'));
    expect(runs.map((x) => x.cost).sort()).toEqual([3000, 5000]);
    expect(runs.every((x) => x.agentId === runs[0]!.agentId && x.tokensIn === 0)).toBe(true);
    const steward = (await db.select().from(agent).where(and(eq(agent.workstationId, wsId), eq(agent.isSteward, 1))))[0]!;
    expect(runs[0]!.agentId).toBe(steward.id);

    await setBudget(8000);
    const res = await req('POST', `/api/videos/${v.id}/voice`, { force: true });
    expect(res.status).toBe(409);
    expect((await json(res)).error).toContain('预算已用完');
    expect((await db.select().from(run).where(eq(run.trigger, 'media'))).length).toBe(2);
  });

  it('voice_shots 工具：Agent 发起记在自己名下', async () => {
    const v = await newVideo([{ title: 'A', narration: '你好' }]);
    const r = await call('voice_shots', { videoId: v.id });
    expect(r.error).toBeUndefined();
    expect(r.voiced as unknown[]).toHaveLength(1);
    const runs = await db.select().from(run).where(eq(run.trigger, 'media'));
    expect(runs[0]!.agentId).toBe((await director()).id);
  });

  it('设置页试听：mock 回 wav；不支持的类型 400', async () => {
    const res = await req('POST', '/api/settings/media/test', { name: 'mock', kind: 'tts', protocol: 'mock' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/wav');
    expect(Number(res.headers.get('x-aw-duration'))).toBeGreaterThan(0);
    expect(Buffer.from(await res.arrayBuffer()).subarray(0, 4).toString()).toBe('RIFF');
    expect((await req('POST', '/api/settings/media/test', { name: 'v', kind: 'video', protocol: 'mock' })).status).toBe(400);
    const s = await json<{ providers: { name: string; source: string }[]; default: string | null }>(req('GET', '/api/settings/media'));
    expect(s.providers.map((p) => p.name)).toContain('mock');
  });

  it('设置：媒体密钥只回「有没有」，留空沿用旧值；不传 media 时保留', async () => {
    const base = { providers: [], chain: [], prices: {} };
    await req('PUT', '/api/settings/models', { ...base, media: [{ name: 'tts', kind: 'tts', protocol: 'openai-speech', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'sk-secret-123' }], defaultTts: 'tts' });
    await req('PUT', '/api/settings/models', { ...base, media: [{ name: 'tts', kind: 'tts', protocol: 'openai-speech', baseUrl: 'http://127.0.0.1:9/v1' }] });
    await req('PUT', '/api/settings/models', base);
    const raw = await (await req('GET', '/api/settings/models')).text();
    expect(raw).not.toContain('sk-secret-123');
    const c = JSON.parse(raw) as { media: { name: string; hasKey: boolean }[]; defaultTts?: string };
    expect(c.media).toEqual([expect.objectContaining({ name: 'tts', hasKey: true })]);
    expect(c.defaultTts).toBe('tts');
  });
});

describe('媒体文件路由', () => {
  async function saveFile(type: string, name: string, bytes: Buffer, dir = mediaDir(db, 'audio')) {
    const file = path.join(dir, `${crypto.randomUUID()}-${name}`);
    fs.writeFileSync(file, bytes);
    const id = crypto.randomUUID();
    await db.insert(artifact).values({ id, workstationId: wsId, type, name, ref: file, metaJson: JSON.stringify({ downloadName: '成片 测试.mp4' }), createdAt: new Date().toISOString() });
    return id;
  }

  it('Range 206 / 后缀范围 / 416；download=1 带文件名；非媒体类型和媒体目录外的文件 404', async () => {
    const bytes = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));
    const id = await saveFile('video_render', 'a.mp4', bytes, mediaDir(db, 'renders'));
    const full = await req('GET', `/api/media/${id}`);
    expect(full.status).toBe(200);
    expect(full.headers.get('content-type')).toBe('video/mp4');
    expect(full.headers.get('accept-ranges')).toBe('bytes');
    expect(Buffer.from(await full.arrayBuffer()).equals(bytes)).toBe(true);

    const part = await req('GET', `/api/media/${id}`, undefined, { range: 'bytes=10-19' });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe('bytes 10-19/1000');
    expect(Buffer.from(await part.arrayBuffer()).equals(bytes.subarray(10, 20))).toBe(true);
    const tail = await req('GET', `/api/media/${id}`, undefined, { range: 'bytes=-5' });
    expect(Buffer.from(await tail.arrayBuffer()).equals(bytes.subarray(995))).toBe(true);
    const bad = await req('GET', `/api/media/${id}`, undefined, { range: 'bytes=2000-' });
    expect(bad.status).toBe(416);
    expect(bad.headers.get('content-range')).toBe('bytes */1000');

    const dl = await req('GET', `/api/media/${id}?download=1`);
    expect(dl.headers.get('content-disposition')).toBe(`attachment; filename*=UTF-8''${encodeURIComponent('成片 测试.mp4')}`);

    const shot = await saveFile('screenshot', 'x.png', bytes);
    expect((await req('GET', `/api/media/${shot}`)).status).toBe(404);
    const outside = path.join(path.dirname(mediaDir(db, 'audio')), '..', `outside-${crypto.randomUUID()}.wav`);
    fs.writeFileSync(outside, bytes);
    const oid = crypto.randomUUID();
    await db.insert(artifact).values({ id: oid, workstationId: wsId, type: 'audio', name: 'x', ref: path.join(mediaDir(db, 'audio'), '..', '..', path.basename(outside)), createdAt: new Date().toISOString() });
    expect((await req('GET', `/api/media/${oid}`)).status).toBe(404);
    fs.rmSync(outside, { force: true });
    expect((await req('GET', '/api/media/nope')).status).toBe(404);
  });

  it('parseRange 边界', () => {
    expect(parseRange(undefined, 10)).toBeNull();
    expect(parseRange('bytes=0-', 10)).toEqual([0, 9]);
    expect(parseRange('bytes=5-100', 10)).toEqual([5, 9]);
    expect(parseRange('bytes=-0', 10)).toBe('invalid');
    expect(parseRange('bytes=0-1,4-5', 10)).toBeNull();
    expect(parseRange('bytes=8-3', 10)).toBe('invalid');
  });
});

describe('出片检查', () => {
  it('缺画面 400，allowPlaceholders 放行；帧率不在 24/25/30/60 内 400；预算用完 409', async () => {
    const v = await newVideo([{ title: 'A', narration: '你好', duration: 1 }]);
    const r1 = await req('POST', `/api/videos/${v.id}/renders`, {});
    expect(r1.status).toBe(400);
    expect((await json(r1)).error).toContain('还没有画面');
    expect((await req('POST', `/api/videos/${v.id}/renders`, { fps: 29, allowPlaceholders: true })).status).toBe(400);
    await setBudget(0);
    const r2 = await req('POST', `/api/videos/${v.id}/renders`, { allowPlaceholders: true, override: '预算测试' });
    if (CAN_RENDER) {
      expect(r2.status).toBe(409);
      expect((await json(r2)).error).toContain('预算已用完');
    } else {
      expect(r2.status).toBe(409);
    }
  });

  it('重启恢复：排队中 / 渲染中的标失败', async () => {
    const v = await newVideo([{ title: 'A', html: '<p>a</p>', duration: 1 }]);
    for (const status of ['queued', 'running', 'succeeded']) {
      await db.insert(videoRender).values({ id: `r-${status}`, workstationId: wsId, videoId: v.id, videoVersion: 1, status, settingsJson: '{"shots":[]}', createdAt: new Date().toISOString() });
    }
    expect(await recoverVideoRenders(db)).toBe(2);
    const rows = await db.select().from(videoRender);
    expect(Object.fromEntries(rows.map((r) => [r.id, r.status]))).toEqual({ 'r-queued': 'failed', 'r-running': 'failed', 'r-succeeded': 'succeeded' });
    expect(rows.find((r) => r.id === 'r-running')!.error).toContain('服务重启');
    expect((await req('POST', '/api/video-renders/r-succeeded/cancel')).status).toBe(409);
  });
});

interface RenderView { id: string; status: string; progress: number; error: string | null; total: number; output: { artifactId: string; duration: number | null } | null; srt: { artifactId: string } | null; voiced: number }

describe.skipIf(!CAN_RENDER)('出片（ffmpeg + Chromium）', () => {
  it('3 个镜头 720p 各 2 秒、一个淡入：h264 1280×720 30fps + 一条 aac，时长扣掉交叠；字幕另存 srt；再出片复用片段', async () => {
    const v = await newVideo([
      { title: '一', narration: '第一镜头。', html: html('一'), duration: 2 },
      { title: '二', narration: '第二镜头。', html: html('二', '#462'), duration: 2, transition: 'fade' },
      { title: '三', narration: '第三镜头。', html: html('三', '#624'), duration: 2 },
    ]);
    await approve(v.id);
    expect((await getVideo(db, wsId, v.id))!.status).toBe('approved');
    const before = { ...renderCounters };
    const res = await req('POST', `/api/videos/${v.id}/renders`, { fps: 30, subtitles: 'burn' });
    const created = await json<{ id: string; total: number; channel: string }>(res);
    expect(res.status).toBe(201);
    expect(created.total).toBe(5.5);
    // 预览和成片同一条时间线
    expect((await getVideo(db, wsId, v.id))!.total).toBe(5.5);
    expect(created.channel).toBe(`video:${created.id}`);
    await videoRenderIdle();
    const r = await json<RenderView>(req('GET', `/api/video-renders/${created.id}`));
    expect(r.error).toBeNull();
    expect(r).toMatchObject({ status: 'succeeded', progress: 1, voiced: 3 });
    expect(renderCounters.sessions - before.sessions + renderCounters.reused - before.reused).toBe(3);

    const a = (await db.select().from(artifact).where(eq(artifact.id, r.output!.artifactId)))[0]!;
    const probe = await ffprobe(a.ref!);
    const vs = probe.streams.filter((s) => s.codec_type === 'video');
    const as = probe.streams.filter((s) => s.codec_type === 'audio');
    expect(vs).toHaveLength(1);
    expect(vs[0]).toMatchObject({ codec_name: 'h264', width: 1280, height: 720, r_frame_rate: '30/1' });
    expect(as).toHaveLength(1);
    expect(as[0]!.codec_name).toBe('aac');
    expect(Number(probe.format.duration)).toBeGreaterThan(5.4);
    expect(Number(probe.format.duration)).toBeLessThan(5.65);
    const head = fs.readFileSync(a.ref!).subarray(0, 64 * 1024).toString('latin1');
    expect(head.indexOf('moov')).toBeGreaterThan(-1);
    expect(head.indexOf('moov')).toBeLessThan(head.indexOf('mdat') === -1 ? Infinity : head.indexOf('mdat'));

    const srt = await req('GET', `/api/media/${r.srt!.artifactId}`);
    const srtText = await srt.text();
    expect(srtText).toContain('00:00:00,000 --> ');
    expect(srtText).toContain('第三镜头');
    expect((await json<{ status: string }>(req('GET', `/api/videos/${v.id}`))).status).toBe('rendered');

    const mid = { ...renderCounters };
    const again = await json<{ id: string }>(req('POST', `/api/videos/${v.id}/renders`, { fps: 30, subtitles: 'burn' }));
    await videoRenderIdle();
    expect(renderCounters.sessions).toBe(mid.sessions);
    expect(renderCounters.reused - mid.reused).toBe(3);
    expect((await json<RenderView>(req('GET', `/api/video-renders/${again.id}`))).status).toBe('succeeded');

    await updateShot(HUMAN, db, wsId, v.shots[1]!, { html: html('二改', '#264') });
    // 改了画面：审片作废，人要填原因才能越过门禁
    expect((await getVideo(db, wsId, v.id))!.status).toBe('storyboarded');
    const blocked = await req('POST', `/api/videos/${v.id}/renders`, { fps: 30, subtitles: 'burn' });
    expect(blocked.status).toBe(409);
    expect((await json(blocked)).error).toContain('重新审片');
    const third = await json<{ id: string }>(req('POST', `/api/videos/${v.id}/renders`, { fps: 30, subtitles: 'burn', override: '先给客户看个样' }));
    await videoRenderIdle();
    expect((await json<RenderView>(req('GET', `/api/video-renders/${third.id}`))).status).toBe('succeeded');
    expect((await getVideo(db, wsId, v.id))!.status).toBe('storyboarded');
    expect((await json<{ override: { reason: string } | null }>(req('GET', `/api/video-renders/${third.id}`))).override?.reason).toBe('先给客户看个样');
    const th = await wsThreadOf(db, wsId);
    const msgs = await db.select().from(message).where(eq(message.threadId, th.id));
    expect(msgs.some((m) => m.kind === 'status' && !!m.content?.includes('越过出片门禁') && !!m.content?.includes('先给客户看个样'))).toBe(true);
    // 只改了第二个镜头：只重渲它，另外两个复用
    expect(renderCounters.sessions - mid.sessions).toBe(1);
    expect(renderCounters.reused - mid.reused).toBe(5);

    const list = await json<{ renders: RenderView[] }>(req('GET', `/api/videos/${v.id}/renders`));
    expect(list.renders.map((x) => x.id)).toEqual([third.id, again.id, created.id]);
  }, 120_000);

  it('取消：渲染中途停下，状态 cancelled，不留成片', async () => {
    const v = await newVideo([{ title: '长', html: html('长', '#333'), duration: 6 }, { title: '再长', html: html('再长', '#353'), duration: 6 }]);
    const created = await json<{ id: string }>(req('POST', `/api/videos/${v.id}/renders`, { fps: 30, subtitles: 'off', override: '取消测试' }));
    await new Promise((r) => setTimeout(r, 1500));
    const c = await req('POST', `/api/video-renders/${created.id}/cancel`);
    expect(c.status).toBe(200);
    await videoRenderIdle();
    const r = await json<RenderView>(req('GET', `/api/video-renders/${created.id}`));
    expect(r.status).toBe('cancelled');
    expect(r.error).toBe('已取消');
    expect(r.output).toBeNull();
    expect(fs.existsSync(path.join(mediaDir(db, 'renders'), `${created.id}.mp4`))).toBe(false);
  }, 120_000);

  it('render_video / read_render 工具：立刻返回出片 id，之后查得到结果；srt 模式带 mov_text 字幕轨', async () => {
    const v = await newVideo([{ title: '一', narration: '工具出片。', html: html('工具'), duration: 1 }]);
    // Agent 过不了门禁就出不了片，也没有越过的参数
    const denied = await call('render_video', { videoId: v.id, fps: 24, subtitles: 'srt', override: '我想出片' });
    expect(denied.error).toContain('Agent 不能越过门禁');
    expect((denied.gate as { id: string; ok: boolean }[]).filter((c) => !c.ok).map((c) => c.id)).toEqual(['review', 'voice']);
    await approve(v.id);
    const r = await call('render_video', { videoId: v.id, fps: 24, subtitles: 'srt' });
    expect(r.error).toBeUndefined();
    expect(r.status).toBe('queued');
    await videoRenderIdle();
    const read = await call('read_render', { id: r.renderId });
    expect(read).toMatchObject({ status: 'succeeded', fps: 24, progress: '100%', subtitles: 'srt' });
    const out = (read.output as { artifactId: string }).artifactId;
    const probe = await ffprobe((await db.select().from(artifact).where(eq(artifact.id, out)))[0]!.ref!);
    expect(probe.streams.filter((s) => s.codec_type === 'subtitle').map((s) => s.codec_name)).toEqual(['mov_text']);
    expect(probe.streams.find((s) => s.codec_type === 'video')!.r_frame_rate).toBe('24/1');
    const byVideo = await call('read_render', { videoId: v.id });
    expect((byVideo.renders as unknown[]).length).toBe(1);
  }, 120_000);
});
