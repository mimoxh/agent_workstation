import { describe, expect, it } from 'vitest';
import { isOverdue, wouldCreateCycle, type DepEdge } from '../src/plan.js';

const edges = (pairs: [string, string][]): DepEdge[] => pairs.map(([taskId, dependsOnId]) => ({ taskId, dependsOnId }));

describe('wouldCreateCycle', () => {
  it('自指即成环', () => {
    expect(wouldCreateCycle([], 'a', ['a'])).toBe(true);
  });

  it('A 等 B、B 再等 A 成环', () => {
    const e = edges([['a', 'b']]);
    expect(wouldCreateCycle(e, 'b', ['a'])).toBe(true);
  });

  it('更长的链回指也成环', () => {
    const e = edges([
      ['a', 'b'],
      ['b', 'c'],
    ]);
    expect(wouldCreateCycle(e, 'c', ['a'])).toBe(true);
  });

  it('同方向的依赖不成环', () => {
    const e = edges([
      ['a', 'b'],
      ['b', 'c'],
    ]);
    expect(wouldCreateCycle(e, 'd', ['a', 'c'])).toBe(false);
  });

  it('同一个任务自己的旧边按整组替换处理', () => {
    // 已有 a→b、c→a；把 a 的依赖整组换成 [c]：a→c→a 成环
    expect(wouldCreateCycle(edges([['a', 'b'], ['c', 'a']]), 'a', ['c'])).toBe(true);
    // 而保持 [b] 仍无环：c→a 单独不构成回路
    expect(wouldCreateCycle(edges([['a', 'b'], ['c', 'a']]), 'a', ['b'])).toBe(false);
  });

  it('多条新边里只要一条成环就算', () => {
    const e = edges([['x', 'a']]);
    expect(wouldCreateCycle(e, 'a', ['y', 'x'])).toBe(true);
  });
});

describe('isOverdue', () => {
  it('截止日早于今天且未收口才算逾期', () => {
    expect(isOverdue('2026-01-01', 'in_progress', '2026-01-02')).toBe(true);
    expect(isOverdue('2026-01-02', 'in_progress', '2026-01-02')).toBe(false);
    expect(isOverdue('2026-01-01', 'done', '2026-01-02')).toBe(false);
    expect(isOverdue('2026-01-01', 'cancelled', '2026-01-02')).toBe(false);
    expect(isOverdue(null, 'in_progress', '2026-01-02')).toBe(false);
  });
});
