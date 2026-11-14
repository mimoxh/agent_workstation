import type { WorkbenchManifest } from '@aw/plugin-spec';
import { and, eq } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { entity } from '../db/schema.js';
import type { TaskScope } from './scope.js';

type EntityRow = typeof entity.$inferSelect;

// Module 登记表：任务范围对照它判断「是不是新 Module」，并把职责带进上下文
export interface ModuleEntry { name: string; path: string; responsibility?: string; owner?: string }

const norm = (p: string) => p.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');

export async function registeredModules(db: DB, wsId: string, registry = 'Module', pathField = 'path', keep: (row: EntityRow) => boolean = () => true): Promise<ModuleEntry[]> {
  const rows = (await db.select().from(entity).where(and(eq(entity.workstationId, wsId), eq(entity.entityType, registry)))).filter(keep);
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

// 作为新 Module 登记表的实体类型（被某个阶段的 new_scope_decision 引用）及其路径字段
export function registryPathField(manifest: WorkbenchManifest | null | undefined, entityType: string): string | null {
  for (const s of manifest?.stages ?? []) {
    for (const r of s.requirements ?? []) if (r.kind === 'new_scope_decision' && r.registry === entityType) return r.pathField ?? 'path';
  }
  return null;
}

// Agent 直接登记前查重：同一路径只登记一次
export async function registeredAt(db: DB, wsId: string, registry: string, pathField: string, rawPath: unknown) {
  if (typeof rawPath !== 'string' || !norm(rawPath)) return null;
  const p = norm(rawPath);
  const rows = await db.select().from(entity).where(and(eq(entity.workstationId, wsId), eq(entity.entityType, registry)));
  const hit = rows.find((r) => {
    const v = (JSON.parse(r.dataJson ?? '{}') as Record<string, unknown>)[pathField];
    return typeof v === 'string' && norm(v) === p;
  });
  return hit ? { id: hit.id, path: p, name: String((JSON.parse(hit.dataJson ?? '{}') as Record<string, unknown>).name ?? p) } : null;
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
