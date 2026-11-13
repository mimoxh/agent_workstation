# 文档工作台（插件 `docs`）

**版本**：v0.1
**日期**：2026-11-13

---

## 0. 定位

写两类文档：跟着代码走的技术文档（README、API 参考、使用指南、架构说明、ADR、发布说明），和不绑代码的通用文档（方案、PRD、报告）。

三条边界：

- 一个项目最多一个文档台（manifest `singleton: true`，挂载时拦截），覆盖项目里全部开发台的仓库。
- 文档台不写仓库。入库一律交接成开发台的 `dev.issue`，走现有的 worktree、审查和合并流程。
- 引用由平台在写入时解析和校验，模型自报的出处不算数；正文是模型写的，按不可信内容渲染。

写稿是对话驱动的，没有任务类型和阶段：人说一句，主笔出一版，每版都是实体版本，可回滚。交接前过一道门禁（§5）。打开工作台默认进「文档」（板块声明 `config.home`），大群移到 `panel=_chat`。

## 1. 板块

| 板块 | 做什么 |
|---|---|
| 文档 | 文档列表；编辑 / 预览；右栏对话、评论、引用、核对结论、交接条件；请求核对、交给开发、导出 |
| 文档健康 | 过时文档、行号漂移、入库后被改、最近合并影响；自动起草开关；起草发布说明 |
| 风格指南 | 术语表、写作规范、lint 配置 |
| 知识库 | 复用平台板块 |

三个板块共用板块类型 `doc`，用 `config.view`（`studio` / `health` / `style`）分派，渲染器在 `apps/web/src/components/docs/`。

预览用 react-markdown + remark-gfm，不开 raw HTML；链接只放行 http(s)、mailto、`#` 和相对路径；图片渲染成链接，不自动加载。脚注标记 `[^id]` 渲染成可点的引用标签。

## 2. 成员

| Agent | 职责 |
|---|---|
| 主笔（steward） | 起草、改稿、处理评论、维护风格指南、起草发布说明 |
| 事实核对 | 只读，逐条核对引用和论断，用 `save_doc_review` 给结论 |
| 文字编辑 | 只读，看结构、清晰度和术语一致，只钉评论 |

都只在被 @ 时工作，界面按钮发一条 @ 消息，默认不自动花 token。三个 Agent 都不能交接，交接只能由人在界面上做。

## 3. 数据

没有新表，都是实体，`writeMode: direct`。

| 实体 | 内容 |
|---|---|
| `Doc` | `title`、`kind`、`brief`、`target_repo`（开发台 id）、`target_path`、`content`（markdown）、`citations`、`status`、`review`、`drift`、`handoff` |
| `DocComment` | `doc`、`version`、`heading`、`quote`（原文摘录，用来钉位置）、`body`、`severity`（`block` / `note`）、`status` |
| `StyleGuide` | 每台一份：`terms`（`{ term, preferred, avoid[] }`）、`rules`、`lint`（标题深度、句长、禁用词、必备章节） |

状态由平台维护，人和 Agent 都不能直接改：

`draft → reviewing → approved → handed_off → published`，过时转 `stale`。

- 正文或引用变了（内容哈希变了），一律回到 `draft`。
- 核对通过进 `approved`，不通过回 `draft`。
- 交接任务合并进 `published`；任务终止没合并，退回 `approved`（核对仍有效）或 `draft`。
- `approved` / `published` 的引用代码变了转 `stale`，出 `stale` 只能靠改稿或重新交接。

目标路径必须是仓库内相对路径：不能是绝对路径、不能带盘符、不能含 `..`、不能落在 `.git`、不能以 `-` 开头，300 字以内。

## 4. 引用

正文用脚注标记 `[^id]`，同一 id 登记在 `citations` 里：

