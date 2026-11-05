# AGENTS.md

Agent Workstation 的 M0.1 手工骨架（Vite + Hono + SQLite + 三栏 + 任务看板）。
本机 shell 用 **PowerShell**（`shell_flavor: "powershell"`），没有 bash。

## 目录结构

```
apps/
├ web/            React + Vite 前端（端口 5173，/api 代理到 8787）
│  └ src/
│     ├ routes/   TanStack Router 文件路由（routeTree.gen.ts 为生成物，勿手改）
│     ├ components/
│     │  ├ board/    任务看板——剧本 A 的目标 Module，写干净、可扩展
│     │  ├ layout/   IDE 三栏外壳
│     │  └ ui/       基础组件（button / badge / card / input）
│     └ lib/api.ts   Hono RPC 类型化客户端
└ server/         Hono 本地常驻服务（端口 8787，AW_PORT 可改）
   └ src/
      ├ db/         schema / client / migrate / seed（AW_DB_PATH 可改，默认可 :memory:）
      ├ repositories/  仓储层
      ├ runtime?    （M0.2）
      └ app.ts      路由（/api 前缀）+ AppType 导出
packages/
└ domain/         纯函数领域层：task-state 状态机、Actor 类型
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
- 不要做 git init / commit。


## 模型配置（M0.2）
复制 .env.example 为 .env.local 填 provider 密钥；AW_DEFAULT_MODEL 选默认；AW_AUTORUN=0 关自动运行；AW_ENABLE_MOCK=1 用脚本化 mock。冒烟：pnpm --filter @aw/server smoke:model（不回显 key）。
