# 全栈开发工作台（插件 `dev`）

**版本**：v0.4
**日期**：2026-11-08

---

## 0. 为什么先做这个

| 理由 | 说明 |
|---|---|
| **能吃自己的狗粮** | 用这个产品开发这个产品本身，闭环最短，反馈最快 |
| **验收可执行** | `build` / `test` / `lint` / 截图 diff 都能自动判定，这是所有垂直里唯一能做到的 |
| **提案制天然同构** | diff → review → merge，就是 code review，不需要发明新概念 |
| **结构化程度最高** | 文件、AST、测试、依赖图，全是结构化的 |

代价也得说清楚：

- **竞争最激烈** —— Claude Code / Cursor / Codex / Devin 已经很强。别指望在「生成代码」上赢。
- **需要代码执行** —— 这推翻了 D3「Agent 不执行代码」，属于真实的范围扩张。
- **需要 Git 集成** —— 会和你自己的版本系统产生重叠。

**差异化不在「会写代码」，在「多 Agent 分工 + 任务调度 + 提案审计」。** 单 Agent 写代码已经解决得不错；没人解决好的是「五个 Agent 并行推进一个项目，且每一步可审计」。

## 1. 一条底层约束：双真相源

```
git               → 代码的真相源
workbench DB      → 协作的真相源（任务、提案、评审、决策、测试）
```

具体规则：

- **代码正文不进数据库**（预览缓存除外）。否则你会做出一套半吊子 VCS。
- `Proposal` 存 `branch` + `base_sha` + `patch` + `review` 状态，不存完整文件内容。
- 合并是**真实的 git merge**，记录 `merge_sha`；工作台的「合并」按钮只是包了一层。
- 任何展示都从 `merge_sha` 对应的提交读，不用数据库快照冒充。

这条约束决定了很多实现细节，先立住。

## 2. 实体

| 实体 | 关键字段 | 说明 |
|---|---|---|
| `Module` | name, path, responsibility, owner | 代码域划分，用于派活与边界校验 |
| `ADR` | title, context, decision, consequences, status | 架构决策记录，防止 Agent「忘了为什么」 |
| `TestRun` | command, status, duration, output_ref, commit_sha | 可执行验收的证据 |
| `Page` | route, name, status, screenshot_ref | 前端页面（可选的领域实体） |

`Issue` **不是独立实体**：Issue = 任务类型为 `dev.issue` 的 Task。

| 任务类型 `dev.issue` | input 字段 |
|---|---|
| 必填 | title / kind(feature / bug / chore) / priority / **module** |
| 验收 | 结构化 `acceptance`（command / visual / manual） |

> `Change`（改动提案）**不单独建实体**，直接复用平台的 `Proposal`；`Issue` 复用平台的 `Task`——两者是同一个论证：平台抽象若能被复用，就说明它成立。

## 3. 板块

| id | 类型 | 实体 | 说明 |
|---|---|---|---|
| `board` | board | `system:task` | 看板，按 stage 分列：需求 / 设计 / 实现 / 测试 / 评审 / 合并 |
| `changes` | diff | `system:proposal` | **核心界面**：改动列表 + diff 审阅 + 评论 |
| `tests` | table | TestRun | 测试结果，可点开原始输出 |
| `decisions` | table | ADR | 架构决策 |
| `files` | tree | `system:files` | 只读文件树（git 工作树），点开看代码 |
| `preview` | preview | Page | 页面预览 + 截图对比 |
| `knowledge` | knowledge | `system:knowledge` | 知识库：规范、资料、笔记 |

`diff` 是 M0 新增的 panel 类型，`preview` 于 M1。

## 4. 阶段

这是 `dev.issue` 任务的工作流：**按任务推进，不是工作台全局状态**。

```
需求 → 设计 → 实现 → 测试 → 评审 → 合并
```

