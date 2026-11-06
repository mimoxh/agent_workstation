# 技术架构

**版本**：v0.2
**日期**：2026-11-05

---

## 1. 技术选型

| 层 | 选择 | 理由 | 迁移路径 |
|---|---|---|---|
| 运行环境 | Node 26 LTS + pnpm workspace | 长期支持；monorepo 让 domain 与框架物理隔离 | — |
| 语言 | TypeScript（strict） | 权限与契约需要类型保护 | — |
| 前端 | React 19.3 + Vite 8 + TanStack Router / Query | 本地应用不需要 SSR；类型安全路由；请求缓存与 SSE 订阅分离 | 可原样装进 Electron 外壳 |
| UI | Tailwind CSS 4.3 + shadcn/ui | 表格、树、看板、对话框组件齐全，可控样式 | — |
| 前端状态 | TanStack Query（服务端数据）+ Zustand（仅会话流/本地 UI） | 避免全局状态膨胀 | — |
| 本地服务 | Hono 4.13 + @hono/node-server 2.x，常驻进程 | Agent 运行时需要长生命周期：分钟级 run、子进程、合并队列、重启恢复；请求式框架托管不了 | 拆出独立 runtime 服务时路由可平移 |
| 数据库 | SQLite + better-sqlite3 | 本地优先、零运维、驱动稳定（node:sqlite 仍为 RC） | Schema 保持 Postgres 兼容，换 driver 即可 |
| ORM | Drizzle 0.45.x | 类型推导好，迁移透明；1.0 GA 后升级 | 同一套 schema 换 PG |
| 校验 | Zod | manifest / 任务契约 / 工具参数统一校验 | — |
| 流式 | SSE（Hono `streamSSE`） | 简单、可穿透代理 | 后续可换 WebSocket |
| 队列 | 进程内 p-queue（M0–M2） | 无需额外依赖 | 换 BullMQ + Redis |
| 模型 | Vercel AI SDK v7：`@ai-sdk/anthropic` + `@ai-sdk/openai-compatible`（M0）；Ollama 社区 provider（M1） | provider 适配、tool calling、streaming 交给 SDK；降级链 / 熔断 / trace / 预算自己做 | 新增厂商只需加 provider 包 |
| 测试 | Vitest（domain）+ Playwright（关键流程） | 领域逻辑必须纯函数可测 | — |

选型对比与未选方案见 DECISIONS D19。

## 2. 分层

```
┌ UI ──────────────────────────────────────────┐
│ 板块渲染器 / 会话面板 / 看板 / 收件箱 / 运行详情  │
├ 应用层（Hono 路由 / 用例）─────────────────────┤
│ 用例：创建任务、派发、接单、发消息、合并提案       │
├ 领域层（纯函数，无框架依赖）────────────────────┤
│ 权限 / 作用域 / 任务状态机 / 提案合并 / 预算       │
├ 运行时（Agent Runtime）───────────────────────┤
│ 上下文装配 / 工具执行 / 模型调用 / 熔断           │
│   （与 HTTP 同进程常驻，生命周期 = 本地服务进程）  │
├ 基础设施 ─────────────────────────────────────┤
│ 仓储（Drizzle）/ 事件总线 / AI SDK provider / 文件│
└──────────────────────────────────────────────┘
```

**硬规则**：`packages/domain/**` 不得 import Hono、React、Drizzle、AI SDK 或任何运行时依赖。它只接受普通对象、返回普通对象。这是保证权限逻辑可测的前提。lint 规则（`no-restricted-imports`）与 workspace 依赖声明双重保证。

## 3. 数据模型

SQLite 表（字段省略通用时间戳）：

