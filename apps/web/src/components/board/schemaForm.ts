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

export const toChecks = (text: string): CommandCheck[] =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((run) => ({ kind: 'command', run, expect: { exitCode: 0 } }));

export const fromChecks = (json: string | null | undefined) => {
  try {
    return (JSON.parse(json ?? '[]') as { run?: string }[]).flatMap((c) => (c.run ? [c.run] : [])).join('\n');
  } catch {
    return '';
  }
};
