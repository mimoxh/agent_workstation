// 任务排期与前置依赖的纯函数：日期一律 'YYYY-MM-DD'，字典序即时间序

export interface DepEdge {
  taskId: string;
  dependsOnId: string;
}

// 给 taskId 新增指向 dependsOn 里每个任务的依赖边，是否会成环（含自指）
export function wouldCreateCycle(edges: DepEdge[], taskId: string, dependsOn: string[]): boolean {
  const next = new Map<string, string[]>();
  const add = (from: string, to: string) => next.set(from, [...(next.get(from) ?? []), to]);
  for (const e of edges) {
    // taskId 自己的旧边会被整组替换，不计入
    if (e.taskId !== taskId) add(e.taskId, e.dependsOnId);
  }
  for (const dep of dependsOn) {
    if (dep === taskId) return true;
    add(taskId, dep);
  }
  // 沿反向边（依赖它的任务）向上走，能回到 taskId 即成环
  const reverse = new Map<string, string[]>();
  for (const [from, tos] of next) for (const to of tos) reverse.set(to, [...(reverse.get(to) ?? []), from]);
  const seen = new Set<string>();
  const queue = [...(reverse.get(taskId) ?? [])];
  while (queue.length > 0) {
    const cur = queue.pop()!;
    if (cur === taskId) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    queue.push(...(reverse.get(cur) ?? []));
  }
  return false;
}

// 截止日已过且任务还没收口
export function isOverdue(dueAt: string | null, status: string, today: string): boolean {
  return !!dueAt && dueAt < today && status !== 'done' && status !== 'cancelled';
}

// 本地日历日（不是 UTC）：'YYYY-MM-DD'
export function localDate(d = new Date()): string {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}
