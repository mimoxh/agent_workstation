import { and, eq } from 'drizzle-orm';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { git, gitOk, devSettings } from '../git.js';
import { runCommand, isDangerous, splitCommand, portEnv, type ExecResult } from '../exec.js';
import { inboxItem, proposal, reviewComment } from '../../db/schema.js';
import type { ToolCtx, ToolDef } from './index.js';
import { events } from '../../events.js';
import { logEvent } from '../../usecases/index.js';

const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();

export function codeRef(t: { codeRefJson: string | null }): { worktree: string; branch: string; base_sha: string; head_sha?: string } | null {
  if (!t.codeRefJson) return null;
  try { return JSON.parse(t.codeRefJson) as { worktree: string; branch: string; base_sha: string; head_sha?: string }; } catch { return null; }
}

function requireWt(ctx: ToolCtx) {
  const ref = codeRef(ctx.task);
  if (!ref?.worktree) return null;
  return ref;
}

// 路径必须落在 worktree 内（防 .. / 符号链接逃逸 / .git）
function safePath(wt: string, p: string): string | null {
  if (p.includes('\0') || path.isAbsolute(p)) return null;
  const abs = path.join(wt, p);
  const rel = path.relative(wt, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel) || rel === '' || rel.startsWith('.git')) return null;
  try {
    const real = realpathSync(path.dirname(abs));
    if (!real.startsWith(realpathSync(wt))) return null;
  } catch { return null; }
  return abs;
}

function moduleOf(ctx: ToolCtx): string {
  try { return String((JSON.parse(ctx.task.inputJson ?? '{}') as { module?: string }).module ?? ''); } catch { return ''; }
}

function inModule(p: string, mod: string): boolean {
  if (!mod) return true;
  const norm = (x: string) => x.replace(/\\/g, '/').replace(/\/+$/, '');
  return norm(p).startsWith(norm(mod));
}

const FILE_LIMIT = 8 * 1024;
const DIFF_LIMIT = 32 * 1024;
const PATCH_DIFF_LIMIT = 200 * 1024;

