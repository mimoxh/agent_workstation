import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { proposal, workstation } from '../../db/schema.js';
import { logEvent } from '../../usecases/core.js';
import { pushInbox } from '../../usecases/inbox.js';
import { postMessage, taskThreadOf } from '../../usecases/threads.js';
import { git } from '../git.js';
import { hashContent, listFolder, projectFolderOf, readFolderFile, resolveInside, searchFolder } from '../folder.js';
import type { RunCtx, ToolDef } from './index.js';

const AFTER_LIMIT = 512 * 1024;
const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();

const threadOf = async (ctx: RunCtx) => ctx.thread ?? (ctx.task ? await taskThreadOf(ctx.db, ctx.task.id) : null);
const speaker = (ctx: RunCtx) => ({ type: 'agent' as const, id: ctx.agent.id });

// 写提案的路径多一层限制：.git 的任何层级都不许落笔
function resolveForWrite(root: string, rel: string) {
  const r = resolveInside(root, rel, { forFile: true });
  if (!r.ok) return r;
  if (r.rel.split('/').includes('.git')) return { ok: false as const, error: '路径不合法' };
  return r;
}

// 人审提案用统一 diff：git --no-index 给两个临时文件，再把头换成真实路径
async function unifiedDiff(rel: string, before: string, after: string, isNew: boolean): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-diff-'));
  try {
    fs.writeFileSync(path.join(dir, 'a'), before);
    fs.writeFileSync(path.join(dir, 'b'), after);
    const r = await git(dir, ['diff', '--no-index', '--no-color', '-U3', 'a', 'b']);
    if (r.code !== 1 || !r.stdout) return '';
    let header = true;
    return r.stdout
      .split('\n')
      .map((l) => {
        if (l.startsWith('@@')) header = false;
        if (!header) return l;
        if (l.startsWith('diff --git ')) return `diff --git a/${rel} b/${rel}`;
        if (l.startsWith('--- ')) return isNew ? '--- /dev/null' : `--- a/${rel}`;
        if (l.startsWith('+++ ')) return `+++ b/${rel}`;
        return l;
      })
      .join('\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// 项目文件夹：Agent 只读，改动打包成提案等人审批（对应 ARCHITECTURE 里实体提案的同一道闸）
export const folderTools: Record<string, ToolDef> = {
  list_folder: {
    taskless: true,
    description: '列出项目文件夹某个目录下的条目（目录在前）；path 缺省为根目录',
    right: 'observe',
    parameters: z.object({ path: z.string().optional() }),
    execute: async (ctx, a) => {
      const f = await projectFolderOf(ctx.db, ctx.agent.workstationId);
      if (!f.ok) return { error: f.error };
      const r = listFolder(f.root, (a.path as string | undefined) ?? '');
      return r.ok ? { entries: r.entries, truncated: r.truncated } : { error: r.error };
    },
  },
  read_folder_file: {
    taskless: true,
    description: '读项目文件夹里的一个文件；numbered 为 true 时每行带行号前缀',
    right: 'observe',
    parameters: z.object({ path: z.string(), numbered: z.boolean().optional().describe('true 时给每行加行号前缀（`12| ...`）') }),
    execute: async (ctx, a) => {
      const f = await projectFolderOf(ctx.db, ctx.agent.workstationId);
      if (!f.ok) return { error: f.error };
      const r = readFolderFile(f.root, String(a.path));
      if (!r.ok) return { error: r.error };
      const content = a.numbered ? r.content.split('\n').map((l, i) => `${i + 1}| ${l}`).join('\n') : r.content;
      return { path: r.path, content, size: r.size, binary: r.binary, truncated: r.truncated };
    },
  },
  search_folder: {
    taskless: true,
    description: '在项目文件夹里按子串搜索文本，返回 路径:行号: 行内容；大小写敏感，跳过二进制和大文件',
    right: 'observe',
    parameters: z.object({ query: z.string().min(2) }),
    execute: async (ctx, a) => {
      const f = await projectFolderOf(ctx.db, ctx.agent.workstationId);
      if (!f.ok) return { error: f.error };
      const r = searchFolder(f.root, String(a.query));
      return r.ok ? { matches: r.matches, more: r.more } : { error: r.error };
    },
  },
  propose_file_change: {
    taskless: true,
    description: '对项目文件夹提交一个文件改动提案，人审批后平台才写入。content 整篇写入；edits 按序替换，每段 oldText 必须在当前文件里恰好出现一次。新文件只能用 content',
    right: 'propose',
    parameters: z.object({
      path: z.string(),
      content: z.string().optional(),
      edits: z.array(z.object({ oldText: z.string().min(1), newText: z.string() })).optional(),
      reason: z.string(),
    }),
    execute: async (ctx, a) => {
      const f = await projectFolderOf(ctx.db, ctx.agent.workstationId);
      if (!f.ok) return { error: f.error };
      const hasContent = a.content !== undefined;
      const hasEdits = a.edits !== undefined && (a.edits as unknown[]).length > 0;
      if (hasContent === hasEdits) return { error: 'content 和 edits 二选一' };
      const r = resolveForWrite(f.root, String(a.path));
      if (!r.ok) return { error: r.error };

      let before: string | null = null;
      let after: string;
      if (fs.existsSync(r.abs)) {
        const buf = fs.readFileSync(r.abs);
        if (buf.subarray(0, 8000).includes(0)) return { error: '二进制文件不支持改动提案' };
        before = buf.toString('utf8');
        if (hasContent) after = String(a.content);
        else {
          after = before;
          for (const [i, e] of (a.edits as { oldText: string; newText: string }[]).entries()) {
            const first = after.indexOf(e.oldText);
            if (first === -1) return { error: `第 ${i + 1} 段 oldText 未找到` };
            if (after.indexOf(e.oldText, first + e.oldText.length) !== -1) return { error: `第 ${i + 1} 段 oldText 出现多次，请提供更多上下文` };
            after = after.slice(0, first) + e.newText + after.slice(first + e.oldText.length);
          }
        }
      } else {
        if (!hasContent) return { error: '文件不存在，新文件只能用 content 整篇写入' };
        after = String(a.content);
      }
      if (after.length > AFTER_LIMIT) return { error: '改动后文件超过 512 KB，请分段提交' };
      if (before === after) return { error: '内容没有变化' };

      const diff = await unifiedDiff(r.rel, before ?? '', after, before === null);
      const id = uid();
      const ws = (await ctx.db.select().from(workstation).where(eq(workstation.id, ctx.agent.workstationId)))[0];
      if (!ws) return { error: '工作台不存在' };
      await ctx.db.insert(proposal).values({
        id,
        taskId: ctx.task?.id ?? null,
        workstationId: ws.id,
        targetType: 'file',
        baseVersion: 0,
        patchJson: JSON.stringify({ path: r.rel, before, after, baseHash: before === null ? null : hashContent(before), diff }),
        reason: String(a.reason),
        authorType: 'agent',
        authorId: ctx.agent.id,
        status: 'pending',
        createdAt: now(),
      });
      await logEvent(ctx.db, ctx.actor, 'proposal_created', 'proposal', id, { path: r.rel });
      await pushInbox(ctx.db, ws.projectId, { kind: 'proposal_review', refType: 'proposal', refId: id });
      const th = await threadOf(ctx);
      if (th) await postMessage(ctx.db, th.id, speaker(ctx), `提交文件改动：${r.rel}`, 'proposal_notice', { proposalId: id });
      return { proposalId: id };
    },
  },
};