| 阶段 | 门禁（Requirement kind） | 激活的 Agent |
|---|---|---|
| 需求 | `entity` / `manual`：有明确 acceptance | 架构师 |
| 设计 | `new_scope_decision`：任务范围有未登记的 Module 路径时需有 ADR（平台判定） | 架构师 |
| 实现 | 存在 pending 的 code proposal | 前端 / 后端 |
| 测试 | `acceptance` | 测试 |
| 评审 | `approval` | 审查 |
| 合并 | 平台合并队列 | — |

> M0 只做「进入 done 前必须通过任务的可执行验收（acceptance）」，其余门禁的自动校验放在 M3。

## 5. Agent 编制

| Agent | 职责 | 工具 |
|---|---|---|
| `architect`（steward） | 拆模块、定接口、写 ADR、主持讨论、分诊阻塞、对外代表 | `read_entity` `list_entities` `propose_entity` `create_task` `send_message` `record_decision` `search_knowledge` `search_code` `git_diff` `report_blocked` `request_human` `respond_task` `resolve_block` `escalate_block` `advance_stage` |
| `frontend-dev` | 页面、组件、样式、交互 | `read_file` `search_code` `git_diff` `apply_patch` `git_commit` `submit_change` `run_command` `send_message` `report_blocked` |
| `backend-dev` | API、数据层、任务编排 | 同 `frontend-dev` |
| `test-engineer` | 写测试、跑测试、出报告 | `read_file` `search_code` `git_diff` `apply_patch` `git_commit` `run_command` `run_tests`（M1）`capture_screenshot`（M1）`send_message` |
| `reviewer` | **只读 diff，独立上下文** | `git_diff` `read_file` `read_entity` `list_entities` `search_knowledge` `review_change` `send_message` |

成员之间用 @ 互相询问，被 @ 的成员只回应问题，不能写 assignee 的 worktree；预设「快速接力」关闭任务内讨论（见 DECISIONS D22）。

**reviewer 的价值来自「不看实现过程」**：它不共享实现者的对话上下文，只看最终 diff 与验收结果。这比单 Agent 自审强得多，也是多 Agent 唯一不可替代的地方之一。

## 6. 工具与权限

内置工具之外新增 10 个工具，M0 做 8 个：

| 工具 | 说明 | 风险 | 里程碑 |
|---|---|---|---|
| `read_file` | 读 worktree 内文件 | 低 | M0 |
| `search_code` | 在 Module 路径内检索代码 | 低 | M0 |
| `git_diff` | 读差异 | 低 | M0 |
| `apply_patch` | 写入 worktree | 中 | M0 |
| `git_commit` | 提交到本 Agent 分支 | 中 | M0 |
| `submit_change` | 把当前分支提交为代码 Proposal | 中 | M0 |
| `review_change` | 提交审查意见（逐行评论 + approve / request_changes） | 低 | M0 |
| `run_command` | 执行白名单命令 | 高 | M0 |
| `run_tests` | 跑测试并生成 TestRun | 中 | M1（M0 用 `run_command` 代替） |
| `capture_screenshot` | 页面截图 | 低 | M1 |
| `list_files` | 列 worktree 目录（默认任务范围根） | 低 | v0.3 |
| `sync_branch` | 把目标分支合进任务分支，冲突标记留给实现者解决 | 中 | v0.3 |

`apply_patch` 自 v0.3 起除 edits / creates 外还支持 renames（移动 / 重命名）和 deletes（删除文件或目录），全部校验通过才落盘。`git_commit` 拒绝带冲突标记的提交。

**平台托管（非 Agent 工具）**：worktree 和分支由平台在子任务指派时自动创建；merge 由平台的串行合并队列在审查通过且验收通过后执行；worktree 在任务结束时回收。不提供 `git_branch`——这三项都不是 Agent 工具。

**执行边界**（v0.1 白名单；v0.4 起可选容器沙箱，见 §13.7）：

