import { describe, expect, it } from 'vitest';
import { costMicros, firstBreach } from '../src/budget.js';

const usage = (tokens: number, cost = 0) => ({ tokens, costMicros: cost });

describe('firstBreach', () => {
  it('没有设置预算时不熔断', () => {
    expect(firstBreach([{ scope: 'project', budget: null, usage: usage(1e9) }])).toBeNull();
  });

  it('任一级超限都熔断，从最窄的一级开始报', () => {
    const r = firstBreach([
      { scope: 'project', budget: { tokens: 100 }, usage: usage(200) },
      { scope: 'task', budget: { tokens: 50 }, usage: usage(60) },
    ]);
    expect(r).toEqual({ scope: 'task', metric: 'tokens', limit: 50, used: 60 });
  });

  it('上级超限时下级没超也要停', () => {
    const r = firstBreach([
      { scope: 'task', budget: { tokens: 1000 }, usage: usage(10) },
      { scope: 'project', budget: { costMicros: 500 }, usage: usage(10, 500) },
    ]);
    expect(r).toEqual({ scope: 'project', metric: 'cost', limit: 500, used: 500 });
  });

  it('未到上限不熔断', () => {
    expect(firstBreach([{ scope: 'workstation', budget: { tokens: 100 }, usage: usage(99) }])).toBeNull();
  });
});

describe('costMicros', () => {
  it('按百万 token 单价折算成微美元', () => {
    expect(costMicros(1_000_000, 500_000, { input: 3, output: 15 })).toBe(10_500_000);
  });
  it('没有单价时成本为 0，不估算', () => expect(costMicros(100, 100, undefined)).toBe(0));
});
