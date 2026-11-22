# 视频工作台（插件 `video`）

**版本**：v0.4
**日期**：2026-11-22

---

用对话做讲解视频：编导写讲解稿、拆分镜，动画师用 HTML/CSS 给每个镜头做画面，审片逐镜头把关，平台配音、逐帧渲染成 mp4。镜头也可以用现成的图片 / 片段，或经人批准后调用视频生成服务生成片段。每个项目一个（manifest `singleton`），版本 0.4.0。成员：编导 `video-director`、动画师 `motion-designer`、审片 `video-reviewer`、素材制作 `asset-producer`。

## 板块

| 板块 | 内容 |
|---|---|
| 工作室 `studio` | 视频列表 → 讲解稿 / 分镜 / 预览；顶栏「请求审片」「生成配音」「出片」；右栏「对话 / 评论 / 审片」三个页签 |
| 成片 `renders` | 每次出片一条：进度、实时日志（`/api/live/video:<id>`）、播放、下载 mp4 / srt、取消、失败原因、警告（含画面问题）、出片快照 |
| 素材 `assets` | 本台素材库：上传、筛选、预览、元数据、引用情况；片段申请列表（等审批 / 生成中 / 成功 / 失败） |
| 风格 `style` | 本台一份 `VideoStyle`：调色板、字体、默认配音（可试听）、背景音乐（上传 / 音量 / 说话时压低）、字幕样式、风格规则；右侧实时预览 |

## 镜头画面

画面是模型写的代码，按不可信处理：只经 `composeShotDoc` 合成（断网 CSP + 虚拟时钟 + 本台风格的 CSS 变量），前端在 `sandbox="allow-scripts"` 的 iframe 里播，postMessage 过 `parsePlayerEvent`（`ready / time / issue / pick`）；服务端（`runtime/video_frame.ts`）用 Chromium 逐帧推时钟后截图，和预览是同一份文档。

- 风格变量：`--aw-bg / --aw-fg / --aw-accent / --aw-muted`（及自定义颜色 `--aw-<名>`）、`--aw-font-heading / --aw-font-body`；`html` 默认铺底色、字色、正文字体。没保存过风格的台不注入。颜色 / 字体值走白名单（`lookError`），挡住 `; { } url(`。
- 画面问题（文字超出画面、脚本报错、外部资源被拦）：预览播放器收到 `issue` 就 `POST /api/shots/:id/issues`；出片在每个镜头 25% / 50% / 最后一帧抽查；`view_shot` 也会记。都落到 `Shot.issues`（按镜头版本，版本变了自动失效），分镜卡片显示「画面问题 N」，出片 warnings 带上「镜头 N「标题」：…」，审片 `read_video` 能看到。
- 圈选：评论时「圈选元素」给 iframe 发 `pick`，点中的元素回传结构化选择器（`body > div:nth-child(2) …`，`isShotSelector` 校验）和文字；打开评论时发 `mark` 高亮。叠层颜色取 index.css 令牌的计算值。

## 时间线与时长

预览、分镜、视频总长和成片用同一条时间线（`timeline` → `renderTimeline`，按视频帧率对齐）：淡入 / 滑入与上一镜头交叠，交叠 = min(0.5 秒, 前一镜头一半, 本镜头一半)，向下取到整帧；硬切不交叠。总长 = 各镜头时长之和 − 各交叠。播放器在交叠期间叠两层 iframe：淡入调上层透明度，滑入两层一起平移（对应 ffmpeg `xfade` 的 `fade` / `slideleft`），下一个镜头提前 1 秒装进隐藏层；每层自己的配音跟着主时钟走（和成片 `adelay` + `amix` 一样可以重叠）。



镜头生效时长按优先级取（`shotTiming`）：

1. 人 / Agent 设定的 `duration`；
2. 新鲜配音的实测时长 + 0.3 秒气口，向上取到 0.1 秒（最多 120 秒）；
3. 按旁白估算（中文每秒 4.5 字、英文每秒 2.6 词，至少 2 秒）。

配音「新鲜」= 合成时的旁白（规整空白后）、provider、音色、语速都没变（`textHash`）；改了任何一项就过期，lint 报 `audio_stale`，出片不带这段声音。设定时长短于配音时报 `audio_too_long`，成片里配音被截断。

## 配音

