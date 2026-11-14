# 项目管理工作台（插件 `pm`）

**版本**：v0.5
**日期**：2026-11-12

---

## 0. 定位

每个项目的根工作台（`parentId` 为空），管任务之上的项目面：立项派发、排期依赖、里程碑、风险和进展汇总。子工作台的日常在各自台里，PM 台只看跨台的项目全貌。

## 1. 成员

| Agent | 职责 |
|---|---|
| 项目经理（steward） | 拆解目标、派发任务、维护排期和依赖、起草进展报告 |

## 2. 数据

| 实体 | 内容 |
|---|---|
| `Milestone` | `name`、`due`、`status`；里程碑进度按关联任务算，签字后的测试结论挂上来 |
| `Risk` | `title`、`level`、`impact`、`mitigation`、`owner`、`status` |
| `StatusReport` | `title`、`period`、`summary`、`highlights`、`issues`、`next`，PM 起草人审 |

排期字段在平台任务上：`dueAt`（本机日历日期）和 `task_dependency` 边（`taskId` 依赖 `dependsOnId`）。依赖限同项目、不成环；有未完成前置的任务不能开工，前置全完成时自动开工并在任务会话留言，前置被取消时提醒后续任务调整依赖（不自动摘边）。

## 3. 板块

| id | 类型 | 实体 | 说明 |
|---|---|---|---|
| `board` | board | `system:task` | 任务看板，含排期和依赖状态 |
| `miles` | timeline | `Milestone` | 里程碑进度：完成数、逾期、风险、测试结论徽标 |
| `gantt` | gantt | `system:task` | 甘特图：任务按日排布，含里程碑和依赖 |
| `risks` | table | `Risk` | 风险登记 |
| `reports` | table | `StatusReport` | 进展报告列表，可一键请 PM 起草 |
| `knowledge` | knowledge | `system:knowledge` | 知识库 |

`gantt` 是新增板块类型，渲染器在 `apps/web/src/components/pm/`（`GanttPanel` / `MilestonePanel` / `ReportsPanel` / `PlanDialog`）。

## 4. 工具

| 工具 | 说明 |
|---|---|
| `list_tasks` / `plan_task` | 查任务 / 设排期：`dueAt`、`dependsOn`（校验成环和同项目） |
| `project_status` | 项目快照：任务统计、逾期、阻塞、等待前置、里程碑（含测试结论）、风险、各子台概况、收件箱和 token 消耗 |
| `propose_entity` | 起草 / 更新 Milestone、Risk、StatusReport |
| `dispatch_task` | 把任务派到同项目的子工作台 |

其余用平台内置工具（`read_entity` / `list_entities` / `send_message` / `record_decision` / `request_human` 等）。

## 5. 跨台

- `dispatch_task` 走平台派发通道，目标是同项目的子工作台。
- 开发台的测试计划签字后，根台会话收到 `decision` 消息（结论、通过率、人工放行备注、关联里程碑），里程碑进度带上测试结论徽标；阻断或人工放行的未完成里程碑计入风险（见 QA §5）。
- 进展报告不自动产出：报告板块的一键按钮在根台大群 @项目经理，PM 读 `project_status` 起草 `StatusReport`。

## 6. 还没做

- 跨台负载均衡调度员（PLUGIN-SPEC §11，v0.2+）。
- 里程碑只按关联任务和测试结论汇总，没有自定义完成判定。
- 甘特图是展示层，不做关键路径分析。
