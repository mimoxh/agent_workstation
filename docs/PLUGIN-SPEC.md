# 工作台插件协议 v0.2

**日期**：2026-11-05
**状态**：草案

---

## 1. 设计原则

1. **声明式优先** — 能配置的不写代码。插件的 90% 应该是一个 JSON。
2. **一切可被 Agent 理解** — 每个字段都有 `description`，直接拼进系统提示词。
3. **权限最小化** — 工具白名单只是上限，实际授权由运行时 `grant` 决定。
4. **向前兼容** — 未知字段忽略；未知面板类型降级为 JSON 视图而非报错。
5. **插件不能越权** — manifest 中不允许声明「可访问其他工作台」。

## 2. 目录结构

```
plugins/dev/
├ manifest.json
├ prompts/
│  ├ architect.md
│  └ reviewer.md
└ README.md
```

## 3. Manifest 总览

```ts
export interface WorkbenchManifest {
  id: string;              // 全局唯一，小写短横线
  name: string;
  version: string;         // semver
  description: string;
  icon?: string;           // lucide 图标名

  entities: Record<string, EntityDef>;
  relations?: RelationDef[];
  stages?: StageDef[];     // 工作流步骤，由任务类型引用（可选）
  panels: PanelDef[];
  agents: AgentTemplateDef[];
  steward: string;         // 对外代表的 agent 模板 id（必填，有且只有一个，见 §7）
  tasks: TaskTypeDef[];
  tools?: ToolDef[];

  modules?: ModulesConfig;     // 模块声明，见 §3.1
  presets?: PresetDef[];       // 面向用户的预设，见 §3.1

  defaults?: {
    writeMode?: 'direct' | 'propose';
    taskBudget?: { tokens?: number; minutes?: number };
  };
}
```

### 3.1 模块声明

**工作台 = 一组模块的组合。** 模块是平台提供的能力，插件只声明「用哪个、怎么配」。

| 模块 | 作用 | v0.1 |
|---|---|---|
| `conversation` | 线程的发言调度 | ✅ |
| `knowledge` | 知识库导入与检索 | ✅ |
| `memory` | 显式记忆（决策记录 / 摘要卡片） | ✅ |
| `approval` | 审批与阻塞升级 | ✅ 内置 |
| `notification` | 通知与提醒 | ⬜ v0.2 |
| `scheduling` | 定时 / 周期任务 | ⬜ v0.2 |

```ts
export interface ModulesConfig {
  conversation?: ConversationConfig;
  knowledge?: KnowledgeConfig;
  memory?: MemoryConfig;
  approval?: ApprovalConfig;
}

export interface ConversationConfig {
  // v0.1 可用的 mode 为 relay / moderated；free 作为开关保留；bidding 是 v0.2
  defaultMode: 'free' | 'moderated' | 'bidding' | 'relay';
  // 默认 mode：task → relay，review → moderated，dm 不调度；
  // discussion 在 v0.1 用 moderated、v0.2 起用 bidding
  threadOverrides?: Partial<Record<'task' | 'review' | 'discussion' | 'dm', ConversationMode>>;
  moderator?: string;         // agent 模板 id，缺省用 steward
  maxTurns?: number;
  summaryEvery?: number;      // 每 N 轮生成一张结论卡片
}

export interface KnowledgeConfig {
  scope: 'project' | 'workstation';
  acceptedTypes: ('md' | 'txt' | 'pdf' | 'docx')[];   // v0.1 只支持 md/txt（以及手工笔记）；pdf/docx 于 v0.2
  retrieval: {
    strategy: 'fts' | 'hybrid';
    topK: number;             // 默认 5
    maxTokens: number;        // 默认 3000
  };
  citation: 'required' | 'preferred';
}

export interface MemoryConfig {
  strategy: 'none' | 'explicit';   // v0.1 只支持这两种，没有 auto
  decisionLog?: boolean;
  sessionSummary?: { enabled: boolean; every?: number };
}

export interface ApprovalConfig {
  requireHumanFor: ('proposal_merge' | 'dangerous_command' | 'budget_overrun' | 'task_complete')[];
}
```

