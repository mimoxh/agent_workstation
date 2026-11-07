import { extractMentions, TERMINAL, type TaskStatus } from '@aw/domain';
import { eq } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { agent, task, thread, workstation } from '../db/schema.js';
import { events } from '../events.js';
import { manifestOf } from '../usecases/core.js';
import { executingWs, stewardOf } from '../usecases/flow.js';
import { conversationOf, PLATFORM, postMessage, threadAgents } from '../usecases/threads.js';
import { triggerRun, triggerThreadRun } from './scheduler.js';
import type { ThreadRow } from './types.js';

interface Turn { agentId: string; trigger: string }

// 发言队列在内存里：进程重启后线程自然回到等人发话的状态
const queues = new Map<string, Turn[]>();
const speaking = new Map<string, string>();

const loadThread = async (db: DB, id: string) => (await db.select().from(thread).where(eq(thread.id, id)))[0];

const hostWs = async (db: DB, th: ThreadRow) => {
  if (th.scopeType === 'workstation') return th.scopeId;
  if (th.scopeType === 'task') {
    const t = (await db.select().from(task).where(eq(task.id, th.scopeId ?? '')))[0];
    return t ? executingWs(t) : null;
  }
  return (await db.select().from(agent).where(eq(agent.id, th.scopeId ?? '')))[0]?.workstationId ?? null;
};

const settingsOf = async (db: DB, wsId: string | null) => {
  const ws = wsId ? (await db.select().from(workstation).where(eq(workstation.id, wsId)))[0] : undefined;
  return { ws, conf: conversationOf(ws) };
};

function enqueue(threadId: string, turn: Turn) {
  const q = queues.get(threadId) ?? [];
  if (!q.some((t) => t.agentId === turn.agentId)) q.push(turn);
  queues.set(threadId, q);
}

const startTurn = (db: DB, th: ThreadRow, turn: Turn) =>
  th.scopeType === 'task'
    ? triggerRun(db, turn.agentId, th.scopeId!, turn.trigger, { threadId: th.id })
    : triggerThreadRun(db, turn.agentId, th.id, turn.trigger);

// 一条线程同一时刻只有一个 Agent 发言；排不上（它正在跑别的）就留在队头等下一次 run 结束
async function pump(db: DB, threadId: string) {
  if (speaking.has(threadId)) return;
  const q = queues.get(threadId);
  while (q && q.length > 0) {
    const th = await loadThread(db, threadId);
    if (!th || th.state === 'silenced') {
      queues.delete(threadId);
      return;
    }
    const r = await startTurn(db, th, q[0]!);
    if (r.ok) {
      q.shift();
      speaking.set(threadId, r.runId!);
      return;
    }
    if (r.error?.includes('已在队列')) return;
    q.shift();
  }
}

const silence = async (db: DB, threadId: string, note: string) => {
  await db.update(thread).set({ state: 'silenced' }).where(eq(thread.id, threadId));
  queues.delete(threadId);
  await postMessage(db, threadId, PLATFORM, note, 'status');
};

// 人默认在和负责这件事的 Agent 说话；讨论线程由 steward 主持
async function defaultResponder(db: DB, th: ThreadRow): Promise<Turn | null> {
  if (th.kind === 'dm') return th.scopeId ? { agentId: th.scopeId, trigger: 'human_reply' } : null;
  if (th.scopeType === 'workstation') {
    if (th.mode !== 'moderated') return null;
    const steward = await stewardOf(db, th.scopeId ?? '');
    return steward ? { agentId: steward.id, trigger: 'moderated' } : null;
  }
  const t = (await db.select().from(task).where(eq(task.id, th.scopeId ?? '')))[0];
  if (!t || TERMINAL.includes(t.status as TaskStatus) || t.status === 'draft' || t.assigneeType === 'human') return null;
  if (t.assigneeType === 'agent' && t.assigneeId) return { agentId: t.assigneeId, trigger: 'human_reply' };
  const steward = await stewardOf(db, executingWs(t));
  return steward ? { agentId: steward.id, trigger: 'human_reply' } : null;
}

