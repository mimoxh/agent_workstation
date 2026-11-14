import { z } from 'zod';
import { listRepoSources, repoSourceOf } from '../../usecases/repo_source.js';
import { git } from '../git.js';
import type { RunCtx, ToolDef } from './index.js';

const FILE_LIMIT = 60 * 1024;
const REF = /^[\w][\w./@-]*$/;
const SAFE_PATH = /^[^-\0][^\0]*$/;

const sourceOf = (ctx: RunCtx, repo: unknown) => repoSourceOf(ctx.db, ctx.agent.workstationId, repo as string | undefined);

// 本项目开发台仓库的只读访问：开发台的质量成员和文档台共用；repo 参数选仓库，缺省用工作台默认
export const repoReadTools: Record<string, ToolDef> = {
  list_repos: {
    taskless: true,
    description: '列出本项目开发工作台绑定的仓库：写文档选目标仓库、读代码选 repo 参数时用这里的 id',
    right: 'observe',
    parameters: z.object({}),
    execute: async (ctx) => ({ repos: await listRepoSources(ctx.db, ctx.agent.workstationId) }),
  },
  read_repo_file: {
    taskless: true,
    description: '按分支或提交只读地读取仓库的文件；repo 指定开发工作台 id，缺省用本台默认仓库',
    right: 'observe',
    resultLimit: FILE_LIMIT + 1024,
    parameters: z.object({ path: z.string(), ref: z.string().optional().describe('默认目标分支'), repo: z.string().optional().describe('开发工作台 id，见 list_repos'), numbered: z.boolean().optional().describe('true 时给每行加真实行号前缀（`12| ...`），引行号时用') }),
    execute: async (ctx, a) => {
      const source = await sourceOf(ctx, a.repo);
      if (!source.ok) return { error: source.error };
      const ref = (a.ref as string | undefined) ?? source.settings.targetBranch;
      const file = String(a.path).replace(/\\/g, '/').replace(/^\.?\/+/, '');
      if (!REF.test(ref) || !SAFE_PATH.test(file) || file.split('/').includes('..')) return { error: '路径或版本不合法' };
      const r = await git(source.settings.repoPath, ['show', `${ref}:${file}`]);
      if (r.code !== 0) return { error: `读取失败：${r.stderr.trim().slice(0, 200)}` };
      const text = a.numbered ? r.stdout.split('\n').map((l, i) => `${i + 1}| ${l}`).join('\n') : r.stdout;
      return { path: file, ref, truncated: text.length > FILE_LIMIT, content: text.slice(0, FILE_LIMIT) };
    },
  },
  search_repo: {
    taskless: true,
    description: '在仓库的某个版本里搜索文本，返回文件和行；repo 指定开发工作台 id，缺省用本台默认仓库',
    right: 'observe',
    parameters: z.object({ query: z.string().min(2), ref: z.string().optional().describe('默认目标分支'), repo: z.string().optional().describe('开发工作台 id，见 list_repos') }),
    execute: async (ctx, a) => {
      const source = await sourceOf(ctx, a.repo);
      if (!source.ok) return { error: source.error };
      const ref = (a.ref as string | undefined) ?? source.settings.targetBranch;
      if (!REF.test(ref)) return { error: '版本不合法' };
      const r = await git(source.settings.repoPath, ['grep', '-n', '-I', '-F', '--max-count=20', '-e', String(a.query), ref]);
      if (r.code > 1 || r.code < 0) return { error: `搜索失败：${r.stderr.trim().slice(0, 200)}` };
      const hits = r.stdout.split('\n').filter(Boolean);
      return { matches: hits.slice(0, 80).map((l) => l.slice(ref.length + 1, ref.length + 301)), more: Math.max(0, hits.length - 80) };
    },
  },
};