- provider 在设置页「媒体」里配（OpenAI 兼容 `/audio/speech`，可「试听」），或用环境变量 `AW_TTS_BASE_URL / AW_TTS_API_KEY / AW_TTS_MODEL / AW_TTS_VOICE / AW_TTS_FORMAT / AW_TTS_PRICE`（同名时环境变量优先）。`AW_ENABLE_MOCK=1` 或测试时有一个本地 mock（正弦音 WAV，时长按念的速度）。冒烟：`pnpm --filter @aw/server smoke:media`。
- 选择顺序：视频自己的配音设置 → 本台风格的 `voice` → 设置里的默认 → 环境变量 → 第一个真实 provider → mock。`voice.off = true` 表示不配音：门禁不查配音，成片不铺旁白。
- 风格面板「试听」：`POST /api/workstations/:id/video-style/voice-test`，按当前表单合成一句样例，不记花费。
- `POST /api/videos/:id/voice { shotIds?, force? }` 或工具 `voice_shots`：没旁白的、配音新鲜的跳过；超长旁白按句切成 ≤3000 字分段合成再拼接；请求 60 秒超时、重试 2 次。
- 花费：每合成一段先查三级预算（用完 409，停在当前镜头），再记一条 `trigger=media`、0 token 的 run，挂在发起的 Agent 名下（人发起记本台 steward），所以预算和项目账本不用另开统计。单价是「美元 / 百万字符」。
- 密钥加密存在本地，接口只回 `hasKey`，错误信息经 `sanitizeError`。

## 审片、状态与内容哈希

- 内容哈希 `contentHash` = sha256(`videoHashInput`)：尺寸 / 帧率 / 字幕模式 / 是否配音，风格键（CSS 变量、字幕样式、背景音乐 id / 音量 / 压低），按顺序每个镜头的 id、规整后的旁白、画面类型、画面原文（缺画面时是占位文档；素材镜头是素材 id + 运动 + 保留原声 + 叠加层原文）、生效时长、转场、新鲜配音的 `textHash`。讲解稿、标题、备注、评论、画面问题、状态字段不进哈希。
- 状态只由平台推（`deriveVideoStatus`，每次写视频 / 镜头 / 风格 / 配音后 `refreshVideoStatus`）：没镜头 `draft`；审片 pass 且哈希没变 `approved`，出片时的哈希（`renderHash`）也对得上 `rendered`；请求审片后哈希没变 `reviewing`；其余 `storyboarded`。内容一改，审片结论和「已出片」自动作废。
- 请求审片：`POST /api/videos/:id/request-review { note? }` 记下 `reviewRequestHash`、状态拨到审片中，以人的身份在大群 @审片。审片 `read_video` 拿哈希 → `view_shot` 看画面 → `comment_shot` 钉问题 → `save_video_review { contentHash, verdict, summary }`；哈希对不上回 409（读完后有人改过，要重读再审）。

## 评论

`ShotComment` 钉在镜头版本和镜头内时间点上：`{ shot, version, time, selector?, anchor?, body, severity: block | note, status }`。人在右栏「评论」里「在当前时刻留评论」（取播放器的镜头和镜头内时间，可圈选元素），Agent 用 `comment_shot`；解决用 `POST /api/workstations/:id/video-comments/resolve` 或 `resolve_shot_comments`。点评论跳到预览里那个镜头和时间并高亮元素；进度条上有评论标记。删镜头连同它的评论一起删。

## 出片门禁

`evaluateRenderGate` 四项：审片通过且内容没再改、检查没有 error、阻断评论都已解决、有旁白的镜头都有新鲜配音（不配音时跳过）。`GET /api/videos/:id` 的 `gate` 给出逐项结果，出片对话框和右栏「审片」页签都显示。

- 门禁没过时 Agent 出片一律 409（`Agent 不能越过门禁`），没有越过的口子；
- 人出片要勾「人工越过门禁」并填原因（`override`），原因、没通过的项、人和时间写进出片快照的 `override`，记 `video_render_override` 事件，并以平台身份在大群发一条状态消息；
- lint error 不能越过，先修。

## 出片

`POST /api/videos/:id/renders { fps?, subtitles?, allowPlaceholders?, override? }` 或工具 `render_video`（只排队，立刻返回 id；进度用 `read_render`）。

