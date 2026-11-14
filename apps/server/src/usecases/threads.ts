import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Actor } from '@aw/domain';
import type { ModulesConfig } from '@aw/plugin-spec';
import type { DB } from '../db/client.js';
import { agent, message, proposal, run, task, thread, threadMember, workstation } from '../db/schema.js';
import { events } from '../events.js';
import { clearThreadQueue, threadQueueLength } from '../runtime/conversation.js';
import { cancelRun } from '../runtime/loop.js';
import { logEvent, manifestOf } from './core.js';
import { executingWs, stewardOf } from './flow.js';
import { pushInbox } from './inbox.js';

const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();

export type ThreadKind = 'task' | 'review' | 'discussion' | 'dm' | 'group';
type Conversation = NonNullable<ModulesConfig['conversation']>;

const DEFAULT_MODES: Record<ThreadKind, Conversation['defaultMode']> = { task: 'relay', review: 'moderated', discussion: 'moderated', dm: 'relay', group: 'moderated' };
const DEFAULT_MAX_TURNS = 12;
const DEFAULT_SUMMARY_EVERY = 6;

// 平台默认 → manifest.modules → 工作台选中的预设
export function conversationOf(ws: { pluginId: string | null; settingsJson: string | null } | undefined) {
  const manifest = ws ? manifestOf(ws) : null;
  const presetId = (JSON.parse(ws?.settingsJson ?? '{}') as { preset?: string }).preset;
  const patch = manifest?.presets?.find((p) => p.id === presetId)?.patch as { modules?: ModulesConfig } | undefined;
  const conf: Partial<Conversation> = { ...manifest?.modules?.conversation, ...patch?.modules?.conversation };
  return {
    modeOf: (kind: ThreadKind) =>
      (conf.threadOverrides as Partial<Record<ThreadKind, Conversation['defaultMode']> | undefined>)?.[kind]
      ?? (conf.defaultMode && kind !== 'dm' && kind !== 'group' ? conf.defaultMode : DEFAULT_MODES[kind]),
    maxTurns: conf.maxTurns ?? DEFAULT_MAX_TURNS,
    summaryEvery: conf.summaryEvery ?? DEFAULT_SUMMARY_EVERY,
  };
}

const wsRow = async (db: DB, id: string) => (await db.select().from(workstation).where(eq(workstation.id, id)))[0];

export async function taskThreadOf(db: DB, taskId: string) {
  const rows = await db.select().from(thread).where(and(eq(thread.kind, 'task'), eq(thread.scopeId, taskId)));
  if (rows[0]) return rows[0];
  const t = (await db.select().from(task).where(eq(task.id, taskId)))[0];
  if (!t) return null;
  const id = uid();
  const mode = conversationOf(await wsRow(db, executingWs(t))).modeOf('task');
  await db.insert(thread).values({ id, scopeType: 'task', scopeId: taskId, kind: 'task', mode, title: t.title, createdAt: now() });
  await db.insert(threadMember).values([
    { threadId: id, participantType: 'human', participantId: 'local', role: 'member' },
    ...(t.assigneeId && t.assigneeType !== 'human' ? [{ threadId: id, participantType: t.assigneeType ?? 'agent', participantId: t.assigneeId, role: 'member' }] : []),
  ]);
  return (await db.select().from(thread).where(eq(thread.id, id)))[0]!;
}

export async function wsThreadOf(db: DB, wsId: string) {
  const rows = await db.select().from(thread).where(and(eq(thread.kind, 'discussion'), eq(thread.scopeId, wsId)));
  if (rows[0]) return rows[0];
  const id = uid();
  const mode = conversationOf(await wsRow(db, wsId)).modeOf('discussion');
  await db.insert(thread).values({ id, scopeType: 'workstation', scopeId: wsId, kind: 'discussion', mode, title: '讨论', createdAt: now() });
  await db.insert(threadMember).values({ threadId: id, participantType: 'human', participantId: 'local', role: 'member' });
  return (await db.select().from(thread).where(eq(thread.id, id)))[0]!;
}

// 线程的最近活跃时间：最后一条消息，没有消息看创建时间
async function lastAt(db: DB, threadId: string, fallback: string) {
  const msgs = await db.select().from(message).where(eq(message.threadId, threadId));
  let at = fallback;
  for (const m of msgs) if (m.createdAt > at) at = m.createdAt;
  return at;
}

