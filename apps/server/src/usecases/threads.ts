import { and, eq, inArray } from 'drizzle-orm';
import type { Actor } from '@aw/domain';
import type { ModulesConfig } from '@aw/plugin-spec';
import type { DB } from '../db/client.js';
import { agent, message, proposal, task, thread, threadMember, workstation } from '../db/schema.js';
import { events } from '../events.js';
import { logEvent, manifestOf } from './core.js';
import { executingWs } from './flow.js';
import { pushInbox } from './inbox.js';

const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();

export type ThreadKind = 'task' | 'review' | 'discussion' | 'dm';
type Conversation = NonNullable<ModulesConfig['conversation']>;

const DEFAULT_MODES: Record<ThreadKind, Conversation['defaultMode']> = { task: 'relay', review: 'moderated', discussion: 'moderated', dm: 'relay' };
const DEFAULT_MAX_TURNS = 12;
const DEFAULT_SUMMARY_EVERY = 6;

// 平台默认 → manifest.modules → 工作台选中的预设
export function conversationOf(ws: { pluginId: string | null; settingsJson: string | null } | undefined) {
  const manifest = ws ? manifestOf(ws) : null;
  const presetId = (JSON.parse(ws?.settingsJson ?? '{}') as { preset?: string }).preset;
  const patch = manifest?.presets?.find((p) => p.id === presetId)?.patch as { modules?: ModulesConfig } | undefined;
  const conf: Partial<Conversation> = { ...manifest?.modules?.conversation, ...patch?.modules?.conversation };
  return {
    modeOf: (kind: ThreadKind) => conf.threadOverrides?.[kind] ?? (conf.defaultMode && kind !== 'dm' ? conf.defaultMode : DEFAULT_MODES[kind]),
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

export async function dmThreadOf(db: DB, agentId: string) {
  const a = (await db.select().from(agent).where(eq(agent.id, agentId)))[0];
  if (!a) return null;
  const rows = await db.select().from(thread).where(and(eq(thread.kind, 'dm'), eq(thread.scopeId, agentId)));
  if (rows[0]) return rows[0];
  const id = uid();
  await db.insert(thread).values({ id, scopeType: 'agent', scopeId: agentId, kind: 'dm', mode: 'relay', title: a.name, createdAt: now() });
  await db.insert(threadMember).values([
    { threadId: id, participantType: 'human', participantId: 'local', role: 'member' },
    { threadId: id, participantType: 'agent', participantId: agentId, role: 'member' },
  ]);
  return (await db.select().from(thread).where(eq(thread.id, id)))[0]!;
}

// 能在这条线程发言的 Agent：本台成员，加上可以向父级发言的子台 steward（I2）
export async function threadAgents(db: DB, th: typeof thread.$inferSelect) {
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
  const m = await postMessage(db, threadId, actor, content, 'chat', meta);
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
