import type { Actor, PermCtx } from '@aw/domain';
import { can } from '@aw/domain';
import type { WorkbenchManifest } from '@aw/plugin-spec';
import { eq } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { accessGrant, agent, eventLog, workstation } from '../db/schema.js';
import { events } from '../events.js';
import { pluginRegistry } from '../plugins.js';

const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();

export async function logEvent(
  db: DB,
  actor: Actor,
  action: string,
  targetType: string,
  targetId: string,
  payload: Record<string, unknown> = {},
) {
  await db.insert(eventLog).values({
    id: uid(),
    actorType: actor.type,
    actorId: actor.id,
    action,
    targetType,
    targetId,
    payloadJson: JSON.stringify(payload),
    createdAt: now(),
  });
  events.emit(action, { targetType, targetId, ...payload });
}

// 构建 can() 的 ctx（纯对象，无外部引用）
export async function buildPermCtx(actor: Actor, db: DB): Promise<PermCtx> {
  const workstations = await db
    .select({ id: workstation.id, parentId: workstation.parentId })
    .from(workstation);
  const grants = await db.select().from(accessGrant);
  let agentRow: PermCtx['agent'];
  if (actor.type === 'agent') {
    const rows = await db.select().from(agent).where(eq(agent.id, actor.id));
    const a = rows[0];
    if (a) {
      agentRow = { id: a.id, workstationId: a.workstationId, isSteward: a.isSteward === 1 };
    }
  }
  return {
    workstations,
    agent: agentRow,
    grants: grants.map((g) => ({
      subjectType: g.subjectType as 'human' | 'agent',
      subjectId: g.subjectId,
      scopeType: g.scopeType as 'workstation' | 'project',
      scopeId: g.scopeId,
      rights: JSON.parse(g.rightsJson ?? '[]') as string[],
    })),
  };
}

export function manifestOf(ws: { pluginId: string | null }): WorkbenchManifest | null {
  return ws.pluginId ? (pluginRegistry.get(ws.pluginId) ?? null) : null;
}

// 合并类型默认 acceptance（按 JSON 序列化去重）
export function mergeAcceptance(existing: unknown[] | string | null, defaults: unknown[]): unknown[] {
  const base = typeof existing === 'string' ? (JSON.parse(existing || '[]') as unknown[]) : (existing ?? []);
  const merged = [...base];
  for (const d of defaults) {
    if (!merged.some((x) => JSON.stringify(x) === JSON.stringify(d))) merged.push(d);
  }
  return merged;
}

export function visibleTaskFilter(ctx: PermCtx, actor: Actor): string[] | null {
  if (actor.type === 'human') return null;
  return ctx.workstations
    .filter((w) => can(actor, 'observe', { type: 'workstation', id: w.id }, ctx))
    .map((w) => w.id);
}