// 同一个 Agent 可以有多条私聊：这里取最近活跃的未归档那条，没有就建
export async function dmThreadOf(db: DB, agentId: string) {
  const a = (await db.select().from(agent).where(eq(agent.id, agentId)))[0];
  if (!a) return null;
  const rows = await db.select().from(thread).where(and(eq(thread.kind, 'dm'), eq(thread.scopeId, agentId), isNull(thread.archivedAt)));
  if (rows.length > 0) {
    let best = rows[0]!;
    let bestAt = await lastAt(db, best.id, best.createdAt);
    for (const r of rows.slice(1)) {
      const at = await lastAt(db, r.id, r.createdAt);
      if (at > bestAt) [best, bestAt] = [r, at];
    }
    return best;
  }
  const id = uid();
  await db.insert(thread).values({ id, scopeType: 'agent', scopeId: agentId, kind: 'dm', mode: 'relay', title: a.name, createdAt: now() });
  await db.insert(threadMember).values([
    { threadId: id, participantType: 'human', participantId: 'local', role: 'member' },
    { threadId: id, participantType: 'agent', participantId: agentId, role: 'member' },
  ]);
  return (await db.select().from(thread).where(eq(thread.id, id)))[0]!;
}

// 人工建会话：1 个成员是私聊，多个是群聊；群主优先 steward，否则第一个成员
export async function createConversation(actor: Actor, db: DB, wsId: string, input: { agentIds: string[]; title?: string | undefined }) {
  const ws = await wsRow(db, wsId);
  if (!ws) return { kind: 'not_found' as const, status: 404 as const, error: '工作台不存在' };
  const ids = [...new Set(input.agentIds)];
  const members = ids.length ? await db.select().from(agent).where(inArray(agent.id, ids)) : [];
  if (ids.length === 0 || members.length !== ids.length || members.some((a) => a.workstationId !== wsId)) {
    return { kind: 'error' as const, status: 400 as const, error: '成员要都是本台的 Agent' };
  }
  const id = uid();
  const title = input.title?.trim() ? input.title.trim() : null;
  if (ids.length === 1) {
    await db.insert(thread).values({ id, scopeType: 'agent', scopeId: ids[0]!, kind: 'dm', mode: 'relay', title, createdAt: now() });
    await db.insert(threadMember).values([
      { threadId: id, participantType: 'human', participantId: 'local', role: 'member' },
      { threadId: id, participantType: 'agent', participantId: ids[0]!, role: 'member' },
    ]);
  } else {
    const steward = await stewardOf(db, wsId);
    const host = steward && ids.includes(steward.id) ? steward.id : ids[0]!;
    await db.insert(thread).values({ id, scopeType: 'workstation', scopeId: wsId, kind: 'group', mode: 'moderated', title, createdAt: now() });
    await db.insert(threadMember).values([
      { threadId: id, participantType: 'human', participantId: 'local', role: 'member' },
      ...ids.map((aid) => ({ threadId: id, participantType: 'agent', participantId: aid, role: aid === host ? 'host' : 'member' })),
    ]);
  }
  await logEvent(db, actor, 'thread_created', 'thread', id, { workstationId: wsId });
  const th = (await db.select().from(thread).where(eq(thread.id, id)))[0]!;
  return { kind: 'ok' as const, thread: th };
}

// Agent 页的会话列表：本台所有私聊 + 本台的人工群聊（含已归档，带 archivedAt），按最近活跃倒序
export async function listConversations(db: DB, wsId: string) {
  const wsAgents = await db.select().from(agent).where(eq(agent.workstationId, wsId));
  const dmRows = wsAgents.length
    ? await db.select().from(thread).where(and(eq(thread.kind, 'dm'), inArray(thread.scopeId, wsAgents.map((a) => a.id))))
    : [];
  const groupRows = await db.select().from(thread).where(and(eq(thread.kind, 'group'), eq(thread.scopeId, wsId)));
  const out = [];
  for (const th of [...dmRows, ...groupRows]) {
    const members = await db.select().from(threadMember).where(and(eq(threadMember.threadId, th.id), eq(threadMember.participantType, 'agent')));
    const msgs = await db.select().from(message).where(eq(message.threadId, th.id));
    let last = msgs[0];
    for (const m of msgs) if (last === undefined || m.createdAt > last.createdAt) last = m;
    out.push({
      id: th.id,
      kind: th.kind,
      title: th.title,
      state: th.state,
      turnCount: th.turnCount,
      agentIds: members.map((m) => m.participantId),
      hostId: members.find((m) => m.role === 'host')?.participantId ?? null,
      lastAt: last?.createdAt ?? th.createdAt,
      lastPreview: last?.content ?? null,
      archivedAt: th.archivedAt,
      createdAt: th.createdAt,
    });
  }
  return out.sort((a, b) => b.lastAt.localeCompare(a.lastAt));
}

