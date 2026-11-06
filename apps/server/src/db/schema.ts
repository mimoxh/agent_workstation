import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  type AnySQLiteColumn,
} from 'drizzle-orm/sqlite-core';

// ARCHITECTURE §3 数据模型（M0.1 子集）。*_json 列存 text。
// 通用时间戳只实现 created_at（其余列在对应表补齐时再加）。

export const workspace = sqliteTable('workspace', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  createdAt: text('created_at').notNull(),
});

export const appUser = sqliteTable('app_user', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspace.id),
  name: text('name').notNull(),
  email: text('email'),
  avatar: text('avatar'),
  createdAt: text('created_at').notNull(),
});

export const project = sqliteTable('project', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspace.id),
  name: text('name').notNull(),
  goal: text('goal'),
  status: text('status'),
  trigger: text('trigger'),
  budgetJson: text('budget_json'),
  createdAt: text('created_at').notNull(),
});

// 树形：parent_id 为 NULL 表示根工作台（承载「全局作用域」）。
// stage 已删除：阶段挂在任务上，不挂在工作台上。
export const workstation = sqliteTable(
  'workstation',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => project.id),
    parentId: text('parent_id').references((): AnySQLiteColumn => workstation.id),
    pluginId: text('plugin_id'),
    pluginVersion: text('plugin_version'),
    name: text('name').notNull(),
    status: text('status'),
  trigger: text('trigger'),
    settingsJson: text('settings_json'),
    sort: integer('sort'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('idx_ws_project_parent').on(t.projectId, t.parentId)],
);

// stage = 插件定义的工作流位置（任务级）；status = 平台通用生命周期。
// module 等字段放 input_json，按任务类型的 schema 校验。
export const task = sqliteTable(
  'task',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => project.id),
    workstationId: text('workstation_id')
      .notNull()
      .references(() => workstation.id),
    parentId: text('parent_id').references((): AnySQLiteColumn => task.id),
    typeId: text('type_id'),
    stage: text('stage'),
    codeRefJson: text('code_ref_json'),
    title: text('title').notNull(),
    intent: text('intent'),
    inputJson: text('input_json'),
    acceptanceJson: text('acceptance_json'),
    status: text('status').notNull().default('draft'),
  trigger: text('trigger'),
    assigneeType: text('assignee_type'),
    assigneeId: text('assignee_id'),
    dispatchReason: text('dispatch_reason'),
    budgetJson: text('budget_json'),
    usageJson: text('usage_json'),
    resultJson: text('result_json'),
    blockedReason: text('blocked_reason'),
    feedbackCount: integer('feedback_count').notNull().default(0),
    dueAt: text('due_at'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('idx_task_ws_status').on(t.workstationId, t.status)],
);

export const agent = sqliteTable('agent', {
  id: text('id').primaryKey(),
  workstationId: text('workstation_id').notNull().references(() => workstation.id),
  templateId: text('template_id'),
  name: text('name').notNull(),
  role: text('role'),
  modelJson: text('model_json'),
  prompt: text('prompt'),
  toolsJson: text('tools_json'),
  budgetJson: text('budget_json'),
  isSteward: integer('is_steward').notNull().default(0),
  status: text('status'),
  trigger: text('trigger'),
  createdAt: text('created_at').notNull(),
});

export const block = sqliteTable('block', {
  id: text('id').primaryKey(),
  workstationId: text('workstation_id').notNull().references(() => workstation.id),
  panelId: text('panel_id'),
  panelType: text('panel_type'),
  entityType: text('entity_type'),
  name: text('name'),
  configJson: text('config_json'),
  sort: integer('sort'),
  createdAt: text('created_at').notNull(),
});

