import { and, eq } from 'drizzle-orm';
import type { Actor } from '@aw/domain';
import type { DB } from '../db/client.js';
import { message, task, thread, threadMember } from '../db/schema.js';
import { events } from '../events.js';
import { logEvent } from './index.js';

const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();

export async function taskThreadOf(db: DB, taskId: string) {
  const rows = await db.select().from(thread).where(and(eq(thread.kind, 'task'), eq(thread.scopeId, taskId)));
  if (rows[0]) return rows[0];
  const t = (await db.select().from(task).where(eq(task.id, taskId)))[0];
  if (!t) return null;
  const id = uid();
  await db.insert(thread).values({ id, scopeType: 'task', scopeId: taskId, kind: 'task', mode: 'relay', title: t.title, createdAt: now() });
  await db.insert(threadMember).values([
    { threadId: id, participantType: 'human', participantId: 'local', role: 'member' },
    ...(t.assigneeId ? [{ threadId: id, participantType: t.assigneeType ?? 'agent', participantId: t.assigneeId, role: 'member' }] : []),
  ]);
  return (await db.select().from(thread).where(eq(thread.id, id)))[0]!;
}

export async function wsThreadOf(db: DB, wsId: string) {
  const rows = await db.select().from(thread).where(and(eq(thread.kind, 'discussion'), eq(thread.scopeId, wsId)));
  if (rows[0]) return rows[0];
  const id = uid();
  await db.insert(thread).values({ id, scopeType: 'workstation', scopeId: wsId, kind: 'discussion', mode: 'relay', title: '讨论', createdAt: now() });
  await db.insert(threadMember).values({ threadId: id, participantType: 'human', participantId: 'local', role: 'member' });
  return (await db.select().from(thread).where(eq(thread.id, id)))[0]!;
}

export async function postThreadMessage(actor: Actor, db: DB, threadId: string, content: string) {
  const m = { id: uid(), threadId, senderType: actor.type, senderId: actor.id, kind: 'chat', content, createdAt: now() };
  await db.insert(message).values(m);
  await logEvent(db, actor, 'message_posted', 'thread', threadId, {});
  events.emit('message_created', m as unknown as Record<string, unknown>);
  return m;
}