// 能在这条线程发言的 Agent：群聊只看群成员；其余是本台成员，加上可以向父级发言的子台 steward（I2）
export async function threadAgents(db: DB, th: typeof thread.$inferSelect) {
  if (th.kind === 'group') {
    const members = await db.select().from(threadMember).where(and(eq(threadMember.threadId, th.id), eq(threadMember.participantType, 'agent')));
    return members.length ? db.select().from(agent).where(inArray(agent.id, members.map((m) => m.participantId))) : [];
  }
  if (th.scopeType === 'agent') return db.select().from(agent).where(eq(agent.id, th.scopeId ?? ''));
  let wsIds: string[];
  if (th.scopeType === 'task') {
    const t = (await db.select().from(task).where(eq(task.id, th.scopeId ?? '')))[0];
    if (!t) return [];
    wsIds = [...new Set([t.workstationId, executingWs(t)])];
  } else {
    wsIds = [th.scopeId ?? ''];
  }
  const own = await db.select().from(agent).where(inArray(agent.workstationId, wsIds));
  const children = (await db.select().from(workstation).where(inArray(workstation.parentId, wsIds))).map((w) => w.id).filter((id) => !wsIds.includes(id));
  const stewards = children.length ? await db.select().from(agent).where(and(inArray(agent.workstationId, children), eq(agent.isSteward, 1))) : [];
  return [...own, ...stewards];
}

export interface Sender { type: string; id: string }

export async function postMessage(db: DB, threadId: string, sender: Sender, content: string, kind = 'chat', meta?: Record<string, unknown>) {
  const m = { id: uid(), threadId, senderType: sender.type, senderId: sender.id, kind, content, metaJson: meta ? JSON.stringify(meta) : null, createdAt: now() };
  await db.insert(message).values(m);
  events.emit('message_created', m as unknown as Record<string, unknown>);
  return m;
}

export const PLATFORM: Sender = { type: 'agent', id: 'platform' };

export async function postThreadMessage(actor: Actor, db: DB, threadId: string, content: string, meta?: Record<string, unknown>) {
  const th = (await db.select().from(thread).where(eq(thread.id, threadId)))[0];
  if (!th) return null;
  // 人在归档的会话里发话就是要接着聊：先取消归档再发，回复照常调度
  if (actor.type === 'human' && th.archivedAt) {
    await db.update(thread).set({ archivedAt: null }).where(eq(thread.id, threadId));
    await logEvent(db, actor, 'thread_unarchived', 'thread', threadId, {});
  }
  const m = await postMessage(db, threadId, actor, content, 'chat', meta);
  // 人开的第一句话给未命名的私聊/群聊起题
  if (actor.type === 'human' && (th.kind === 'dm' || th.kind === 'group') && th.title === null) {
    await db.update(thread).set({ title: content.replace(/\s+/g, ' ').slice(0, 24) }).where(eq(thread.id, threadId));
  }
  await logEvent(db, actor, 'message_posted', 'thread', threadId, {});
  return m;
}

export interface Handoff { from: string; to: string; next?: string | undefined; refs?: Record<string, string> | undefined }

// Agent 之间的交接一律结构化（ARCHITECTURE §5.3）：平台在流转点写入，不靠模型自述
export async function postHandoff(db: DB, taskId: string, summary: string, h: Handoff) {
  const th = await taskThreadOf(db, taskId);
  if (th) await postMessage(db, th.id, PLATFORM, summary, 'handoff', { ...h });
}

export async function postStatus(db: DB, taskId: string, content: string, sender: Sender = PLATFORM) {
  const th = await taskThreadOf(db, taskId);
  if (th) await postMessage(db, th.id, sender, content, 'status');
}