```sql
workspace(id, name, created_at)

-- 原名 user，因 Postgres 保留字改名
app_user(id, workspace_id, name, email, avatar, created_at)

project(id, workspace_id, name, goal, status, budget_json, created_at)

-- 树形：parent_id 为 NULL 表示根工作台（承载「全局作用域」）
-- stage 已删除：阶段挂在任务上，不挂在工作台上
workstation(id, project_id, parent_id, plugin_id, plugin_version,
            name, status, settings_json, sort)

-- Agent 实例：从插件模板实例化，属于唯一工作台
agent(id, workstation_id, template_id, name, role, model_json,
      prompt, tools_json, budget_json, is_steward, status, created_at)

-- 板块 = 面板实例（视图），绑定插件中的面板定义
block(id, workstation_id, panel_id, panel_type, entity_type,
      name, config_json, sort)

-- 结构化条目，data_json 按插件 schema 存储
-- 实体按「工作台 + 类型」归属，同一类型可被多个面板展示
entity(id, workstation_id, entity_type, data_json, version,
       created_by_type, created_by_id, created_at, updated_at)

entity_version(id, entity_id, version, data_json,
               author_type, author_id, reason, created_at)

-- 泛化提案：既可改实体，也可改代码（code_ref_json 存分支与 sha）
proposal(id, task_id, target_type /* entity | code */,
         entity_id /* 可空 */, base_version, patch_json,
         code_ref_json /* {worktree, branch, base_sha, head_sha, merge_sha} */,
         reason, author_type, author_id,
         status /* pending|approved|changes_requested|rejected|merged|conflicted|superseded */,
         decided_by_type, decided_by_id, decided_at, created_at)

-- 提案的逐行审查意见（code review）
review_comment(id, proposal_id, author_type, author_id,
               path, line, body, resolved, created_at)

-- stage = 插件定义的工作流位置（任务级），status = 平台通用生命周期
-- module 等字段放 input_json，按任务类型的 schema 校验
task(id, project_id, workstation_id, parent_id, type_id, stage,
     title, intent, input_json, acceptance_json /* 结构化验收：command|visual|manual|text */,
     status, assignee_type, assignee_id /* 人或 Agent */, dispatch_reason,
     budget_json, usage_json, result_json, blocked_reason,
     feedback_count /* 连续退回次数，超限转 blocked */,
     due_at, created_at)

-- kind ∈ task | review | discussion | dm；mode 为发言调度模式
thread(id, scope_type, scope_id, kind, mode, title, created_at)

thread_member(thread_id, participant_type, participant_id, role)

message(id, thread_id, sender_type, sender_id, kind,
        content, meta_json, created_at)

run(id, agent_id, task_id, status, provider, model, fallback_from,
    stop_reason /* max_turns|no_progress|budget|timeout|error|interrupted|completed */,
    started_at, ended_at, tokens_in, tokens_out, cost, trace_json, error)

artifact(id, workstation_id, task_id, type, name, ref,
         meta_json, created_at)

-- M0：kind ∈ command_confirm|blocked|proposal_review|run_failed|task_rejected|task_countered|human_request|task_rejected|task_countered|human_request；M1 增加 budget 等
inbox_item(id, workspace_id, project_id, kind, ref_type, ref_id,
           severity, status, created_at)

event_log(id, actor_type, actor_id, action, target_type,
          target_id, payload_json, created_at)

-- 原名 grant，因 Postgres 保留字改名
access_grant(id, subject_type, subject_id, scope_type, scope_id, rights_json)

-- 插件安装记录，对应 /plugins 页面的启停
plugin_install(id, workspace_id, plugin_id, version,
               source /* builtin|bundle */, enabled, created_at)
```

**关键索引**

```sql
CREATE INDEX idx_ws_project_parent ON workstation(project_id, parent_id);
CREATE INDEX idx_entity_ws_type      ON entity(workstation_id, entity_type);
CREATE INDEX idx_version_entity      ON entity_version(entity_id, version);
CREATE INDEX idx_task_ws_status      ON task(workstation_id, status);
CREATE INDEX idx_msg_thread          ON message(thread_id, created_at);
CREATE INDEX idx_run_agent           ON run(agent_id, started_at);
```

**设计取舍**

- `data_json` 不用宽表：插件 schema 是动态的，宽表必然改表。用 JSON + 应用层 Zod 校验，配合 SQLite 的 `json_extract` 做少量查询。
- `entity_version` 存全量快照而非 diff：条目体积可控，读取简单，diff 在展示时计算。
- `workstation.parent_id` 支持任意深度，但 UI 与路由只解释两层。
- `user` / `grant` 改名为 `app_user` / `access_grant`：二者都是 Postgres 保留字，schema 要保持 PG 兼容就先避开。
- 阶段挂在 `task.stage` 而非 `workstation`：同一工作台里不同任务处在不同 stage 是常态，工作台级阶段会把它压成单线。

### 3.1 知识库表

知识库与结构化实体是两条独立的数据通路：实体是「要改的」，知识库是「只读的」。

```sql
knowledge_source(id, workspace_id, scope_type, scope_id,
                 name, kind, uri, mime, sha256, size,
                 status, meta_json, created_at)

knowledge_chunk(id, source_id, ordinal, text, token_count,
                anchor_json,        -- { page } | { headingPath } | { offset }
                created_at)

-- v0.1：全文检索（SQLite FTS5）
knowledge_fts(text)               -- 虚拟表，content = knowledge_chunk

-- v0.2：向量召回
-- knowledge_embedding(chunk_id, model, vector, dim)
```

