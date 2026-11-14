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
| `decisions` | table | ADR | 架构决策 |
| `files` | tree | `system:files` | 只读文件树（git 工作树），点开看代码 |
| `preview` | preview | Page | 页面预览 + 截图对比 |
| `knowledge` | knowledge | `system:knowledge` | 知识库：规范、资料、笔记 |
| `overview` `runs` `cases` `plans` `bugs` `flaky` `coverage` | quality | TestSuite 等 | 质量板块（原测试台，D32 并入），侧栏归在「测试」分组，见 §15 |

`diff` 是 M0 新增的 panel 类型，`preview` 于 M1。原 `tests`（TestRun 表格）板块在 1.9.0 撤掉：验收命令的原始输出看任务页「测试」视图，版本级的运行看「测试运行」。

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
| `qa-lead` / `case-designer` / `failure-analyst` | 质量成员（原测试台）：发布结论、用例草稿、失败分诊，只在被 @ 时工作，不写仓库 | 见 §15 与 QA.md §2 |

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
  - kind: design_match
    url: http://localhost:{port}/           # 实现跑起来的页面
    artifact: <design_handoff Artifact id>  # 交接冻结的设计稿
    maxDiff: 0.25                           # 可省，默认 0.25
  - kind: manual
    text: 三栏在 1280 宽度下不换行