- 命令白名单：`pnpm` / `npm` / `node` / `git` / `tsc` / 测试运行器
- 工作目录锁定在仓库根，禁止 `cd ..`
- 危险命令（`rm -rf`、`curl | sh`、`git push --force`）强制人工确认
- 单命令超时 120s，输出截断到 32KB
- 所有执行记录进 `run.trace_json`，可回放

## 7. 可执行验收

这是 dev 垂直最大的结构性优势：**验收从自然语言变成断言**。

```yaml
acceptance:
  - kind: command
    run: pnpm build
    expect: { exitCode: 0 }
  - kind: command
    run: pnpm test
    expect: { exitCode: 0 }
  - kind: command
    run: pnpm lint
    expect: { exitCode: 0 }
  - kind: visual
    url: http://localhost:{port}/projects/1   # {port} 由平台换成这个 worktree 分到的端口
    baseline: shots/workspace-shell.png
    maxDiff: 0.02
  - kind: manual
    text: 三栏在 1280 宽度下不换行
```

前三种可自动判定，第四种给前端场景兜底。配了 `commands.serve` 时，平台在跑 visual 前于被验收的 worktree 里启动它（端口从环境变量 `PORT` 取），页面可访问后再截图，结束即停；不配就假设页面已经在跑。

验收跑不起来（命令不存在、不在白名单、服务起不来、浏览器没装）算**环境错误**：任务转 blocked 进收件箱，不计退回次数，修好环境后解除阻塞、实现者重新提交再验收。超时和测试自身失败仍按退回处理。**任务能不能「完成」，不再靠 Agent 自评。**

`TestRun` 由平台写入，不靠 Agent 提案：M0 在执行 acceptance 中的 `command` 检查时自动记录；M1 起 `run_tests` 也会生成 TestRun。

## 7.1 manifest 草图