- 仓库：输入 `{ id, kind: 'repo', repo?, path, ref?, lines: [起, 止] }`。平台解析出 `commit`、`blob`、`snippetHash`（`normalizeSnippet` 规整后取 sha256）和 `excerpt` 存下来。`ref` 默认目标分支，一次最多 200 行。
- 知识库：输入 `{ id, kind: 'knowledge', sourceId, quote }`。来源要对本项目可见，引文规整后要逐字落在某个片段里。

任何一条解析失败，整次写入失败（fail-closed）。lint 会报两种问题：正文用了没登记的标记（error），以及登记了但没用到的引用（warn）。

`read_repo_file` 带 `numbered: true` 时返回行号前缀，引用行号以它为准。

**内容哈希**：正文 + 按 id 排序的引用身份字段（仓库：`id / kind / repo / path / snippetHash`；知识库：`id / kind / sourceId / excerpt`）。commit、blob、行号不计入，所以把挪位的片段重新指向新行号不会让核对失效。

## 5. 核对与门禁

- 「请求核对」以人的身份 @事实核对，文档转 `reviewing`。核对结论用 `save_doc_review` 写入，必须带 `read_doc` 返回的 `contentHash`，读取后文档被改过就拒绝。
- 核对结论绑定内容哈希，不绑实体版本：平台改状态、写漂移记录都会升版本，但不影响核对。
- 交接门禁（`canHandoff`）：
  - 有核对结论，结论针对当前内容哈希，且通过；
  - 没有 lint error；
  - 没有未解决的 `block` 评论；
  - 设了目标仓库和目标路径。

  前三条不满足时，人可以勾选放行并写明理由，理由记进交接记录和会话。缺目标不能放行。

## 6. 交接与入库

「交给开发」做这几件事：

1. 先过门禁。目标开发台必须绑了仓库。记下目标分支当前的 `baseCommit`，以及目标文件的 `baseBlob`（文件不存在时为 null）。
2. 按引用处理方式渲染成品（`renderForRepo`）：
   - `strip`（默认）：去掉标记和脚注定义；
   - `footnotes`：保留标记，补上脚注定义。仓库引用写成 `` `path` 第 s–e 行 ``，跨仓库时加仓库名前缀；知识库引用写成 `《来源》：摘录`。
3. 成品冻结成 `doc_handoff` Artifact，在目标开发台建 `dev.issue`：`kind: chore`，`input.doc_artifact` 指向 Artifact，验收是「目标文件内容与交接版本一致」。
4. 文档转 `handed_off`，记 `doc_handed_off` 事件，在会话里留一条说明。

开发台的 architect、frontend-dev、backend-dev 用 `read_doc_handoff` 读成品，限任务或祖先任务声明过的交接件。目标文件在交接后被改过时，`changedSinceHandoff` 为真，同时带上当前内容，要求合并而不是覆盖；否则逐字写入。

合并对账（`reconcileDocHandoffs`）在合并后和每次仓库巡检时都跑，可以重复调用：

- 任务有 `merge_sha`：文档转 `published`，记下 `publishedCommit` 和 `publishedBlob`，后者是反向漂移的基线。
- 任务终止没合并：文档退回，交接记录标 `cancelled`。

不入库的文档可以导出（`GET /api/docs/:id/export?format=md|html|pdf`）：

- md 用 `renderForRepo` 渲染。
- html 在服务端用 unified 渲染，不放行 raw HTML。
- pdf 复用设计台的隔离 Chromium（`renderDesign`）；本机没装 Chromium 时报环境错误。

## 7. 漂移

`checkDocDrift` 跟仓库巡检（`repo_watch`）同节奏跑，不花 token。

**仓库引用**：对比引用仓库目标分支 HEAD 上的文件。

- 先比 blob：文件没了是 `deleted`，blob 没变就跳过。
- blob 变了，再用 `classifyCitationDrift` 分类：原位置片段哈希一致是 `unchanged`；同长度窗口在文件别处找到是 `moved`（附新行号）；都找不到是 `changed`。

