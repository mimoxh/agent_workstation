import {
  index,
  integer,
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
    typeId: text('type_id'),
    stage: text('stage'),
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
    dueAt: text('due_at'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('idx_task_ws_status').on(t.workstationId, t.status)],
);