export async function listMessages(db: DB, threadId: string) {
  const rows = await db.select().from(message).where(eq(message.threadId, threadId));
  return rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

// 这条线程有没有正在生成或排队的回复：会话页据此显示「正在回复…」与停止按钮
export async function threadActivity(db: DB, threadId: string) {
  const running = await db.select().from(run).where(and(eq(run.threadId, threadId), eq(run.status, 'running')));
  return {
    running: running.length > 0,
    runIds: running.map((r) => r.id),
    agentIds: running.map((r) => r.agentId).filter((id): id is string => !!id),
    queued: threadQueueLength(threadId),
  };
}

// 停掉这条线程正在进行与排队中的回复：不静默，人发新消息照常继续
export async function stopThread(actor: Actor, db: DB, threadId: string) {
  const th = (await db.select().from(thread).where(eq(thread.id, threadId)))[0];
  if (!th) return { kind: 'not_found' as const, status: 404 as const, error: '会话不存在' };
  let stopped = clearThreadQueue(threadId);
  const running = await db.select().from(run).where(and(eq(run.threadId, threadId), eq(run.status, 'running')));
  for (const r of running) {
    stopped += 1;
    // 不在内存 active 表里的 running 记录按孤儿处理，同 /runs/:id/cancel
    if (!cancelRun(r.id)) {
      await db.update(run).set({ status: 'cancelled', stopReason: 'cancelled', endedAt: now() }).where(eq(run.id, r.id));
      events.emit('run_finished', { runId: r.id, agentId: r.agentId, taskId: r.taskId, stopReason: 'cancelled' });
    }
  }
  if (stopped > 0) {
    await postMessage(db, threadId, PLATFORM, '已停止，发新消息会继续。', 'status');
    await logEvent(db, actor, 'thread_stopped', 'thread', threadId, { stopped });
  }
  return { kind: 'ok' as const, stopped };
}

// 归档只收起私聊和群聊：停掉进行中的回复，消息全部保留，可以随时取消归档
export async function archiveThread(actor: Actor, db: DB, threadId: string, archived: boolean) {
  const th = (await db.select().from(thread).where(eq(thread.id, threadId)))[0];
  if (!th) return { kind: 'not_found' as const, status: 404 as const, error: '会话不存在' };
  if (th.kind !== 'dm' && th.kind !== 'group') return { kind: 'error' as const, status: 400 as const, error: '只有私聊和群聊可以归档' };
  if (archived === !!th.archivedAt) return { kind: 'ok' as const, archivedAt: th.archivedAt };
  if (archived) await stopThread(actor, db, threadId);
  const archivedAt = archived ? now() : null;
  await db.update(thread).set({ archivedAt }).where(eq(thread.id, threadId));
  await logEvent(db, actor, archived ? 'thread_archived' : 'thread_unarchived', 'thread', threadId, {});
  return { kind: 'ok' as const, archivedAt };
}

export async function silenceThread(actor: Actor, db: DB, threadId: string, silenced: boolean) {
  const th = (await db.select().from(thread).where(eq(thread.id, threadId)))[0];
  if (!th) return { kind: 'not_found' as const, status: 404 as const, error: '会话不存在' };
  await db.update(thread).set({ state: silenced ? 'silenced' : 'active', ...(silenced ? {} : { turnCount: 0 }) }).where(eq(thread.id, threadId));
  await logEvent(db, actor, silenced ? 'thread_silenced' : 'thread_resumed', 'thread', threadId, {});
  await postMessage(db, threadId, PLATFORM, silenced ? '已静默，Agent 不再继续发言。' : '已恢复，Agent 可以继续发言。', 'status');
  return { kind: 'ok' as const };
}

// 结论沉淀成 ADR 提案：走提案制，人在改动审阅里决定是否写入板块
export async function decisionToProposal(actor: Actor, db: DB, messageId: string) {
  const m = (await db.select().from(message).where(eq(message.id, messageId)))[0];
  if (!m || m.kind !== 'decision') return { kind: 'not_found' as const, status: 404 as const, error: '结论不存在' };
  const th = (await db.select().from(thread).where(eq(thread.id, m.threadId)))[0];
  const t = th?.scopeType === 'task' ? (await db.select().from(task).where(eq(task.id, th.scopeId ?? '')))[0] : undefined;
  const wsId = t ? executingWs(t) : th?.scopeId;
  const ws = wsId ? await wsRow(db, wsId) : undefined;
  if (!ws || !manifestOf(ws)?.entities.ADR) return { kind: 'error' as const, status: 400 as const, error: '这个工作台没有架构决策板块' };
  const content = m.content ?? '';
  const id = uid();
  await db.insert(proposal).values({
    id, taskId: t?.id ?? null, workstationId: ws.id, targetType: 'ADR', baseVersion: 0,
    patchJson: JSON.stringify({ title: content.split('\n')[0]!.slice(0, 60), context: `来自「${th?.title ?? '讨论'}」的结论`, decision: content, status: 'proposed' }),
    reason: '会话结论沉淀', authorType: actor.type, authorId: actor.id, status: 'pending', createdAt: now(),
  });
  await logEvent(db, actor, 'proposal_created', 'proposal', id, { entityType: 'ADR', messageId });
  await pushInbox(db, ws.projectId, { kind: 'proposal_review', refType: 'proposal', refId: id });
  return { kind: 'ok' as const, proposalId: id };
}