export const devTools: Record<string, ToolDef> = {
  read_file: {
    description: '读取任务 worktree 内文件（带行号）',
    right: 'observe',
    parameters: z.object({ path: z.string(), startLine: z.number().optional(), endLine: z.number().optional() }),
    execute: async (ctx, a) => {
      const ref = requireWt(ctx);
      if (!ref) return { error: '任务没有 worktree' };
      const abs = safePath(ref.worktree, String(a.path));
      if (!abs || !existsSync(abs)) return { error: '路径非法或不存在' };
      const lines = readFileSync(abs, 'utf8').split('\n');
      const s = Math.max(1, Number(a.startLine ?? 1));
      const e = Math.min(lines.length, Number(a.endLine ?? lines.length));
      let out = lines.slice(s - 1, e).map((l, i) => `${s + i}: ${l}`).join('\n');
      if (out.length > FILE_LIMIT) out = `${out.slice(0, FILE_LIMIT)}\n…[truncated]`;
      return { content: out };
    },
  },
  search_code: {
    description: 'git grep 搜索（默认限 module 路径）',
    right: 'observe',
    parameters: z.object({ query: z.string(), path: z.string().optional() }),
    execute: async (ctx, a) => {
      const ref = requireWt(ctx);
      if (!ref) return { error: '任务没有 worktree' };
      const mod = moduleOf(ctx);
      const scope = a.path ? String(a.path) : mod;
      if (!inModule(scope, mod)) return { error: '越出 Module' };
      const r = await git(ref.worktree, ['grep', '-n', '-I', '-F', String(a.query), '--', scope || '.']);
      return { matches: r.stdout.split('\n').filter(Boolean).slice(0, 50) };
    },
  },
  git_diff: {
    description: 'worktree 相对 base_sha 的完整 diff（含未提交）',
    right: 'observe',
    parameters: z.object({}),
    execute: async (ctx) => {
      const ref = requireWt(ctx);
      if (!ref) return { error: '任务没有 worktree' };
      await git(ref.worktree, ['add', '-N', '.']);
      const r = await git(ref.worktree, ['diff', ref.base_sha]);
      const out = r.stdout;
      return { diff: out.length > DIFF_LIMIT ? `${out.slice(0, DIFF_LIMIT)}\n…[truncated]` : out };
    },
  },
  apply_patch: {
    description: '原子化编辑文件（oldText 必须恰好出现一次；paths 必须在 module 内）',
    right: 'propose',
    parameters: z.object({
      edits: z.array(z.object({ path: z.string(), oldText: z.string(), newText: z.string() })).default([]),
      creates: z.array(z.object({ path: z.string(), content: z.string() })).default([]),
    }),
    execute: async (ctx, a) => {
      const ref = requireWt(ctx);
      if (!ref) return { error: '任务没有 worktree' };
      const mod = moduleOf(ctx);
      const edits = (a.edits ?? []) as { path: string; oldText: string; newText: string }[];
      const creates = (a.creates ?? []) as { path: string; content: string }[];
      // 先全部校验
      const plans: { abs: string; content: string; eol: string }[] = [];
      for (const c of creates) {
        if (!inModule(c.path, mod)) return { error: `越出 Module：${c.path}` };
        const abs = safePath(ref.worktree, c.path);
        if (!abs) return { error: `路径非法：${c.path}` };
        plans.push({ abs, content: c.content, eol: '\n' });
      }
      for (const e of edits) {
        if (!inModule(e.path, mod)) return { error: `越出 Module：${e.path}` };
        const abs = safePath(ref.worktree, e.path);
        if (!abs || !existsSync(abs)) return { error: `路径非法或不存在：${e.path}` };
        const cur = readFileSync(abs, 'utf8');
        const eol = cur.includes('\r\n') ? '\r\n' : '\n';
        const normCur = cur.replace(/\r\n/g, '\n');
        const normOld = e.oldText.replace(/\r\n/g, '\n');
        const count = normCur.split(normOld).length - 1;
        if (count !== 1) return { error: `${e.path}：oldText 出现 ${count} 次（要求恰好 1 次）` };
        plans.push({ abs, content: normCur.replace(normOld, e.newText.replace(/\r\n/g, '\n')), eol });
      }
      for (const p of plans) {
        mkdirSync(path.dirname(p.abs), { recursive: true });
        writeFileSync(p.abs, p.eol === '\r\n' ? p.content.replace(/\n/g, '\r\n') : p.content);
      }
      return { edited: plans.length };
    },
  },
  git_commit: {
    description: '提交 worktree 改动（限 module 内）',
    right: 'propose',
    parameters: z.object({ message: z.string() }),
    execute: async (ctx, a) => {
      const ref = requireWt(ctx);
      if (!ref) return { error: '任务没有 worktree' };
      const mod = moduleOf(ctx);
      const r = await git(ref.worktree, ['diff', '--name-only', ref.base_sha]);
      const untracked = await git(ref.worktree, ['ls-files', '--others', '--exclude-standard']);
      const files = [...r.stdout.split('\n'), ...untracked.stdout.split('\n')].filter(Boolean);
      const out = files.filter((f) => !inModule(f, mod));
      if (out.length > 0) return { error: `越出 Module 的改动：${out.join(', ')}` };
      await gitOk(ref.worktree, ['add', '-A']);
      const email = `agent-${ctx.agent.id.slice(0, 8)}@aw.local`;
      const c = await git(ref.worktree, ['-c', `user.name=${ctx.agent.name}`, '-c', `user.email=${email}`, 'commit', '-m', String(a.message)]);
      if (c.code !== 0) return { error: c.stderr || 'nothing to commit' };
      const sha = (await gitOk(ref.worktree, ['rev-parse', 'HEAD'])).stdout.trim();
      return { sha };
    },
  },
  submit_change: {
    description: '提交改动提案（需分支领先 base 且无未提交改动）',
    right: 'propose',
    parameters: z.object({ summary: z.string() }),
    execute: async (ctx, a) => {
      const ref = requireWt(ctx);
      if (!ref) return { error: '任务没有 worktree' };
      const status = await git(ref.worktree, ['status', '--porcelain']);
      if (status.stdout.trim()) return { error: '存在未提交改动' };
      const count = await git(ref.worktree, ['rev-list', '--count', `${ref.base_sha}..HEAD`]);
      if (Number(count.stdout.trim()) < 1) return { error: '分支未领先 base' };
      const head = (await gitOk(ref.worktree, ['rev-parse', 'HEAD'])).stdout.trim();
      const diff = await git(ref.worktree, ['diff', `${ref.base_sha}..HEAD`]);
      const d = diff.stdout;
      const pid = uid();
      const { supersedePending } = await import('../dev_workflow.js');
      await supersedePending(ctx.db, ctx.task.id);
      await ctx.db.insert(proposal).values({
        id: pid, taskId: ctx.task.id, targetType: 'code', baseVersion: 0,
        patchJson: d.length > PATCH_DIFF_LIMIT ? `${d.slice(0, PATCH_DIFF_LIMIT)}\n…[truncated]` : d,
        reason: String(a.summary), authorType: 'agent', authorId: ctx.agent.id,
        status: 'pending', createdAt: now(),
      });
      await ctx.db.update((await import('../../db/schema.js')).task).set({ codeRefJson: JSON.stringify({ ...ref, head_sha: head }) }).where(eq((await import('../../db/schema.js')).task.id, ctx.task.id));
      await logEvent(ctx.db, ctx.actor, 'proposal_created', 'proposal', pid, { kind: 'code' });
      const { afterSubmit } = await import('../dev_workflow.js');
      await afterSubmit(ctx, pid);
      return { proposalId: pid, head_sha: head };
    },
  },
  review_change: {
    description: '审查当前任务最新 pending proposal',
    right: 'propose',
    parameters: z.object({
      decision: z.enum(['approve', 'request_changes']),
      summary: z.string(),
      comments: z.array(z.object({ path: z.string(), line: z.number().optional(), body: z.string() })).optional(),
    }),
    execute: async (ctx, a) => {
      const p = (await ctx.db.select().from(proposal).where(and(eq(proposal.taskId, ctx.task.id), eq(proposal.status, 'pending')))).pop();
      if (!p) return { error: '没有 pending 提案' };
      for (const c of (a.comments ?? []) as { path: string; line?: number; body: string }[]) {
        await ctx.db.insert(reviewComment).values({ id: uid(), proposalId: p.id, authorType: ctx.actor.type, authorId: ctx.actor.id, path: c.path, line: c.line ?? null, body: c.body, resolved: 0, createdAt: now() });
      }
      await ctx.db.update(proposal).set({ status: a.decision === 'approve' ? 'approved' : 'changes_requested' }).where(eq(proposal.id, p.id));
      await logEvent(ctx.db, ctx.actor, a.decision === 'approve' ? 'proposal_approved' : 'proposal_changes_requested', 'proposal', p.id, { summary: a.summary });
      const { afterReview } = await import('../dev_workflow.js');
      await afterReview(ctx, p.id, a.decision as 'approve' | 'request_changes');
      return { proposalId: p.id };
    },
  },
  run_command: {
    description: '在任务 worktree 里执行受控命令',
    right: 'invoke',
    parameters: z.object({ command: z.string() }),
    execute: async (ctx, a) => {
      const ref = requireWt(ctx);
      if (!ref) return { error: '任务没有 worktree' };
      const cmd = String(a.command);
      const argv = splitCommand(cmd);
      const ws = (await ctx.db.select().from((await import('../../db/schema.js')).workstation).where(eq((await import('../../db/schema.js')).workstation.id, ctx.agent.workstationId)))[0];
      const s = devSettings(ws?.settingsJson ?? null);
      if (argv && isDangerous(argv)) {
        // 生成 inbox command_confirm 并原地等待
        const p = await ctx.db.select().from((await import('../../db/schema.js')).project).where(eq((await import('../../db/schema.js')).project.id, ctx.task.projectId));
        const iid = uid();
        await ctx.db.insert(inboxItem).values({
          id: iid, workspaceId: p[0]?.workspaceId ?? 'default', projectId: ctx.task.projectId, kind: 'command_confirm',
          refType: 'task', refId: ctx.task.id, status: 'open',
          payloadJson: JSON.stringify({ command: cmd, cwd: ref.worktree, agentId: ctx.agent.id }),
          createdAt: now(),
        });
        events.emit('inbox_created', { kind: 'command_confirm', refId: iid });
        const deadline = Date.now() + Math.min(300_000, 300_000);
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 2000));
          const row = (await ctx.db.select().from(inboxItem).where(eq(inboxItem.id, iid)))[0];
          if (row?.status === 'resolved') {
            const decision = (JSON.parse(row.resolutionJson ?? '{}') as { decision?: string }).decision;
            if (decision === 'approve') break;
            return { error: '命令被拒绝' };
          }
        }
        const row = (await ctx.db.select().from(inboxItem).where(eq(inboxItem.id, iid)))[0];
        if (row?.status !== 'resolved') return { error: '命令确认超时' };
      }
      const t0 = Date.now();
      const res: ExecResult = await runCommand({ cwd: ref.worktree, command: cmd, timeoutSec: s.commandTimeoutSec, env: portEnv(path.basename(ref.worktree)) });
      await logEvent(ctx.db, ctx.actor, 'command_executed', 'task', ctx.task.id, { cwd: ref.worktree, argv: argv ?? [], exitCode: res.exitCode, ms: res.durationMs });
      return { exitCode: res.exitCode, durationMs: res.durationMs, output: res.output, truncated: res.truncated, timedOut: res.timedOut, waited: Date.now() - t0 };
    },
  },
};
