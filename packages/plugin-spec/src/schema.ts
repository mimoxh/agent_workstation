import { z } from 'zod';

// PLUGIN-SPEC v0.2 manifest 的 Zod schema

export const fieldDefSchema = z.object({
  type: z.enum(['string', 'text', 'markdown', 'number', 'boolean', 'date', 'enum', 'ref', 'ref[]', 'json']),
  label: z.string(),
  description: z.string().optional(),
  required: z.boolean().optional(),
  enum: z.array(z.string()).optional(),
  refTo: z.string().optional(),
  maxLength: z.number().optional(),
  default: z.unknown().optional(),
});

export const entityDefSchema = z.object({
  label: z.string(),
  description: z.string(),
  titleField: z.string(),
  writeMode: z.enum(['direct', 'propose']).optional(),
  fields: z.record(z.string(), fieldDefSchema),
});

export const relationDefSchema = z.object({
  id: z.string(),
  from: z.string(),
  to: z.string(),
  label: z.string(),
  directed: z.boolean().optional(),
});

export const requirementSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('entity'),
    entity: z.string(),
    minCount: z.number().optional(),
    fieldsPresent: z.array(z.string()).optional(),
    description: z.string().optional(),
  }),
  z.object({ kind: z.literal('acceptance'), description: z.string().optional() }),
  z.object({
    kind: z.literal('approval'),
    by: z.enum(['human', 'agent']).optional(),
    description: z.string().optional(),
  }),
  z.object({ kind: z.literal('manual'), text: z.string(), description: z.string().optional() }),
]);

export const stageDefSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  requirements: z.array(requirementSchema).optional(),
  activePanels: z.array(z.string()).optional(),
  activeAgents: z.array(z.string()).optional(),
});

export const PANEL_TYPES = ['table', 'board', 'tree', 'doc', 'graph', 'timeline', 'form', 'detail', 'diff', 'preview', 'knowledge'] as const;

export const panelDefSchema = z.object({
  id: z.string(),
  type: z.enum(PANEL_TYPES),
  entity: z.string(),
  title: z.string(),
  config: z.record(z.string(), z.unknown()).optional(),
  editableBy: z.array(z.enum(['human', 'agent'])),
});

export const agentTemplateDefSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.string(),
  systemPrompt: z.string().optional(),
  promptFile: z.string().optional(),
  model: z
    .object({
      provider: z.string().optional(),
      name: z.string().optional(),
      temperature: z.number().optional(),
    }).optional(),
  tools: z.array(z.string()),
  triggers: z.array(z.enum(['task_assigned', 'mentioned', 'stage_enter', 'schedule', 'manual'])).optional(),
  budget: z.object({ tokens: z.number().optional(), minutes: z.number().optional() }).optional(),
});

export const acceptanceCheckSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('command'),
    run: z.string(),
    expect: z.object({ exitCode: z.number() }),
  }),
  z.object({ kind: z.literal('visual'), url: z.string(), baseline: z.string(), maxDiff: z.number() }),
  z.object({ kind: z.literal('manual'), text: z.string() }),
]);

export const taskTypeDefSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
  stages: z.array(z.string()).optional(),
  acceptance: z.array(z.union([z.string(), acceptanceCheckSchema])).optional(),
  defaultBudget: z.object({ tokens: z.number().optional(), minutes: z.number().optional() }).optional(),
  handler: z.enum(['agent', 'human', 'auto']).optional(),
});

export const toolDefSchema = z.object({
  id: z.string(),
  description: z.string(),
  params: z.record(z.string(), z.unknown()),
  handler: z.string(),
  scope: z.enum(['workstation', 'project']),
});

export const modulesConfigSchema = z.object({
  conversation: z
    .object({
      defaultMode: z.enum(['free', 'moderated', 'bidding', 'relay']),
      threadOverrides: z
        .partialRecord(z.enum(['task', 'review', 'discussion', 'dm']), z.enum(['free', 'moderated', 'bidding', 'relay']))
        .optional(),
      moderator: z.string().optional(),
      maxTurns: z.number().optional(),
      summaryEvery: z.number().optional(),
    })
    .optional(),
  knowledge: z
    .object({
      scope: z.enum(['project', 'workstation']),
      acceptedTypes: z.array(z.enum(['md', 'txt', 'pdf', 'docx'])),
      retrieval: z.object({ strategy: z.enum(['fts', 'hybrid']), topK: z.number(), maxTokens: z.number() }),
      citation: z.enum(['required', 'preferred']),
    })
    .optional(),
  memory: z
    .object({
      strategy: z.enum(['none', 'explicit']),
      decisionLog: z.boolean().optional(),
      sessionSummary: z.object({ enabled: z.boolean(), every: z.number().optional() }).optional(),
    })
    .optional(),
  approval: z
    .object({
      requireHumanFor: z.array(z.enum(['proposal_merge', 'dangerous_command', 'budget_overrun', 'task_complete'])),
    })
    .optional(),
});

export const presetDefSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  patch: z.record(z.string(), z.unknown()),
});

export const manifestSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string(),
  version: z.string(),
  description: z.string(),
  icon: z.string().optional(),
  entities: z.record(z.string(), entityDefSchema),
  relations: z.array(relationDefSchema).optional(),
  stages: z.array(stageDefSchema).optional(),
  panels: z.array(panelDefSchema),
  agents: z.array(agentTemplateDefSchema),
  steward: z.string(),
  tasks: z.array(taskTypeDefSchema),
  tools: z.array(toolDefSchema).optional(),
  modules: modulesConfigSchema.optional(),
  presets: z.array(presetDefSchema).optional(),
  defaults: z
    .object({
      writeMode: z.enum(['direct', 'propose']).optional(),
      taskBudget: z.object({ tokens: z.number().optional(), minutes: z.number().optional() }).optional(),
    })
    .optional(),
});

export type FieldDef = z.infer<typeof fieldDefSchema>;
export type EntityDef = z.infer<typeof entityDefSchema>;
export type RelationDef = z.infer<typeof relationDefSchema>;
export type Requirement = z.infer<typeof requirementSchema>;
export type StageDef = z.infer<typeof stageDefSchema>;
export type PanelDef = z.infer<typeof panelDefSchema>;
export type AgentTemplateDef = z.infer<typeof agentTemplateDefSchema>;
export type AcceptanceCheck = z.infer<typeof acceptanceCheckSchema>;
export type TaskTypeDef = z.infer<typeof taskTypeDefSchema>;
export type ToolDef = z.infer<typeof toolDefSchema>;
export type ModulesConfig = z.infer<typeof modulesConfigSchema>;
export type PresetDef = z.infer<typeof presetDefSchema>;
export type WorkbenchManifest = z.infer<typeof manifestSchema>;
