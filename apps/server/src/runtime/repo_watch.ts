import { and, eq, inArray } from 'drizzle-orm';
import path from 'node:path';
import type { DB } from '../db/client.js';
import { proposal, task, workstation } from '../db/schema.js';
import { events } from '../events.js';
import { logEvent } from '../usecases/core.js';
import { postStatus } from '../usecases/threads.js';
import { platformHeadOf } from './dev_workflow.js';
import { devSettings, git } from './git.js';

// 双真相源漂移检测：人在平台外改了仓库（手动 commit / 主分支前进 / 已提交的任务分支又被改），工作台要马上知道
export interface RepoDrift {
  targetHead: string | null;
  baseAhead: number;
  external: { from: string; to: string; commits: string[]; at: string } | null;
  checkedAt: string;
}

const POLL_MS = Number(process.env.AW_REPO_POLL_MS ?? 15_000);
const state = new Map<string, RepoDrift>();
const warnedBranches = new Map<string, string>();
const actor = { type: 'human', id: 'local' } as const;

export const repoDrift = (wsId: string): RepoDrift | null => state.get(wsId) ?? null;

async function checkWorkstation(db: DB, ws: typeof workstation.$inferSelect) {
  const s = devSettings(ws.settingsJson);
  if (!path.isAbsolute(s.repoPath)) return;
  const target = (await git(s.repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${s.targetBranch}`])).stdout.trim() || null;
  const base = (await git(s.repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${s.baseBranch}`])).stdout.trim() || null;
  const prev = state.get(ws.id);
  const baseAhead = target && base ? Number((await git(s.repoPath, ['rev-list', '--count', `${target}..${base}`])).stdout.trim()) || 0 : 0;
  let external = prev?.external ?? null;
  if (prev?.targetHead && target && target !== prev.targetHead && platformHeadOf(ws.id) !== target) {
    const log = await git(s.repoPath, ['log', '--format=%h %s', '-n', '10', `${prev.targetHead}..${target}`]);
    external = { from: prev.targetHead, to: target, commits: log.stdout.split('\n').filter(Boolean), at: new Date().toISOString() };
    await logEvent(db, actor, 'workstation_drift', 'workstation', ws.id, { branch: s.targetBranch, from: prev.targetHead, to: target, commits: external.commits.length });
  }
  if (prev && baseAhead > prev.baseAhead) {
    await logEvent(db, actor, 'workstation_base_ahead', 'workstation', ws.id, { branch: s.baseBranch, ahead: baseAhead });
  }
  state.set(ws.id, { targetHead: target, baseAhead, external, checkedAt: new Date().toISOString() });
}

// 已提交待审 / 已通过待合并的任务：分支被改过就提醒，合并时会拒绝
async function checkSubmittedBranches(db: DB) {
  const open = await db.select({ taskId: proposal.taskId }).from(proposal).where(and(eq(proposal.targetType, 'code'), inArray(proposal.status, ['pending', 'approved'])));
  const ids = [...new Set(open.flatMap((p) => (p.taskId ? [p.taskId] : [])))];
  if (ids.length === 0) return;
  for (const t of await db.select().from(task).where(inArray(task.id, ids))) {
    const ref = t.codeRefJson ? (JSON.parse(t.codeRefJson) as { worktree?: string; branch?: string; head_sha?: string }) : null;
    if (!ref?.worktree || !ref.branch || !ref.head_sha) continue;
    const head = (await git(ref.worktree, ['rev-parse', '--verify', '--quiet', `refs/heads/${ref.branch}`])).stdout.trim();
    if (!head || head === ref.head_sha || warnedBranches.get(t.id) === head) continue;
    warnedBranches.set(t.id, head);
    await logEvent(db, actor, 'task_branch_moved', 'task', t.id, { head, reviewed: ref.head_sha });
    await postStatus(db, t.id, `分支 ${ref.branch} 在提交提案后又有新提交（${head.slice(0, 8)}）。审过的是 ${ref.head_sha.slice(0, 8)}，合并时会退回重新提交。`);
  }
}

export async function checkRepos(db: DB) {
  const stations = (await db.select().from(workstation)).filter((w) => w.pluginId === 'dev' && w.settingsJson);
  for (const ws of stations) {
    try { await checkWorkstation(db, ws); } catch (e) { console.error('[repo-watch]', ws.id, String(e)); }
  }
  try { await checkSubmittedBranches(db); } catch (e) { console.error('[repo-watch] branches', String(e)); }
}

// 人点了「知道了」：清掉外部提交提示
export function acknowledgeDrift(wsId: string) {
  const cur = state.get(wsId);
  if (cur) state.set(wsId, { ...cur, external: null });
  events.emit('workstation_drift_ack', { targetId: wsId });
}

let timer: ReturnType<typeof setInterval> | undefined;
export function startRepoWatch(db: DB) {
  if (timer || POLL_MS <= 0) return;
  void checkRepos(db);
  timer = setInterval(() => void checkRepos(db), POLL_MS);
  timer.unref?.();
}
