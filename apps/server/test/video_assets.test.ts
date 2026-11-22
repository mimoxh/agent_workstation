import { and, eq } from 'drizzle-orm';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { PNG } from 'pngjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createDb, migrateDb, type DB } from '../src/db/client.js';
import { seed } from '../src/db/seed.js';
import { agent, artifact, entity, inboxItem, message, run, workstation } from '../src/db/schema.js';
import { loadPlugins } from '../src/plugins.js';
import { writeModelConfig } from '../src/runtime/config.js';
import { ffmpegAvailable, ffmpegBin, ffprobe } from '../src/runtime/media/ffmpeg.js';
import { adapterFor, clipCostMicros, MOCK_VIDEO, mockAdapter, resolveVideoProvider } from '../src/runtime/media/video_gen.js';
import { loadModels } from '../src/runtime/models.js';
import { executeTool, type RunCtx } from '../src/runtime/tools/index.js';
import { videoRenderIdle } from '../src/runtime/video_render.js';
import { buildPermCtx, createVideo, getVideo, mountWorkstation, replaceStoryboard, updateShot } from '../src/usecases/index.js';
import { assetContextOf } from '../src/usecases/video_assets.js';
import { decideClipRequest, pumpClips, readClipRequest, recoverClipRequests, stopClipPoller } from '../src/usecases/video_clips.js';

const HUMAN = { type: 'human', id: 'local' } as const;

let db: DB;
let app: ReturnType<typeof createApp>['app'];
let wsId: string;

