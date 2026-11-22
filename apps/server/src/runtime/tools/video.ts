import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { styleVars } from '@aw/domain';
import { z } from 'zod';
import { artifact } from '../../db/schema.js';
import { editShotHtml, getVideo, listVideos, lookOf, renderableShot, replaceStoryboard, saveScript, saveShotHtml, saveShotIssues, shotRow, updateShot, videoStyleOf, type ShotInput } from '../../usecases/videos.js';
import { addShotComment, resolveShotComments, saveVideoReview } from '../../usecases/video_review.js';
import { listVideoMedia, saveVideoStyle } from '../../usecases/video_style.js';
import { getAsset, listAssets } from '../../usecases/video_assets.js';
import { listClipRequests, readClipRequest, requestClip } from '../../usecases/video_clips.js';
import { BROWSER_MISSING, renderShotFrames } from '../video_frame.js';
import { renderMediaFrames } from '../video_render.js';
import { voiceShots } from '../../usecases/video_voice.js';
import { createVideoRender, getVideoRender, listVideoRenders } from '../../usecases/video_renders.js';
import type { ToolDef } from './index.js';

const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();

const failed = (r: { kind: string; error?: string }) => ({ error: r.error ?? `写入失败（${r.kind}）` });

// 镜头 HTML 和整篇讲解稿：默认 8KB 的工具结果上限会截断
const VIDEO_RESULT_LIMIT = 120 * 1024;

const edit = z.object({ oldText: z.string().describe('要替换的原文，必须逐字一致且在画面 HTML 里唯一'), newText: z.string() });

const shotFields = {
  title: z.string().optional().describe('镜头要表达什么，一句话'),
  narration: z.string().optional().describe('旁白原文，字幕和配音的来源'),
  visual: z.enum(['html', 'generated', 'asset']).optional().describe('画面类型，默认 html'),
  prompt: z.string().optional().describe('visual=generated 时的生成提示词'),
  asset: z.string().optional().describe('visual=asset / generated 时的素材 id（list_assets 里的 asset）'),
  duration: z.number().positive().max(120).nullable().optional().describe('时长（秒）；不填或 null 按旁白估算'),
  transition: z.enum(['cut', 'fade', 'slide']).optional().describe('进入这个镜头的转场，默认 cut'),
  motion: z.enum(['none', 'zoom-in', 'zoom-out', 'pan-left', 'pan-right']).nullable().optional().describe('素材镜头的画面运动（推 / 拉 / 左右移），默认 none'),
  keepAudio: z.boolean().optional().describe('素材片段自带的音频要不要进成片，默认丢掉'),
};

const renderSummary = (r: Awaited<ReturnType<typeof listVideoRenders>>[number]) => ({
  id: r.id, videoId: r.videoId, status: r.status, progress: `${Math.round(r.progress * 100)}%`, error: r.error, size: `${r.width}×${r.height}`, fps: r.fps,
  total: r.total, subtitles: r.subtitles, voiced: r.voiced, placeholders: r.placeholders, warnings: r.warnings,
  shotIssues: r.shotIssues, override: r.override ? r.override.reason : null, bgm: !!r.bgm,
  output: r.output ? { artifactId: r.output.artifactId, duration: r.output.duration, bytes: r.output.size } : null, finishedAt: r.finishedAt,
});

const shotInput = z.object({ id: z.string().optional().describe('保留已有镜头时传它的 id'), ...shotFields });

