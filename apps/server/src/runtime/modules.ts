import { and, eq } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { entity } from '../db/schema.js';
import type { TaskScope } from './scope.js';

// Module 登记表：任务范围对照它判断「是不是新 Module」，并把职责带进上下文
export interface ModuleEntry { name: string; path: string; responsibility?: string; owner?: string }

const norm = (p: string) => p.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');

export async function registeredModules(db: DB, wsId: string, registry = 'Module', pathField = 'path'): Promise<ModuleEntry[]> {
  const rows = await db.select().from(entity).where(and(eq(entity.workstationId, wsId), eq(entity.entityType, registry)));
  return rows.flatMap((r) => {
    const d = JSON.parse(r.dataJson ?? '{}') as Record<string, unknown>;
    const p = typeof d[pathField] === 'string' ? norm(d[pathField]) : '';
    if (!p) return [];
    return [{
      name: String(d.name ?? p), path: p,
      ...(typeof d.responsibility === 'string' && d.responsibility ? { responsibility: d.responsibility } : {}),
      ...(typeof d.owner === 'string' && d.owner ? { owner: d.owner } : {}),
    }];
  });
}

const covers = (m: ModuleEntry, p: string) => p === m.path || p.startsWith(`${m.path}/`) || m.path === '.';

// 范围里没有被任何登记 Module 覆盖的路径；一个 Module 都没登记时无从比较，不算新
export function uncoveredPaths(scope: TaskScope, mods: ModuleEntry[]): string[] {
  if (scope.invalid || scope.whole || mods.length === 0) return [];
  return scope.modules.filter((p) => !mods.some((m) => covers(m, p)));
}

// 与任务范围相关的 Module：范围在 Module 里，或 Module 在范围里
export function relatedModules(scope: TaskScope, mods: ModuleEntry[]): ModuleEntry[] {
  if (scope.invalid) return [];
  if (scope.whole) return mods;
  return mods.filter((m) => scope.modules.some((p) => covers(m, p) || m.path.startsWith(`${p}/`)));
}

export const describeModules = (mods: ModuleEntry[]) =>
  mods.map((m) => `- ${m.name}（${m.path}）${m.responsibility ? `：${m.responsibility}` : ''}${m.owner ? `；负责人 ${m.owner}` : ''}`).join('\n');
