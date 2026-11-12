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
    takeoverFrom: text('takeover_from'),
    typeId: text('type_id'),
    stage: text('stage'),
    codeRefJson: text('code_ref_json'),
    title: text('title').notNull(),
    intent: text('intent'),
    inputJson: text('input_json'),
    acceptanceJson: text('acceptance_json'),
    status: text('status').notNull().default('draft'),
    assigneeType: text('assignee_type'),
    assigneeId: text('assignee_id'),
    dispatchReason: text('dispatch_reason'),
    budgetJson: text('budget_json'),
    usageJson: text('usage_json'),
    resultJson: text('result_json'),
    blockedReason: text('blocked_reason'),
    feedbackCount: integer('feedback_count').notNull().default(0),
    startAt: text('start_at'),
    dueAt: text('due_at'),
    milestoneId: text('milestone_id'),
    pendingAssigneeId: text('pending_assignee_id'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('idx_task_ws_status').on(t.workstationId, t.status)],
);

// 前置依赖（A 等 B）：B 完成后草稿态的 A 才会被放行派发
export const taskDependency = sqliteTable(
  'task_dependency',
  {
    taskId: text('task_id')
      .notNull()
      .references(() => task.id),
    dependsOnId: text('depends_on_id')
      .notNull()
      .references(() => task.id),
    createdAt: text('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.dependsOnId] }), index('idx_dep_on').on(t.dependsOnId)],
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
  workstationId: text('workstation_id'),
  targetType: text('target_type'),
  entityId: text('entity_id'),
  baseVersion: integer('base_version'),
  patchJson: text('patch_json'),
  codeRefJson: text('code_ref_json'),
  reason: text('reason'),
  authorType: text('author_type'),
  authorId: text('author_id'),
  status: text('status').notNull().default('pending'),
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
  state: text('state').notNull().default('active'),
  turnCount: integer('turn_count').notNull().default(0),
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
    threadId: text('thread_id'),
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

// 测试台的一次套件运行。config_json 是发起时的命令快照：套件之后被改，这次跑的仍是当时审定的命令
export const qaRun = sqliteTable(
  'qa_run',
  {
    id: text('id').primaryKey(),
    workstationId: text('workstation_id').notNull().references(() => workstation.id),
    suiteId: text('suite_id').notNull(),
    suiteName: text('suite_name').notNull(),
    configJson: text('config_json').notNull(),
    planId: text('plan_id'),
    ref: text('ref').notNull(),
    commitSha: text('commit_sha').notNull(),
    status: text('status').notNull().default('queued'),
    trigger: text('trigger').notNull(),
    actorType: text('actor_type'),
    actorId: text('actor_id'),
    total: integer('total').notNull().default(0),
    passed: integer('passed').notNull().default(0),
    failed: integer('failed').notNull().default(0),
    errored: integer('errored').notNull().default(0),
    skipped: integer('skipped').notNull().default(0),
    durationMs: integer('duration_ms'),
    coverageJson: text('coverage_json'),
    outputArtifactId: text('output_artifact_id'),
    error: text('error'),
    envError: integer('env_error').notNull().default(0),
    retryOf: text('retry_of'),
    triageJson: text('triage_json'),
    createdAt: text('created_at').notNull(),
    startedAt: text('started_at'),
    finishedAt: text('finished_at'),
  },
  (t) => [index('idx_qa_run_ws').on(t.workstationId, t.createdAt), index('idx_qa_run_suite').on(t.workstationId, t.suiteId, t.createdAt)],
);

export const qaCaseResult = sqliteTable(
  'qa_case_result',
  {
    id: text('id').primaryKey(),
    runId: text('run_id').notNull().references(() => qaRun.id),
    workstationId: text('workstation_id').notNull().references(() => workstation.id),
    suiteId: text('suite_id').notNull(),
    caseKey: text('case_key').notNull(),
    classname: text('classname').notNull(),
    name: text('name').notNull(),
    status: text('status').notNull(),
    durationMs: integer('duration_ms').notNull().default(0),
    failureMessage: text('failure_message'),
    failureDetail: text('failure_detail'),
    fingerprint: text('fingerprint'),
    commitSha: text('commit_sha').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('idx_qa_case_key').on(t.workstationId, t.caseKey, t.createdAt), index('idx_qa_case_run').on(t.runId)],
);

// kind：command_confirm / blocked / proposal_review / run_failed / task_rejected / task_countered / human_request / qa_regression
export const inboxItem = sqliteTable('inbox_item', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  projectId: text('project_id'),
  kind: text('kind').notNull(),
  refType: text('ref_type'),
  refId: text('ref_id'),
  severity: text('severity'),
  status: text('status').notNull().default('open'),
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

// ARCHITECTURE §3.1：知识库与实体是两条独立通路；全文索引 knowledge_fts 是迁移里建的虚拟表
export const knowledgeSource = sqliteTable('knowledge_source', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  scopeType: text('scope_type').notNull(),
  scopeId: text('scope_id').notNull(),
  name: text('name').notNull(),
  kind: text('kind').notNull(),
  uri: text('uri'),
  mime: text('mime'),
  sha256: text('sha256'),
  size: integer('size'),
  status: text('status'),
  metaJson: text('meta_json'),
  createdAt: text('created_at').notNull(),
});

export const knowledgeChunk = sqliteTable(
  'knowledge_chunk',
  {
    id: text('id').primaryKey(),
    sourceId: text('source_id').notNull().references(() => knowledgeSource.id),
    ordinal: integer('ordinal').notNull(),
    text: text('text').notNull(),
    tokenCount: integer('token_count'),
    anchorJson: text('anchor_json'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('idx_chunk_source').on(t.sourceId, t.ordinal)],
);