export const videoTools: Record<string, ToolDef> = {
  list_videos: {
    taskless: true,
    description: '列出本台的视频（不含讲解稿和画面）',
    right: 'observe',
    parameters: z.object({}),
    execute: async (ctx) => ({ videos: await listVideos(ctx.db, ctx.agent.workstationId) }),
  },
  read_video: {
    taskless: true,
    description: '读取一支视频：画幅与分辨率、讲解稿、按顺序的镜头（含生效时长、成片里的起止时间、画面问题 issues、评论数）、检查结果、未解决评论、出片门禁 gate 和内容哈希 contentHash（save_video_review 要原样带上）。默认不带画面 HTML，要改画面时用 shotIds 指定镜头或 includeHtml 全部带上',
    right: 'observe',
    resultLimit: VIDEO_RESULT_LIMIT,
    parameters: z.object({ id: z.string(), version: z.number().int().optional().describe('讲解稿等视频字段的历史版本'), includeHtml: z.boolean().optional(), shotIds: z.array(z.string()).optional() }),
    execute: async (ctx, a) => {
      const shotIds = a.shotIds as string[] | undefined;
      const v = await getVideo(ctx.db, ctx.agent.workstationId, String(a.id), { version: a.version as number | undefined, includeHtml: a.includeHtml === true || !!shotIds?.length, shotIds: a.includeHtml === true ? undefined : shotIds });
      return v ?? { error: '视频不存在' };
    },
  },
  write_video_script: {
    taskless: true,
    largeOutput: true,
    description: '写入视频的讲解稿（完整 markdown，覆盖旧稿，产生一个新版本）',
    right: 'propose',
    parameters: z.object({ id: z.string(), script: z.string().describe('完整讲解稿'), reason: z.string().optional().describe('这一版改了什么') }),
    execute: async (ctx, a) => {
      const r = await saveScript(ctx.actor, ctx.db, ctx.agent.workstationId, String(a.id), { script: String(a.script), reason: a.reason as string | undefined });
      return r.kind === 'ok' ? { id: r.id, version: r.version, lint: r.lint } : failed(r);
    },
  },
  write_storyboard: {
    taskless: true,
    largeOutput: true,
    description: '整组写入分镜：按顺序传入全部镜头。带 id 的保留并更新（没传的字段不变，画面 HTML 保留），不带 id 的新建，没列出的已有镜头会被删除',
    right: 'propose',
    parameters: z.object({ videoId: z.string(), shots: z.array(shotInput).max(200), reason: z.string().optional() }),
    execute: async (ctx, a) => {
      const r = await replaceStoryboard(ctx.actor, ctx.db, ctx.agent.workstationId, String(a.videoId), { shots: a.shots as ShotInput[], reason: a.reason as string | undefined });
      return r.kind === 'ok' ? { shots: r.shots, removed: r.removed, total: r.total, lint: r.lint } : failed(r);
    },
  },
  list_assets: {
    taskless: true,
    description: '列出本台素材：上传的图片 / 片段和生成出来的片段（id、类型、尺寸、时长、来源、授权、被几个镜头用着）。镜头要真实画面时先在这里挑',
    right: 'observe',
    parameters: z.object({ kind: z.enum(['image', 'video', 'audio']).optional().describe('只看某一类') }),
    execute: async (ctx, a) => ({ assets: await listAssets(ctx.db, ctx.agent.workstationId, { kind: a.kind as string | undefined }) }),
  },
  read_asset: {
    taskless: true,
    description: '读一件素材的完整信息：元数据、授权 / 来源、生成用的提示词、被哪些镜头用着',
    right: 'observe',
    parameters: z.object({ id: z.string().describe('素材 id') }),
    execute: async (ctx, a) => (await getAsset(ctx.db, ctx.agent.workstationId, String(a.id))) ?? { error: '素材不存在' },
  },
  generate_clip: {
    taskless: true,
    description: '给镜头申请生成一段素材片段。只创建一条待审批申请 + 一条收件箱条目：人批了平台才提交生成、才花钱，成功后会自己接到镜头上。不要假设申请会被批准，也不要跟人说片段已经好了；进度用 read_clip_request 查',
    right: 'propose',
    parameters: z.object({
      shotId: z.string().describe('镜头 id'),
      prompt: z.string().min(1).max(4000).describe('中文提示词：谁 / 在哪 / 做什么 + 景别机位光线 + 风格'),
      negativePrompt: z.string().max(2000).optional().describe('要避免的东西'),
      duration: z.number().min(1).max(20).optional().describe('秒；不填按镜头时长'),
      image: z.string().optional().describe('以某件图片素材作为首帧（素材 id）'),
    }),
    execute: async (ctx, a) => {
      const r = await requestClip(ctx.actor, ctx.db, ctx.agent.workstationId, { shotId: String(a.shotId), prompt: String(a.prompt), negativePrompt: a.negativePrompt as string | undefined, duration: a.duration as number | undefined, image: a.image as string | undefined });
      return r.kind === 'ok' ? { requestId: r.id, status: r.status, duration: r.duration, estimatedCostMicros: r.estimatedCostMicros, estimatedCost: `$${(r.estimatedCostMicros / 1e6).toFixed(3)}`, provider: r.provider, note: '已提交申请，等人批了才会生成' } : failed(r);
    },
  },
  read_clip_request: {
    taskless: true,
    description: '查片段申请：给 id 看一条；给 videoId 或 shotId 看列表（最新在前）。succeeded 会带回 asset（生成的素材 id），failed 带回原因',
    right: 'observe',
    parameters: z.object({ id: z.string().optional(), videoId: z.string().optional(), shotId: z.string().optional() }),
    execute: async (ctx, a) => {
      const wsId = ctx.agent.workstationId;
      if (a.id) {
        const r = await readClipRequest(ctx.db, wsId, String(a.id));
        return r ?? { error: '片段申请不存在' };
      }
      const list = await listClipRequests(ctx.db, wsId, { videoId: a.videoId as string | undefined, shotId: a.shotId as string | undefined });
      return { requests: list.slice(0, 20) };
    },
  },
  update_shot: {
    taskless: true,
    description: '修改单个镜头的旁白、时长、转场、画面类型或状态（ready 表示画面已确认）',
    right: 'propose',
    parameters: z.object({ id: z.string(), ...shotFields, status: z.enum(['draft', 'ready']).optional(), reason: z.string().optional() }),
    execute: async (ctx, a) => {
      const { id, reason, ...patch } = a as Record<string, unknown> & { id: string; reason?: string };
      const r = await updateShot(ctx.actor, ctx.db, ctx.agent.workstationId, String(id), { ...(patch as Omit<ShotInput, 'id'>), reason });
      return r.kind === 'ok' ? { id: r.id, version: r.version, duration: r.duration, lint: r.lint } : failed(r);
    },
  },
  write_shot_html: {
    taskless: true,
    largeOutput: true,
    description: '用完整 HTML 文档写入一个镜头的画面（画布尺寸 = 视频分辨率，时间 0 = 镜头开始，断网）。局部修改用 edit_shot_html',
    right: 'propose',
    parameters: z.object({ id: z.string().describe('镜头 id'), html: z.string().describe('完整、自包含的 HTML 文档'), reason: z.string().optional() }),
    execute: async (ctx, a) => {
      const r = await saveShotHtml(ctx.actor, ctx.db, ctx.agent.workstationId, String(a.id), { html: String(a.html), reason: a.reason as string | undefined });
      return r.kind === 'ok' ? { id: r.id, version: r.version, duration: r.duration, lint: r.lint } : failed(r);
    },
  },
  edit_shot_html: {
    taskless: true,
    largeOutput: true,
    description: '局部修改镜头画面：一组原文替换，产生一个新版本',
    right: 'propose',
    parameters: z.object({ id: z.string(), edits: z.array(edit).min(1), reason: z.string().optional() }),
    execute: async (ctx, a) => {
      const r = await editShotHtml(ctx.actor, ctx.db, ctx.agent.workstationId, String(a.id), { edits: a.edits as { oldText: string; newText: string }[], reason: a.reason as string | undefined });
      return r.kind === 'ok' ? { id: r.id, version: r.version, duration: r.duration, lint: r.lint } : failed(r);
    },
  },
  view_shot: {
    taskless: true,
    description: '把镜头画面真正渲染出来看：在指定时刻（秒，相对镜头开始，最多 4 个）各截一帧，同时返回溢出、脚本报错等问题；默认看开头、中间和结尾',
    right: 'observe',
    parameters: z.object({ id: z.string().describe('镜头 id'), times: z.array(z.number().min(0)).max(4).optional(), version: z.number().int().optional() }),
    execute: async (ctx, a) => {
      const row = await shotRow(ctx.db, String(a.id));
      if (!row || row.workstationId !== ctx.agent.workstationId) return { error: '镜头不存在' };
      const shot = await renderableShot(ctx.db, row.id, a.version as number | undefined);
      if (!shot) return { error: `版本 v${String(a.version)} 不存在` };
      if (shot.placeholder) return { error: shot.visual === 'html' ? '这个镜头还没有 HTML 画面' : '这个镜头缺素材：先挑素材或申请生成片段' };
      const end = Math.max(0, Math.round((shot.duration - 0.05) * 100) / 100);
      const times = (a.times as number[] | undefined)?.length ? (a.times as number[]).map((t) => Math.min(t, end)) : [0, Math.round(shot.duration * 50) / 100, end];
      const scale = shot.width * shot.height > 1280 * 720 ? 0.5 : 1;
      let out: { frames: { t: number; png: Buffer }[]; issues: string[] };
      try {
        out = shot.media
          ? await renderMediaFrames({ media: { file: shot.media.file, kind: shot.media.kind, motion: shot.media.motion }, width: shot.width, height: shot.height, fps: shot.fps, duration: shot.duration, overlayDoc: shot.hasOverlay ? shot.doc : null, times, scale })
          : await renderShotFrames(shot.doc, { width: shot.width, height: shot.height, scale, times });
      } catch (e) {
        const msg = e instanceof Error ? e.message.split('\n')[0]! : String(e);
        return { error: BROWSER_MISSING.test(msg) ? '本机没有可用的 Chromium，请人在环境里装 playwright chromium 后再试' : `渲染失败：${msg}` };
      }
      await saveShotIssues(ctx.db, shot.shotId, shot.version, out.issues);
      const dir = path.join(os.tmpdir(), 'aw-video-frames');
      fs.mkdirSync(dir, { recursive: true });
      const frames: { t: number; artifactId: string }[] = [];
      for (const f of out.frames) {
        const target = path.join(dir, `${uid()}.png`);
        fs.writeFileSync(target, f.png);
        const artifactId = uid();
        await ctx.db.insert(artifact).values({ id: artifactId, workstationId: ctx.agent.workstationId, type: 'screenshot', name: `${shot.title || '镜头'} v${shot.version} ${f.t}s`, ref: target, metaJson: JSON.stringify({ shotId: shot.shotId, videoId: shot.videoId, version: shot.version, t: f.t }), createdAt: now() });
        frames.push({ t: f.t, artifactId });
      }
      return {
        shotId: shot.shotId, version: shot.version, width: shot.width, height: shot.height, duration: shot.duration, frames, issues: out.issues,
        __images: out.frames.map((f) => ({ mediaType: 'image/png', base64: f.png.toString('base64') })),
      };
    },
  },
  voice_shots: {
    taskless: true,
    description: '给视频的镜头生成配音（按旁白合成）。旁白和音色没变的镜头会跳过，force=true 时重配；没设时长的镜头生效时长随之变成配音时长 + 0.3 秒。每段配音会计入预算',
    right: 'invoke',
    parameters: z.object({ videoId: z.string(), shotIds: z.array(z.string()).max(200).optional().describe('只配这些镜头；不传配全部'), force: z.boolean().optional() }),
    execute: async (ctx, a) => {
      const r = await voiceShots(ctx.actor, ctx.db, ctx.agent.workstationId, String(a.videoId), { shotIds: a.shotIds as string[] | undefined, force: a.force === true });
      if (r.kind !== 'ok') {
        const partial = r as { voiced?: unknown; skipped?: unknown };
        return { error: r.error, ...(partial.voiced ? { voiced: partial.voiced, skipped: partial.skipped } : {}) };
      }
      return { voiced: r.voiced, skipped: r.skipped, cost: `$${(r.costMicros / 1e6).toFixed(4)}`, provider: r.provider, voice: r.voice, speed: r.speed };
    },
  },
  render_video: {
    taskless: true,
    description: '把视频渲染成 mp4（排队后台执行，立刻返回出片 id，不等渲染完）。要先过出片门禁：审片通过且之后内容没改、没有 error、阻断评论都已解决、有旁白的镜头都有最新配音；Agent 不能越过门禁。画面缺失算错误，allowPlaceholders=true 时用占位画面出片；进度、结果和渲染时抽查到的画面问题用 read_render 查',
    right: 'invoke',
    parameters: z.object({
      videoId: z.string(),
      fps: z.number().int().optional().describe('24 / 25 / 30 / 60，默认用视频设置'),
      subtitles: z.enum(['burn', 'srt', 'off']).optional().describe('burn 烧进画面，srt 外挂字幕轨，off 不要；都会另存 .srt'),
      allowPlaceholders: z.boolean().optional(),
    }),
    execute: async (ctx, a) => {
      const r = await createVideoRender(ctx.actor, ctx.db, ctx.agent.workstationId, String(a.videoId), {
        fps: a.fps as number | undefined, subtitles: a.subtitles as 'burn' | 'srt' | 'off' | undefined, allowPlaceholders: a.allowPlaceholders === true,
      });
      if (r.kind !== 'ok') return { error: r.error, ...('gate' in r && r.gate ? { gate: r.gate.checks } : {}) };
      return { renderId: r.id, status: r.status, total: r.total, size: `${r.width}×${r.height}`, fps: r.fps, subtitles: r.subtitles, warnings: r.warnings };
    },
  },
  read_render: {
    taskless: true,
    description: '查出片进度和结果：给 id 看一次出片；只给 videoId 看这支视频最近几次',
    right: 'observe',
    parameters: z.object({ id: z.string().optional(), videoId: z.string().optional() }),
    execute: async (ctx, a) => {
      if (a.id) {
        const r = await getVideoRender(ctx.db, String(a.id));
        return r && r.workstationId === ctx.agent.workstationId ? renderSummary(r) : { error: '出片记录不存在' };
      }
      if (!a.videoId) return { error: '给 id 或 videoId' };
      return { renders: (await listVideoRenders(ctx.db, ctx.agent.workstationId, String(a.videoId))).slice(0, 5).map(renderSummary) };
    },
  },
  comment_shot: {
    taskless: true,
    description: '在镜头的某个时间点留评论（审片意见 / 修改要求）。severity=block 的评论没解决前不能出片；time 是镜头内的秒数',
    right: 'propose',
    parameters: z.object({
      shotId: z.string(),
      time: z.number().min(0).optional().describe('镜头内的秒数，默认 0'),
      body: z.string().min(1).max(4000).describe('问题是什么、要怎么改'),
      severity: z.enum(['block', 'note']).optional().describe('block = 必须改完才能出片；note = 建议，默认 note'),
      anchor: z.string().max(80).optional().describe('说的是画面里哪段文字 / 哪个元素'),
    }),
    execute: async (ctx, a) => {
      const r = await addShotComment(ctx.actor, ctx.db, ctx.agent.workstationId, { shot: String(a.shotId), time: a.time as number | undefined, body: String(a.body), severity: a.severity as 'block' | 'note' | undefined, anchor: a.anchor as string | undefined });
      return r.kind === 'ok' ? { id: r.id, shotId: r.shot, version: r.version, time: r.time, severity: r.severity } : failed(r);
    },
  },
  resolve_shot_comments: {
    taskless: true,
    description: '把处理完的镜头评论标成已解决（按 id），note 写怎么改的',
    right: 'propose',
    parameters: z.object({ ids: z.array(z.string()).min(1).max(100), note: z.string().max(2000).optional() }),
    execute: async (ctx, a) => ({ resolved: await resolveShotComments(ctx.actor, ctx.db, ctx.agent.workstationId, a.ids as string[], a.note as string | undefined) }),
  },
  save_video_review: {
    taskless: true,
    description: '保存审片结论。contentHash 必须是这次 read_video 拿到的值：中途内容被改过会被拒（409），要重新读再审。pass 后视频变成「已审核」，可以出片；具体问题先用 comment_shot 钉在镜头上',
    right: 'propose',
    parameters: z.object({ id: z.string().describe('视频 id'), contentHash: z.string(), verdict: z.enum(['pass', 'fail']), summary: z.string().min(1).max(4000).describe('结论和理由，一段话') }),
    execute: async (ctx, a) => {
      const r = await saveVideoReview(ctx.actor, ctx.db, ctx.agent.workstationId, { id: String(a.id), contentHash: String(a.contentHash), verdict: a.verdict as 'pass' | 'fail', summary: String(a.summary) });
      return r.kind === 'ok' ? { verdict: r.verdict, status: r.status, contentHash: r.contentHash } : failed(r);
    },
  },
  read_video_style: {
    taskless: true,
    description: '读本台视频风格：调色板、字体、配音、背景音乐、字幕样式和风格规则。镜头 HTML 里用 var(--aw-bg) / var(--aw-fg) / var(--aw-accent) / var(--aw-muted) / var(--aw-font-heading) / var(--aw-font-body) 引用',
    right: 'observe',
    parameters: z.object({}),
    execute: async (ctx) => {
      const st = await videoStyleOf(ctx.db, ctx.agent.workstationId);
      return { ...st, cssVars: styleVars(lookOf(st) ?? { palette: st.palette, fonts: st.fonts }), bgmLibrary: (await listVideoMedia(ctx.db, ctx.agent.workstationId)).map((m) => ({ id: m.id, name: m.name, duration: m.duration })) };
    },
  },
  update_video_style: {
    taskless: true,
    description: '修改本台视频风格（只传要改的字段）。字体只能用本机已装的字体名（镜头断网，网络字体加载不了）。改风格会让所有视频的审片结论作废，需要重新审片',
    right: 'propose',
    parameters: z.object({
      name: z.string().max(40).optional(),
      palette: z.record(z.string(), z.string()).optional().describe('颜色：bg / fg / accent / muted 等，值用 #rrggbb、rgb() 或 hsl()'),
      fonts: z.object({ heading: z.string().optional(), body: z.string().optional() }).optional(),
      voice: z.object({ provider: z.string().optional(), voice: z.string().optional(), speed: z.number().min(0.25).max(4).optional(), off: z.boolean().optional() }).optional().describe('默认配音；视频自己设了配音时以视频为准'),
      bgm: z.string().nullable().optional().describe('背景音乐 id（read_video_style 的 bgmLibrary），null 去掉'),
      bgmVolume: z.number().min(0).max(1).optional(),
      ducking: z.boolean().optional().describe('说话时自动压低背景音乐'),
      rules: z.string().max(20000).optional().describe('风格规则（markdown）'),
      subtitle: z.object({ size: z.enum(['s', 'm', 'l']).optional(), position: z.enum(['bottom', 'top']).optional(), background: z.enum(['box', 'shadow', 'none']).optional() }).optional(),
      reason: z.string().optional(),
    }),
    execute: async (ctx, a) => {
      const r = await saveVideoStyle(ctx.actor, ctx.db, ctx.agent.workstationId, a as Parameters<typeof saveVideoStyle>[3]);
      return r.kind === 'ok' ? { id: r.id, version: r.version, palette: r.palette, fonts: r.fonts, subtitle: r.subtitle, bgm: r.bgm } : failed(r);
    },
  },
};
