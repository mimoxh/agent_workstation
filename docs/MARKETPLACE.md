# 市场与分发

**版本**：v0.2
**日期**：2026-11-05

---

## 0. 一个前提

**市场是分发机制，不是供给机制。**

没有 3–5 个打磨过、真的能跑通的第一方方案，市场开出来就是空的，还会消耗用户对「这个产品有生态」的信任。

所以顺序是：

```
官方方案（打磨） → 文件导入导出（试水） → 社区提交（审核） → 评分评论（有量之后）
```

不要跳步。

## 1. 分享的单元：Bundle

用户分享的不是「一个插件」，也不是「整个工作台」，而是 **Bundle**：

```ts
export interface WorkbenchBundle {
  schema: 'workbench-bundle/v1';
  id: string;                    // 全局唯一
  name: string;
  version: string;               // semver
  description: string;
  author: { name: string; url?: string };
  license: string;

  requires: {
    platform: string;            // semver range，如 ">=0.1.0 <0.4.0"
    plugins: { id: string; version: string }[];
  };

  apply: {
    preset?: string;                        // 引用插件内置预设
    patches?: DeepPartial<WorkbenchManifest>[];  // 覆盖参数
    prompts?: Record<string, string>;       // 覆盖提示词
    modules?: ModulesConfig;                // 覆盖模块配置
  };

  seed?: {
    entities: { block: string; type: string; data: unknown }[];
    tasks?: { title: string; intent: string; acceptance?: string[] }[];
  };

  checksum: string;              // sha256，导入时校验
}
```

### 为什么是这个粒度

| 方案 | 问题 |
|---|---|
| 分享整个工作台（含真实数据） | 泄露隐私，几乎不可用 |
| 只分享预设 patch | 太轻，用户真正想分享的是「填好的结构」 |
| ✅ Bundle：结构 + 示例数据 + 调优 | 可复用、可脱敏、可离线 |

`seed` 里的示例数据必须是 **schema 合法但内容虚构** 的。导入时用户可选「带示例」或「空白」。

## 2. 三级信任

| 级别 | 来源 | 审核 | 可否含代码 |
|---|---|---|---|
| **L0 官方** | 平台团队 | 内部评审 | 可以 |
| **L1 认证** | 社区提交 | 人工 + 自动扫描 | **不可以** |
| **L2 社区** | 自动扫描 | 无 | **不可以** |

**核心约束：第三方插件必须纯声明式。**

插件能声明工具、能读你的数据。一旦允许代码，就等于允许任意代码执行——供应链风险不可接受，审核成本也会高到无法运营。

纯声明式的表达力上限 = 内置工具 + schema + 板块 + 提示词 + 预设。这够覆盖约 80% 的场景；不够的部分由第一方插件补齐。

## 3. 兼容性

三个版本维度会打架：**平台版本 × 插件版本 × Bundle 版本**。

- `requires.platform` 用 semver range 声明。
- `requires.plugins` 锁定插件版本区间。
- 安装时校验，不兼容则拒绝，并给出替代建议（「这个方案需要 novel@1.2，你装的是 2.0，已有一个兼容版本」）。

**不允许静默降级。** 版本不匹配就明说，别让用户跑到一半才发现板块缺字段。

## 4. 数据迁移（最容易被忽略）

用户装了一个带 schema 的插件，写了三个月，作者把字段 `desc` 改名成 `goal`——数据怎么办？

必须提供**声明式迁移**，不允许写代码：

```json
{
  "from": "1.1.0",
  "to": "2.0.0",
  "steps": [
    { "op": "renameField", "entity": "Character", "from": "desc", "to": "goal" },
    { "op": "setDefault",  "entity": "Character", "field": "flaw", "value": "" },
    { "op": "dropField",   "entity": "Character", "field": "legacy_note" }
  ]
}
```

允许的 `op`：`renameField` / `setDefault` / `dropField` / `splitEntity` / `mergeEntity`。

执行前强制生成快照，失败可回滚。**没有迁移声明的 major 升级，一律拒绝安装。**

## 5. 安装体验

市场解决的是「发现」问题，不解决「调试」问题。用户装完跑不通，负担并没有消失。

所以安装必须是一个向导：

```
预览结构（有哪些板块、Agent、示例）
  → 依赖检查（缺哪个插件 / 版本对不对）
  → 配置体检（lint：有没有语义冲突）
  → 试运行（用示例数据跑一次最小任务）
  → 选择：带示例 / 空白
  → 安装（失败自动回滚）
```

「试运行」这一步是关键——它把「装完才发现不对」提前到了安装时。

## 6. 冷启动：五个官方方案（v0.2 内置）

**v0.1 无 Bundle；v0.2 内置官方方案库 + 文件导入导出；v0.3 开社区提交。**

五个官方方案同时充当文档、测试用例和演示素材，内容只基于 pm / dev / novel，不依赖尚未实现的模块：

| # | 方案 | 验证什么 |
|---|---|---|
| 1 | 全栈功能迭代（dev 标准） | 多 Agent 分工 + 可执行验收 |
| 2 | 缺陷修复快车道（dev） | `relay` + 单实现者 + 回归测试 |
| 3 | 文档与测试补全（dev） | 低风险 `direct` 写入 + 知识库（规范文档） |
| 4 | 悬疑长篇小说（novel） | 结构化设定 + 多 Agent 评审 |
| 5 | 网文快节奏连载（novel） | `relay` + 高频产出 |

sales、内容运营、研究综述类方案等对应插件存在后再做。

## 7. 明确不做（v0.1–v0.2）

| 不做 | 原因 |
|---|---|
| 评分与评论 | 早期评论数少，反而拉低信任 |
| 付费与分账 | 需要支付、结算、税务，v0.4 再谈 |
| 代码插件 | 供应链风险 |
| 云端托管市场 | 先做「官方内置 + 文件导入导出」，与个人优先定位一致 |
| 自动更新 | 版本一变就可能坏数据，先手动 |

## 8. 与插件协议的关系

- 插件（`manifest`）定义**能力**：能做什么。
- Bundle 定义**配置**：怎么配、预置什么数据。
- 市场分发的是 Bundle，不是插件。

这条区分很重要：插件升级由平台管，Bundle 升级由作者管，两者节奏不同。
