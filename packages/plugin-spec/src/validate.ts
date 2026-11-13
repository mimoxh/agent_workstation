import { manifestSchema, type WorkbenchManifest } from './schema.js';

// ARCHITECTURE §6.3 内置工具 + 协作工具 + DEV §6 的 10 个
export const BUILTIN_TOOLS = [
  'read_entity',
  'list_entities',
  'propose_entity',
  'search_workstation',
  'create_task',
  'send_message',
  'report_blocked',
  'request_human',
  'search_knowledge',
  'respond_task',
  'dispatch_task',
  'record_decision',
  'resolve_block',
  'escalate_block',
  'advance_stage',
  'search_knowledge',
  'read_file',
  'search_code',
  'git_diff',
  'apply_patch',
  'git_commit',
  'submit_change',
  'review_change',
  'run_command',
  'run_tests',
  'capture_screenshot',
  'list_files',
  'sync_branch',
  'list_designs',
  'read_design',
  'write_design',
  'edit_design',
  'read_design_system',
  'update_design_system',
  'comment_design',
  'resolve_design_comments',
  'read_design_handoff',
  'view_design',
  'read_design_snapshot',
  'qa_overview',
  'list_test_suites',
  'run_test_suite',
  'get_test_run',
  'get_case_history',
  'list_flaky_tests',
  'read_repo_file',
  'search_repo',
  'list_repos',
  'list_docs',
  'read_doc',
  'write_doc',
  'edit_doc',
  'comment_doc',
  'resolve_doc_comments',
  'read_style_guide',
  'update_style_guide',
  'save_doc_review',
  'read_doc_handoff',
  'list_tasks',
  'plan_task',
  'project_status',
  'save_triage',
  'save_test_cases',
  'draft_bug',
  'save_plan_summary',
] as const;

export const SYSTEM_ENTITIES = ['system:task', 'system:proposal', 'system:files', 'system:knowledge'] as const;

export type ValidateResult =
  | { ok: true; manifest: WorkbenchManifest }
  | { ok: false; errors: string[] };

export function validateManifest(json: unknown): ValidateResult {
  const parsed = manifestSchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    };
  }
  const m = parsed.data;
  const errors: string[] = [];

  for (const entityId of Object.keys(m.entities)) {
    if (entityId.startsWith('system:')) {
      errors.push(`实体 ${entityId} 使用了保留前缀 system:`);
    }
  }
  for (const [entityId, def] of Object.entries(m.entities)) {
    for (const [fieldId, f] of Object.entries(def.fields)) {
      if (f.refTo !== undefined && m.entities[f.refTo] === undefined) {
        errors.push(`${entityId}.${fieldId} 的 refTo 指向不存在的实体 ${f.refTo}`);
      }
    }
  }

  const agentIds = new Set(m.agents.map((a) => a.id));
  const panelIds = new Set(m.panels.map((p) => p.id));
  const stageIds = new Set((m.stages ?? []).map((s) => s.id));
  const declaredTools = new Set([...BUILTIN_TOOLS, ...(m.tools ?? []).map((t) => t.id)]);

  if (!agentIds.has(m.steward)) {
    errors.push(`steward ${m.steward} 不在 agents 中`);
  }
  for (const p of m.panels) {
    const isSystem = (SYSTEM_ENTITIES as readonly string[]).includes(p.entity);
    if (!isSystem && m.entities[p.entity] === undefined) {
      errors.push(`面板 ${p.id} 引用的实体 ${p.entity} 不存在（且不是 system:*）`);
    }
  }
  for (const s of m.stages ?? []) {
    for (const a of s.activeAgents ?? []) {
      if (!agentIds.has(a)) errors.push(`stage ${s.id} 引用了不存在的 Agent ${a}`);
    }
    for (const p of s.activePanels ?? []) {
      if (!panelIds.has(p)) errors.push(`stage ${s.id} 引用了不存在的面板 ${p}`);
    }
  }
  for (const t of m.tasks) {
    for (const s of t.stages ?? []) {
      if (!stageIds.has(s)) errors.push(`任务类型 ${t.id} 引用了不存在的 stage ${s}`);
    }
  }
  for (const a of m.agents) {
    for (const tool of a.tools) {
      if (!declaredTools.has(tool)) {
        errors.push(`Agent ${a.id} 声明了未知工具 ${tool}`);
      }
    }
  }
  const dup = (ids: string[], what: string) => {
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) errors.push(`${what} id 重复：${id}`);
      seen.add(id);
    }
  };
  dup(m.panels.map((p) => p.id), '面板');
  dup(m.agents.map((a) => a.id), 'Agent');
  dup((m.stages ?? []).map((s) => s.id), 'stage');
  dup(m.tasks.map((t) => t.id), '任务类型');

  return errors.length > 0 ? { ok: false, errors } : { ok: true, manifest: m };
}

// JSON-Schema 子集校验器：只支持 type / required / properties / enum
export function validateInput(schema: Record<string, unknown>, value: unknown): string[] {
  const errors: string[] = [];
  const typeOf = (v: unknown): string =>
    v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
  const check = (s: Record<string, unknown>, v: unknown, path: string) => {
    const want = s.type as string | undefined;
    if (want !== undefined) {
      const got = typeOf(v);
      const okType =
        want === got || (want === 'integer' && got === 'number' && Number.isInteger(v)) || (want === 'number' && got === 'number');
      if (!okType) {
        errors.push(`${path || '$'} 类型应为 ${want}，实际为 ${got}`);
        return;
      }
    }
    if (s.enum !== undefined && !(s.enum as unknown[]).includes(v)) {
      errors.push(`${path || '$'} 必须是 ${JSON.stringify(s.enum)} 之一`);
    }
    if (want === 'object' && typeof v === 'object' && v !== null) {
      const obj = v as Record<string, unknown>;
      for (const req of (s.required as string[] | undefined) ?? []) {
        if (obj[req] === undefined) errors.push(`${path || '$'} 缺少必填字段 ${req}`);
      }
      const props = (s.properties as Record<string, Record<string, unknown>> | undefined) ?? {};
      for (const [k, sub] of Object.entries(props)) {
        if (obj[k] !== undefined) check(sub, obj[k], path ? `${path}.${k}` : k);
      }
    }
  };
  check(schema, value, '');
  return errors;
}