#### 配置层级

```
平台默认值
   ↓ 被覆盖
工作台 manifest.modules
   ↓ 被覆盖
线程实例（thread.mode / thread.knowledgeScope）
```

**工作台是默认值容器，线程才是实际执行单元。** 只做工作台级会出问题：小说工作台里「讨论剧情」和「审查章节」显然不能用同一种调度。

三类模块的粒度并不一样：

| 模块 | 工作台级定义 | 线程级覆盖 |
|---|---|---|
| conversation | 默认模式、上限、摘要频率 | `thread.mode` |
| knowledge | 作用域、检索参数、引用要求 | `thread.knowledgeScope` |
| memory | 策略开关 | 是否沉淀本次会话 |
| approval | 哪些动作需人工 | 单次审批 |

#### 用预设，不要暴露裸参数

用户不该看到 `defaultMode: 'bidding'` 这种字面量。对外只暴露预设：

```ts
export interface PresetDef {
  id: string;
  name: string;
  description?: string;
  patch: DeepPartial<WorkbenchManifest>;   // 可叠加合并
}
```

```json
"presets": [
  {
    "id": "novel-standard",
    "name": "标准小说创作",
    "patch": {
      "modules": {
        "conversation": { "defaultMode": "bidding", "maxTurns": 12 },
        "knowledge": { "citation": "required" }
      }
    }
  },
  {
    "id": "novel-fast",
    "name": "快速出稿",
    "patch": {
      "modules": {
        "conversation": { "defaultMode": "relay" },
        "knowledge": { "citation": "preferred" }
      }
    }
  }
]
```

**理由**：模块化对开发者是自由，对用户是负担。N 个模块 × M 个选项 = 用户永远配不对。产品形态应该是「模块 + 预设 + 少量开关」，三层，不是一层。

#### 组合体检（lint）

装载时检查语义冲突，输出 warning 而非直接拒绝：

| 组合 | 问题 | 建议 |
|---|---|---|
| `conversation: relay` + 无任务图 | 没人会说话 | 改 `moderated` |
| `citation: required` + 零来源 | 所有产出都会被判不可信 | 先导入资料 |
| `memory: explicit` + 两个子项都关 | 模块空转 | 直接关掉 `memory` |
| `conversation: free` + 无 `maxTurns` | 成本不可控 | 强制补上限 |

## 4. 实体定义

```ts
export interface EntityDef {
  label: string;
  description: string;          // 给人和 Agent 看，进提示词
  titleField: string;           // 列表展示字段
  writeMode?: 'direct' | 'propose';   // 缺省继承 defaults.writeMode
  fields: Record<string, FieldDef>;
}

export interface FieldDef {
  type:
    | 'string' | 'text' | 'markdown'
    | 'number' | 'boolean' | 'date'
    | 'enum' | 'ref' | 'ref[]' | 'json';
  label: string;
  description?: string;
  required?: boolean;
  enum?: string[];              // type = 'enum'
  refTo?: string;               // type = 'ref' | 'ref[]'，指向实体类型
  maxLength?: number;
  default?: unknown;
}

export interface RelationDef {
  id: string;
  from: string;                 // 实体类型
  to: string;                   // 实体类型
  label: string;
  directed?: boolean;
}
```

### 系统实体

`system:` 是保留前缀，插件不得定义以它开头的实体。平台表可以被面板绑定：

| 实体 | 来源 | 可写 |
|---|---|---|
| `system:task` | 平台 task 表 | 经任务状态机 |
| `system:proposal` | 平台 proposal 表 | 经提案合并流程 |
| `system:files` | git 工作树（虚拟实体） | 只读 |
| `system:knowledge` | 知识库来源 | 经导入 |

### 字段类型语义

