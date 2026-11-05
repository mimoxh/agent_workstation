// inputSchema（JSON-Schema 子集）→ 表单描述：enum 下拉 + 必填标注
export interface SchemaField {
  name: string;
  required: boolean;
  enum?: string[] | undefined;
  type?: string | undefined;
}

export function fieldsOf(schema: Record<string, unknown> | null | undefined): SchemaField[] {
  if (!schema) return [];
  const required = new Set((schema.required as string[] | undefined) ?? []);
  const props = (schema.properties as Record<string, { enum?: string[]; type?: string }> | undefined) ?? {};
  return Object.entries(props).map(([name, p]) => ({
    name,
    required: required.has(name),
    enum: p.enum,
    type: p.type,
  }));
}

export function enumOf(schema: Record<string, unknown> | null | undefined, prop: string): string[] {
  const props = (schema?.properties as Record<string, { enum?: string[] }> | undefined) ?? {};
  return props[prop]?.enum ?? [];
}