- 检查：lint error 回 400（缺画面在 `allowPlaceholders` 时降为 warn，用占位画面顶上）；帧率只能 24 / 25 / 30 / 60；最高 1080p、全片最长 10 分钟；没有 ffmpeg / Chromium 或预算用完回 409；同一支视频同时只能有一次出片在跑。
- 快照：创建时把每个镜头的版本、帧对齐后的时长、转场交叠、配音、字幕时间、内容哈希、风格、背景音乐、门禁结果和越过原因都写进 `video_render.settings_json`，之后改镜头不影响这次出片。
- 渲染：出片之间 p-queue 串行；一次出片内镜头并行，默认 min(3, CPU 数 / 4)，`AW_RENDER_CONCURRENCY` 可改（1–8）。所有镜头共用一个 Chromium，每个镜头一个独立上下文（断网路由 + 兜底强杀）。逐帧用 `__awFrame(t)` 同步推时钟 + CDP `Page.captureScreenshot`（JPEG q90、`optimizeForSpeed`），mjpeg 经 stdin 灌给 ffmpeg 编成无声 H.264 片段；每个会话首帧前先推到别的时刻空截一张，保证同一时刻逐字节一致（并行和串行产出的片段相同）。片段按「合成文档 + 尺寸 + 帧率 + 帧数 + 烧进去的字幕 + 编码参数（素材镜头再加素材产物 id / 文件大小 / 修改时间 / 运动 / 保留原声）」哈希缓存在 `media/cache/`，抽查到的画面问题存在同名 `.json`，复用片段时一起带回。最后一步 concat / xfade 拼画面，配音按各镜头成片起点 `adelay` 铺到静音底轨上 `amix`，AAC 192k / 48kHz，`+faststart`。
- 背景音乐：`-stream_loop -1` 循环铺满，`atrim` 到全片长、`volume`、首尾各 1 秒 `afade`；开了「说话时压低」且有配音时，旁白 `asplit` 一路做侧链 `sidechaincompress=threshold=0.01:ratio=10:attack=20:release=400` 压背景音乐，再和旁白 `amix`（`normalize=0`）。背景音乐文件不见了只出警告、不铺。
- 速度（16 核、720p30、3 镜头 9.4 秒、配音 + 烧字幕）：串行 PNG 截图 20.5 秒（约 2.2 倍实时）；并行 + JPEG 快截冷渲染 7.2 秒（约 0.77 倍实时，含拉起 Chromium），片段全部命中缓存时 1.3 秒。0.4.0 复测：并行冷渲染 7.0 秒、全部命中缓存 1.1 秒、`AW_RENDER_CONCURRENCY=1` 单路冷渲染 13.8 秒。
- 进度：片段帧数占 85%，拼接按 ffmpeg `-progress` 占 15%；最多每 500ms 写库并发 `video_render_progress`。事件：`video_render_queued / started / progress / finished / cancel`。
- 取消：`POST /api/video-renders/:id/cancel`，杀掉 Chromium 和 ffmpeg，删半成品。服务重启时排队中 / 渲染中的标失败（`recoverVideoRenders`）。
- 成功后存两个产物：`video_render`（mp4）和 `subtitle`（srt）；出片时的内容哈希就是审片通过的那个时，视频状态拨到「已出片」（越过门禁出的片不算）。

## 字幕

旁白按句切成字幕（`subtitleCues`），按念的时长分配镜头时间。

- `burn`（默认）：出片时在 Chromium 里把字幕挂进平台自己的 shadow root（镜头样式碰不到），和画面一起截帧；版式来自 `subtitleLayout`（风格里的字号 s / m / l、位置底部 / 顶部、底框 / 阴影 / 无），预览播放器用同一份样式，字体可用 `AW_SUBTITLE_FONT` 换。转场交叠期间上一镜头的字幕提前收掉。
- `srt`：不烧，mp4 里带一条 `mov_text` 字幕轨。
- `off`：都不要。

三种模式都会另存一份全片 `.srt`（时间按成片起点平移，截到下一镜头开始）。

## 素材

`Asset` 实体，每台一份素材库（「素材」板块：拖拽 / 点选上传、按类型筛选、预览、改名 / 授权 / 标签、删除；卡片显示来源「上传 / 生成」和被哪些镜头用着）。

- 上传：`POST /api/workstations/:id/assets`（multipart 字段 `file`，可带 `license` / `tags` / `notes`）。图片 png / jpeg / webp ≤ 20MB；视频 mp4 / webm / mov ≤ 200MB 且 ≤ 5 分钟；音频 mp3 / wav / m4a / ogg ≤ 30MB。文件头要和扩展名对得上，ffprobe 读出尺寸 / 时长才收；视频自动抽一帧做封面（`poster`，`image` 产物）。
- 读写：`GET /api/workstations/:id/assets?kind=`、`GET / PATCH / DELETE /api/assets/:id`；还有镜头在用的素材不能删（409，先换掉）。文件走 `GET /api/media/:artifactId`（产物类型白名单加了 `image` / `video`）。
- Agent 工具：`list_assets`、`read_asset`（只读）；上传只能人做。