**要点**

- `anchor_json` 是引用能力的根：没有它，Agent 只能「说做过」，不能「说在哪」。
- 分块优先按标题层级切，其次按段落；512–1024 tokens，重叠 10–15%。
- 知识库不进系统提示词，只走检索注入（见 §7.1）。

## 4. 权限模型

### 4.1 四权 + 作用域

```ts
type Right = 'observe' | 'propose' | 'speak' | 'invoke';
type Scope = { type: 'workstation' | 'project'; id: string };

function can(actor: Actor, right: Right, scope: Scope): boolean;
```

四项权利相互独立，不互相推导。其中 `invoke(scope)` 表示在该作用域内创建或派发任务、触发 Agent 的权利。

### 4.2 默认授权

| 主体 | 自身工作台 | 祖先工作台 | 子孙工作台 | 兄弟工作台 |
|---|---|---|---|---|
| 普通 Agent | observe + propose + speak + invoke | observe（摘要投影） | invoke（仅以工作台为单位派发）+ observe（任务状态与 steward 回传） | ✗ |
| Steward Agent | 同上 | 额外 speak（仅父级） | 同上 | ✗ |
| 人 | 全项目 | 全项目 | 全项目 | 全项目 |

> 子级 Agent 对祖先**没有** invoke 权，只能通过 steward 回传结果，或用 `report_blocked` 上报。

### 4.3 可见投影

祖先链不是全量可见，而是**摘要投影**：名称、任务统计、被显式授权的 Artifact。这样既满足「能看见上级在干嘛」，又不泄漏细节。

### 4.4 执行位置

权限校验必须在**仓储层**做，不在 UI 或调用方：

```ts
repo.entities.list({ actor, blockId })   // 内部自动追加 scope 过滤
```

任何返回 `entity` / `task` / `message` 的查询都强制带 `actor`。漏传直接抛错（类型层面用必填参数保证）。

## 5. 通信三层

### 5.1 控制面：任务状态机

| 从 | 到 | 说明 |
|---|---|---|
| draft | dispatched | 派发 |
| dispatched | accepted / rejected / countered | countered = 反提案，修改契约 |
| countered | dispatched / cancelled | 派发方接受修改后重派 |
| rejected | draft / cancelled | 修改后重派 |
| accepted | in_progress | |
| in_progress | submitted / blocked | |
| blocked | in_progress / escalated | 本台内解除 / 超出本台决策权，送上级待处理 |
| escalated | in_progress / cancelled | 上级决策后 |
| submitted | reviewing | 执行可执行验收 + 审查 |
| reviewing | done / in_progress | 验收或审查不通过时退回 |
| 任意非终态 | cancelled | |

终态：`done` / `cancelled`。

`task.status` 是平台通用的生命周期；`task.stage` 是插件定义的工作流位置，只在 `in_progress` / `reviewing` 期间推进。stage 决定该任务上下文里激活哪些 Agent、哪些板块可写；M0 只做「手动或 Agent 推进 stage + 进入 done 前必须通过任务的可执行验收」，stage requirements 的自动门禁在 M3。

转移条件与副作用写在 `packages/domain/src/task-state.ts`，纯函数 `transition(task, event) → Result`。

### 5.2 数据面：版本化

```
Entity v1 ──proposal──► Proposal(pending) ──merge──► Entity v2
                                    │
                                    └──reject──► Proposal(rejected)，理由入库
```

### 5.3 会话面

`message.kind` 枚举：

| kind | 用途 |
|---|---|
| `chat` | 自由讨论 |
| `handoff` | 结构化交接（JSON payload） |
| `proposal_notice` | 提醒有提案待审 |
| `decision` | 结论，可回写板块 |
| `status` | 进度播报 |
| `artifact` | 产物通知 |

Agent 之间的实际交接一律用 `handoff`，自然语言只用于人和 Agent 之间的讨论。这是控制成本的关键。

## 6. Agent 运行时

### 6.1 单次 run 的生命周期

1. 组装上下文（§7）
2. 调用 Provider（streaming，写入 run.trace_json）
3. 工具调用循环，最多 8 轮
4. 产出：`message` / `proposal` / `task_update` / `artifact` / `blocked`
5. 落库、扣预算、发事件

### 6.2 熔断条件