```json
{
  "id": "dev",
  "name": "全栈开发工作台",
  "version": "1.0.0",
  "description": "多 Agent 分工 + 可执行验收的软件开发工作台",
  "steward": "architect",
  "entities": {
    "Module": {
      "label": "模块",
      "description": "代码域划分，用于派活与边界校验",
      "titleField": "name",
      "fields": {
        "name":           { "type": "string", "label": "名称", "required": true },
        "path":           { "type": "string", "label": "路径", "required": true },
        "responsibility": { "type": "text",   "label": "职责" },
        "owner":          { "type": "string", "label": "负责人" }
      }
    },
    "ADR": {
      "label": "架构决策",
      "description": "架构决策记录，防止 Agent 忘了为什么",
      "titleField": "title",
      "fields": {
        "title":        { "type": "string", "label": "标题", "required": true },
        "context":      { "type": "text",   "label": "背景" },
        "decision":     { "type": "text",   "label": "决策" },
        "consequences": { "type": "text",   "label": "后果" },
        "status":       { "type": "enum",   "label": "状态", "enum": ["proposed", "accepted", "superseded"] }
      }
    },
    "TestRun": {
      "label": "测试运行",
      "description": "可执行验收的证据",
      "titleField": "command",
      "fields": {
        "command":    { "type": "string", "label": "命令", "required": true },
        "status":     { "type": "enum",   "label": "状态", "enum": ["passed", "failed", "error"] },
        "duration":   { "type": "number", "label": "耗时(s)" },
        "output_ref": { "type": "string", "label": "输出" },
        "commit_sha": { "type": "string", "label": "提交" }
      }
    },
    "Page": {
      "label": "页面",
      "description": "前端页面（可选的领域实体）",
      "titleField": "route",
      "fields": {
        "route":          { "type": "string", "label": "路由", "required": true },
        "name":           { "type": "string", "label": "名称" },
        "status":         { "type": "string", "label": "状态" },
        "screenshot_ref": { "type": "string", "label": "截图" }
      }
    }
  },
  "stages": [
    { "id": "requirement", "name": "需求", "activePanels": ["board"], "activeAgents": ["architect"] },
    { "id": "design",      "name": "设计",
      "requirements": [{ "kind": "manual", "text": "涉及新 Module 时需有 ADR" }],
      "activePanels": ["board", "decisions"], "activeAgents": ["architect"] },
    { "id": "implement",   "name": "实现", "activePanels": ["board", "changes"], "activeAgents": ["frontend-dev", "backend-dev"] },
    { "id": "test",        "name": "测试",
      "requirements": [{ "kind": "acceptance" }],
      "activePanels": ["tests", "changes"], "activeAgents": ["test-engineer"] },
    { "id": "review",      "name": "评审",
      "requirements": [{ "kind": "approval" }],
      "activePanels": ["changes"], "activeAgents": ["reviewer"] },
    { "id": "merge",       "name": "合并", "activePanels": ["changes"], "activeAgents": [] }
  ],
  "panels": [
    { "id": "board",     "type": "board",   "entity": "system:task",     "title": "任务看板", "editableBy": ["human", "agent"] },
    { "id": "changes",   "type": "diff",    "entity": "system:proposal", "title": "改动审阅", "editableBy": ["human", "agent"], "config": { "showComments": true } },
    { "id": "tests",     "type": "table",   "entity": "TestRun",         "title": "测试结果", "editableBy": ["human"] },
    { "id": "decisions", "type": "table",   "entity": "ADR",             "title": "架构决策", "editableBy": ["human", "agent"] },
    { "id": "files",     "type": "tree",    "entity": "system:files",    "title": "文件树",   "editableBy": ["human"] },
    { "id": "preview",   "type": "preview", "entity": "Page",            "title": "页面预览", "editableBy": ["human"], "config": { "urlField": "route", "baselineField": "screenshot_ref" } }
  ],
  "agents": [
    {
      "id": "architect",
      "name": "架构师",
      "role": "拆模块、定接口、写 ADR、对外代表",
      "tools": ["read_entity", "list_entities", "propose_entity", "create_task", "send_message", "search_code", "git_diff", "report_blocked", "request_human"],
      "triggers": ["task_assigned", "mentioned", "stage_enter"]
    },
    {
      "id": "frontend-dev",
      "name": "前端开发",
      "role": "页面、组件、样式、交互",
      "tools": ["read_file", "search_code", "git_diff", "apply_patch", "git_commit", "submit_change", "run_command", "send_message", "report_blocked"],
      "triggers": ["task_assigned", "mentioned"]
    },
    {
      "id": "backend-dev",
      "name": "后端开发",
      "role": "API、数据层、任务编排",
      "tools": ["read_file", "search_code", "git_diff", "apply_patch", "git_commit", "submit_change", "run_command", "send_message", "report_blocked"],
      "triggers": ["task_assigned", "mentioned"]
    },
    {
      "id": "test-engineer",
      "name": "测试工程师",
      "role": "写测试、跑测试、出报告",
      "tools": ["read_file", "search_code", "git_diff", "apply_patch", "git_commit", "run_command", "run_tests", "capture_screenshot", "send_message"],
      "triggers": ["task_assigned"]
    },
    {
      "id": "reviewer",
      "name": "审查",
      "role": "只读 diff，独立上下文：逐行评论并给出 approve / request_changes",
      "tools": ["git_diff", "read_file", "read_entity", "list_entities", "review_change", "send_message"],
      "triggers": ["task_assigned"]
    }
  ],
  "tasks": [
    {
      "id": "dev.issue",
      "name": "开发任务",
      "description": "任务在开发台内的形态：feature / bug / chore，限定在声明的 Module 内",
      "stages": ["requirement", "design", "implement", "test", "review", "merge"],
      "inputSchema": {
        "type": "object",
        "required": ["title", "kind", "priority", "module"],
        "properties": {
          "title":    { "type": "string" },
          "kind":     { "type": "string", "enum": ["feature", "bug", "chore"] },
          "priority": { "type": "string", "enum": ["p0", "p1", "p2"] },
          "module":   { "type": "string", "description": "改动不得越出该 Module 的路径" }
        }
      },
      "acceptance": [{ "kind": "command", "run": "pnpm build", "expect": { "exitCode": 0 } }]
    }
  ],
  "defaults": {
    "writeMode": "propose",
    "taskBudget": { "tokens": 200000, "minutes": 30 }
  }
}
```