## 素材镜头

`Shot.visual` 三种：`html`（模型写的画面）、`asset`（挑一件现成素材）、`generated`（生成的片段，成功后平台写入 `asset`）。后两种的额外字段：

- `asset`：素材 id（图片或视频）。缺了 lint 报 error `asset_empty`「缺素材」，出片前必须补（`allowPlaceholders` 时降为 warn，用占位画面）；片段申请等审批时报 warn `clip_request_pending`，上次失败报 warn `clip_request_failed`。
- `motion`：图片的推拉摇移 `none / zoom-in / zoom-out / pan-left / pan-right`（Ken Burns，幅度 10%）。预览用 CSS transform、成片用 ffmpeg `zoompan`，起止由 `video_media.ts` 同一份定义给出。视频素材等比缩放留黑边，短于镜头时长时冻最后一帧，长了按镜头时长截断。
- `keepAudio`：视频素材自带的声音要不要留（默认丢）。留的话按镜头成片起点铺进混音，和配音一起 `amix`。
- `html`：素材镜头上的 HTML 是一层**透明叠加画面**（标题条、标注），同样只经 `overlayDoc` → `composeShotDoc` 合成、在 sandbox iframe 里叠在原生 `<img>` / `<video>` 上播；成片在 Chromium 里透明底逐帧截 PNG（`alphaFrame`）再 ffmpeg `overlay` 上去，烧进去的字幕也走这层。

镜头编辑对话框里有「画面类型」切换、素材选择、运动、保留原声、叠加层 HTML 和「生成片段」表单；分镜卡片显示素材缩略图和「等审批 / 生成中 / 失败」标记。内容哈希里素材镜头取素材 id + 运动 + 保留原声 + 叠加层原文。

## 片段生成（必须人批）

- 申请：Agent 用 `generate_clip { shotId, prompt, duration?, negativePrompt?, image? }`，人在镜头编辑里点「生成片段」（`POST /api/videos/:id/clip-requests`）。都只创建一条 `ClipRequest`（`pending`）+ 一条收件箱 `clip_request`（提示词、时长、预估花费、provider），**绝不调用生成服务**。时长夹在 1–20 秒，不给用镜头生效时长；`image` 是首帧图片素材 id。
- 审批：只有人能批（Agent 调 `POST /api/clip-requests/:id/decide` 一律 409）。收件箱或 API `{ decision: approve | reject, reason? }`。批准前把预估花费加到三级预算上查一遍，会超就 409、申请保持 `pending`。拒绝在大群里 @ 申请方并带上原因。
- 生成：批准后平台立刻提交（`approved → running`），后台每 1.5 秒轮询一次（`pumpClips`，同一条申请不并发）。成功后下载到 `media/assets/`、ffprobe、登记为 `Asset`（来源 `generated`，带提示词和 provider）、接到镜头上（`visual: generated`），按实际秒数记一条 `trigger=media` 的花费（记在申请的 Agent 名下，人发起记 steward），并在大群 @ 申请方；失败把原因写进 `error` 并 @ 申请方。`read_clip_request` 查状态。
- 重启：`running` 的申请在启动时恢复。mock 的任务在内存里，丢了就退回 `approved` 重新提交（确定性、不花钱）；接真实厂商的标 `failed`（服务重启，生成中断），由人决定是否重新申请，避免重复扣费。
- 事件：`video_clip_requested / approved / rejected / submitted / succeeded / failed`。

### provider 与 mock

视频 provider 在设置页「媒体」里加（`kind: video`，价格「美元 / 秒」`price.perSecond`），「默认视频生成」选 `defaultVideo`。选择顺序：设置里的默认 → 第一个有适配器的。`AW_ENABLE_MOCK=1` 或测试时自动补一个 `mock`：用本机 ffmpeg `testsrc2` 合成和请求尺寸、时长完全一致的片子（渐变底 + 移动方块 + 提示词摘要），排队 250ms、生成 1.5 秒（`AW_MOCK_CLIP_MS` 可改生成耗时，0 表示立即完成）。

### 接一个真实厂商

适配层在 `apps/server/src/runtime/media/video_gen.ts`，平台只认这套接口：