export const entity = sqliteTable(
  'entity',
  {
    id: text('id').primaryKey(),
    workstationId: text('workstation_id').notNull().references(() => workstation.id),
    entityType: text('entity_type').notNull(),
    dataJson: text('data_json'),
    version: integer('version').notNull().default(1),
    createdByType: text('created_by_type'),
    createdById: text('created_by_id'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at'),
  },
  (t) => [index('idx_entity_ws_type').on(t.workstationId, t.entityType)],
);

export const entityVersion = sqliteTable(
  'entity_version',
  {
    id: text('id').primaryKey(),
    entityId: text('entity_id').notNull().references(() => entity.id),
    version: integer('version').notNull(),
    dataJson: text('data_json'),
    authorType: text('author_type'),
    authorId: text('author_id'),
    reason: text('reason'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('idx_version_entity').on(t.entityId, t.version)],
);

export const proposal = sqliteTable('proposal', {
  id: text('id').primaryKey(),
  taskId: text('task_id').references(() => task.id),
  targetType: text('target_type'),
  entityId: text('entity_id'),
  baseVersion: integer('base_version'),
  patchJson: text('patch_json'),
  codeRefJson: text('code_ref_json'),
  reason: text('reason'),
  authorType: text('author_type'),
  authorId: text('author_id'),
  status: text('status').notNull().default('pending'),
  trigger: text('trigger'),
  decidedByType: text('decided_by_type'),
  decidedById: text('decided_by_id'),
  decidedAt: text('decided_at'),
  createdAt: text('created_at').notNull(),
});

export const reviewComment = sqliteTable('review_comment', {
  id: text('id').primaryKey(),
  proposalId: text('proposal_id').notNull().references(() => proposal.id),
  authorType: text('author_type'),
  authorId: text('author_id'),
  path: text('path'),
  line: integer('line'),
  body: text('body'),
  resolved: integer('resolved').notNull().default(0),
  createdAt: text('created_at').notNull(),
});

export const thread = sqliteTable('thread', {
  id: text('id').primaryKey(),
  scopeType: text('scope_type'),
  scopeId: text('scope_id'),
  kind: text('kind'),
  mode: text('mode'),
  title: text('title'),
  createdAt: text('created_at').notNull(),
});

export const threadMember = sqliteTable(
  'thread_member',
  {
    threadId: text('thread_id').notNull().references(() => thread.id),
    participantType: text('participant_type').notNull(),
    participantId: text('participant_id').notNull(),
    role: text('role'),
  },
  (t) => [primaryKey({ columns: [t.threadId, t.participantType, t.participantId] })],
);

export const message = sqliteTable(
  'message',
  {
    id: text('id').primaryKey(),
    threadId: text('thread_id').notNull().references(() => thread.id),
    senderType: text('sender_type'),
    senderId: text('sender_id'),
    kind: text('kind'),
    content: text('content'),
    metaJson: text('meta_json'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('idx_msg_thread').on(t.threadId, t.createdAt)],
);

export const run = sqliteTable(
  'run',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id').references(() => agent.id),
    taskId: text('task_id').references(() => task.id),
    status: text('status'),
    trigger: text('trigger'),
    provider: text('provider'),
    model: text('model'),
    fallbackFrom: text('fallback_from'),
    stopReason: text('stop_reason'),
    startedAt: text('started_at'),
    endedAt: text('ended_at'),
    tokensIn: integer('tokens_in'),
    tokensOut: integer('tokens_out'),
    cost: integer('cost'),
    traceJson: text('trace_json'),
    error: text('error'),
  },
  (t) => [index('idx_run_agent').on(t.agentId, t.startedAt)],
);

export const artifact = sqliteTable('artifact', {
  id: text('id').primaryKey(),
  workstationId: text('workstation_id').references(() => workstation.id),
  taskId: text('task_id').references(() => task.id),
  type: text('type'),
  name: text('name'),
  ref: text('ref'),
  metaJson: text('meta_json'),
  createdAt: text('created_at').notNull(),
});

// M0��kind �� command_confirm|blocked|proposal_review|run_failed|task_rejected|task_countered��M1 ���� budget ��
export const inboxItem = sqliteTable('inbox_item', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  projectId: text('project_id'),
  kind: text('kind').notNull(),
  refType: text('ref_type'),
  refId: text('ref_id'),
  severity: text('severity'),
  status: text('status').notNull().default('open'),
  trigger: text('trigger'),
   payloadJson: text('payload_json'),
   resolutionJson: text('resolution_json'),
  createdAt: text('created_at').notNull(),
});

export const eventLog = sqliteTable('event_log', {
  id: text('id').primaryKey(),
  actorType: text('actor_type'),
  actorId: text('actor_id'),
  action: text('action').notNull(),
  targetType: text('target_type'),
  targetId: text('target_id'),
  payloadJson: text('payload_json'),
  createdAt: text('created_at').notNull(),
});

export const accessGrant = sqliteTable('access_grant', {
  id: text('id').primaryKey(),
  subjectType: text('subject_type').notNull(),
  subjectId: text('subject_id').notNull(),
  scopeType: text('scope_type').notNull(),
  scopeId: text('scope_id').notNull(),
  rightsJson: text('rights_json'),
});

export const pluginInstall = sqliteTable('plugin_install', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  pluginId: text('plugin_id').notNull(),
  version: text('version'),
  source: text('source'),
  enabled: integer('enabled').notNull().default(1),
  createdAt: text('created_at').notNull(),
});