const canHearMention = async (db: DB, a: typeof agent.$inferSelect) => {
  const ws = (await db.select().from(workstation).where(eq(workstation.id, a.workstationId)))[0];
  const tpl = ws ? manifestOf(ws)?.agents.find((x) => x.id === a.templateId) : undefined;
  return tpl?.triggers?.includes('mentioned') ?? false;
};

async function mentionedTurns(db: DB, th: ThreadRow, content: string, senderId: string | null) {
  const members = await threadAgents(db, th);
  const turns: Turn[] = [];
  for (const id of extractMentions(content, members)) {
    const a = members.find((m) => m.id === id)!;
    if (id !== senderId && (await canHearMention(db, a))) turns.push({ agentId: id, trigger: 'mentioned' });
  }
  return turns;
}

async function onHuman(db: DB, th: ThreadRow, content: string) {
  await db.update(thread).set({ turnCount: 0, state: 'active' }).where(eq(thread.id, th.id));
  queues.delete(th.id);
  const turns = await mentionedTurns(db, th, content, null);
  if (turns.length > 0) for (const t of turns) enqueue(th.id, t);
  else {
    const fallback = await defaultResponder(db, th);
    if (fallback) enqueue(th.id, fallback);
  }
  await pump(db, th.id);
}

async function onAgent(db: DB, th: ThreadRow, senderId: string, content: string) {
  if (th.state !== 'active' || th.mode === 'relay' || th.kind === 'dm') return;
  // 工作中的 Agent 顺手发的消息不算发言回合，但它点名别人仍然有效
  if (!speaking.has(th.id)) {
    for (const t of await mentionedTurns(db, th, content, senderId)) enqueue(th.id, t);
    await pump(db, th.id);
    return;
  }
  const { conf, ws } = await settingsOf(db, await hostWs(db, th));
  const turnCount = th.turnCount + 1;
  await db.update(thread).set({ turnCount }).where(eq(thread.id, th.id));
  const moderator = ws ? await stewardOf(db, ws.id) : null;

  if (turnCount >= conf.maxTurns) {
    await db.update(thread).set({ state: 'concluding' }).where(eq(thread.id, th.id));
    queues.delete(th.id);
    if (moderator) enqueue(th.id, { agentId: moderator.id, trigger: 'conclude' });
  } else {
    const turns = await mentionedTurns(db, th, content, senderId);
    for (const t of turns) enqueue(th.id, t);
    // 讨论里没人被点名时回到主持人；任务线程只跟随点名，避免 steward 每句都插话
    if (turns.length === 0 && th.kind === 'discussion' && moderator && moderator.id !== senderId) {
      enqueue(th.id, { agentId: moderator.id, trigger: 'moderated' });
    }
    if (turnCount % conf.summaryEvery === 0 && moderator) enqueue(th.id, { agentId: moderator.id, trigger: 'conclude' });
  }
  await pump(db, th.id);
}

async function onRunFinished(db: DB, runId: string, stopReason: unknown) {
  for (const [threadId, active] of speaking) {
    if (active !== runId) continue;
    speaking.delete(threadId);
    const th = await loadThread(db, threadId);
    if (stopReason === 'budget') await silence(db, threadId, '预算耗尽，会话已静默，等你决定是否继续。');
    else if (th?.state === 'concluding') await silence(db, threadId, '已达到本轮发言上限，讨论收束，等你发话。');
  }
  for (const threadId of queues.keys()) await pump(db, threadId);
}

export function startConversation(db: DB): () => void {
  const offs = [
    events.on('message_created', async (p) => {
      if (p.kind !== 'chat') return;
      const th = await loadThread(db, String(p.threadId));
      if (!th) return;
      const content = String(p.content ?? '');
      if (p.senderType === 'human') await onHuman(db, th, content);
      else if (p.senderType === 'agent' && p.senderId !== PLATFORM.id) await onAgent(db, th, String(p.senderId), content);
    }),
    events.on('run_finished', (p) => onRunFinished(db, String(p.runId), p.stopReason)),
  ];
  return () => {
    for (const off of offs) off();
    queues.clear();
    speaking.clear();
  };
}

// scheduler.idle 之外，测试需要知道发言队列也排空了
export const conversationIdle = () => speaking.size === 0 && [...queues.values()].every((q) => q.length === 0);