## 8. 并发与隔离

三个 Agent 同时改仓库 = 合并地狱。规则：

```
一个 Agent 一个 worktree / 一个分支
        ↓
每个改动 = 一个 Proposal（= PR）
        ↓
reviewer 独立审阅
        ↓
合并串行化（一次只合一个，冲突立即退回）
```

不做这个隔离，多 Agent 并行就是负收益。

## 9. 三个硬问题

**1. 双真相源漂移** —— 用户手动 `git commit` 了，工作台不知道。v0.3 的做法：

- 后台每 15 秒（`AW_REPO_POLL_MS`）检查一次仓库：目标分支在平台之外前进 → 设置页提示外部提交；基线分支领先目标分支 → 提示并可一键「合进目标分支」（走合并队列）。
- 提案提交后任务分支又有新提交 → 任务会话提醒；合并时校验分支 HEAD 必须等于审过的 `head_sha`，否则取代提案并退回重新提交。
- 任务页显示分支相对目标分支落后 / 领先多少，可手动同步。

**2. 上下文成本** —— 代码仓库动辄几十万 token。必须靠 `Module` 划分 + 检索装配，不能把仓库塞进上下文。这是 dev 垂直比小说垂直贵得多的根本原因。

**3. 执行安全** —— 没有沙箱时，一条恶意 prompt 就能 `rm -rf`。默认靠白名单 + 确认 + 目录锁定；v0.4 起工作台配置镜像后命令进容器（§13.7）。

## 10. 与竞品的差异

| | 单 Agent 工具 | 本产品 |
|---|---|---|
| 单位 | 会话 | 项目 / 任务 |
| 分工 | 一个模型包办 | 多 Agent 按域分工 |
| 验收 | 人看 | 可执行断言 + 截图对比 |
| 审计 | 聊天记录 | 提案、评审、决策、成本全留痕 |
| 范围 | 单个仓库 | 可跨工作台（产品台 → 开发台） |

**不追通用市场，先赢自己**：只要它能稳定地把这个产品往前推，就成立。

## 11. 风险

| 风险 | 缓解 |
|---|---|
| 竞争激烈，用户不买单 | 先 dogfooding，内部价值独立成立 |
| 上下文成本高 | Module 划分 + 检索装配 + 预算硬约束 |
| 破坏性命令 | 白名单 + 确认 + 目录锁定 |
| 合并冲突 | 一 Agent 一 worktree，串行合并 |
| 与 git 重复造轮子 | 明确双真相源，代码不落库 |

## 12. M0 验收

跑通 PRD §6 剧本 A：

- 一个项目、一个开发工作台、五个 Agent 模板全部参与（实现者为 `frontend-dev` 两个实例）
- 两个实现实例并行，平台在子任务指派时自动创建各自 worktree 与分支
- 子任务按 stage 推进：实现 → 测试 → 评审 → 合并
- reviewer 独立审阅并提问题
- 测试 Agent 跑通 build + 单测（Playwright 用例以 command 形式执行），产出 TestRun
- 审查通过且验收通过后，平台串行合并进主分支
- 全程可在运行记录里回放

## 13. M0 的最小集（增量开发）

> §12 是整体验收场景；本节把它收窄到 M0 实际能做完的范围。

### 13.1 先解决鸡生蛋

「用产品开发产品」有个前置矛盾：**产品还不存在时，没法用它开发。**

所以 M0 分两步，不要合并：

```
M0.1  手工骨架（人 + 普通编辑器）
      Vite + Hono + SQLite + 三栏布局 + 一个能跑的板块
      pnpm build 通过，git 有历史
        ↓
M0.2  工作台接手
      给它派第一个真实任务：在已有代码上加一个功能
```

