export type BudgetScope = 'task' | 'workstation' | 'project';

export interface Budget {
  tokens?: number | undefined;
  costMicros?: number | undefined;
}

export interface Usage {
  tokens: number;
  costMicros: number;
}

export interface BudgetLevel {
  scope: BudgetScope;
  budget: Budget | null;
  usage: Usage;
}

export interface BudgetBreach {
  scope: BudgetScope;
  metric: 'tokens' | 'cost';
  limit: number;
  used: number;
}

const ORDER: readonly BudgetScope[] = ['task', 'workstation', 'project'];

// I6：三级预算硬约束，任何一级超限都熔断；从最窄的一级开始报，方便人知道该调哪里
export function firstBreach(levels: readonly BudgetLevel[]): BudgetBreach | null {
  for (const scope of ORDER) {
    const level = levels.find((l) => l.scope === scope);
    if (!level?.budget) continue;
    const { tokens, costMicros } = level.budget;
    if (tokens !== undefined && level.usage.tokens >= tokens) return { scope, metric: 'tokens', limit: tokens, used: level.usage.tokens };
    if (costMicros !== undefined && level.usage.costMicros >= costMicros) return { scope, metric: 'cost', limit: costMicros, used: level.usage.costMicros };
  }
  return null;
}

// 价格单位：美元 / 百万 token；存储单位：微美元，避免浮点累计误差
export function costMicros(tokensIn: number, tokensOut: number, price: { input: number; output: number } | undefined): number {
  if (!price) return 0;
  return Math.round(tokensIn * price.input + tokensOut * price.output);
}