| type | 存储 | Agent 视角 | 渲染 |
|---|---|---|---|
| `string` | 短文本 | 一行 | 输入框 |
| `text` | 纯文本 | 多行 | 文本域 |
| `markdown` | 富文本 | 按需截断 | 编辑器 |
| `number` / `boolean` / `date` | 原生 | 值 | 对应控件 |
| `enum` | 枚举字符串 | 值 + 可选集 | 下拉 |
| `ref` | 实体 id | 关联标签 | 选择器 |
| `ref[]` | 实体 id 数组 | 关联标签列表 | 多选选择器 |
| `json` | 任意 | 序列化 | JSON 视图 |

## 5. 板块定义

```ts
export interface PanelDef {
  id: string;
  type: 'table' | 'board' | 'tree' | 'doc' | 'graph' | 'timeline' | 'form' | 'detail' | 'diff' | 'preview' | 'knowledge' | 'canvas' | 'tokens' | 'quality' | 'gantt';
  entity: string;                 // 插件实体或系统实体（system:*）
  title: string;
  config?: Record<string, unknown>;
  editableBy: ('human' | 'agent')[];
}
```

| type | 适用 | 典型 config |
|---|---|---|
| `table` | 角色表、客户表 | `columns`, `groupBy` |
| `board` | 章节状态、商机阶段 | `field`, `columns` |
| `tree` | 大纲、目录 | `titleField`, `childrenField` |
| `doc` | 文档台的撰写视图 | `view`：`studio` / `health` / `style`；`home`：作为工作台默认入口 |
| `graph` | 人物关系 | `relation`, `labelField` |
| `timeline` | 事件线、跟进记录 | `dateField` |
| `form` | 单条编辑 | `entity` |
| `detail` | 只读详情 | `layout` |
| `diff` | 代码改动审阅 | `showComments` |
| `preview` | 页面预览 + 截图对比 | `urlField`, `baselineField` |
| `knowledge` | 知识库导入与检索 | — |
| `canvas` | 设计画布（对话 + 沙箱预览 + 评论） | `home`：作为工作台默认入口 |
| `tokens` | 设计令牌与规范 | — |
| `quality` | 测试台的质量视图 | `view`：`overview` / `runs` / `cases` / `plans` / `bugs` / `flaky` / `coverage`；`home`：作为工作台默认入口 |
| `gantt` | 按日排布的任务甘特图（含里程碑与依赖） | — |

## 6. 阶段定义

阶段（stage）挂在**任务**上，不挂在工作台上：`task.status` 是平台通用的生命周期，`task.stage` 是插件定义的工作流位置，只在 in_progress / reviewing 期间推进。manifest 的 `stages` 声明可选的工作流步骤，由任务类型按序引用（见 §8）。

```ts
export interface StageDef {
  id: string;
  name: string;
  description?: string;
  requirements?: Requirement[];   // 进入下一阶段的门禁（自动校验在 M3，见 §12）
  activePanels?: string[];        // 本阶段展示的板块 id
  activeAgents?: string[];        // 本阶段激活的 agent 模板 id
}

// 门禁条件，在任务上下文里求值（作用对象是与该任务关联的实体、提案和验收）
export type Requirement =
  | { kind: 'entity'; entity: string; minCount?: number; fieldsPresent?: string[] }
  | { kind: 'acceptance' }
  | { kind: 'approval'; by?: 'human' | 'agent' }
  | { kind: 'manual'; text: string }
  | { kind: 'new_scope_decision'; registry: string; pathField?: string; decision: string };  // 任务范围有未登记路径时要一条决策实体
// 每种都可以带 description?: string
```

阶段的核心作用不是「好看」，而是**决定该任务此刻谁在工作、哪些板块可写**。它不是纯展示状态，是运行时输入。

## 7. Agent 模板

```ts
export interface AgentTemplateDef {
  id: string;
  name: string;
  role: string;                   // 一句话职责，进提示词
  systemPrompt?: string;          // 内联
  promptFile?: string;            // 或引用 prompts/*.md
  model?: {
    provider?: string;
    name?: string;
    temperature?: number;
  };
  tools: string[];                // 工具白名单
  triggers?: ('task_assigned' | 'mentioned' | 'stage_enter' | 'schedule' | 'manual')[];
  budget?: { tokens?: number; minutes?: number };
}
```