| 条件 | 动作 |
|---|---|
| 工具轮次 > 8 | 终止，标记 `max_turns` |
| 连续两次相同工具+参数 | 终止，标记 `no_progress` |
| token 超任务预算 | 终止，标记 `budget` |
| wall-clock 超时 | 终止，标记 `timeout` |
| 连续失败 3 次 | 加入收件箱，人工介入 |

> M0 中所有非 completed 的 run 都进入待处理（宁可多报）；「连续失败 3 次」的聚合在 M1 收件箱分级时实现。
| 进程重启时状态为 running | 标记 `interrupted` 并进入待处理 |

> M0 全部实现；token 上限取 Agent 或任务预算字段，仅 run 级（三级预算 M1）。

### 6.3 工具集（v0.1）

| 工具 | 说明 | 权限要求 |
|---|---|---|
| `read_entity` | 读单个条目 | observe |
| `list_entities` | 按类型/条件列出 | observe |
| `propose_entity` | 提交变更提案 | propose |
| `search_workstation` | 检索本工作台 | observe |
| `create_task` | 建子任务 | invoke |
| `send_message` | 发消息 | speak |
| `report_blocked` | 上报阻塞 | 总是允许 |
| `request_human` | 请求人工决策 | 总是允许 |
| `respond_task` | steward 对派发到本台的任务接单 / 拒绝 / 反提案 | 仅 steward |
| `search_knowledge` | 检索知识库（M1） | observe |

工具返回结果必须按 token 预算裁剪；超长结果截断并标注 `truncated: true`。

### 6.4 多模型路由

Provider 适配、tool calling 与 streaming 由 Vercel AI SDK v7 提供；平台不依赖 SDK 的 agent 循环抽象，循环、熔断、降级与 trace 写入在 `apps/server/src/runtime/loop.ts` 自己实现，保证语义与 §6.2 一致。

```ts
// 底层用 AI SDK 的 LanguageModel，平台只包一层路由与能力声明
import type { LanguageModel } from 'ai';

interface ModelRoute {
  id: `${'openai-compat' | 'anthropic' | 'ollama'}:${string}`;  // 如 'anthropic:claude-sonnet'
  model: LanguageModel;
  supportsParallelTools: boolean;   // Ollama 为 false → 运行时串行化
}
```

**选择顺序**

1. Agent 实例配置的 `model.provider` + `model.name`
2. 工作台插件模板的 `model`（缺省值）
3. 项目级默认
4. 全局默认

**降级链**

```ts
// 配置示例
routing: {
  chain: ['openai-compat:deepseek-chat', 'anthropic:claude-sonnet', 'ollama:qwen2.5:32b'],
  on: ['rate_limit', 'timeout', 'unavailable', 'quota_exceeded'],
  maxAttempts: 2,
}
```

**边界**

- 降级会改变输出风格与 tool-use 能力，必须写入 `run.trace_json`，并在 UI 标注「本次由备用模型完成」。
- Ollama 通常不支持并行 tool call，运行时需串行化。
- 密钥只存在本地 keychain 或加密文件，不进入数据库明文、不进日志。
- **M0 / M1 分界**：M0 只接 `@ai-sdk/openai-compatible` 与 `@ai-sdk/anthropic`，失败即报错并进入待处理，不做降级链；Ollama（社区 provider）与降级链在 M1 实现。

### 6.5 代码执行与 Git 集成

**双真相源**

```
git            → 代码真相（branch / commit / merge）
workbench DB   → 协作真相（task / proposal / review / ADR / test）
绑定键          → commit_sha
```

代码正文不落库；`Proposal` 只存 `branch + base_sha + patch + review`。合并是真实 git merge，记录 `merge_sha`。

**执行模型（v0.1，无容器）**

```
tool call → 权限校验 → 命令白名单 → 目录锁定 → 超时 120s
          → 危险命令需人工确认 → 输出截断 32KB → 写入 trace
```

- 白名单：`pnpm` / `npm` / `node` / `git` / `tsc` / 测试运行器
- 禁止越出仓库根目录
- `rm -rf`、`push --force`、管道执行远程脚本 → 强制确认
- 每条命令记录 cwd、耗时、退出码、输出摘要

**隔离**

```
Agent → 独立 worktree → 独立分支 → Proposal → 串行 merge
```

不做隔离，多 Agent 并行是负收益。冲突立即退回提案，不自动解决。

**平台托管（非 Agent 工具）**：worktree、分支与合并不暴露为工具，由平台负责——

- 子任务指派时自动创建 worktree + 分支；
- 审查通过且验收通过后，提案进入**串行合并队列**执行真实 git merge；
- 冲突则提案标记为 `conflicted` 并退回；
- 任务结束时回收 worktree。

**上下文**

