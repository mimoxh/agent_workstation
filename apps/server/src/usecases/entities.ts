import type { Actor } from '@aw/domain';
import type { EntityDef } from '@aw/plugin-spec';
import { and, desc, eq } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { entity, entityVersion, workstation } from '../db/schema.js';
import { logEvent, manifestOf } from './core.js';

const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();

function validate(def: EntityDef, data: Record<string, unknown>): string | null {
  for (const [id, f] of Object.entries(def.fields)) {
    const v = data[id];
    const empty = v === undefined || v === null || v === '';
    if (f.required && empty) return `缺少必填字段：${f.label ?? id}`;
    if (!empty && f.type === 'enum' && f.enum && !f.enum.includes(String(v))) return `${f.label ?? id} 的取值不合法`;
  }
  return null;
}

async function defOf(db: DB, wsId: string, entityType: string) {
  const ws = (await db.select().from(workstation).where(eq(workstation.id, wsId)))[0];
  if (!ws) return { kind: 'not_found' as const, status: 404 as const, error: '工作台不存在' };
  const def = manifestOf(ws)?.entities[entityType];
  if (!def) return { kind: 'error' as const, status: 400 as const, error: `实体类型 ${entityType} 不存在` };
  return { kind: 'ok' as const, def };
}

// 人直写实体（I3 的人工例外）：同样落版本，可追溯
export async function createEntity(actor: Actor, db: DB, wsId: string, input: { entityType: string; data: Record<string, unknown>; reason?: string | undefined }) {
  const d = await defOf(db, wsId, input.entityType);
  if (d.kind !== 'ok') return d;
  const bad = validate(d.def, input.data);
  if (bad) return { kind: 'error' as const, status: 400 as const, error: bad };
  const id = uid();
  const dataJson = JSON.stringify(input.data);
  await db.insert(entity).values({ id, workstationId: wsId, entityType: input.entityType, dataJson, version: 1, createdByType: actor.type, createdById: actor.id, createdAt: now(), updatedAt: now() });
  await db.insert(entityVersion).values({ id: uid(), entityId: id, version: 1, dataJson, authorType: actor.type, authorId: actor.id, reason: input.reason ?? null, createdAt: now() });
  await logEvent(db, actor, 'entity_created', 'entity', id, { entityType: input.entityType });
  return { kind: 'ok' as const, id };
}

export async function updateEntity(actor: Actor, db: DB, id: string, input: { data: Record<string, unknown>; baseVersion: number; reason?: string | undefined }) {
  const e = (await db.select().from(entity).where(eq(entity.id, id)))[0];
  if (!e) return { kind: 'not_found' as const, status: 404 as const, error: '实体不存在' };
  if (e.version !== input.baseVersion) return { kind: 'conflict' as const, status: 409 as const, error: '实体已被更新，请刷新后重试' };
  const d = await defOf(db, e.workstationId, e.entityType);
  if (d.kind !== 'ok') return d;
  const bad = validate(d.def, input.data);
  if (bad) return { kind: 'error' as const, status: 400 as const, error: bad };
  const version = e.version + 1;
  const dataJson = JSON.stringify(input.data);
  await db.update(entity).set({ dataJson, version, updatedAt: now() }).where(eq(entity.id, id));
  await db.insert(entityVersion).values({ id: uid(), entityId: id, version, dataJson, authorType: actor.type, authorId: actor.id, reason: input.reason ?? null, createdAt: now() });
  await logEvent(db, actor, 'entity_updated', 'entity', id, { version });
  return { kind: 'ok' as const, id, version };
}

// 回滚也是一次新版本：历史永久保留（I3）
export async function rollbackEntity(actor: Actor, db: DB, id: string, version: number) {
  const e = (await db.select().from(entity).where(eq(entity.id, id)))[0];
  if (!e) return { kind: 'not_found' as const, status: 404 as const, error: '实体不存在' };
  const target = (await db.select().from(entityVersion).where(and(eq(entityVersion.entityId, id), eq(entityVersion.version, version))))[0];
  if (!target) return { kind: 'not_found' as const, status: 404 as const, error: '版本不存在' };
  const next = e.version + 1;
  await db.update(entity).set({ dataJson: target.dataJson, version: next, updatedAt: now() }).where(eq(entity.id, id));
  await db.insert(entityVersion).values({ id: uid(), entityId: id, version: next, dataJson: target.dataJson, authorType: actor.type, authorId: actor.id, reason: `回滚到 v${version}`, createdAt: now() });
  await logEvent(db, actor, 'entity_updated', 'entity', id, { version: next, rollback: version });
  return { kind: 'ok' as const, id, version: next };
}

export async function entityHistory(db: DB, id: string) {
  return db.select().from(entityVersion).where(eq(entityVersion.entityId, id)).orderBy(desc(entityVersion.version));
}