**知识库引用**：来源没了，或者引文在片段里找不到，算 `changed`。

**只在结果变了时写回**：漂移记录（`Doc.drift`）只在结果变化时写回实体，避免每轮巡检都升版本。另有内存缓存：内容哈希和各仓库 HEAD 都没变时跳过；写回撞了版本就作废这条缓存，下一轮重算。

`approved` / `published` 的文档出现 `changed` / `deleted` 时：

- 文档转 `stale`，记 `doc_stale` 事件；
- 进收件箱（`docs_drift`）；
- 会话里列出受影响的引用。

同一批引用只提醒一次，有新的坏引用才再提醒。只有 `moved` 不改状态，在「文档健康」里一键「更新行号」，核对仍有效。

**反向漂移**：`published` 文档的落点文件在目标分支上被绕过平台改过（blob 不等于 `publishedBlob`），记为 `diverged` / `deleted`，每个新 blob 进一次收件箱。这种情况不改状态，人可以选：

- 「忽略」：记下 `acknowledgedBlob`，同一 blob 不再提醒。
- 「导回为新版本」：把仓库里的现文存成新的草稿版本。`strip` 方式交接的文档导回后没有引用标记，对应的引用会被丢掉。

## 8. 从合并起草

开发任务合并时，`noteMergeImpact` 用 `merge_sha^1..merge_sha` 的文件列表找受影响的文档：有仓库引用指向这些文件，或者目标路径在其中。这次合并本身就是某篇文档的交接任务时，不算那篇文档。

找到后记一条 `doc_impact` 事件，在文档台会话留一条消息。消息的形式取决于工作台设置 `autoDraft`：

- `off`（默认）：平台状态消息，只列出可能受影响的文档。
- `affected`：以人的身份 @主笔，列出改动的文件和受影响的文档，要求每篇用 `edit_doc` 出新版本草稿，不交接。列表最多 30 个文件、10 篇文档。

「起草发布说明」按里程碑或日期区间收集项目里已合并的开发任务，最多 80 条，日期按合并时间算。收集到后 @主笔，要求起草一篇 `kind: release_notes` 的文档，按新增、改进、修复、其他分组；区间里没有已合并任务时直接报错。

## 9. 工具

| 工具 | 谁用 | 说明 |
|---|---|---|
| `list_docs` / `read_doc` | 三个 Agent | 清单 / 全文。全文带引用、内容哈希、未解决的评论、lint 和交接条件，可取历史版本，结果上限 120KB |
| `write_doc` / `edit_doc` | 主笔 | 整篇写入 / 原文替换加引用增删，都产生新版本，返回 lint 和解析后的引用 |
| `comment_doc` / `resolve_doc_comments` | 核对、编辑 / 主笔 | 钉评论 / 关闭评论 |
| `read_style_guide` / `update_style_guide` | 主笔、编辑 / 主笔 | 读 / 改风格指南 |
| `save_doc_review` | 事实核对 | 保存核对结论，必须带 `contentHash` |
| `list_repos` / `read_repo_file` / `search_repo` | 主笔、核对（测试台也用） | 本项目开发台仓库的只读访问。`repo` 参数选仓库，缺省按测试台的默认解析（`settings.sourceWorkstationId`，否则第一个开发台） |
| `read_doc_handoff` | 开发台 | 读任务上声明的文档交接件 |

## 10. 现状与缺口

- 只用脚本化 mock 跑过端到端，真实模型的冒烟（`smoke:model`）还没跑，本机没配 provider。
- 引用只到行范围，不理解符号；函数改名、整体搬到别的文件会被判成 `changed` / `deleted`。
- 跨片段边界的知识库引文会解析失败，只能引一个片段之内的原文。
- 影响分析每次扫一遍全部文档的引用，文档量大了再加索引表。
- 没做 docs 站点构建（如 VitePress）的预览，只有 markdown 预览和导出。
