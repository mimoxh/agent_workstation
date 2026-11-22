import { and, eq } from 'drizzle-orm';
import { chromium } from 'playwright-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { composeShotDoc } from '@aw/domain';
import { createApp } from '../src/app.js';
import { createDb, migrateDb, type DB } from '../src/db/client.js';
import { seed } from '../src/db/seed.js';
import { agent, artifact, entity, entityVersion, eventLog, message, workstation } from '../src/db/schema.js';
import { loadPlugins } from '../src/plugins.js';
import { conversationIdle } from '../src/runtime/conversation.js';
import { loadModels } from '../src/runtime/models.js';
import { scheduler, startScheduler } from '../src/runtime/scheduler.js';
import { executeTool, type RunCtx } from '../src/runtime/tools/index.js';
import { renderShotFrames } from '../src/runtime/video_frame.js';
import { buildPermCtx, createVideo, getVideo, mountWorkstation, replaceStoryboard, saveShotHtml } from '../src/usecases/index.js';
import { wsThreadOf } from '../src/usecases/threads.js';

const HUMAN = { type: 'human', id: 'local' } as const;

let db: DB;
let app: ReturnType<typeof createApp>['app'];
let wsId: string;
let rootId: string;
let stop: () => void;

const req = (method: string, p: string, body?: unknown) =>
  app.request(p, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const json = async <T = Record<string, never>>(r: Response | Promise<Response>) => (await (await r).json()) as T & { error?: string };

async function settle() {
  for (let quiet = 0; quiet < 3;) {
    await new Promise((r) => setTimeout(r, 20));
    await scheduler.idle();
    quiet = conversationIdle() ? quiet + 1 : 0;
  }
}

// 收集阶段探测一次：本机没装 Chromium 时渲染类用例跳过
const HAS_CHROMIUM = await chromium.launch().then(async (b) => { await b.close(); return true; }).catch(() => false);
if (!HAS_CHROMIUM) console.log('[video.test] Chromium 不可用，渲染类用例跳过');

const agentOf = async (templateId: string, ws = wsId) => (await db.select().from(agent).where(and(eq(agent.workstationId, ws), eq(agent.templateId, templateId))))[0]!;
async function call(name: string, args: Record<string, unknown>, template = 'video-director') {
  const a = await agentOf(template);
  const actor = { type: 'agent', id: a.id } as const;
  const ctx: RunCtx = { db, actor, permCtx: await buildPermCtx(actor, db), agent: a, task: null, run: { id: 'r' } as never };
  return (await executeTool(ctx, name, args)) as Record<string, unknown> & { error?: string };
}

interface Lint { level: string; rule: string; shotId?: string }
interface VideoRead {
  id: string; version: number; title: string; script: string; status: string; aspect: string; resolution: string; fps: number;
  size: { width: number; height: number }; total: number; lint: Lint[];
  shots: { id: string; order: number; title: string; narration: string; html?: string; htmlSize: number; duration: number; start: number; end: number; transition: string; placeholder: boolean; status: string }[];
}

const ANIMATED = '<!doctype html><html><head><style>body{background:#111}#box{position:absolute;left:0;top:40px;width:80px;height:80px;background:#f60;animation:go 2s linear forwards}@keyframes go{to{transform:translateX(400px)}}</style></head><body><div id="box"></div><p id="n" style="color:#fff;position:absolute;top:200px;left:20px"></p><script>document.getElementById("n").textContent=String(Math.random()).slice(0,8)</script></body></html>';

async function newVideo(title = '三分钟讲清楚', extra: Record<string, unknown> = {}) {
  const r = await createVideo(HUMAN, db, wsId, { title, ...extra });
  if (r.kind !== 'ok') throw new Error(r.error);
  return r.id;
}

beforeEach(async () => {
  process.env.AW_ENABLE_MOCK = '1';
  process.env.AW_DEFAULT_MODEL = 'mock:scripted';
  loadPlugins();
  const r = createDb(':memory:');
  db = r.db;
  migrateDb(r.sqlite);
  await seed(db);
  app = createApp(db).app;
  rootId = (await db.select().from(workstation).where(eq(workstation.pluginId, 'pm')))[0]!.id;
  const m = await mountWorkstation(HUMAN, db, { projectId: 'proj-aw', parentId: rootId, pluginId: 'video', name: '视频' });
  if (m.kind !== 'ok') throw new Error(m.error);
  wsId = m.id;
  await loadModels();
  stop = startScheduler(db);
});

afterEach(() => stop());

describe('视频台挂载', () => {
  it('singleton：同一项目再挂一个视频台被拒；编导和动画师都在', async () => {
    const m = await mountWorkstation(HUMAN, db, { projectId: 'proj-aw', parentId: rootId, pluginId: 'video', name: '视频二' });
    expect(m).toMatchObject({ kind: 'error' });
    expect((m as { error: string }).error).toContain('一个项目只能有一个');
    expect(await agentOf('video-director')).toBeTruthy();
    expect(await agentOf('motion-designer')).toBeTruthy();
  });
});

describe('视频用例', () => {
  it('新建默认 16:9 1080p 30fps 草稿；尺寸按画幅换算', async () => {
    const id = await newVideo();
    const v = (await getVideo(db, wsId, id))!;
    expect(v).toMatchObject({ title: '三分钟讲清楚', aspect: '16:9', resolution: '1080p', fps: 30, status: 'draft', size: { width: 1920, height: 1080 } });
    expect(v.lint.map((l) => l.rule).sort()).toEqual(['no_shots', 'script_missing']);
    const tall = (await getVideo(db, wsId, await newVideo('竖屏', { aspect: '9:16', resolution: '720p' })))!;
    expect(tall.size).toEqual({ width: 720, height: 1280 });
  });

  it('非法字段被拒，不落库', async () => {
    expect(await createVideo(HUMAN, db, wsId, { title: 'x', aspect: '4:3' as never })).toMatchObject({ kind: 'error' });
    expect(await createVideo(HUMAN, db, wsId, { title: 'x', fps: 7 })).toMatchObject({ kind: 'error' });
    expect((await db.select().from(entity).where(eq(entity.entityType, 'Video'))).length).toBe(0);
  });

  it('整组写分镜：保留 / 新建 / 删除、顺序重排、状态 draft↔storyboarded', async () => {
    const id = await newVideo();
    const r1 = await replaceStoryboard(HUMAN, db, wsId, id, { shots: [{ title: 'A', narration: '一句旁白' }, { title: 'B', duration: 4 }, { title: 'C', duration: 3 }] });
    if (r1.kind !== 'ok') throw new Error(r1.error);
    const [a, b, c] = r1.shots;
    expect((await getVideo(db, wsId, id))!.status).toBe('storyboarded');
    await saveShotHtml(HUMAN, db, wsId, a!.id, { html: '<p>A</p>' });

    const r2 = await replaceStoryboard(HUMAN, db, wsId, id, { shots: [{ id: c!.id }, { id: a!.id, narration: '改过的旁白' }, { title: 'D', duration: 2 }] });
    if (r2.kind !== 'ok') throw new Error(r2.error);
    expect(r2.removed).toBe(1);
    const v = (await getVideo(db, wsId, id))!;
    expect(v.shots.map((s) => s.title)).toEqual(['C', 'A', 'D']);
    expect(v.shots.map((s) => s.order)).toEqual([1, 2, 3]);
    expect(v.shots[1]).toMatchObject({ narration: '改过的旁白', html: '<p>A</p>', placeholder: false });
    expect(v.shots[0]!.start).toBe(0);
    expect(v.shots[1]!.start).toBe(3);
    expect(v.total).toBeCloseTo(v.shots.reduce((n, s) => n + s.duration, 0));
    expect((await db.select().from(entity).where(eq(entity.id, b!.id))).length).toBe(0);

    await replaceStoryboard(HUMAN, db, wsId, id, { shots: [] });
    expect((await getVideo(db, wsId, id))!.status).toBe('draft');
  });

  it('分镜整体先校验：别的视频的镜头 id、重复 id、非法时长都不写入', async () => {
    const id = await newVideo();
    const other = await newVideo('另一支');
    const r = await replaceStoryboard(HUMAN, db, wsId, other, { shots: [{ title: 'X' }] });
    if (r.kind !== 'ok') throw new Error(r.error);
    const foreign = r.shots[0]!.id;
    expect(await replaceStoryboard(HUMAN, db, wsId, id, { shots: [{ title: '好的' }, { id: foreign }] })).toMatchObject({ kind: 'error' });
    expect(await replaceStoryboard(HUMAN, db, wsId, id, { shots: [{ title: '好的' }, { duration: 999 }] })).toMatchObject({ kind: 'error' });
    expect((await getVideo(db, wsId, id))!.shots).toHaveLength(0);
  });
});

describe('视频工具', () => {
  it('编导写稿、拆分镜；read_video 默认不带 HTML，shotIds 指定时带', async () => {
    const id = await newVideo();
    const s = await call('write_video_script', { id, script: '# 稿\n\n第一段', reason: '初稿' });
    expect(s).toMatchObject({ version: 2 });
    expect((s.lint as Lint[]).some((l) => l.rule === 'script_missing')).toBe(false);
    const sb = await call('write_storyboard', { videoId: id, shots: [{ title: '开场', narration: '大家好' }, { title: '收尾', narration: '谢谢', duration: 2 }] });
    expect(sb.error).toBeUndefined();
    const shots = sb.shots as { id: string }[];
    expect(shots).toHaveLength(2);
    expect((sb.lint as Lint[]).filter((l) => l.rule === 'html_empty')).toHaveLength(2);

    const list = (await call('list_videos', {})).videos as { id: string; shots: number; missing: number; status: string }[];
    expect(list).toMatchObject([{ id, shots: 2, missing: 2, status: 'storyboarded' }]);

    const plain = (await call('read_video', { id })) as unknown as VideoRead;
    expect(plain.script).toContain('第一段');
    expect(plain.shots.every((x) => x.html === undefined)).toBe(true);
    await call('write_shot_html', { id: shots[0]!.id, html: '<p>开场</p>' }, 'motion-designer');
    const picked = (await call('read_video', { id, shotIds: [shots[0]!.id] })) as unknown as VideoRead;
    expect(picked.shots[0]!.html).toBe('<p>开场</p>');
    expect(picked.shots[1]!.html).toBeUndefined();
    const old = (await call('read_video', { id, version: 1 })) as unknown as VideoRead;
    expect(old.script).toBe('');
  });

  it('动画师写画面、局部改画面，留版本；原文不唯一时不写入；外链给 warn', async () => {
    const id = await newVideo();
    const shotId = ((await call('write_storyboard', { videoId: id, shots: [{ title: '一', narration: '旁白' }] })).shots as { id: string }[])[0]!.id;
    const w = await call('write_shot_html', { id: shotId, html: '<h1>标题</h1><p>a</p><p>a</p>', reason: '初稿' }, 'motion-designer');
    expect(w).toMatchObject({ version: 2 });
    const e = await call('edit_shot_html', { id: shotId, edits: [{ oldText: '<h1>标题</h1>', newText: '<h1>新标题</h1>' }] }, 'motion-designer');
    expect(e).toMatchObject({ version: 3 });
    const dup = await call('edit_shot_html', { id: shotId, edits: [{ oldText: '<p>a</p>', newText: '<p>b</p>' }] }, 'motion-designer');
    expect(dup.error).toBeTruthy();
    expect((await db.select().from(entityVersion).where(eq(entityVersion.entityId, shotId))).length).toBe(3);
    const net = await call('write_shot_html', { id: shotId, html: '<img src="https://x.test/a.png">' }, 'motion-designer');
    expect((net.lint as Lint[]).some((l) => l.rule === 'network')).toBe(true);
    const u = await call('update_shot', { id: shotId, duration: 5, transition: 'fade', status: 'ready' });
    expect(u).toMatchObject({ duration: 5 });
    expect((await call('update_shot', { id: shotId, duration: 0 })).error).toBeTruthy();
  });

  it('跨台读写不到', async () => {
    const id = await newVideo();
    const shotId = ((await call('write_storyboard', { videoId: id, shots: [{ title: '一' }] })).shots as { id: string }[])[0]!.id;
    const devId = (await db.select().from(workstation).where(eq(workstation.pluginId, 'dev')))[0]!.id;
    const a = (await db.select().from(agent).where(eq(agent.workstationId, devId)))[0]!;
    const actor = { type: 'agent', id: a.id } as const;
    const ctx: RunCtx = { db, actor, permCtx: await buildPermCtx(actor, db), agent: { ...a, workstationId: devId }, task: null, run: { id: 'r' } as never };
    expect(((await executeTool(ctx, 'read_video', { id })) as { error?: string }).error).toBeTruthy();
    expect(((await executeTool(ctx, 'write_shot_html', { id: shotId, html: '<p>x</p>' })) as { error?: string }).error).toBeTruthy();
  });

  it('view_shot：没画面时报错', async () => {
    const id = await newVideo();
    const shotId = ((await call('write_storyboard', { videoId: id, shots: [{ title: '一' }] })).shots as { id: string }[])[0]!.id;
    expect((await call('view_shot', { id: shotId }, 'motion-designer')).error).toContain('还没有 HTML 画面');
  });

  it.skipIf(!HAS_CHROMIUM)('view_shot：关键帧进产物和 __images', async () => {
    const id = await newVideo('小', { resolution: '720p' });
    const shotId = ((await call('write_storyboard', { videoId: id, shots: [{ title: '一', duration: 2 }] })).shots as { id: string }[])[0]!.id;
    await call('write_shot_html', { id: shotId, html: ANIMATED }, 'motion-designer');
    const r = await call('view_shot', { id: shotId, times: [0, 1] }, 'motion-designer');
    expect(r.error).toBeUndefined();
    expect(r.frames).toHaveLength(2);
    expect(r.__images).toHaveLength(2);
    expect((await db.select().from(artifact).where(eq(artifact.workstationId, wsId))).length).toBe(2);
  }, 120_000);
});

describe('确定性渲染', () => {
  it.skipIf(!HAS_CHROMIUM)('同一时刻逐字节一致；不同时刻不同；溢出被报出', async () => {
    const doc = composeShotDoc(ANIMATED, { width: 480, height: 270, duration: 2 });
    const a = await renderShotFrames(doc, { width: 480, height: 270, times: [0, 1, 1] });
    const b = await renderShotFrames(doc, { width: 480, height: 270, times: [1] });
    expect(a.frames[0]!.png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(a.frames[1]!.png.equals(a.frames[2]!.png)).toBe(true);
    expect(a.frames[1]!.png.equals(b.frames[0]!.png)).toBe(true);
    expect(a.frames[0]!.png.equals(a.frames[1]!.png)).toBe(false);

    const wide = composeShotDoc('<p style="position:absolute;left:400px;white-space:nowrap">一段很长很长很长很长的文字</p>', { width: 480, height: 270, duration: 1 });
    const o = await renderShotFrames(wide, { width: 480, height: 270, times: [0] });
    expect(o.issues.some((i) => i.includes('文字超出画面'))).toBe(true);
  }, 120_000);

  it.skipIf(!HAS_CHROMIUM)('脚本报错和外链拦截都进 issues，渲染不挂起', async () => {
    const doc = composeShotDoc('<img src="https://example.com/x.png"><script>throw new Error("坏了")</script>', { width: 320, height: 180, duration: 1 });
    const r = await renderShotFrames(doc, { width: 320, height: 180, times: [0] });
    expect(r.issues.some((i) => i.includes('坏了'))).toBe(true);
  }, 120_000);
});

describe('视频路由', () => {
  it('建 / 读 / 改 / 写稿 / 分镜 / 排序 / 改镜头 / 删除', async () => {
    const created = await json<{ id: string; version: number }>(req('POST', `/api/workstations/${wsId}/videos`, { title: '路由视频', aspect: '1:1' }));
    expect(created.version).toBe(1);
    const id = created.id;
    expect((await req('POST', `/api/workstations/${wsId}/videos`, { title: '  ' })).status).toBe(400);

    const list = await json<{ videos: { id: string; aspect: string }[] }>(req('GET', `/api/workstations/${wsId}/videos`));
    expect(list.videos).toMatchObject([{ id, aspect: '1:1' }]);

    const patched = await json<{ version: number }>(req('PATCH', `/api/videos/${id}`, { title: '新名字', baseVersion: 1 }));
    expect(patched.version).toBe(2);
    expect((await req('PATCH', `/api/videos/${id}`, { title: '冲突', baseVersion: 1 })).status).toBe(409);

    const sc = await json<{ version: number; lint: Lint[] }>(req('PUT', `/api/videos/${id}/script`, { script: '# 稿', baseVersion: 2 }));
    expect(sc.version).toBe(3);

    const sb = await json<{ shots: { id: string }[]; total: number }>(req('PUT', `/api/videos/${id}/storyboard`, { shots: [{ title: '一', duration: 2 }, { title: '二', duration: 3 }] }));
    expect(sb.shots).toHaveLength(2);
    expect(sb.total).toBe(5);
    const [s1, s2] = sb.shots;
    expect((await req('POST', `/api/videos/${id}/reorder`, { ids: [s2!.id, s1!.id] })).status).toBe(200);
    expect((await req('POST', `/api/videos/${id}/reorder`, { ids: [s2!.id] })).status).toBe(400);

    const read = await json<VideoRead>(req('GET', `/api/videos/${id}`));
    expect(read).toMatchObject({ title: '新名字', status: 'storyboarded', size: { width: 1080, height: 1080 } });
    expect(read.shots.map((s) => s.title)).toEqual(['二', '一']);
    expect((await json<VideoRead>(req('GET', `/api/videos/${id}?version=1`))).title).toBe('路由视频');

    const shot = read.shots[0]!;
    const up = await json<{ version: number; duration: number }>(req('PATCH', `/api/shots/${shot.id}`, { html: '<p>二</p>', duration: 4, baseVersion: (await db.select().from(entity).where(eq(entity.id, shot.id)))[0]!.version }));
    expect(up.duration).toBe(4);

    expect((await req('GET', '/api/videos/ghost')).status).toBe(404);
    expect((await req('PATCH', '/api/shots/ghost', { baseVersion: 1 })).status).toBe(404);
    expect((await req('DELETE', `/api/videos/${id}`)).status).toBe(200);
    expect((await db.select().from(entity).where(eq(entity.workstationId, wsId))).filter((e) => e.entityType === 'Video' || e.entityType === 'Shot')).toHaveLength(0);
    const kinds = (await db.select().from(eventLog)).map((e) => e.action);
    for (const k of ['video_created', 'video_updated', 'video_script', 'video_storyboard', 'video_shot', 'video_deleted']) expect(kinds).toContain(k);
  });

  it.skipIf(!HAS_CHROMIUM)('镜头帧路由：PNG、同一 t 一致、不同 t 不同', async () => {
    const id = await newVideo('帧', { resolution: '720p', aspect: '1:1' });
    const r = await replaceStoryboard(HUMAN, db, wsId, id, { shots: [{ title: '一', duration: 2, html: ANIMATED }] });
    if (r.kind !== 'ok') throw new Error(r.error);
    const sid = r.shots[0]!.id;
    const get = async (t: number) => {
      const res = await req('GET', `/api/shots/${sid}/frame?t=${t}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/png');
      return Buffer.from(await res.arrayBuffer());
    };
    const f1 = await get(1);
    expect(f1.equals(await get(1))).toBe(true);
    expect(f1.equals(await get(0))).toBe(false);
    expect((await req('GET', '/api/shots/ghost/frame')).status).toBe(404);
  }, 120_000);
});

describe('找 Agent', () => {
  it('ask director：没稿先写稿，有稿拆分镜；ask motion：给缺画面的镜头出画面', async () => {
    const id = await newVideo();
    expect((await req('POST', `/api/videos/${id}/ask`, { who: 'motion' })).status).toBe(400);

    expect((await req('POST', `/api/videos/${id}/ask`, { who: 'director' })).status).toBe(200);
    await settle();
    expect((await getVideo(db, wsId, id))!.script).toContain('讲解稿（mock）');

    expect((await req('POST', `/api/videos/${id}/ask`, { who: 'director' })).status).toBe(200);
    await settle();
    const v = (await getVideo(db, wsId, id))!;
    expect(v.shots.map((s) => s.title)).toEqual(['提出问题（mock）', '给出答案（mock）']);
    expect(v.status).toBe('storyboarded');

    expect((await req('POST', `/api/videos/${id}/ask`, { who: 'motion' })).status).toBe(200);
    await settle();
    const after = (await getVideo(db, wsId, id))!;
    expect(after.shots.every((s) => !s.placeholder)).toBe(true);
    const th = await wsThreadOf(db, wsId);
    const msgs = await db.select().from(message).where(eq(message.threadId, th.id));
    expect(msgs.some((m) => m.senderType === 'agent' && m.content === '画面已更新（mock）。')).toBe(true);
  }, 120_000);
});
