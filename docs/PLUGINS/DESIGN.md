# 前端设计工作台（插件 `design`）

**版本**：v0.1
**日期**：2026-11-08

---

## 0. 定位

用对话产出可交互的前端设计稿，人在画布上直接看、圈、改，定稿后交给开发台实现。

对话是主要的工作方式，所以这个台没有任务类型和阶段：人说一句，设计师出一版。打开工作台默认进画布（板块声明 `config.home`），大群移到 `panel=_chat`。

## 1. 成员

| Agent | 职责 |
|---|---|
| 设计师（steward） | 出稿、改稿、处理评论、维护设计系统 |
| 设计评审 | 只读，把意见钉在元素上；被 @ 时工作 |

## 2. 数据

没有新表，都是普通实体，自带版本和回滚，`writeMode: direct`。

| 实体 | 内容 |
|---|---|
| `Design` | `html`、`brief`、`group` / `direction`（方案组）、`tweaks`（旋钮）、`status`、`handoff` |
| `DesignComment` | 锚定的 `selector` + `anchor`、`body`、`status` |
| `DesignSystem` | `tokens`（CSS 变量）、`guidelines`。每台一份；没保存过时用默认令牌 |

## 3. 渲染与安全

稿子是模型写的代码，按不可信处理：

- `<iframe sandbox="allow-scripts">`，不给 `allow-same-origin`，拿不到平台的接口和 cookie。
- 注入 CSP（`DESIGN_CSP`）：断网，禁表单提交，外部资源只放行字体、图片和四个常见 CDN。
- 外层只接受 `parseFrameEvent` 校验过的消息，内容一律当纯文本。

文档由 `composeDesignDoc` 拼出：令牌写 `:root`，稿子可以覆盖；旋钮写 `:root:root`，总是生效。预览额外注入检查脚本，导出和交接不带。

检查脚本的浮层挂在 `<html>` 下、脚本和样式放 `<head>`，所以 `body` 内的 `nth-child` 选择器在预览和稿子原文里一致。评论钉和就地改字都依赖这一点。

## 4. 工具

| 工具 | 说明 |
|---|---|
| `list_designs` / `read_design` | 清单 / 全文（可取历史版本）。`read_design` 的结果上限放宽到 120KB |
| `write_design` / `edit_design` | 整份写入 / 原文替换，都产生新版本；返回 `lintDesign` 的警告 |
| `read_design_system` / `update_design_system` | 读 / 增改删令牌 |
| `comment_design` / `resolve_design_comments` | 钉评论 / 关闭评论 |
| `read_design_handoff` | dev 台用，读任务（或祖先任务）上声明的交接件 |

写稿的 Agent 单次输出上限设为 `AW_LARGE_OUTPUT_TOKENS`（默认 16000，0 表示不设）。

## 5. 交接

工作台之间不共享实体（PLUGIN-SPEC §13）。`交给开发` 把当前版本冻结成 `design_handoff` Artifact，在同项目的 dev 台起草一个 `dev.issue`，`input.design_artifact` 指向它，由人确认后派发。之后继续改稿不影响已交接的快照。

## 6. 还没做

- 导出只有 HTML，没有 PNG / PDF。
- 模型看不到渲染结果，只有静态自检和人的反馈。
- 从代码库提取只读 CSS 变量，不理解组件。
