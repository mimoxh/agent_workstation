import { z } from 'zod';
import { addDocComment, editDoc, listDocs, readDoc, readDocHandoffFor, resolveDocComments, saveDoc, saveDocReview, saveStyleGuide, styleGuideOf, type CitationInput, type DocCitation, type ReviewFinding } from '../../usecases/docs.js';
import type { ToolDef } from './index.js';

const failed = (r: { kind: string; error?: string }) => ({ error: r.error ?? `写入失败（${r.kind}）` });

// 整篇 markdown 读写：默认 8KB 的工具结果上限会把文档截断
const DOC_RESULT_LIMIT = 120 * 1024;

const edit = z.object({ oldText: z.string().describe('要替换的原文，必须逐字一致且在文档里唯一'), newText: z.string() });

const repoCitation = z.object({
  id: z.string().describe('正文脚注标记 [^id] 里的 id'),
  kind: z.literal('repo'),
  repo: z.string().optional().describe('开发工作台 id，见 list_repos；缺省用本台默认仓库'),
  path: z.string(),
  ref: z.string().optional().describe('默认目标分支'),
  lines: z.tuple([z.number().int(), z.number().int()]).describe('引用的起止行号（含两端，最多 200 行）'),
});

const knowledgeCitation = z.object({
  id: z.string(),
  kind: z.literal('knowledge'),
  sourceId: z.string().describe('知识库来源 id，见 search_knowledge 结果'),
  quote: z.string().describe('原文里逐字的一小段'),
});

const citation = z.discriminatedUnion('kind', [repoCitation, knowledgeCitation]);

const finding = z.object({
  claim: z.string().describe('被核对的原句或要点'),
  citation: z.string().optional(),
  status: z.enum(['supported', 'unsupported', 'outdated', 'unverifiable']),
  evidence: z.string(),
});

