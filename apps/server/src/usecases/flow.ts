import { and, eq } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { agent, workstation } from '../db/schema.js';
import { manifestOf } from './core.js';

type FlowTask = { workstationId: string; assigneeType: string | null; assigneeId: string | null; typeId: string | null };

// 任务派发后由目标台执行：stage、编制、预算都看目标台，不看立项的根台
export const executingWs = (t: Pick<FlowTask, 'workstationId' | 'assigneeType' | 'assigneeId'>) =>
  t.assigneeType === 'workstation' && t.assigneeId ? t.assigneeId : t.workstationId;

export async function taskFlow(db: DB, t: FlowTask) {
  const workstationId = executingWs(t);
  const ws = (await db.select().from(workstation).where(eq(workstation.id, workstationId)))[0];
  const manifest = ws ? manifestOf(ws) : null;
  const type = manifest?.tasks.find((x) => x.id === t.typeId);
  const declared = manifest?.stages ?? [];
  const ids = type?.stages ?? declared.map((s) => s.id);
  const stages = ids.flatMap((id) => declared.filter((s) => s.id === id));
  return { workstationId, manifest, type, stages };
}

export async function stewardOf(db: DB, wsId: string) {
  return (await db.select().from(agent).where(and(eq(agent.workstationId, wsId), eq(agent.isSteward, 1))))[0] ?? null;
}
