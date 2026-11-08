import type { Actor } from '@aw/domain';
import { and, eq, gte } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { entity, proposal, task } from '../db/schema.js';
import { logEvent } from './core.js';
import { taskFlow } from './flow.js';
import { registeredModules, uncoveredPaths } from '../runtime/modules.js';
import { parseScope } from '../runtime/scope.js';

type TaskRow = typeof task.$inferSelect;

// 阶段门禁：离开一个阶段（往后推进）前，必须满足这个阶段声明的 requirements
export interface Gate {
  stage: string;
  index: number;
  kind: 'entity' | 'acceptance' | 'approval' | 'manual' | 'new_scope_decision';
  text: string;
  met: boolean;
  // manual 只能人确认；其余由平台按事实判定
  confirmable: boolean;
}

type Requirement =
  | { kind: 'entity'; entity: string; minCount?: number | undefined; fieldsPresent?: string[] | undefined; description?: string | undefined }
  | { kind: 'acceptance'; description?: string | undefined }
  | { kind: 'approval'; by?: 'human' | 'agent' | undefined; description?: string | undefined }
  | { kind: 'manual'; text: string; description?: string | undefined }
  | { kind: 'new_scope_decision'; registry: string; pathField?: string | undefined; decision: string; description?: string | undefined };

const resultOf = (t: TaskRow) => (t.resultJson ? (JSON.parse(t.resultJson) as Record<string, unknown>) : {});
const confirmedOf = (t: TaskRow) => (resultOf(t).gates ?? {}) as Record<string, number[]>;

async function evaluate(db: DB, t: TaskRow, wsId: string, stage: string, index: number, r: Requirement): Promise<Gate> {
  const base = { stage, index, kind: r.kind, confirmable: r.kind === 'manual' };
  if (r.kind === 'manual') {
    return { ...base, text: r.text, met: (confirmedOf(t)[stage] ?? []).includes(index) };
  }
  if (r.kind === 'acceptance') {
    const acc = resultOf(t).acceptance as { passed?: boolean } | undefined;
    return { ...base, text: r.description ?? '任务验收全部通过', met: acc?.passed === true };
  }
  if (r.kind === 'approval') {
    const ps = await db.select().from(proposal).where(eq(proposal.taskId, t.id));
    const met = ps.some((p) => ['approved', 'merged'].includes(p.status) && (!r.by || p.decidedByType === r.by || (r.by === 'agent' && p.decidedByType === null)));
    return { ...base, text: r.description ?? (r.by === 'human' ? '改动经人审查通过' : '改动审查通过'), met };
  }
  if (r.kind === 'new_scope_decision') {
    const fresh = uncoveredPaths(parseScope(t.inputJson), await registeredModules(db, wsId, r.registry, r.pathField ?? 'path'));
    if (fresh.length === 0) return { ...base, text: `${r.description ?? `涉及新 ${r.registry} 时需有 ${r.decision}`}：未涉及未登记的 ${r.registry}`, met: true };
    const made = await entitiesSince(db, t, wsId, r.decision, []);
    return { ...base, text: `${r.description ?? `涉及新 ${r.registry}`}（${fresh.join('、')}）：需要至少 1 条 ${r.decision}`, met: made >= 1 };
  }
  const need = r.minCount ?? 1;
  const mine = await entitiesSince(db, t, wsId, r.entity, r.fieldsPresent ?? []);
  return { ...base, text: r.description ?? `至少 ${need} 条 ${r.entity}${r.fieldsPresent?.length ? `（含 ${r.fieldsPresent.join('、')}）` : ''}`, met: mine >= need };
}

// 本任务开始之后在执行台里产生的该类实体（带 task_id 的只算本任务的）
async function entitiesSince(db: DB, t: TaskRow, wsId: string, type: string, fieldsPresent: string[]) {
  const rows = await db.select().from(entity).where(and(eq(entity.workstationId, wsId), eq(entity.entityType, type), gte(entity.createdAt, t.createdAt)));
  return rows.filter((e) => {
    const data = JSON.parse(e.dataJson ?? '{}') as Record<string, unknown>;
    if (data.task_id && data.task_id !== t.id) return false;
    return fieldsPresent.every((f) => data[f] !== undefined && data[f] !== null && data[f] !== '');
  }).length;
}

export async function stageGates(db: DB, t: TaskRow, stageId?: string | null): Promise<Gate[]> {
  const { stages, workstationId } = await taskFlow(db, t);
  const st = stages.find((s) => s.id === (stageId ?? t.stage));
  if (!st) return [];
  return Promise.all(((st.requirements ?? []) as Requirement[]).map((r, i) => evaluate(db, t, workstationId, st.id, i, r)));
}

// 从当前阶段跳到 target 要经过的所有阶段的门禁；往回退不检查
export async function gatesBetween(db: DB, t: TaskRow, target: string): Promise<Gate[]> {
  const { stages } = await taskFlow(db, t);
  const from = stages.findIndex((s) => s.id === t.stage);
  const to = stages.findIndex((s) => s.id === target);
  if (from < 0 || to <= from) return [];
  const all = await Promise.all(stages.slice(from, to).map((s) => stageGates(db, t, s.id)));
  return all.flat();
}

export async function confirmGates(actor: Actor, db: DB, taskId: string, gates: { stage: string; index: number }[]) {
  const t = (await db.select().from(task).where(eq(task.id, taskId)))[0];
  if (!t) return;
  const rj = resultOf(t);
  const confirmed = { ...((rj.gates ?? {}) as Record<string, number[]>) };
  for (const g of gates) confirmed[g.stage] = [...new Set([...(confirmed[g.stage] ?? []), g.index])];
  await db.update(task).set({ resultJson: JSON.stringify({ ...rj, gates: confirmed }) }).where(eq(task.id, taskId));
  await logEvent(db, actor, 'task_gate_confirmed', 'task', taskId, { gates });
}

export const describeGates = (gs: Gate[]) => gs.map((g) => `「${g.text}」`).join('、');