**steward 规则**：一个工作台有且只有一个 steward（对外代表）。它额外拥有父级的 `speak` 权，其余 Agent 只能在父级被派发时发言。

## 8. 任务类型

```ts
export interface TaskTypeDef {
  id: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;    // JSON Schema
  outputSchema?: Record<string, unknown>;
  stages?: string[];                       // 按顺序引用 manifest 中的 stage id；缺省 = 使用全部 stage 的顺序
  acceptance?: (string | AcceptanceCheck)[];
  defaultBudget?: { tokens?: number; minutes?: number };
  handler?: 'agent' | 'human' | 'auto';
}

// 字符串等价于 manual；M0 只自动判定 command，visual 于 M1
export type AcceptanceCheck =
  | { kind: 'command'; run: string; expect: { exitCode: number } }
  | { kind: 'visual'; url: string; baseline: string; maxDiff: number }
  | { kind: 'manual'; text: string };
```

## 9. 工作台内部工具

```ts
export interface ToolDef {
  id: string;
  description: string;
  params: Record<string, unknown>;   // JSON Schema
  handler: string;                   // 代码中注册的实现名
  scope: 'workstation' | 'project';
}
```

内置工具（`read_entity` / `propose_entity` / `send_message` 等）无需声明，插件只需声明**额外的领域工具**，例如 `resolve_foreshadowing`、`score_lead`。

## 10. 完整示例：`novel`（M2）

