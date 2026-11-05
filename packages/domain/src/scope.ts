export type Scope = { type: 'workstation' | 'project'; id: string };

export interface PermCtx {
  workstations: { id: string; parentId: string | null }[];
  agent?: { id: string; workstationId: string; isSteward: boolean } | undefined;
  grants: {
    subjectType: 'human' | 'agent';
    subjectId: string;
    scopeType: 'workstation' | 'project';
    scopeId: string;
    rights: string[];
  }[];
}

export function ancestorIds(ctx: PermCtx, wsId: string): string[] {
  const byId = new Map(ctx.workstations.map((w) => [w.id, w.parentId]));
  const chain: string[] = [];
  let cur = byId.get(wsId) ?? null;
  while (cur !== null) {
    chain.push(cur);
    cur = byId.get(cur) ?? null;
  }
  return chain;
}

export function descendantIds(ctx: PermCtx, wsId: string): string[] {
  const result: string[] = [];
  const queue = [wsId];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const w of ctx.workstations) {
      if (w.parentId === cur) {
        result.push(w.id);
        queue.push(w.id);
      }
    }
  }
  return result;
}