```ts
interface VideoGenAdapter {
  protocol: MediaProtocol;                      // 和设置里 provider 的 protocol 对应
  submit(req: VideoGenRequest, ctx: GenCtx): Promise<{ jobId: string }>;
  poll(jobId: string, ctx: GenCtx): Promise<VideoJobStatus>;   // queued / running / succeeded / failed
  fetchResult(result: VideoResult, destPath: string, ctx: GenCtx): Promise<void>;
}
```

1. 在 `runtime/config.ts` 的 `MediaProtocol` 里加一个协议名（如 `acme-video`），设置页「视频生成」的协议下拉（`routes/_console.settings.tsx` 的 `VideoForm`）同步加上。
2. 写 adapter：`submit` 用 `ctx.provider` 的 `baseUrl / apiKey / model` 调厂商的创建接口，把 `prompt / negativePrompt / duration / aspect / resolution / image`（首帧是本地文件路径，需要的话自己上传或转 base64）映射过去，返回厂商的任务 id；`poll` 查任务状态，成功时把下载地址放在 `result.url`；`fetchResult` 把成片下载到 `destPath`（mp4）。请求都包在 `attempt()` 里（带超时、中止信号、网络错误 / 5xx 重试两次），错误文本过 `sanitizeError`，密钥不进日志和返回值。
3. 把它加进 `VIDEO_ADAPTERS`。别的都不用改：审批、预算、轮询、落库、记账、接镜头、重启恢复都是平台做的。
4. 厂商的计费口径如果不是按秒，把单价折算成 `price.perSecond`；实际花费按 ffprobe 读到的成片时长算。

## 出片对比

成片板块里每条成功出片有「和另一次对比」：选同一支视频的另一次成功出片，`GET /api/video-renders/compare?a=&b=` 返回设置差异（尺寸、帧率、字幕、总时长、风格、背景音乐、门禁、越过原因）和逐镜头状态（`same / changed / added / removed`，按出片快照里每个镜头的 `hash` 比，`hash` 和片段缓存键用同一份输入），以及每个镜头在两次成片里的起点和时长。界面上两段视频并排、一起播放 / 拖进度（总长相同时右边跟着左边对时），点镜头两边各跳到这个镜头在自己成片里的起点；改过的镜头高亮。

## 素材制作成员

`asset-producer`（素材制作）：`list_assets` 挑现成素材，`update_shot` 设 `visual: asset` / `motion` / `keepAudio`；没有合适的就 `generate_clip` 提申请，`read_clip_request` 跟进。提示词见 `prompts/asset-producer.md`：永远不假设申请会被批，只说「已提交申请，等人批」。编导也能用这两样工具；动画师和审片只能看素材。

## 媒体文件

放在数据库旁的 `media/`（`audio/` `bgm/` `assets/` `renders/` `cache/`），`AW_MEDIA_DIR` 可改，内存库用临时目录。背景音乐上传：`POST /api/workstations/:id/media`（multipart 字段 `file`），只收 mp3 / wav / m4a / ogg、30MB 以内，文件头要和扩展名对得上，ffprobe 读得出时长；`GET /api/workstations/:id/media` 列出。`GET /api/media/:artifactId`：只认 `audio / video_render / subtitle / image / video` 五类产物，路径必须在媒体目录里；支持单段 Range（206 / 416），`?download=1` 带下载文件名。

## 本机依赖

ffmpeg / ffprobe 在 PATH 上（或 `AW_FFMPEG` / `AW_FFPROBE`），Chromium 用 `pnpm exec playwright install chromium`。缺了出片回 409 并给出中文提示，测试里相关用例跳过。

## 现状与缺口

- 只用 mock 跑过：真实 TTS（`smoke:media`）和真实对话模型（`smoke:model`）都还没跑冒烟，本机没配 provider；mock 不看工具 schema。
- 视频生成只有 `mock` 适配器，设置页的协议下拉也只有 `mock`；mock 的任务在内存里，重启靠重新提交恢复。
- 预览播放器里「说话时压低背景音乐」只是近似，准确混音只在成片里。
- 渲染进度和日志在内存里，服务重启后丢失，中断的出片标失败。
- 出片对比没有「只看改过的镜头」筛选，改过的镜头用高亮标出。
- `drizzle/meta` 没有 `0013_snapshot.json`（加入视频台之前就缺）；`0014_snapshot.json` 是按当前 `schema.ts` 生成的完整快照，`drizzle-kit generate` 报「No schema changes」。
