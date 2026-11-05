# Agent Workstation（智能体工作台）

> 以「工作台」为组织单元、以「任务」为调度总线、以「结构化板块」为共享记忆的多 Agent 协作系统。

## 这是什么

一个面向个人创作者 / 独立工作者的多 Agent 工作台产品。核心结构是两层：

- **根工作台**：项目、任务、依赖、跨台调度
- **领域工作台**：按业务插件装配（小说、销售……），各自拥有板块、阶段、Agent 团队

关键设计不是「给聊天套个皮」，而是：

1. **板块是结构化的**（人物卡、章节、大纲是对象，不是一大段 markdown），Agent 才能精确读写、校验、diff。
2. **通信分三层**：控制面（任务契约）、数据面（版本化产物）、会话面（群聊）。群聊只是界面，不是协议。
3. **作用域隔离**：Agent 只能看见自己所属工作台与祖先链，跨台协作必须经父级中转。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/PRD.md](docs/PRD.md) | 产品需求：定位、用户、概念模型、不变量、P0 范围、里程碑 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 技术架构：分层、数据模型、权限模型、Agent 运行时 |
| [docs/PLUGIN-SPEC.md](docs/PLUGIN-SPEC.md) | 工作台插件协议 v0.2：schema / 板块 / 阶段 / Agent 模板 / 模块声明 |
| [docs/MARKETPLACE.md](docs/MARKETPLACE.md) | 市场与分发：Bundle 格式、信任分级、兼容与迁移、冷启动 |
| [docs/PLUGINS/DEV.md](docs/PLUGINS/DEV.md) | 首个垂直插件 `dev`：全栈开发工作台的实体、板块、阶段与执行边界 |
| [docs/DECISIONS.md](docs/DECISIONS.md) | 决策记录：19 条已定、10 条待定（Q1–Q3 已收敛） |

## 技术栈

Node 26 LTS · pnpm workspace · TypeScript（strict）
React 19.3 · Vite 8 · TanStack Router / Query · Tailwind CSS 4.3 · shadcn/ui
Hono 4.13（本地常驻服务）· SQLite + better-sqlite3 · Drizzle ORM · Zod · SSE · Vercel AI SDK v7

## 当前状态

- [x] 需求澄清与建模
- [x] 架构与插件协议草案
- [ ] M0.1 手工骨架（进行中）
- [ ] M0.2 pm 根台 + dev 工作台（全栈开发工作台）
- [ ] M2 novel 插件

## 开发

```bash
pnpm install      # 安装依赖
pnpm db:seed      # 初始化数据库（自动建表 + 幂等播种）
pnpm dev          # 启动开发环境：API http://localhost:8787，Web http://localhost:5173
pnpm build        # 全仓 typecheck + 构建
pnpm test         # 单元测试（vitest）
pnpm test:e2e     # 端到端测试（Playwright，独立端口 8877/5273）
pnpm lint         # ESLint
pnpm db:migrate   # 生成并执行数据库迁移
```