export const docTools: Record<string, ToolDef> = {
  list_docs: {
    taskless: true,
    description: '列出本台的文档（不含正文）',
    right: 'observe',
    parameters: z.object({}),
    execute: async (ctx) => ({ docs: await listDocs(ctx.db, ctx.agent.workstationId) }),
  },
  read_doc: {
    taskless: true,
    description: '读取一篇文档：正文、引用、核对结论、未解决的评论、lint 和交接条件；可指定历史版本',
    right: 'observe',
    resultLimit: DOC_RESULT_LIMIT,
    parameters: z.object({ id: z.string(), version: z.number().int().optional() }),
    execute: async (ctx, a) => (await readDoc(ctx.db, ctx.agent.workstationId, String(a.id), a.version as number | undefined)) ?? { error: '文档不存在' },
  },
  write_doc: {
    taskless: true,
    largeOutput: true,
    description: '新建文档，或用完整正文覆盖一篇已有文档（带 id）。局部修改用 edit_doc。引用在 citations 里登记，正文用 [^id] 标记',
    right: 'propose',
    parameters: z.object({
      id: z.string().optional().describe('覆盖已有文档时传'),
      title: z.string(),
      kind: z.enum(['readme', 'api', 'guide', 'architecture', 'adr', 'release_notes', 'general']).optional(),
      brief: z.string().optional(),
      target_repo: z.string().optional().describe('目标开发工作台 id，见 list_repos'),
      target_path: z.string().optional().describe('文档在目标仓库里的落点'),
      content: z.string().describe('完整 markdown 正文'),
      citations: z.array(citation).optional(),
      reason: z.string().optional().describe('这一版改了什么，显示在版本历史'),
    }),
    execute: async (ctx, a) => {
      const r = await saveDoc(ctx.actor, ctx.db, ctx.agent.workstationId, {
        id: a.id as string | undefined, title: String(a.title), kind: a.kind as never, brief: a.brief as string | undefined,
        target_repo: a.target_repo as string | undefined, target_path: a.target_path as string | undefined,
        content: String(a.content), citations: a.citations as (CitationInput | DocCitation)[] | undefined, reason: a.reason as string | undefined,
      });
      return r.kind === 'ok' ? { id: r.id, version: r.version, status: r.status, lint: r.lint, citations: r.citations } : failed(r);
    },
  },
  edit_doc: {
    taskless: true,
    largeOutput: true,
    description: '局部修改文档：一组原文替换，产生一个新版本；可同时增改引用（按 id upsert）或删除引用',
    right: 'propose',
    parameters: z.object({ id: z.string(), edits: z.array(edit), citations: z.array(citation).optional(), removeCitations: z.array(z.string()).optional(), reason: z.string().optional() }),
    execute: async (ctx, a) => {
      const r = await editDoc(ctx.actor, ctx.db, ctx.agent.workstationId, String(a.id), {
        edits: a.edits as { oldText: string; newText: string }[],
        citations: a.citations as (CitationInput | DocCitation)[] | undefined,
        removeCitations: a.removeCitations as string[] | undefined,
        reason: a.reason as string | undefined,
      });
      return r.kind === 'ok' ? { id: r.id, version: r.version, status: r.status, lint: r.lint, citations: r.citations } : failed(r);
    },
  },
  comment_doc: {
    taskless: true,
    description: '在文档上留一条评论；quote 从原文逐字摘一小段来钉位置，不写表示针对整篇',
    right: 'speak',
    parameters: z.object({ doc: z.string(), quote: z.string().optional(), heading: z.string().optional(), body: z.string(), severity: z.enum(['block', 'note']).optional() }),
    execute: async (ctx, a) => {
      const r = await addDocComment(ctx.actor, ctx.db, ctx.agent.workstationId, { doc: String(a.doc), quote: a.quote as string | undefined, heading: a.heading as string | undefined, body: String(a.body), severity: a.severity as 'block' | 'note' | undefined });
      return r.kind === 'ok' ? { commentId: r.id } : failed(r);
    },
  },
  resolve_doc_comments: {
    taskless: true,
    description: '把已处理的评论标记为解决，并写一句处理说明',
    right: 'propose',
    parameters: z.object({ ids: z.array(z.string()), note: z.string().optional() }),
    execute: async (ctx, a) => ({ resolved: await resolveDocComments(ctx.actor, ctx.db, ctx.agent.workstationId, a.ids as string[], a.note as string | undefined) }),
  },
  read_style_guide: {
    taskless: true,
    description: '读取本台的术语表、写作规范和 lint 配置',
    right: 'observe',
    parameters: z.object({}),
    execute: async (ctx) => {
      const s = await styleGuideOf(ctx.db, ctx.agent.workstationId);
      return { name: s.name, terms: s.terms, rules: s.rules, lint: s.lint };
    },
  },
  update_style_guide: {
    taskless: true,
    description: '修改风格指南：术语表、写作规范或 lint 配置。影响本台所有文档，只在人同意时使用',
    right: 'propose',
    parameters: z.object({
      terms: z.array(z.object({ term: z.string(), preferred: z.string(), avoid: z.array(z.string()) })).optional(),
      rules: z.string().optional(),
      lint: z.object({ maxHeadingDepth: z.number().int().optional(), maxSentenceChars: z.number().int().optional(), bannedWords: z.array(z.string()).optional(), requiredSections: z.array(z.string()).optional() }).optional(),
      reason: z.string().optional(),
    }),
    execute: async (ctx, a) => {
      const r = await saveStyleGuide(ctx.actor, ctx.db, ctx.agent.workstationId, { terms: a.terms as never, rules: a.rules as string | undefined, lint: a.lint as never, reason: a.reason as string | undefined });
      return r.kind === 'ok' ? { saved: true } : failed(r);
    },
  },
  save_doc_review: {
    taskless: true,
    description: '保存对一篇文档的事实核对结论。contentHash 必传 read_doc 返回的值；文档被改过会拒绝，要重读再核',
    right: 'propose',
    parameters: z.object({ id: z.string(), contentHash: z.string(), verdict: z.enum(['pass', 'fail']), summary: z.string(), findings: z.array(finding) }),
    execute: async (ctx, a) => {
      const r = await saveDocReview(ctx.actor, ctx.db, ctx.agent.workstationId, { id: String(a.id), contentHash: String(a.contentHash), verdict: a.verdict as 'pass' | 'fail', summary: String(a.summary), findings: a.findings as ReviewFinding[] });
      return r.kind === 'ok' ? { verdict: r.verdict, status: r.status } : failed(r);
    },
  },
  read_doc_handoff: {
    description: '读取这个任务交接过来的文档成品：最终文本、落点路径，以及目标分支上该文件交接后是否有改动',
    right: 'observe',
    resultLimit: DOC_RESULT_LIMIT,
    parameters: z.object({}),
    execute: async (ctx) => (await readDocHandoffFor(ctx.db, ctx.task)) ?? { error: '这个任务没有交接的文档' },
  },
};