```

前三种可自动判定，第四种给前端场景兜底。配了 `commands.serve` 时，平台在跑 visual / design_match 前于被验收的 worktree 里启动它（端口从环境变量 `PORT` 取），页面可访问后再截图，结束即停；不配就假设页面已经在跑。

`design_match` 把交接的设计稿 HTML 在服务端渲染成 1280×800 截图，实现的页面用同一视口截图，两者做像素对比，差异率超 `maxDiff`（默认 25%）判失败。产出三张 `screenshot` Artifact（设计稿 / 实现 / 差异）和一个带 `meta.kind = 'design_match'` 的 `test_output`，任务页与测试记录里并排展示、可叠加调透明度。交接件不存在、类型不对或属于别的项目时是 error（不算环境错误）；页面打不开、浏览器没装等仍算环境错误。`artifact` 必须指向同项目的 `design_handoff`，由「生成实现任务」对话框的「页面地址」自动写入，不手写。

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
      "activePanels": ["runs", "changes"], "activeAgents": ["test-engineer"] },
    { "id": "review",      "name": "评审",
      "requirements": [{ "kind": "approval" }],
      "activePanels": ["changes"], "activeAgents": ["reviewer"] },
    { "id": "merge",       "name": "合并", "activePanels": ["changes"], "activeAgents": [] }
  ],
  "panels": [
    { "id": "board",     "type": "board",   "entity": "system:task",     "title": "任务看板", "editableBy": ["human", "agent"] },
    { "id": "changes",   "type": "diff",    "entity": "system:proposal", "title": "改动审阅", "editableBy": ["human", "agent"], "config": { "showComments": true } },
    { "id": "runs",      "type": "quality", "entity": "TestSuite",       "title": "测试运行", "editableBy": ["human", "agent"], "config": { "view": "runs", "group": "测试" } },
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
- **命令实时输出**：`run_command`、验收命令、环境准备、质量套件运行的 stdout/stderr 经 `/api/live/:channel`（`task:<任务id>` / `qa:<运行id>`）实时推送，任务页「实时输出」标签和运行详情页直接看；`live_*` 事件不进 /api/stream。
- **合并后回归回显**：任务合并后，按 `merge_sha` 的祖先关系找到之后跑过的套件结果，任务右栏「合并后回归」逐套件显示结论并可一键回滚；自动回归新增失败时把可疑合并列进收件箱（`qa_regression` 的 `suspects`）并在任务会话留言。
- **qa_suite 验收**：acceptance 支持 `{ kind: 'qa_suite', suite: <套件 id> }`，平台在任务分支上起一次 trigger=`acceptance` 的套件运行，按非隔离失败判定通过与否；套件不存在或不在本台是环境错误，直接转人工。这类运行不进质量总览和回归判定。派发 / 编辑 / 反提案对话框都能勾选本台的套件。
- **任务依赖**：任务可设 `dueAt` 和前置依赖（`task_dependency` 边，同项目、不成环）；前置全完成后自动开工并留言，前置取消时提醒后续任务调整依赖（见 PM.md）。
- **验收现场恢复**：验收命令可能改动或新增 worktree 里的文件（如 pnpm 自动安装出的 node_modules / 锁文件），验收跑完把工作区恢复到执行前状态，避免这些产物误伤后续的 `git_commit` 范围检查和 integration worktree 干净检查。

## 14. 设计（原设计台，D29 并入）

**版本**：D29 并入开发台（dev manifest 1.7.0）

前端设计的完整闭环搬进开发台：画布出稿 → 评论迭代 → 生成实现任务 → 实现 → 验收，都在同一台完成。原独立 `design` 插件已删除；老的设计工作台启动时自动迁移：项目里有开发台就把 `Design` / `DesignComment`（`DesignSystem` 开发台已有时保留开发台的）和 `design_handoff` / `screenshot` 产物并进最早的开发台、源台归档；没有开发台时就地转成开发台。

### 14.1 成员

设计师和设计评审是开发台的普通成员（`templateId: designer` / `design-critic`，只在被 @ 时工作）；台的负责人仍是架构师。设计侧栏的「和设计师对话」默认就是设计师私聊，画布上的评论和自检问题也发到这条私聊；台里没有设计师时侧栏提示去「成员」添加。

| Agent | 职责 |
|---|---|
| 设计师 | 出稿、改稿、处理评论；配色字体间距按稿自定 |
| 设计评审 | 只读，把意见钉在元素上；被 @ 时工作 |

### 14.2 数据

没有新表，都是普通实体，自带版本和回滚。设计台默认 `writeMode: direct`，并入后逐个实体显式声明 `writeMode: direct`（dev 默认是 propose）。

| 实体 | 内容 |
|---|---|
| `Design` | `html`、`brief`、`group` / `direction`（方案组）、`tweaks`（旋钮）、`status`、`handoff`、`legacyTokens`（旧版令牌，见 §14.7） |
| `DesignComment` | 锚定的 `selector` + `anchor`、`body`、`status` |

板块：`canvas`（设计画布）跟在「任务看板」后面；默认视图仍是看板，不像原设计台那样 `config.home` 到画布。

### 14.3 渲染与安全（与原设计台一致）

稿子是模型写的代码，按不可信处理：

- `<iframe sandbox="allow-scripts">`，不给 `allow-same-origin`，拿不到平台的接口和 cookie。
- 注入 CSP（`DESIGN_CSP`）：断网，禁表单提交，外部资源只放行字体、图片和四个常见 CDN。
- 外层只接受 `parseFrameEvent` 校验过的消息，内容一律当纯文本。

文档由 `composeDesignDoc` 拼出：稿子的 `legacyTokens` 写 `:root`（新稿子为空），稿子可以覆盖；旋钮写 `:root:root`，总是生效。预览额外注入检查脚本，导出和交接不带。

服务端渲染（导出和 `view_design` 共用 `renderDesign`）同样在隔离环境里跑：每次全新浏览器 + 上下文，`data:` / `blob:` / `about:` 之外的请求一律拦截，30s 硬超时；本机没装 Chromium 时报环境错误。

检查脚本的浮层挂在 `<html>` 下、脚本和样式放 `<head>`，所以 `body` 内的 `nth-child` 选择器在预览和稿子原文里一致。评论钉和就地改字都依赖这一点。

### 14.4 工具

| 工具 | 说明 |
|---|---|
| `list_designs` / `read_design` | 清单 / 全文（可取历史版本）。`read_design` 的结果上限放宽到 120KB |
| `write_design` / `edit_design` | 整份写入 / 原文替换，都产生新版本；返回 `lintDesign` 的警告 |
| `comment_design` / `resolve_design_comments` | 钉评论 / 关闭评论 |
| `view_design` | 服务端渲染当前（或指定）版本的截图：桌面 1440 / 平板 834 / 手机 390，整页封顶 6000px。截图存为 `screenshot` Artifact；开了「支持看图」的模型直接收到图片，没开的只拿到产物 id 和一句说明 |
| `read_design_snapshot` | 用例设计专用，读 `design_handoff` Artifact 里冻结的成品文档（限同项目） |
| `read_design_handoff` | 实现者用，读任务（或祖先任务）上声明的交接件 |

写稿的 Agent 单次输出上限取 provider 的「最大输出」，没填时退回 `AW_LARGE_OUTPUT_TOKENS`（默认 16000，0 表示不设）；填了「上下文窗口」时上限再按上轮输入收敛，给输出留出余量。

### 14.5 生成实现任务（原「交接」）

画布上「生成实现任务」把当前版本冻结成 `design_handoff` Artifact，在目标开发台起草 `dev.issue`（默认本台，也可选项目里其他开发台），`input.design_artifact` 指向它，任务停在草稿由人确认后派发。之后继续改稿不影响已冻结的快照。

对话框里可选填「页面地址」（限本机 http(s)，可写 `{port}`）：填了任务验收多一条 `design_match`（见 §7），实现跑起来后和稿子做像素对比。

对话框可勾选「同时请目标台的用例设计起草验收用例」（默认不勾）：勾选后以人的身份在目标开发台会话 @用例设计 并带上快照 id，由用例设计读 `read_design_snapshot` 起草用例草稿（见 QA §6）；目标台没有在岗的用例设计时不发。

### 14.6 导出与对比

- **导出**：画布上可下载当前版本为独立 HTML，或导出 PNG（桌面 / 平板 / 手机三档）和 PDF；`GET /api/designs/:id/export` 也可取历史版本，文件名带标题和版本号。
- **对比**：「对比」模式把两个版本并排渲染在同一个沙箱 iframe 规格里，左右各自选稿子和版本（候选限同方案组的稿），共享设备宽度切换，只用于人眼看差异。

### 14.7 旧版令牌（legacyTokens）

设计系统下线前，每份已有 `Design` 启动时被 `freezeDesignTokens` 冻结一份 `legacyTokens`：稿子里用到 `var(--` 的，取本台保存过的 `DesignSystem` 令牌，没有则取迁移内置的 `LEGACY_DEFAULT_TOKENS`；没用的记 `[]`。实体行和全部 `entity_version` 行原地更新（不产生新版本），幂等以 `legacyTokens` 键是否存在为准，每台记一条 `design_tokens_frozen` 事件。之后渲染、交接、导出、对比都注入这份冻结令牌，旧稿子显示不变；新稿子永远没有 `legacyTokens`，配色字体由设计师在稿子自己的 `:root` 里定义。`read_design` 对带旧版令牌的稿子会附一句说明。

### 14.8 任务实时预览

开发任务页有「预览」视图：平台在任务的 worktree 里后台起 `commands.serve`（和验收同一个命令、同一套端口分配，页面地址 `http://localhost:<分到的 web 端口>/`），起好后嵌 iframe 直接看实现效果，可切桌面 1280 / 平板 834 / 手机 390 三档宽度，能刷新、新窗口打开、手动停。任务带设计交接（`input.design_artifact`）时可开「对照设计稿」并排看快照——稿子仍走 `allow-scripts` 沙箱 iframe，预览 iframe 是另一个源（localhost 端口），与平台互不同源。

规则：只对 dev 任务开放，任务有了 worktree（开始实现之后）才能起；没配 serve 命令先提示去工作台设置。预览占着这个 worktree 的端口槽位——验收要在同一 worktree 起 serve 时会先停掉预览；任务合并、完成或取消时预览一并回收。人停手（不再轮询状态）10 分钟后自动回收；同时最多 3 个预览，进程退出时全部停掉。

## 15. 质量（原测试台，D32 并入）

**版本**：D32 并入开发台（dev manifest 1.9.0）

开发台的 test 阶段回答“这个任务能不能合并”，质量板块回答“这个版本能不能发”。两件事现在在同一台：用例、套件、回归、缺陷和发布结论都挂在开发台上，修缺陷、补自动化直接在本台起草开发任务。细节（执行、判定、分析、缺陷闭环）见 [QA.md](QA.md)。

- **板块**：质量总览、测试运行、用例库、测试计划、缺陷、不稳定用例、覆盖率，侧栏归在「测试」分组（`config.group`，1.9.1 起由「质量」改名，升级时同步已有板块的配置）；默认视图仍是任务看板。测试阶段激活「测试运行」和「改动审阅」。
- **成员**：测试负责人（`qa-lead`）、用例设计（`case-designer`）、失败分析（`failure-analyst`）是普通成员，只在被 @ 时工作，没有写代码、跑命令、改实体的工具；台的负责人仍是架构师，`test-engineer` 照旧负责任务内的测试。
- **仓库**：套件跑在本台绑定的仓库和目标分支上，常驻分离头 worktree 是 `<worktree 根>/<开发台>/_qa`；没绑定仓库时质量总览提示先去设置里绑定。
- **交接**：「生成修复任务」「生成自动化任务」默认在本台起草 `dev.issue` 草稿，项目里有多台开发台时可以选别的开发台。验收里的 `qa_suite` 只能引用本台套件。
- **迁移**：老的测试工作台启动时自动迁移。它绑定的开发台还在就并进去（否则并进同项目最早的开发台）：`TestSuite` / `TestCase` / `TestPlan` / `BugReport` / `TestQuarantine`、`qa_run` / `qa_case_result`、`qa_handoff` / `qa_report` 产物一起挪，源台归档、成员暂停，旧 `_qa` worktree 删掉。项目里没有开发台时就地转成开发台（去掉 `sourceWorkstationId`，板块按开发台重建，补齐开发台成员，架构师接负责人），绑定仓库后即可用。已有开发台升级到 1.9.0 时各补一次三个质量成员，人删过的不再恢复。
