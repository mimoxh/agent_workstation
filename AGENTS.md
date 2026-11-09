# AGENTS.md

Agent Workstation：多 Agent 协作工作台（Vite + Hono + SQLite）。打开即控制台（跨项目），顶栏标签切工作台，左侧栏切台内功能（DECISIONS D25）。designs/aw-workbench/ 是当前原型，其余 designs/ 只作历史参考。
本机 shell 用 **PowerShell**（`shell_flavor: "powershell"`），没有 bash。

## 目录结构

```
apps/
├ web/            React + Vite 前端（端口 5173，/api 代理到 8787）
│  └ src/
│     ├ routes/   TanStack Router 文件路由（_console.* 是控制台布局下的页面；routeTree.gen.ts 为生成物，勿手改）
│     ├ components/
│     │  ├ board/    任务看板——剧本 A 的目标 Module，写干净、可扩展
│     │  ├ panels/   其余板块渲染器（改动审阅 / 测试 / 实体 / 文件 / 知识库 / 预览 / 编制 / 设置）
│     │  ├ workstation/  工作台屏幕（大群 / 板块）、板块注册表、控制台总览
│     │  ├ design/   设计台：画布、沙箱 iframe 与检查脚本、评论 / 旋钮、设计系统、交接
│     │  ├ qa/       测试台：质量总览、运行、用例库、测试计划、缺陷、不稳定用例、覆盖率
│     │  ├ timeline/ 协作时间线、交接与结论卡
│     │  ├ team/     团队脉搏
│     │  ├ task/     任务头、右栏
│     │  ├ inbox/ chat/ run/
│     │  ├ layout/   外壳（顶栏标签 + 上下文侧栏）、页面骨架 Page、命令面板、挂载与新建项目对话框
│     │  └ ui/       基础组件（button / badge / card / input / dialog / feedback / icons）
│     ├ lib/api.ts      Hono RPC 类型化客户端 + unwrap
│     ├ lib/queries.ts  全部读请求的 hook 与派生类型（类型从 RPC 推导，别手写）
│     └ lib/live.ts     /api/stream 实时失效；新增事件时在 RULES 里登记要刷新的 query key
└ server/         Hono 本地常驻服务（端口 8787，AW_PORT 可改）
   └ src/
      ├ db/         schema / client / migrate / seed（AW_DB_PATH 可改，默认可 :memory:）
      ├ repositories/  仓储层（读）
      ├ usecases/   用例（写）：core / flow / tasks / workstations / threads / proposals / inbox / entities / knowledge / projects / backup / repo / designs / qa
      ├ runtime/    Agent 运行时：调度、发言调度、协调、循环、工具、dev 工作流、预算、模型路由
      └ app.ts      路由（/api 前缀）+ AppType 导出
packages/
├ domain/         纯函数领域层：task-state 状态机、权限、@ 解析、三级预算
├ plugin-spec/    manifest 的 Zod schema 与校验（改了要 build，server 读 dist）
└ plugins/        内置插件 pm、dev、design、qa
```

## 命令

- `pnpm dev` — 并行启动 domain watch + server + web
- `pnpm build` — 全部 typecheck + 构建
- `pnpm typecheck` / `pnpm lint` / `pnpm test`
- `pnpm test:e2e` — Playwright（独立端口 server 8877 / web 5273，临时 DB）
- `pnpm db:migrate` — drizzle-kit generate + 执行迁移
- `pnpm db:seed` — 建表 + 幂等播种

## 硬规则

- `packages/domain/**` 不得 import hono / react / drizzle-orm / better-sqlite3 / ai / @ai-sdk/* / node:*（ESLint `no-restricted-imports` 强制）。
- `apps/server/src/repositories/` 所有函数第一个参数必须是 `actor: Actor`，不得缺省；M0.1 不做权限过滤，M0.2 接 `can()`。
- 代码注释默认不写；保持现有中文注释风格（只在结构需要处写）。
- 路由文件改动后 `routeTree.gen.ts` 由插件自动重新生成，不要手改。
- 颜色语义：accent（橙）= 等人，cool（蓝）= 仪器 / 机器在动，bad = 出问题，ok = 收口；主按钮用 primary（墨色）。样式用 index.css 的令牌（深色在同文件的 prefers-color-scheme 里），不写裸色值。
- usecases 与 runtime 互相引用：`usecases/index.ts` 用具名导出，不要用 `export *`；runtime 从具体模块导入。
- 新增 Agent 工具要在 `plugin-spec/src/validate.ts` 的 `BUILTIN_TOOLS` 登记；模板工具变更要升 manifest version，启动时才会同步到已挂载的工作台。
- 设计稿是模型写的代码，按不可信处理：只在 `sandbox="allow-scripts"` 的 iframe 里渲染（不加 allow-same-origin），postMessage 要过 `parseFrameEvent`。
- 测试台不写仓库，改代码一律交接给开发台；测试报告是被测代码写的，按不可信处理。套件命令只能人审定，Agent 按 id 运行（docs/PLUGINS/QA.md）。
- 路由失败统一 `fail(c, r)`，返回 `{ error: string }`；前端 mutation 的错误默认走全局 toast，对话框内自己展示的用 `meta: { silent: true }`。


## 模型配置
在 /settings 配置，或复制 .env.example 为 .env.local（环境变量优先）；AW_DEFAULT_MODEL 选默认；AW_AUTORUN=0 关自动运行；AW_ENABLE_MOCK=1 用脚本化 mock。冒烟：pnpm --filter @aw/server smoke:model（不回显 key）。mock 不看工具 schema，改工具或模型层后要用真实模型跑一次冒烟。
