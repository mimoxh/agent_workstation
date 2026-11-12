// inputSchema（JSON-Schema 子集）→ 表单描述：enum 下拉 + 必填标注
export interface SchemaField {
  name: string;
  required: boolean;
  enum?: string[] | undefined;
  type?: string | undefined;
  description?: string | undefined;
}

export function fieldsOf(schema: Record<string, unknown> | null | undefined): SchemaField[] {
  if (!schema) return [];
  const required = new Set((schema.required as string[] | undefined) ?? []);
  const props = (schema.properties as Record<string, { enum?: string[]; type?: string; description?: string }> | undefined) ?? {};
  return Object.entries(props).map(([name, p]) => ({
    name,
    required: required.has(name),
    enum: p.enum,
    type: p.type,
    description: p.description,
  }));
}

export const FIELD_LABEL: Record<string, string> = { kind: '类型', priority: '优先级', module: '模块路径' };

export type CommandCheck = {
  kind: 'command';
  run: string;
  expect: { exitCode: number };
};

// 验收检查：command 之外的种类（qa_suite、visual、manual）不在文本框里编辑，原样带过去
export type Check = { kind: string; run?: string; suite?: string };

export const parseChecks = (json: string | null | undefined): Check[] => {
  try {
    return (JSON.parse(json ?? '[]') as Check[]).filter((c) => c && typeof c === 'object' && !!c.kind);
  } catch {
    return [];
  }
};

export const qaSuiteChecks = (json: string | null | undefined) => parseChecks(json).filter((c) => c.kind === 'qa_suite' && !!c.suite);

export const toChecks = (text: string, extras: Check[] = []): Check[] => [
  ...text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((run) => ({ kind: 'command', run, expect: { exitCode: 0 } })),
  ...extras.filter((c) => c.kind !== 'command'),
];

export const fromChecks = (json: string | null | undefined) => {
  try {
    return (JSON.parse(json ?? '[]') as { kind?: string; run?: string }[]).flatMap((c) => (c.kind === 'command' && c.run ? [c.run] : [])).join('\n');
  } catch {
    return '';
  }
};
