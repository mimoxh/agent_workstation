import type { DesignTweak } from '@aw/domain';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { artifact, entityVersion } from '../../db/schema.js';
import { createEntity } from '../../usecases/entities.js';
import { designRow, editDesign, listDesignComments, listDesigns, readHandoffFor, renderableDesign, resolveDesignComments, saveDesign, type DesignData } from '../../usecases/designs.js';
import { BROWSER_MISSING, renderDesign, VIEWPORTS, type ViewportName } from '../design_render.js';
import type { ToolDef } from './index.js';

const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();

const tweak = z.object({
  id: z.string(),
  label: z.string(),
  cssVar: z.string().regex(/^--[\w-]+$/),
  type: z.enum(['color', 'range', 'select']),
  value: z.string(),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().optional(),
  unit: z.string().optional(),
  options: z.array(z.string()).optional(),
});

const edit = z.object({ oldText: z.string().describe('要替换的原文，必须逐字一致且在稿子里唯一'), newText: z.string() });

const failed = (r: { kind: string; error?: string }) => ({ error: r.error ?? `写入失败（${r.kind}）` });

// 整份 HTML 读写：默认 8KB 的工具结果上限会把稿子截断成半份
const DESIGN_RESULT_LIMIT = 120 * 1024;

export const designTools: Record<string, ToolDef> = {
  list_designs: {
    taskless: true,
    description: '列出本台的设计稿（不含正文）',
    right: 'observe',
    parameters: z.object({}),
    execute: async (ctx) => ({ designs: await listDesigns(ctx.db, ctx.agent.workstationId) }),
  },
  read_design: {
    taskless: true,
    description: '读取一份设计稿的 HTML、旋钮和未解决的评论；可指定历史版本',
    right: 'observe',
    resultLimit: DESIGN_RESULT_LIMIT,
    parameters: z.object({ id: z.string(), version: z.number().int().optional() }),
    execute: async (ctx, a) => {
      const row = await designRow(ctx.db, String(a.id));
      if (!row || row.workstationId !== ctx.agent.workstationId) return { error: '设计稿不存在' };
      let dataJson = row.dataJson;
      if (a.version !== undefined) {
        const old = (await ctx.db.select().from(entityVersion).where(and(eq(entityVersion.entityId, row.id), eq(entityVersion.version, Number(a.version)))))[0];
        if (!old) return { error: `版本 v${String(a.version)} 不存在` };
        dataJson = old.dataJson;
      }
      const comments = (await listDesignComments(ctx.db, ctx.agent.workstationId, row.id)).filter((c) => c.status !== 'resolved');
      const data = JSON.parse(dataJson ?? '{}') as DesignData;
      const note = data.legacyTokens?.length ? '这份稿子沿用旧版令牌（已注入 :root），改稿时可以把需要的变量直接写进稿子里的 <style>' : undefined;
      return { id: row.id, latestVersion: row.version, ...data, ...(note ? { note } : {}), openComments: comments };
    },
  },
  write_design: {
    taskless: true,
    largeOutput: true,
    description: '新建设计稿，或用完整 HTML 覆盖一份已有设计稿（带 id）。局部修改用 edit_design',
    right: 'propose',
    parameters: z.object({
      id: z.string().optional().describe('覆盖已有设计稿时传'),
      title: z.string(),
      html: z.string().describe('完整、自包含的 HTML 文档'),
      brief: z.string().optional().describe('这份稿子要解决的需求'),
      group: z.string().optional().describe('同一需求的多个方向用同一个组名'),
      direction: z.string().optional().describe('这个方向一句话的设计取向'),
      tweaks: z.array(tweak).optional(),
      reason: z.string().optional().describe('这一版改了什么，显示在版本历史'),
    }),
    execute: async (ctx, a) => {
      const r = await saveDesign(ctx.actor, ctx.db, ctx.agent.workstationId, {
        id: a.id as string | undefined, title: String(a.title), html: String(a.html), brief: a.brief as string | undefined,
        group: a.group as string | undefined, direction: a.direction as string | undefined, tweaks: a.tweaks as DesignTweak[] | undefined, reason: a.reason as string | undefined,
      });
      return r.kind === 'ok' ? { id: r.id, version: r.version, warnings: r.warnings } : failed(r);
    },
  },
  edit_design: {
    taskless: true,
    largeOutput: true,
    description: '局部修改设计稿：一组原文替换，产生一个新版本；也可以同时更新旋钮',
    right: 'propose',
    parameters: z.object({ id: z.string(), edits: z.array(edit), tweaks: z.array(tweak).optional(), reason: z.string().optional() }),
    execute: async (ctx, a) => {
      const r = await editDesign(ctx.actor, ctx.db, ctx.agent.workstationId, String(a.id), { edits: a.edits as { oldText: string; newText: string }[], tweaks: a.tweaks as DesignTweak[] | undefined, reason: a.reason as string | undefined });
      return r.kind === 'ok' ? { id: r.id, version: r.version, warnings: r.warnings } : failed(r);
    },
  },
  comment_design: {
    taskless: true,
    description: '在设计稿的元素上留一条评论；selector 留空表示针对整页',
    right: 'speak',
    parameters: z.object({ designId: z.string(), selector: z.string().optional(), body: z.string() }),
    execute: async (ctx, a) => {
      const row = await designRow(ctx.db, String(a.designId));
      if (!row || row.workstationId !== ctx.agent.workstationId) return { error: '设计稿不存在' };
      const r = await createEntity(ctx.actor, ctx.db, row.workstationId, { entityType: 'DesignComment', data: { design: row.id, version: row.version, selector: (a.selector as string | undefined) ?? '', body: String(a.body), status: 'open' } });
      return r.kind === 'ok' ? { commentId: r.id } : failed(r);
    },
  },
  resolve_design_comments: {
    taskless: true,
    description: '把已处理的评论标记为解决，并写一句处理说明',
    right: 'propose',
    parameters: z.object({ ids: z.array(z.string()), note: z.string().optional() }),
    execute: async (ctx, a) => ({ resolved: await resolveDesignComments(ctx.actor, ctx.db, ctx.agent.workstationId, a.ids as string[], a.note as string | undefined) }),
  },
  view_design: {
    taskless: true,
    description: '把设计稿真正渲染出来看一眼：按断点截图，版式、层级、溢出以渲染结果为准',
    right: 'observe',
    parameters: z.object({ id: z.string(), version: z.number().int().optional(), viewport: z.enum(['desktop', 'tablet', 'mobile']).optional().describe('断点，默认 desktop') }),
    execute: async (ctx, a) => {
      const doc = await renderableDesign(ctx.db, String(a.id), a.version as number | undefined);
      if (!doc || doc.workstationId !== ctx.agent.workstationId) return { error: '设计稿不存在' };
      const viewport = (a.viewport as ViewportName | undefined) ?? 'desktop';
      let buf: Buffer;
      try {
        buf = await renderDesign(doc.html, { width: VIEWPORTS[viewport], format: 'png' });
      } catch (e) {
        const msg = e instanceof Error ? e.message.split('\n')[0]! : String(e);
        return { error: BROWSER_MISSING.test(msg) ? '本机没有可用的 Chromium，请人在环境里装 playwright chromium 后再试' : `渲染失败：${msg}` };
      }
      const target = path.join(os.tmpdir(), 'aw-design-shots', `${uid()}.png`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, buf);
      const artifactId = uid();
      await ctx.db.insert(artifact).values({ id: artifactId, workstationId: ctx.agent.workstationId, type: 'screenshot', name: `${doc.title} v${doc.version} ${viewport}`, ref: target, metaJson: JSON.stringify({ designId: String(a.id), version: doc.version, viewport }), createdAt: now() });
      return { artifactId, viewport, width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), __images: [{ mediaType: 'image/png', base64: buf.toString('base64') }] };
    },
  },
  read_design_handoff: {
    description: '读取这个任务交接过来的设计稿：HTML（已内联旧版令牌）和需求',
    right: 'observe',
    resultLimit: DESIGN_RESULT_LIMIT,
    parameters: z.object({}),
    execute: async (ctx) => (await readHandoffFor(ctx.db, ctx.task)) ?? { error: '这个任务没有交接的设计稿' },
  },
};
