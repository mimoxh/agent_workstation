import { firstBreach, type Budget, type BudgetBreach, type BudgetLevel, type Usage } from '@aw/domain';
import { eq, inArray } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { agent, project, run, task, workstation } from '../db/schema.js';

const parseBudget = (json: string | null | undefined): Budget | null => {
  const b = JSON.parse(json || 'null') as Budget | null;
  return b && (b.tokens !== undefined || b.costMicros !== undefined) ? b : null;
};

const sumRuns = (rows: { tokensIn: number | null; tokensOut: number | null; cost: number | null }[]): Usage => ({
  tokens: rows.reduce((n, r) => n + (r.tokensIn ?? 0) + (r.tokensOut ?? 0), 0),
  costMicros: rows.reduce((n, r) => n + (r.cost ?? 0), 0),
});

const usageColumns = { tokensIn: run.tokensIn, tokensOut: run.tokensOut, cost: run.cost };

async function usageOfAgents(db: DB, wsIds: string[]) {
  const ids = (await db.select({ id: agent.id }).from(agent).where(inArray(agent.workstationId, wsIds))).map((a) => a.id);
  return ids.length ? sumRuns(await db.select(usageColumns).from(run).where(inArray(run.agentId, ids))) : sumRuns([]);
}

async function usageOfTask(db: DB, taskId: string) {
  const all = await db.select({ id: task.id, parentId: task.parentId }).from(task);
  const ids = [taskId];
  for (let i = 0; i < ids.length; i++) ids.push(...all.filter((t) => t.parentId === ids[i]).map((t) => t.id));
  return sumRuns(await db.select(usageColumns).from(run).where(inArray(run.taskId, ids)));
}

// 三级用量：任务含子任务；工作台与项目按 Agent 所属统计，讨论的花费也算在内
export async function budgetLevels(db: DB, scope: { projectId: string; workstationId: string; taskId?: string | null | undefined }): Promise<BudgetLevel[]> {
  const stations = await db.select().from(workstation).where(eq(workstation.projectId, scope.projectId));
  const ws = stations.find((w) => w.id === scope.workstationId);
  const p = (await db.select().from(project).where(eq(project.id, scope.projectId)))[0];
  const levels: BudgetLevel[] = [
    { scope: 'project', budget: parseBudget(p?.budgetJson), usage: await usageOfAgents(db, stations.map((w) => w.id)) },
    { scope: 'workstation', budget: (JSON.parse(ws?.settingsJson ?? '{}') as { budget?: Budget }).budget ?? null, usage: await usageOfAgents(db, [scope.workstationId]) },
  ];
  if (scope.taskId) {
    const t = (await db.select().from(task).where(eq(task.id, scope.taskId)))[0];
    levels.push({ scope: 'task', budget: parseBudget(t?.budgetJson), usage: await usageOfTask(db, scope.taskId) });
  }
  return levels;
}

export const budgetBreach = async (db: DB, scope: Parameters<typeof budgetLevels>[1]) => firstBreach(await budgetLevels(db, scope));

const SCOPE_LABEL = { task: '任务', workstation: '工作台', project: '项目' } as const;

export function describeBreach(b: BudgetBreach) {
  const unit = b.metric === 'tokens' ? `${b.used} / ${b.limit} tok` : `$${(b.used / 1e6).toFixed(2)} / $${(b.limit / 1e6).toFixed(2)}`;
  return `${SCOPE_LABEL[b.scope]}预算已用完（${unit}）`;
}