M0.1 的存在不是妥协，它同时也是**工作台的第一个测试仓库**：有 git、有构建、有测试、有 Module 划分。

### 13.2 任务必须限定在声明的范围内

增量开发的难点不是写代码，是**找到该改哪里**。仓库一大，检索装配就会失控。

M0 的硬约束：

> 每个任务必须声明 `module` 字段，且改动不得越出该范围。

违反就退回重派。v0.3 起 `module` 可以写成逗号分隔的多个路径（`kind=refactor` 跨 Module 重构），`.` 表示整个仓库（`kind=scaffold` 从零搭项目）；`kind=deps` 额外允许改各处 `package.json` 与根目录锁文件。

### 13.3 工具子集

新增 10 个工具中 M0 做 8 个：

| 工具 | M0 | 说明 |
|---|---|---|
| `read_file` | ✅ | 读 worktree 内文件 |
| `search_code` | ✅ | Module 内检索 |
| `git_diff` | ✅ | 读差异 |
| `apply_patch` | ✅ | 写 worktree |
| `git_commit` | ✅ | 提交到本 Agent 分支 |
| `submit_change` | ✅ | 提交为代码 Proposal |
| `review_change` | ✅ | 审查意见 |
| `run_command` | ✅ | build / test / lint |
| `run_tests` | ⬜ | M1；M0 用 `run_command` 代 |
| `capture_screenshot` | ⬜ | M1 |

worktree / 分支 / 合并由平台托管，不是工具。验收类型 M0 只支持 `command`（退出码断言），`visual` 等到 M1。

### 13.4 M0 明确不做（v0.3 已补齐）

M0 为了验证核心模型推迟了五件事，v0.3 起的状态：

| 事项 | 现状 |
|---|---|
| 从零生成项目脚手架 | `kind=scaffold` + `module: .`；仓库路径是空目录时，首次运行自动 `git init` 并建初始提交 |
| 跨 Module 重构 | `kind=refactor`，`module` 写多个路径 |
| 依赖升级与迁移 | `kind=deps`：`pnpm add / update / remove` 不再逐条等确认，可改 package.json 与锁文件；`publish` 仍要确认 |
| 前端视觉验收 | M1 已做（`visual` 验收 + `capture_screenshot`） |
| 自动解决合并冲突 | 合并冲突时平台先把目标分支合进任务分支，冲突标记留在 worktree，退回给实现者用 `apply_patch` 解决后 `git_commit` 完成合并再提交 |

### 13.5 v0.3 新增的平台能力

- **阶段门禁**：推进到后面的阶段前，检查途经各阶段 `requirements`（entity / acceptance / approval / manual）。Agent 推进遇到人工项 → 收件箱「阶段确认」，人确认后平台推进；人亲手推进视为确认人工项，其余未满足项可以显式越过（`force`，记日志）。往回退不检查。任务页列出当前阶段的门禁。
- **回滚**：已合并的任务可在任务页一键回滚，平台在 integration worktree 里对合并提交 `git revert -m 1`，走同一条串行队列；提案标为「已回滚」，只能回滚一次，回滚冲突时报错交人处理。
- **远端 / GitHub**：设置里填远端名后可推送目标分支，可选合并 / 回滚后自动推送；GitHub 仓库可用本机 `gh` 开「目标分支 → 基线分支」的 PR、把开着的 Issue 导入为草稿任务（module 先给 `.`，派发前收窄）。平台不保存任何 token。

### 13.6 v0.4 补齐

