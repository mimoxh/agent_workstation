import type { Actor } from './actor.js';
import { ancestorIds, descendantIds, type PermCtx, type Scope } from './scope.js';

export type Right = 'observe' | 'propose' | 'speak' | 'invoke';

const ALL: Right[] = ['observe', 'propose', 'speak', 'invoke'];

// ARCHITECTURE §4.2 默认授权 + access_grant 显式追加
export function can(actor: Actor, right: Right, scope: Scope, ctx: PermCtx): boolean {
  if (actor.type === 'human') return true;

  const explicit = ctx.grants.some(
    (g) =>
      g.subjectType === 'agent' &&
      g.subjectId === actor.id &&
      g.scopeType === scope.type &&
      g.scopeId === scope.id &&
      g.rights.includes(right),
  );
  if (explicit) return true;

  if (scope.type === 'project') {
    // 项目级作用域：Agent 只能观察（摘要投影级别）
    return right === 'observe';
  }

  const agent = ctx.agent;
  if (!agent || agent.id !== actor.id) return false;
  const own = agent.workstationId;
  const target = scope.id;
  if (target === own) return ALL.includes(right);

  const ancestors = ancestorIds(ctx, own);
  if (ancestors.includes(target)) {
    if (right === 'observe') return true;
    // steward 额外拥有父级 speak（仅直接父级）
    if (right === 'speak' && agent.isSteward && ancestors[0] === target) return true;
    return false;
  }

  if (descendantIds(ctx, own).includes(target)) {
    return right === 'invoke' || right === 'observe';
  }

  return false; // 兄弟及其他：全无
}

// 该 actor 可观察的工作台 id 集合（空数组 = 无限制，仅 human）
export function visibleWorkstations(actor: Actor, ctx: PermCtx): string[] | null {
  if (actor.type === 'human') return null;
  return ctx.workstations
    .filter((w) => can(actor, 'observe', { type: 'workstation', id: w.id }, ctx))
    .map((w) => w.id);
}