代码库不能整体入上下文。装配顺序：`Module` 边界 → 改动相关文件 → 依赖声明 → 测试结果，按 token 预算裁剪。

## 7. 上下文装配

五层，按预算分配：

| 层 | 内容 | 默认占比 |
|---|---|---|
| 系统 | 插件说明、当前任务 stage、Agent 角色与规则 | 10% |
| 事实 | 由结构化数据生成的摘要（人物简表、大纲骨架） | 35% |
| 任务 | 当前任务 input / acceptance / 历史子任务 | 20% |
| 会话 | 最近 N 条消息 + 已有结论摘要 | 25% |
| 预留 | 工具返回、失败重试 | 10% |

**核心原则：事实层从结构生成，不拼原文。** 例如：

```
林某 | 主角 | 目标：查清父亲死因 | 缺陷：不肯求助 | 关系：沈某(敌对)
```

而不是把整份人物设定文档塞进去。这既是成本控制，也是准确性的来源。

### 7.1 知识库注入

知识库**不进入**系统提示词，只走按需检索：

```
Agent 需要外部事实
  → search_knowledge(query, scope, top_k=5)
  → 返回 [chunk_id, text, anchor, score]
  → 截断到预算内注入
  → 产出时必须原样回传 { source, anchor }
```

三条硬约束：

1. **只注入命中片段**，不注入整篇文档。
2. **返回结构里必须带 `anchor`**，否则无法验证。
3. **无引用的断言在审查中一律视为不可信**——这是抑制幻觉最有效的机制，比任何提示词都管用。

检索排序 v0.1 用 FTS5（BM25），v0.2 加向量后做 RRF 融合。融合结果需保留两路分数，便于调参。

## 8. 目录结构

```
apps/
├ web/                         React + Vite 前端
│  └ src/
│     ├ routes/                TanStack Router 文件路由
│     │  ├ index.tsx                         项目总览
│     │  ├ projects.$projectId.tsx           根工作台
│     │  ├ projects.$projectId.ws.$wsId.tsx  领域工作台
│     │  ├ projects.$projectId.tasks.$taskId.tsx  任务详情
│     │  ├ agents.tsx                        Agent 模板库
│     │  ├ plugins.tsx                       插件管理
│     │  └ runs.$runId.tsx                   运行详情
│     ├ components/
│     │  ├ board/              面板渲染器：board / table / tree / diff（M0），preview（M1），doc / graph（M2）
│     │  ├ chat/               消息流、输入、成员
│     │  └ layout/             工作台外壳、导航、面包屑
│     └ lib/api.ts             类型化 API 客户端（Hono RPC）+ SSE 订阅
└ server/                      Hono 本地常驻服务
   └ src/
      ├ routes/                HTTP 路由（含 /runs/:id/stream、/threads/:id/stream SSE）
      ├ usecases/              应用层用例
      ├ repositories/          全部带 actor 参数
      ├ runtime/
      │  ├ models.ts           AI SDK provider 注册与路由
      │  ├ tools/              工具实现与注册表
      │  ├ context.ts          上下文装配
      │  ├ loop.ts             agent 循环与熔断
      │  └ git/                worktree、合并队列（平台托管）
      ├ events.ts              事件总线
      └ db/
         ├ schema.ts
         └ client.ts
packages/
├ domain/                      纯函数，无框架依赖
│  └ src/
│     ├ permission.ts          can() / scope 解析
│     ├ scope.ts               visibleSet / speakSet / invokeSet
│     ├ task-state.ts          状态机
│     ├ proposal.ts            patch 应用与校验
│     └ budget.ts              预算
├ plugin-spec/                 manifest 的 Zod schema 与类型（前后端共享）
└ plugins/
   ├ pm/manifest.json
   ├ dev/manifest.json
   └ novel/manifest.json       (M2)
```

## 9. 演进路径

| 现在 | 之后 | 触发条件 |
|---|---|---|
| SQLite | Postgres | 需要多人/部署 |
| 进程内队列 | BullMQ + Redis | 并发 run > 5 |
| 单进程（HTTP + 运行时） | 独立 runtime 服务 | 需要独立扩缩容或多机 |
| 浏览器访问本地服务 | Electron 外壳（系统钥匙串、原生文件夹选择器、单安装包） | M3 之后，分发给非开发者用户时 |
| 本地文件 | S3 / R2 | 附件变大 |
| 单 workspace | 多租户 | 团队功能上线 |

这些切换点都不需要改领域层——这也是把权限、状态机、提案逻辑放在 `packages/domain` 的原因。