- **合并队列可恢复**：入队时在任务上落标记，合并结束才清除；服务重启后带标记且提案已通过的任务重新入队，integration worktree 里残留的半截合并先 abort。等待命令确认的 run 已经不在了，对应确认项在启动时关闭。
- **范围默认拒绝**：`module` 没声明或解析不了时没有可写范围（只读工具不受影响），创建 / 派发 / 修改任务时直接报错；整个仓库必须显式写 `.`。
- **Module 登记表生效**：与任务范围相关的 Module 职责进入运行上下文；范围里有没被任何 Module 覆盖的路径时，设计阶段门禁要求本任务期间产生一条 ADR。一个 Module 都没登记时不触发。
- **预览**：登记的 Page 可一键套用地址；填基线路径（默认取 Page 的 `screenshot_ref`）时和目标分支上的基线做像素对比并排展示。
- **文件树**可切到任务分支，查看已提交但还没合并的改动。
- **命令确认**由收件箱事件立即唤醒；run 结束时等待随之结束并关闭确认项。


### 13.7 容器沙箱

在工作台设置里填镜像（`settings.sandbox.image`，可选 `memory`、`cpus`）后，run_command、验收、setup、视觉验收服务都在一次性 Docker 容器里跑。留空时仍在本机执行。

- **隔离**：只挂载当前 worktree，`.git` 文件只读；`--cap-drop ALL`、`no-new-privileges`、根文件系统只读（/tmp 为 tmpfs）、限制内存 / CPU / 进程数；不带宿主环境变量。
- **网络**：默认断网。setup 与依赖命令（`pnpm add` 等、经确认的 `npx`）走 bridge；视觉验收服务也走 bridge，端口只发布到 127.0.0.1。
- **git 留在宿主**：容器里 worktree 的 gitdir 指向宿主路径，用不了。沙箱模式下 run_command 只放行只读 git 子命令，提交和同步走 `git_commit`、`sync_branch`。
- **失败即拒绝**：docker 不可用、镜像拉不到时命令失败并按环境错误转人工，绝不退回本机执行。超时按容器名删除容器。
- **镜像要求**：需预装 node 与 pnpm（默认断网，corepack 无法现场下载）。node_modules 由容器内的 setup 安装，和宿主平台不混用。`AW_DOCKER_BIN` 可替换 docker 可执行文件（如 podman）。

### 13.8 v0.5 补齐

- **Module 登记板块**：`modules` 板块管理 Module 实体，每个模块显示在它范围内的进行中任务数；范围不在任何 Module 下的任务仍会在设计阶段要求 ADR。
- **看板筛选与多选**：按成员（含「未指派」）、逾期、等待前置筛选，条件记进 URL；「多选」模式可批量设截止日期和批量取消，逐任务报错汇总提示。
- **命令实时输出**：`run_command`、验收命令、环境准备、测试台套件运行的 stdout/stderr 经 `/api/live/:channel`（`task:<任务id>` / `qa:<运行id>`）实时推送，任务页「实时输出」标签和运行详情页直接看；`live_*` 事件不进 /api/stream。
- **合并后回归回显**：任务合并后，按 `merge_sha` 的祖先关系找到之后跑过的套件结果，任务右栏「合并后回归」逐套件显示结论并可一键回滚；自动回归新增失败时把可疑合并列进收件箱（`qa_regression` 的 `suspects`）并在任务会话留言。
- **qa_suite 验收**：acceptance 支持 `{ kind: 'qa_suite', suite: <套件 id> }`，平台在任务分支上起一次 trigger=`acceptance` 的测试台运行，按非隔离失败判定通过与否；套件不存在或没绑定本开发台是环境错误，直接转人工。这类运行不进测试台总览和回归判定。派发 / 编辑 / 反提案对话框都能勾选项目里绑定本台的套件。
- **任务依赖**：任务可设 `dueAt` 和前置依赖（`task_dependency` 边，同项目、不成环）；前置全完成后自动开工并留言，前置取消时提醒后续任务调整依赖（见 PM.md）。
- **验收现场恢复**：验收命令可能改动或新增 worktree 里的文件（如 pnpm 自动安装出的 node_modules / 锁文件），验收跑完把工作区恢复到执行前状态，避免这些产物误伤后续的 `git_commit` 范围检查和 integration worktree 干净检查。