const req = (method: string, p: string, body?: unknown) =>
  app.request(p, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const json = async <T = Record<string, unknown>>(r: Response | Promise<Response>) => (await (await r).json()) as T & { error?: string };

const CAN_FF = ffmpegAvailable();
const HAS_CHROMIUM = await chromium.launch().then(async (b) => { await b.close(); return true; }).catch(() => false);
const CAN_RENDER = CAN_FF && HAS_CHROMIUM;
if (!CAN_FF) console.log('[video_assets.test] 没有 ffmpeg，素材 / 片段用例跳过');

const tmp = () => path.join(os.tmpdir(), `aw-asset-test-${crypto.randomUUID()}`);

function pngBytes(w: number, h: number, rgb: [number, number, number] = [40, 90, 160]) {
  const p = new PNG({ width: w, height: h });
  for (let i = 0; i < p.data.length; i += 4) {
    p.data[i] = rgb[0];
    p.data[i + 1] = rgb[1];
    p.data[i + 2] = rgb[2];
    p.data[i + 3] = 255;
  }
  return PNG.sync.write(p);
}

function videoBytes(seconds: number, size = '320x240', source = 'testsrc2', tone = false) {
  const file = `${tmp()}.mp4`;
  const audio = tone ? ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-c:a', 'aac'] : [];
  execFileSync(ffmpegBin(), ['-y', '-v', 'error', '-f', 'lavfi', '-i', `${source}=size=${size}:rate=${source === 'color' ? 1 : 30}${source === 'color' ? ':color=black' : ''}`, ...audio, '-t', String(seconds), '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', file]);
  const bytes = fs.readFileSync(file);
  fs.rmSync(file, { force: true });
  return bytes;
}

const upload = (name: string, bytes: Uint8Array, extra: Record<string, string> = {}) => {
  const form = new FormData();
  form.append('file', new File([bytes as BlobPart], name));
  for (const [k, v] of Object.entries(extra)) form.append(k, v);
  return app.request(`/api/workstations/${wsId}/assets`, { method: 'POST', body: form });
};

async function uploadOk(name: string, bytes: Uint8Array, extra: Record<string, string> = {}) {
  const res = await upload(name, bytes, extra);
  const body = await json<{ id: string; kind: string; width: number; height: number; duration: number | null; poster: string | null }>(res);
  if (res.status !== 201) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

async function newVideo(shots: Parameters<typeof replaceStoryboard>[4]['shots'], extra: Record<string, unknown> = {}) {
  const r = await createVideo(HUMAN, db, wsId, { title: '素材测试', resolution: '720p', ...extra });
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

const setBudget = async (costMicros: number) => {
  const ws = (await db.select().from(workstation).where(eq(workstation.id, wsId)))[0]!;
  await db.update(workstation).set({ settingsJson: JSON.stringify({ ...JSON.parse(ws.settingsJson ?? '{}'), budget: { costMicros } }) }).where(eq(workstation.id, wsId));
};

const priced = (perSecond: number) => writeModelConfig({ providers: [], chain: [], prices: {}, media: [{ name: 'gen', kind: 'video', protocol: 'mock', price: { perSecond } }], defaultVideo: 'gen' });

async function drain(id: string) {
  for (let i = 0; i < 200; i++) {
    await pumpClips(db);
    const r = await readClipRequest(db, wsId, id);
    if (r && ['succeeded', 'failed', 'rejected'].includes(r.status)) return r;
    await new Promise((ok) => setTimeout(ok, 25));
  }
  throw new Error('片段一直没有结束');
}

const bodies = async () => (await db.select({ content: message.content }).from(message)).map((m) => m.content ?? '');

async function framePixel(file: string, t: number, x: number, y: number) {
  const out = `${tmp()}.png`;
  execFileSync(ffmpegBin(), ['-y', '-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', out]);
  const png = PNG.sync.read(fs.readFileSync(out));
  fs.rmSync(out, { force: true });
  const i = (png.width * y + x) * 4;
  return [png.data[i]!, png.data[i + 1]!, png.data[i + 2]!];
}
const near = (a: number[], b: number[], tol = 18) => a.every((v, i) => Math.abs(v - b[i]!) <= tol);

beforeEach(async () => {
  process.env.AW_ENABLE_MOCK = '1';
  process.env.AW_DEFAULT_MODEL = 'mock:scripted';
  process.env.AW_MOCK_CLIP_MS = '0';
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
  vi.restoreAllMocks();
  stopClipPoller();
  await videoRenderIdle();
  delete process.env.AW_MOCK_CLIP_MS;
});

describe('视频生成适配器', () => {
  it('按协议找适配器：只有 mock；默认 provider 取设置里的；没实现的协议报错', async () => {
    expect(adapterFor('mock')).toBe(mockAdapter);
    expect(adapterFor('openai-speech')).toBeUndefined();
    expect('error' in resolveVideoProvider() ? null : resolveVideoProvider()).toMatchObject({ provider: { name: MOCK_VIDEO.name } });
    expect(resolveVideoProvider({ provider: 'ghost' })).toMatchObject({ error: expect.stringContaining('ghost') });

    const put = await req('PUT', '/api/settings/models', { providers: [], chain: [], prices: {}, media: [{ name: 'gen', kind: 'video', protocol: 'mock', price: { perSecond: 0.05 } }, { name: 'vendor', kind: 'video', protocol: 'openai-speech' }], defaultVideo: 'gen' });
    expect(put.status).toBe(200);
    const cfg = await json<{ defaultVideo?: string }>(req('GET', '/api/settings/models'));
    expect(cfg.defaultVideo).toBe('gen');
    const r = resolveVideoProvider();
    expect('error' in r ? r.error : r.provider.name).toBe('gen');
    if (!('error' in r)) expect(clipCostMicros(r.provider, 2.5)).toBe(125_000);
    expect(resolveVideoProvider({ provider: 'vendor' })).toMatchObject({ error: expect.stringContaining('还没有实现') });
  });

  it.skipIf(!CAN_FF)('mock 片段：尺寸按画幅 × 分辨率、时长和请求一字不差；排队 → 生成中 → 成功', async () => {
    process.env.AW_MOCK_CLIP_MS = '300';
    const ctx = { provider: MOCK_VIDEO, workstationId: wsId };
    const { jobId } = await mockAdapter.submit({ prompt: '一只橘猫趴在窗台上晒太阳，暖色调', duration: 2.5, aspect: '9:16', resolution: '720p' }, ctx);
    const first = await mockAdapter.poll(jobId, ctx);
    expect(['queued', 'running']).toContain(first.state);
    await new Promise((ok) => setTimeout(ok, 350));
    const done = await mockAdapter.poll(jobId, ctx);
    expect(done.state).toBe('succeeded');
    const dest = `${tmp()}.mp4`;
    await mockAdapter.fetchResult(done.result!, dest, ctx);
    const p = await ffprobe(dest);
    const v = p.streams.find((s) => s.codec_type === 'video')!;
    expect([v.width, v.height]).toEqual([720, 1280]);
    expect(Number(p.format.duration)).toBeCloseTo(2.5, 2);
    expect(p.streams.some((s) => s.codec_type === 'audio')).toBe(false);
    fs.rmSync(dest, { force: true });
    expect((await mockAdapter.poll('nope', ctx)).state).toBe('failed');
  }, 30_000);
});

describe.skipIf(!CAN_FF)('素材库', () => {
  it('上传：图片按文件头认、ffprobe 读尺寸；格式 / 内容 / 大小 / 时长不对分别拒；视频带封面', async () => {
    const img = await uploadOk('封面.png', pngBytes(320, 180), { license: 'CC0 自己拍的', tags: '产品,封面' });
    expect(img).toMatchObject({ kind: 'image', width: 320, height: 180, poster: null });
    const detail = await json<{ license: string; tags: string[]; source: string; mime: string }>(req('GET', `/api/assets/${img.id}`));
    expect(detail).toMatchObject({ license: 'CC0 自己拍的', tags: ['产品', '封面'], source: 'upload', mime: 'image/png' });

    expect((await upload('notes.txt', Buffer.from('hello world!'))).status).toBe(415);
    expect((await upload('fake.jpg', pngBytes(8, 8))).status).toBe(415);
    expect((await upload('fake.png', Buffer.from('not really a png file at all'))).status).toBe(415);
    const big = Buffer.alloc(21 * 1024 * 1024);
    pngBytes(8, 8).copy(big);
    expect((await upload('big.png', big)).status).toBe(413);

    const clip = await uploadOk('片段.mp4', videoBytes(1));
    expect(clip.kind).toBe('video');
    expect(clip.duration).toBeCloseTo(1, 1);
    expect(clip.poster).toBeTruthy();
    const long = await upload('long.mp4', videoBytes(301, '16x16', 'color'));
    expect(long.status).toBe(400);
    expect((await json(long)).error).toContain('最长');

    const list = await json<{ assets: { id: string; kind: string }[] }>(req('GET', `/api/workstations/${wsId}/assets?kind=image`));
    expect(list.assets.map((a) => a.id)).toEqual([img.id]);
  }, 60_000);

  it('素材清单进 Agent 上下文：空台给提示，上传后列出名称、id 和尺寸', async () => {
    expect(await assetContextOf(db, wsId)).toContain('还没有素材');
    const img = await uploadOk('产品图.png', pngBytes(320, 180));
    const ctx = await assetContextOf(db, wsId);
    expect(ctx).toContain(`产品图`);
    expect(ctx).toContain(`asset: ${img.id}`);
    expect(ctx).toContain('320×180');
  }, 30_000);

  it('改信息、被镜头用着不能删、不用了能删；音频素材不能当画面', async () => {
    const img = await uploadOk('a.png', pngBytes(64, 64));
    const v = await newVideo([{ title: '用图', narration: '一句', duration: 2 }]);
    await updateShot(HUMAN, db, wsId, v.shots[0]!, { visual: 'asset', asset: img.id });
    expect((await req('PATCH', `/api/assets/${img.id}`, { license: '买断' })).status).toBe(200);
    const blocked = await req('DELETE', `/api/assets/${img.id}`);
    expect(blocked.status).toBe(409);
    expect((await json(blocked)).error).toContain('用这件素材');
    const d = await json<{ usedBy: { shotId: string }[]; license: string }>(req('GET', `/api/assets/${img.id}`));
    expect(d).toMatchObject({ license: '买断', usedBy: [{ shotId: v.shots[0] }] });
    await updateShot(HUMAN, db, wsId, v.shots[0]!, { visual: 'html', asset: '' });
    expect((await req('DELETE', `/api/assets/${img.id}`)).status).toBe(200);
    expect((await req('GET', `/api/assets/${img.id}`)).status).toBe(404);
  });

  it('镜头检查：素材镜头没素材是「缺素材」error；内容哈希随素材 / 运动 / 叠加层 / 原声变化', async () => {
    const a = await uploadOk('a.png', pngBytes(64, 64));
    const b = await uploadOk('b.png', pngBytes(64, 64, [200, 30, 30]));
    const v = await newVideo([{ title: '素材镜头', narration: '一句', duration: 2, visual: 'asset' }]);
    let d = (await getVideo(db, wsId, v.id))!;
    expect(d.lint.find((l) => l.rule === 'asset_empty')).toMatchObject({ level: 'error' });
    expect(d.lint.find((l) => l.rule === 'asset_empty')!.message).toContain('缺素材');

    const sid = v.shots[0]!;
    const hashes: string[] = [];
    for (const patch of [{ asset: a.id }, { asset: b.id }, { motion: 'zoom-in' as const }, { html: '<div>标注</div>' }, { keepAudio: true }]) {
      await updateShot(HUMAN, db, wsId, sid, patch);
      d = (await getVideo(db, wsId, v.id))!;
      hashes.push(d.contentHash);
    }
    expect(new Set(hashes).size).toBe(hashes.length);
    expect(d.lint.some((l) => l.rule === 'asset_empty')).toBe(false);
    expect(d.shots[0]).toMatchObject({ motion: 'zoom-in', keepAudio: true, assetInfo: { id: b.id, kind: 'image' } });
    const same = d.contentHash;
    await updateShot(HUMAN, db, wsId, sid, { title: '只改标题' });
    expect((await getVideo(db, wsId, v.id))!.contentHash).toBe(same);
  });
});

describe('片段申请', () => {
  it('generate_clip：只建待审批申请和收件箱条目，不调生成服务；Agent 批不了；镜头上有 pending 提示', async () => {
    priced(0.01);
    const submit = vi.spyOn(mockAdapter, 'submit');
    const v = await newVideo([{ title: '开场', narration: '一句', duration: 2, visual: 'generated' }]);
    const r = await call('video-director', 'generate_clip', { shotId: v.shots[0], prompt: '清晨的城市天际线，航拍，缓慢推进' });
    expect(r.error).toBeUndefined();
    expect(r).toMatchObject({ status: 'pending', duration: 2, estimatedCostMicros: 20_000, provider: 'gen' });
    const id = String(r.requestId);
    const inbox = (await db.select().from(inboxItem).where(eq(inboxItem.kind, 'clip_request')))[0]!;
    expect(inbox).toMatchObject({ refId: id, status: 'open' });
    expect(JSON.parse(inbox.payloadJson!)).toMatchObject({ wsId, prompt: '清晨的城市天际线，航拍，缓慢推进', estimatedCostMicros: 20_000, duration: 2 });
    await pumpClips(db);
    expect(submit).not.toHaveBeenCalled();
    expect((await readClipRequest(db, wsId, id))!.status).toBe('pending');
    const a = await agentOf('video-director');
    expect(await decideClipRequest({ type: 'agent', id: a.id }, db, wsId, id, { decision: 'approve' })).toMatchObject({ status: 409 });
    const d = (await getVideo(db, wsId, v.id))!;
    expect(d.lint.find((l) => l.rule === 'clip_request_pending')).toMatchObject({ level: 'warn' });
    expect(d.shots[0]!.clip).toMatchObject({ id, status: 'pending' });
    const read = await call('video-director', 'read_clip_request', { id });
    expect(read).toMatchObject({ status: 'pending', prompt: '清晨的城市天际线，航拍，缓慢推进' });
  });

  it('收件箱里拒绝：申请 rejected、条目关闭、原因发回会话 @ 申请方，不调生成服务', async () => {
    const submit = vi.spyOn(mockAdapter, 'submit');
    const v = await newVideo([{ title: '开场', narration: '一句', duration: 2, visual: 'generated' }]);
    const r = await call('asset-producer', 'generate_clip', { shotId: v.shots[0], prompt: '海边日落' });
    const inbox = (await db.select().from(inboxItem).where(eq(inboxItem.kind, 'clip_request')))[0]!;
    const res = await req('POST', `/api/inbox/${inbox.id}/resolve`, { decision: 'deny', answer: '先用库里的图' });
    expect(res.status).toBe(200);
    expect((await readClipRequest(db, wsId, String(r.requestId)))).toMatchObject({ status: 'rejected', reason: '先用库里的图', decidedBy: 'human:local' });
    expect((await db.select().from(inboxItem).where(eq(inboxItem.id, inbox.id)))[0]!.status).toBe('resolved');
    expect((await bodies()).some((b) => b.includes('@素材制作') && b.includes('被拒') && b.includes('先用库里的图'))).toBe(true);
    await pumpClips(db);
    expect(submit).not.toHaveBeenCalled();
  });

  it('批准前算上预估花费查预算：超了 409，申请仍待审批，不提交', async () => {
    priced(0.01);
    const submit = vi.spyOn(mockAdapter, 'submit');
    const v = await newVideo([{ title: '开场', narration: '一句', duration: 2, visual: 'generated' }]);
    const r = await call('video-director', 'generate_clip', { shotId: v.shots[0], prompt: '雨夜街道' });
    await setBudget(10_000);
    const res = await req('POST', `/api/clip-requests/${String(r.requestId)}/decide`, { decision: 'approve' });
    expect(res.status).toBe(409);
    expect((await json(res)).error).toContain('超预算');
    expect((await readClipRequest(db, wsId, String(r.requestId)))!.status).toBe('pending');
    expect(submit).not.toHaveBeenCalled();
  });

  it.skipIf(!CAN_FF)('批准后全流程：提交 → 轮询成功 → 存成生成素材、接到镜头上、按实际时长记花费、会话 @ 申请方', async () => {
    priced(0.01);
    const v = await newVideo([{ title: '开场', narration: '一句', duration: 2, visual: 'generated' }], { aspect: '1:1' });
    const r = await call('video-director', 'generate_clip', { shotId: v.shots[0], prompt: '一杯咖啡冒着热气，特写' });
    const id = String(r.requestId);
    const res = await req('POST', `/api/clip-requests/${id}/decide`, { decision: 'approve' });
    expect(res.status).toBe(200);
    expect((await json<{ status: string }>(res)).status).toBe('running');
    const done = await drain(id);
    expect(done.error).toBe('');
    expect(done.status).toBe('succeeded');
    const asset = await json<{ id: string; kind: string; source: string; width: number; height: number; duration: number; prompt: string; provider: string; poster: string | null }>(req('GET', `/api/assets/${done.asset}`));
    expect(asset).toMatchObject({ kind: 'video', source: 'generated', width: 720, height: 720, duration: 2, prompt: '一杯咖啡冒着热气，特写', provider: 'gen' });
    expect(asset.poster).toBeTruthy();
    const d = (await getVideo(db, wsId, v.id))!;
    expect(d.shots[0]).toMatchObject({ visual: 'generated', asset: done.asset });
    expect(d.lint.some((l) => l.rule === 'asset_empty')).toBe(false);
    const runs = await db.select().from(run).where(eq(run.trigger, 'media'));
    expect(runs.map((x) => x.cost)).toEqual([20_000]);
    expect(runs[0]!.agentId).toBe((await agentOf('video-director')).id);
    expect((await bodies()).some((b) => b.includes('@编导') && b.includes('生成好了'))).toBe(true);
  }, 60_000);

  it.skipIf(!CAN_FF)('重启恢复：mock 的生成中任务退回 approved 重新提交并完成；没有适配器的标失败', async () => {
    const v = await newVideo([{ title: 'A', narration: '一句', duration: 1, visual: 'generated' }, { title: 'B', narration: '一句', duration: 1, visual: 'generated' }]);
    const r1 = await call('video-director', 'generate_clip', { shotId: v.shots[0], prompt: '森林' });
    const r2 = await call('video-director', 'generate_clip', { shotId: v.shots[1], prompt: '沙漠' });
    for (const r of [r1, r2]) await decideClipRequest(HUMAN, db, wsId, String(r.requestId), { decision: 'approve' });
    const ghost = (await db.select().from(entity).where(eq(entity.id, String(r2.requestId))))[0]!;
    await db.update(entity).set({ dataJson: JSON.stringify({ ...JSON.parse(ghost.dataJson!), provider: 'ghost' }) }).where(eq(entity.id, ghost.id));
    expect(await recoverClipRequests(db)).toBe(2);
    expect(await readClipRequest(db, wsId, String(r1.requestId))).toMatchObject({ status: 'approved', jobId: '' });
    expect((await readClipRequest(db, wsId, String(r2.requestId)))).toMatchObject({ status: 'failed', error: expect.stringContaining('服务重启') });
    expect((await drain(String(r1.requestId))).status).toBe('succeeded');
  }, 60_000);
});

interface RenderView { id: string; status: string; error: string | null; total: number; output: { artifactId: string; duration: number | null } | null }

describe.skipIf(!CAN_RENDER)('素材镜头出片与对比', () => {
  it('html + 图片（推近 + 叠加层）+ 片段（4:3 留黑边、补帧、烧字幕）混剪；view_shot 返回合成帧；两次出片按镜头对比', async () => {
    const img = await uploadOk('蓝.png', pngBytes(640, 360));
    const clip = await uploadOk('片段.mp4', videoBytes(1));
    const overlay = '<!doctype html><html><body><div style="position:absolute;left:0;top:0;width:200px;height:200px;background:#fff"></div></body></html>';
    const v = await newVideo([
      { title: '开场', html: '<!doctype html><html><body style="margin:0;background:#363"><h1 style="color:#fff">开场</h1></body></html>', duration: 1 },
      { title: '图片', visual: 'asset', asset: img.id, motion: 'zoom-in', duration: 2 },
      { title: '片段', visual: 'asset', asset: clip.id, narration: '片段镜头的字幕。', duration: 2 },
    ], { subtitles: 'burn' });
    await updateShot(HUMAN, db, wsId, v.shots[1]!, { html: overlay });

    const view = await call('motion-designer', 'view_shot', { id: v.shots[1] });
    expect(view.error).toBeUndefined();
    expect(view.frames as unknown[]).toHaveLength(3);
    const frozen = await call('motion-designer', 'view_shot', { id: v.shots[2], times: [0.2, 1.6] });
    expect(frozen.error).toBeUndefined();
    expect(frozen.frames as unknown[]).toHaveLength(2);

    const render = async () => {
      const res = await req('POST', `/api/videos/${v.id}/renders`, { fps: 30, subtitles: 'burn', override: '测试素材镜头' });
      const created = await json<{ id: string }>(res);
      expect(res.status, created.error).toBe(201);
      await videoRenderIdle();
      return json<RenderView>(req('GET', `/api/video-renders/${created.id}`));
    };
    const a = await render();
    expect(a.error).toBeNull();
    expect(a.status).toBe('succeeded');
    const art = (await db.select().from(artifact).where(eq(artifact.id, a.output!.artifactId)))[0]!;
    const p = await ffprobe(art.ref!);
    const vs = p.streams.find((s) => s.codec_type === 'video')!;
    expect([vs.width, vs.height]).toEqual([1280, 720]);
    expect(Number(p.format.duration)).toBeCloseTo(5, 1);
    expect(near(await framePixel(art.ref!, 1.5, 100, 100), [255, 255, 255])).toBe(true);
    expect(near(await framePixel(art.ref!, 1.5, 640, 360), [40, 90, 160])).toBe(true);
    expect(near(await framePixel(art.ref!, 4.5, 40, 300), [0, 0, 0])).toBe(true);

    await updateShot(HUMAN, db, wsId, v.shots[1]!, { motion: 'pan-right' });
    const b = await render();
    expect(b.status).toBe('succeeded');
    const cmp = await json<{ changed: number; shots: { id: string; status: string; hashA: string; hashB: string }[]; settings: { field: string }[] }>(req('GET', `/api/video-renders/compare?a=${a.id}&b=${b.id}`));
    expect(cmp.error).toBeUndefined();
    expect(cmp.changed).toBe(1);
    expect(cmp.shots.map((s) => s.status)).toEqual(['same', 'changed', 'same']);
    expect(cmp.shots.every((s) => /^[0-9a-f]{64}$/.test(s.hashA) && /^[0-9a-f]{64}$/.test(s.hashB))).toBe(true);
    expect((await req('GET', `/api/video-renders/compare?a=${a.id}&b=nope`)).status).toBe(404);
  }, 180_000);

  it('静止图片铺满整段；片段保留原声（keepAudio）时原声进成片，关掉后换成静音且不复用旧片段', async () => {
    const img = await uploadOk('红.png', pngBytes(320, 320, [200, 40, 40]));
    const clip = await uploadOk('带声.mp4', videoBytes(1, '320x240', 'testsrc2', true));
    const v = await newVideo([
      { title: '图', visual: 'asset', asset: img.id, duration: 1 },
      { title: '声', visual: 'asset', asset: clip.id, keepAudio: true, duration: 1 },
    ], { subtitles: 'off' });
    const render = async () => {
      const res = await req('POST', `/api/videos/${v.id}/renders`, { fps: 30, subtitles: 'off', override: '测试原声' });
      const created = await json<{ id: string }>(res);
      expect(res.status, created.error).toBe(201);
      await videoRenderIdle();
      const r = await json<RenderView>(req('GET', `/api/video-renders/${created.id}`));
      expect(r.error).toBeNull();
      return (await db.select().from(artifact).where(eq(artifact.id, r.output!.artifactId)))[0]!.ref!;
    };
    const volume = (file: string, from: number) => {
      const r = spawnSync(ffmpegBin(), ['-hide_banner', '-ss', String(from), '-t', '0.8', '-i', file, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
      return Number(r.stderr.match(/mean_volume: (-?[\d.]+) dB/)?.[1] ?? -999);
    };
    const withAudio = await render();
    expect(Number((await ffprobe(withAudio)).format.duration)).toBeCloseTo(2, 1);
    expect(near(await framePixel(withAudio, 0.9, 640, 360), [200, 40, 40])).toBe(true);
    expect(volume(withAudio, 1.1)).toBeGreaterThan(-40);
    expect(volume(withAudio, 0.1)).toBeLessThan(-80);
    await updateShot(HUMAN, db, wsId, v.shots[1]!, { keepAudio: false });
    const silent = await render();
    expect(volume(silent, 1.1)).toBeLessThan(-80);
  }, 120_000);
});