```json
{
  "id": "novel",
  "name": "小说创作工作台",
  "version": "1.0.0",
  "description": "围绕人物、世界观、大纲与章节的结构化长篇创作工作台",
  "icon": "book-open",

  "entities": {
    "Character": {
      "label": "人物",
      "description": "故事中的角色。每个角色必须有目标与缺陷，否则剧情容易失真。",
      "titleField": "name",
      "writeMode": "propose",
      "fields": {
        "name":    { "type": "string", "label": "姓名", "required": true, "maxLength": 40 },
        "role":    { "type": "enum", "label": "定位", "enum": ["主角", "反派", "配角", "路人"] },
        "goal":    { "type": "text", "label": "目标", "description": "角色最想得到什么" },
        "flaw":    { "type": "text", "label": "缺陷", "description": "阻碍目标的内在问题" },
        "secret":  { "type": "text", "label": "秘密" },
        "arc":     { "type": "text", "label": "成长弧线" },
        "relations": { "type": "ref[]", "label": "关系", "refTo": "Character" }
      }
    },
    "WorldRule": {
      "label": "世界观规则",
      "description": "世界运作的硬规则。一旦确立，正文不得违背。",
      "titleField": "statement",
      "fields": {
        "category":  { "type": "enum", "label": "类别", "enum": ["地理", "势力", "规则", "历史", "技术"] },
        "statement": { "type": "text", "label": "规则", "required": true },
        "scope":     { "type": "string", "label": "适用范围" }
      }
    },
    "Outline": {
      "label": "大纲节点",
      "description": "树形结构，卷 → 章 → 情节点。",
      "titleField": "title",
      "fields": {
        "title":   { "type": "string", "label": "标题", "required": true },
        "summary": { "type": "text", "label": "梗概" },
        "parent":  { "type": "ref", "label": "上级", "refTo": "Outline" },
        "order":   { "type": "number", "label": "排序" }
      }
    },
    "Chapter": {
      "label": "章节",
      "description": "正文单元，关联大纲节点。",
      "titleField": "title",
      "fields": {
        "title":       { "type": "string", "label": "标题", "required": true },
        "outline_ref": { "type": "ref", "label": "大纲节点", "refTo": "Outline" },
        "status":      { "type": "enum", "label": "状态", "enum": ["草稿", "待审", "修订", "定稿"] },
        "content":     { "type": "markdown", "label": "正文" },
        "word_count":  { "type": "number", "label": "字数" }
      }
    }
  },

  "relations": [
    { "id": "char-rel", "from": "Character", "to": "Character", "label": "人物关系", "directed": true }
  ],

  "stages": [
    {
      "id": "plan",
      "name": "构思",
      "description": "确定本章情节点与出场人物",
      "activePanels": ["outline", "characters"],
      "activeAgents": ["plot-architect"]
    },
    {
      "id": "draft",
      "name": "起草",
      "activePanels": ["chapters", "outline"],
      "activeAgents": ["plot-architect", "character-designer"]
    },
    {
      "id": "review",
      "name": "审查",
      "requirements": [{ "kind": "approval", "by": "agent" }],
      "activePanels": ["chapters"],
      "activeAgents": ["continuity-checker"]
    },
    {
      "id": "polish",
      "name": "润色",
      "activePanels": ["chapters"],
      "activeAgents": ["stylist"]
    }
  ],

  "panels": [
    { "id": "characters", "type": "table",  "entity": "Character", "title": "人物",   "editableBy": ["human", "agent"] },
    { "id": "world",      "type": "table",  "entity": "WorldRule", "title": "世界观", "editableBy": ["human", "agent"] },
    { "id": "outline",    "type": "tree",   "entity": "Outline",   "title": "大纲",   "editableBy": ["human", "agent"] },
    { "id": "chapters",   "type": "doc",    "entity": "Chapter",   "title": "章节",   "editableBy": ["human", "agent"] }
  ],

  "steward": "plot-architect",

  "agents": [
    {
      "id": "character-designer",
      "name": "人物设计师",
      "role": "补全人物卡，确保每个角色有目标、缺陷与可演化的弧线",
      "promptFile": "prompts/character-designer.md",
      "tools": ["read_entity", "list_entities", "propose_entity", "send_message", "request_human"],
      "triggers": ["task_assigned", "mentioned"],
      "budget": { "tokens": 120000 }
    },
    {
      "id": "plot-architect",
      "name": "剧情架构师",
      "role": "负责大纲结构、章节拆分与内部调度，是本工作台的对外代表",
      "promptFile": "prompts/plot-architect.md",
      "tools": ["read_entity", "list_entities", "propose_entity", "create_task", "send_message", "report_blocked", "request_human"],
      "triggers": ["task_assigned", "mentioned", "stage_enter"],
      "budget": { "tokens": 200000 }
    },
    {
      "id": "continuity-checker",
      "name": "连贯性审查",
      "role": "只读审查：设定冲突、伏笔遗漏、人物行为不一致。只报告，不修改。",
      "promptFile": "prompts/continuity-checker.md",
      "tools": ["read_entity", "list_entities", "report_blocked", "send_message"],
      "triggers": ["task_assigned"],
      "budget": { "tokens": 80000 }
    },
    {
      "id": "stylist",
      "name": "文风润色",
      "role": "在不改变情节与设定的前提下统一文风、节奏与对白质感",
      "tools": ["read_entity", "propose_entity", "send_message"],
      "triggers": ["task_assigned", "mentioned"],
      "budget": { "tokens": 100000 }
    }
  ],

  "tasks": [
    {
      "id": "write_chapter",
      "name": "撰写章节",
      "description": "根据大纲节点产出正文草稿。前置条件：至少 3 个人物且有 goal/flaw，以及至少 1 条世界观规则——启动本任务前应先完成设定。",
      "stages": ["plan", "draft", "review", "polish"],
      "inputSchema": {
        "type": "object",
        "required": ["outline_node"],
        "properties": {
          "outline_node": { "type": "string" },
          "target_words": { "type": "integer", "minimum": 500 },
          "pov": { "type": "string" }
        }
      },
      "acceptance": ["字数达标", "不违背人物设定", "不违背世界观规则", "通过连贯性审查"],
      "defaultBudget": { "tokens": 200000, "minutes": 30 }
    },
    {
      "id": "revise_outline",
      "name": "调整大纲",
      "description": "按新要求重构指定分支",
      "inputSchema": {
        "type": "object",
        "required": ["node"],
        "properties": { "node": { "type": "string" }, "reason": { "type": "string" } }
      },
      "acceptance": ["层级完整", "与已有人物动机不冲突"]
    },
    {
      "id": "audit_consistency",
      "name": "一致性审查",
      "description": "对指定范围做冲突扫描，输出问题清单",
      "inputSchema": {
        "type": "object",
        "properties": { "scope": { "type": "string" } }
      },
      "acceptance": ["每个问题附带证据引用"]
    }
  ],

  "defaults": {
    "writeMode": "propose",
    "taskBudget": { "tokens": 150000, "minutes": 20 }
  }
}
```

## 11. 内置插件 `pm`（根工作台）

根工作台本身也是一个工作台，用插件实现——**同构**可以省掉大量特判代码。

```json
{
  "id": "pm",
  "name": "项目管理",
  "version": "1.0.0",
  "description": "根工作台：任务立项、派发、依赖与验收",
  "entities": {
    "Milestone": { "label": "里程碑", "description": "项目级阶段目标，由人维护",
      "titleField": "name",
      "fields": { "name":   {"type":"string","label":"名称","required":true},
                  "due":    {"type":"date","label":"截止日期"},
                  "status": {"type":"enum","label":"状态","enum":["未开始","进行中","已完成"]} } }
  },
  "panels": [
    { "id": "board",  "type": "board",    "entity": "system:task", "title": "任务看板", "editableBy": ["human","agent"] },
    { "id": "miles",  "type": "timeline", "entity": "Milestone",   "title": "里程碑",   "editableBy": ["human"] }
  ],
  "agents": [
    { "id": "pm",      "name": "项目经理", "role": "拆解目标、分派任务、跟踪阻塞",
      "tools": ["read_entity","list_entities","create_task","send_message","request_human"] }
  ],
  "steward": "pm",
  "tasks": []
}
```

> 跨台负载均衡调度员（dispatcher）推迟到 v0.2+。pm 的根任务只走平台 `status`，不声明 `stages`。

## 12. 校验与版本

| 场景 | 行为 |
|---|---|
| 加载时 Zod 校验失败 | 拒绝装载，报错含 JSON Pointer 路径 |
| 未知字段 | 忽略 |
| 未知面板类型 | 降级为只读 JSON 视图 + 警告 |
| `refTo` 指向不存在实体 | 装载失败 |
| `steward` 缺失或不在 agents 中 | 装载失败 |
| 面板 `entity` 不存在（且不是 `system:*`） | 装载失败 |
| 插件实体使用 `system:` 前缀 | 装载失败 |
| stage 引用不存在的 Agent 或面板 | 装载失败 |
| 任务类型 `stages` 引用不存在的 stage | 装载失败 |
| version 升级 | minor 允许加字段；major 需声明式迁移（见 MARKETPLACE §4，v0.2 提供）。启动时为已挂载工作台补齐新板块和这次新增的工具，人收窄过的工具不恢复 |

## 13. 权限边界（重要）

插件**不能**声明跨工作台访问。`tools` 只是能力上限，实际调用前由运行时检查：

```
can(agent, 'observe', targetScope) && tool in agent.tools
```

propose 类工具（如 `propose_entity`）按同样方式检查 `propose` 权；`create_task` 检查 `invoke` 权；`send_message` 检查 `speak` 权。

跨工作台只能通过两种方式：
1. 父级任务派发（`invoke` 权）
2. 被显式授权的 Artifact 只读引用

这条规则写死在运行时，插件无法绕过。

## 14. 分发与信任边界

| 插件来源 | `handler` 代码 | 可用工具 | 审核 |
|---|---|---|---|
| 第一方（内置） | 允许 | 全部 | 内部 |
| 第三方（L1/L2） | **禁止** | 仅内置工具 | 自动扫描 / 人工 |

第三方插件的表达力上限：

```
entities + panels + stages + agents（提示词）+ tasks + modules + presets
```

这套组合够覆盖约 80% 的场景。需要新工具、新面板类型、新调度策略的，交给第一方。

分发格式（Bundle）、兼容性、迁移与冷启动策略见 [MARKETPLACE.md](MARKETPLACE.md)。
