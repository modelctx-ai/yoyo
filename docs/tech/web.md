---
type: Guide
title: 管理页
description: 常驻进程在本机开的网页，也就是工作台：和 yoyo 聊、看状态和对话，管记忆、日程和联系人，改配置。接口、安全边界、改配置和热加载、页面怎么做、怎么打开。
resource: src/web/server.ts
tags: [web, runtime, security]
status: stable
sources:
  - id: server
    resource: src/web/server.ts
    title: 管理页服务
  - id: api
    resource: src/web/api.ts
    title: 管理页接口
  - id: page
    resource: src/web/page.ts
    title: 页面
  - id: container
    resource: src/app/container.ts
    title: 组装根
  - id: daemon
    resource: src/runtime/daemon.ts
    title: 常驻循环
  - id: commands
    resource: src/cli/commands.ts
    title: 领域表
  - id: settings
    resource: src/web/settings.ts
    title: 改配置
  - id: supervisor
    resource: src/app/supervisor.ts
    title: 换配置
  - id: harness
    resource: src/brain/harness.ts
    title: 取文字增量
---

# 做什么

主人在命令行里能看的、能改的，管理页都给一份网页，长成一个聊天工作台（布局和后面的打算见[工作台](workbench.md)）：主聊天（最近的对话，能打字和 yoyo 聊，回复边写边显示，往上滚接着加载更早的）、状态（桌宠连没连上、模型、右键对话、记忆、下一句碎碎念、在忙什么）、心迹（画像能改，事实能忘，规矩能退役）、日程和联系人（加、删）、行为轨迹。还有「说一句」「听一句」，和右键菜单一样交给收件箱。

除了打字聊天（和右键对话同一个 agent，见[工作台](workbench.md#已经有的)），只做命令行也能做的事，用的是同一套函数：加日程是 `addSchedule`，忘掉事实是 `facts.forget`，退役规矩是 `procedures.retire`，派子任务是 `createAgentTask`，都照旧记一笔行为记录。不改配置，也不碰模型和 MCP。[^api]

# 在哪跑

常驻进程启动时由组装根开，只开一次，关闭应用时一起关；`web.enabled` 关掉就不开。它和编排器在同一个进程，直接读编排器的排期（下一句碎碎念、这一次间隔是怎么定的、最近一次说话）。记忆没打开时库里也可能有以前记的，管理页照样打开记忆库，能看、能删。[^container] [^daemon]

* 只听 `127.0.0.1`，端口缺省随机（`web.port` 可以固定）。日志记一行地址，不带令牌。
* 打开的地址是 `http://127.0.0.1:<端口>/#token=<令牌>`，记进 kv 的 `web-url`。
* 右键「管理」（`web.enabled` 打开时才挂）由常驻进程用 `UrlOpener` 打开这个地址；命令行的 `yoyo web open` 在常驻进程活着时读 kv 打开，并把地址打印出来，`yoyo web url` 只打印，没开着时报错。从 yoyo.app 里跑时（`YOYO_APP`）两处都改成打开 app：app 的外壳用 `yoyo web url` 取地址，放在自己的窗口里，见[发版](release.md#app-外壳)。[^commands]

# 安全

防的是本机浏览器里别的网页来读写，和局域网里的人。不防本机能读 `~/.yoyo` 的程序：它本来就能直接开库。[^server]

| 检查 | 挡什么 |
| --- | --- |
| 只听 `127.0.0.1` | 局域网 |
| Host 只认 `127.0.0.1:<端口>`、`localhost:<端口>`，别的 403 | DNS rebinding |
| 带 Origin 的只认自己这两个，`Sec-Fetch-Site: cross-site` 一律 403 | 别的网页跨站请求 |
| `/api/` 都要 `Authorization: Bearer <令牌>`，常数时间比较；令牌每次启动新生成 | 没打开过页面的人 |
| 写操作只收 `application/json`，正文最多 64 KiB（流式聊天的 `POST` 也是） | 表单跨站提交 |
| 页面带 CSP：脚本和样式只认这次响应的 nonce，`connect-src 'self'`，`frame-ancestors 'none'`；`no-store`、`nosniff`、`no-referrer` | 注入、被嵌进别的页面、令牌随 Referer 带出去 |

令牌放在地址的片段（`#` 后面）里：浏览器不把它发给服务器，也就不进任何日志。页面脚本读出来存进 sessionStorage，再用 `history.replaceState` 从地址栏抹掉。页面本身谁都能取，里面没有数据；没有令牌时只显示一句「从右键「管理」或 `yoyo web open` 打开」。

# 接口

都是 JSON。出错回 `{ "error": "一句中文" }`：主人填错的回 400（文案和命令行一样，例如「时间要写成 HH:MM」），找不到的 404，没想到的 500 并在日志里记一行。[^api]

| 接口 | 做什么 |
| --- | --- |
| `GET /api/status` | 舞台、宠物 id、桌宠连没连上和工作状态（经 `workStatus`，控制台舞台是 null）、模型名和是否给工具（不含密钥）、记忆开没开和事实条数、右键对话接没接上（kv 里有没有 `channel-base`）、MCP 服务器名、下一句碎碎念、`lastPace`（这一次间隔是怎么定的：`source` 是 `fixed`、`decided`、`fallback`，加隔多少秒 `sec`、挑的档 `option` 和把握 `confidence`，或退回的原因 `reason`，再加一句短说明 `note`；还没说过是 null）、最近一次说话、日程和联系人条数、等批准的个数（`approvals`）、是不是在 yoyo.app 的窗口里（`app`）、能不能在访达里显示（`reveal`） |
| `GET /api/context?limit=&before=` | 上下文的一页，按 `(at, seq)` 排好；消息按角色，碎碎念、摘要单列，消息带来源 `via`（`dsh-pet` 是桌宠右键对话，`workbench` 是工作台，没有是语音）；子任务写回来的那条是 `kind: 'task'`，带编号 `task` 和状态 `state`；批准请求有了结论写回来的是 `kind: 'approval'`，带编号 `approval` 和状态 `state`。每条带日志序号 `seq`。缺省 40 条，最多 200。不给 `before` 是最新的一页；往前翻给 `before=<at>:<seq>`（已经拿到的最早那条的 `at` 和 `seq`），回排在它前面的一页，返回的不满 `limit` 条就是到头了。写错回 400 |
| `GET /api/agents` | 子 agent 的类型：`[{ name, description }]`（名字、什么时候用），内置的加上 `~/.yoyo/agents/*.md`；子任务没打开（`tasks.enabled` 关着）是空的 |
| `GET /api/tasks` | 最近 50 个子任务：编号、标题、状态（`queued`、`running`、`waiting` 等回答、`done`、`failed`、`cancelled`）、谁派的、时间、todo 进度 |
| `POST /api/tasks` | 派一个子任务：`{ title, goal, criteria, agent }`。`criteria` 是字符串数组（给整段文字就按行拆），`agent` 不写是 `general`。规则和类型校验同主线程的 `task_create`（`createAgentTask`，标题最多 60 字、目标最多 4000 字、验收标准最多 8 条、类型要在 `GET /api/agents` 里），来源记 `web`、行为记录记 `task-add`；回这个子任务的概要（状态 `queued`，常驻进程下一拍起来做）。填错的回 400（文案和命令行一样），子任务没打开回 409 |
| `GET /api/tasks/:id/events` | SSE：一个子任务的过程，详情页用它代替轮询。见下面的「流式回复」。没有这个子任务回 404 |
| `GET /api/tasks/:id` | 一个子任务的全部，加上 `progress` 和最近 300 步过程（`steps`：收到、说、调用、结果）。等回答的带着 `question`、`askedAt`，答过的带 `answer`、`answeredAt`；带着它要批准的事 `approvals`（概要，同 `GET /api/approvals`）。没有回 404 |
| `POST /api/tasks/:id/answer` | 回答在等回答的子任务：`{ answer }`，去掉首尾空白，最多 2000 字；回这个子任务的概要（状态回到 `queued`），排队接着做；记 `task-answer`。没给 `answer` 回 400，不在等回答的、回答是空的、没有这个子任务回 409；在等批准的子任务也回 409（不收一句话回答，要批准或拒绝）|
| `POST /api/tasks/:id/cancel` | 取消（排队、在做、等回答的都行）；已经结束的回 409 |
| `GET /api/approvals` | 要批准的事：等批准的全列（新的在前），再带最近 40 条批过、拒绝、过期的。每项：编号、工具、摘要、子任务（主线程要的是 `null`）、状态（`pending`、`approved`、`denied`、`expired`）、时间、原因 `note`、做完了没有 `done`；**不带完整参数和结果**（写的内容可以有几 MB），展开时另取 |
| `GET /api/approvals/:id` | 一条的全部：加上完整参数 `input`（写的内容、改的原文和新文、命令）和做完以后的结果 `result`。没有回 404 |
| `POST /api/approvals/:id/approve` | 批准：只对等批准的有效，回这条的概要；常驻进程马上照做一次（`onApproved`），结果写回主会话或交给等批准的子任务；记 `approval-approve`（`via: web`）。没有回 404，已经批过、拒绝过、过期了回 409 |
| `POST /api/approvals/:id/deny` | 拒绝：同上，不做；记 `approval-deny` |
| `GET /api/artifacts?task=` | 交付物，新的在前，带 `view`（`text`、`image`、`file`：工作台直接看还是只给下载）；不给 `task` 列最近的 |
| `GET /api/artifacts/:id` | 原文，不是 JSON：对的 `content-type`（文本带 `charset=utf-8`），能看的 `inline`、别的 `attachment`，文件名按 RFC 5987 写；带 `content-security-policy: sandbox; default-src 'none'`，就算直接打开也不在本页的源里跑。要令牌，所以页面用 `fetch` 取成 Blob 再预览、下载 |
| `DELETE /api/artifacts/:id` | 删一个交付物，文件和记录一起删；记 `artifact-remove` |
| `POST /api/artifacts/:id/reveal` | 在访达里选中这个文件（`open -R`）。只有 macOS 上有，别处回 503 |
| `POST /api/chat` | 工作台聊一句：`{ text }`，去掉首尾空白，最多 4000 字；回 `{ reply }`。问答记进日志、记 `chat-workbench`。常驻进程外回 503，没回上来回 502 和原因 |
| `POST /api/chat/stream` | 同上，但回 SSE，边写边给，见下面的「流式回复」。空的、太长的、不在常驻进程里的，开流之前就回上面那样的 JSON 错误 |
| `GET /api/activity?limit=&types=&before=` | 做过的事，缺省 50 条，最多 500。`types=a,b` 只看这几种，`before=<ISO 时间>` 只看那以前的（条数在筛过的里面数）：对话里穿插的小卡片用它按时间段取 |
| `GET /api/memory` | 画像、仍然成立的事实（按开始成立的时间）、没退役的规矩 |
| `PUT /api/memory/core` | 改画像：`{ text }`，去掉首尾空白，最多 4000 字；记 `memory-core-edit` |
| `DELETE /api/memory/facts/:id` | 真删除一条事实；记 `memory-forget` |
| `DELETE /api/memory/rules/:id` | 规矩退役；记 `memory-retire` |
| `GET`、`POST /api/alarms`，`DELETE /api/alarms/:id` | 日程：列、加、删；删记 `schedule-remove` |
| `GET`、`POST /api/contacts`，`DELETE /api/contacts/:id` | 联系人：列、加、删；删记 `contact-remove` |
| `POST /api/actions/whisper`、`/listen` | 写进收件箱，下一拍做 |
| `GET /api/config` | 打过码的整份原文、各开关的值、指纹、文件路径 |
| `PUT /api/config` | 存整份：`{ text, version }` |
| `PATCH /api/config` | 只改开关：`{ switches: { "weather.enabled": false } }` |

# 流式回复

`POST /api/chat/stream` 和 `GET /api/tasks/:id/events` 回 SSE（`text/event-stream`）。认证、Host、Origin、只收 JSON、`no-store`、`nosniff` 和别的接口一样，在开流之前就查完，查不过回普通的 JSON 错误；开了以后每个事件是 `event: <名字>` 加一行 `data: <JSON>`，空行结束，另有 15 秒一次的注释行当心跳。浏览器用 `fetch` 读流：`EventSource` 带不了 `Authorization` 头，令牌又不能放进地址。[^server]

聊天的事件：

| 事件 | 数据 | 什么时候 |
| --- | --- | --- |
| `delta` | `{ text }` | 模型吐了一小段（原文，开头结尾的空白还在，几步的文字都会来） |
| `done` | `{ reply }` | 回完了。`reply` 就是 `talk` 的返回值，去了首尾空白，和记进日志的、`POST /api/chat` 交回的是同一份；页面用它换掉气泡里增量拼出来的 |
| `error` | `{ error }` | 没回上来，一句中文；不会再有 `done`，问答也没有记进日志 |

增量是从编排器和 harness 之间拿的：编排器只调 `run`，yoyo 在交给它的 harness 外面包一层（`tapDeltas`），这一轮由 `talk` 自己定编号、登记以后，包的那层对它改调 harness 的 `stream`，把 `text.delta` 交出来，`run.ended` 的结果当这一轮的返回；没登记的轮不变。工作台聊天的回复不经 `parseWhisper`（气泡装得下多句，不按念的那一句截），所以 `done` 和日志一致靠的是同一个返回值，不是再解析一遍。浏览器断开不会中止这一轮：它照样跑完、记进日志，刷新就看得到。[^harness]

子任务过程的事件：`task` 是整份详情加交付物（`{ task, artifacts }`，`task` 和 `GET /api/tasks/:id` 一样），一开头先推一份，之后有变化才推；子任务结束（做完、没做成、取消）推完最后一份再推 `end`，服务端关流。没有现成的通知能订，服务端每 1 秒（`pollMs`）看一眼：任务的更新时间、它的会话多没多一条、批准请求的状态、交付物多没多，任何一样变了就推。页面连着时不再自己轮询，断了或没连上就退回每 4 秒轮询，轮询那一拍发现没连着会重连。

# 改配置

「设置」页签：常用的开关直接点，整份 `config.json` 也能改。写进文件就完了，换上新配置是常驻进程自己的事（见下一节）。[^settings]

* 读：整份原文，名字像密钥的键（`apiKey`、`token`、`secret`、`password`、`Authorization` 之类，`mcpServers` 的 `env`、`headers` 里的也算）非空的值换成 `••••••`；还有各开关按缺省值补齐后的值，和文件内容的指纹。
* 存整份：交回来的还是 `••••••` 的，换回同一位置原来的值；原来那里没有就不存，免得把码当成密钥写进去。指纹对不上（开关刚点过、编辑器里改过）回 409，页面换成最新的，刚才的改动要重新改。
* 只改开关：只认开关表里那几个、只收 `true` / `false`，别的原样留着。`web.enabled` 不在里面：关掉它管理页就没了。开关改完，框里的整份没动过就跟着刷新。
* 写之前和常驻进程启动时一样检查（`parseConfig`、`assertDirectorReady`），不过就回 400，文件一个字不改。先写临时文件再改名，权限照旧。记 `config-edit` 或 `config-switch`。

# 热加载

常驻时外层是 `supervise`：组装应用、跑常驻循环，同时每秒 `stat` 一次 `config.json`（编辑器另存再改名、管理页的原子写入都认得出）。[^supervisor]

* 内容变了、读得出来、过了 `assertDirectorReady`，而且按缺省值补齐以后真的不一样（只改空白不算），才换：中止这一代的常驻循环（它关掉应用：等正在跑的一轮、关按键助手、管理页、MCP、对话渠道），按新配置再组装一份、再跑。
* 改坏了只记一行「config.json 改得不对，先接着用现在的：…」，同一个问题只记一次。
* 读得出来、按它却组装不起来（建应用时抛错）：记一行「按新的 config.json 组装不起来，先接着用原来的：…」，退回上一份，等文件再改才换，同一份不反复试。
* 新的一代一开始先对一次文件：上一份换下来的那一两秒里又存了一次，也不会漏。
* 从上一份接过来的（`Resume`）：碎碎念的排期，不然一换就马上说一句；管理页的端口和令牌，开着的页面接着能用。端口被占了就随机挑一个，令牌照旧。配置里固定了 `web.port` 就用配置的。
* 桌宠的右键菜单是桌宠开的时候读的（`YOYO_PET_MENU`），`pet.menu` 改了要重开桌宠。对话渠道换了端口和令牌，新的一份会重新绑定桌宠。
* 按键助手以前起了就不管，换配置时会越起越多；现在由应用记着，关应用时停掉，退出 yoyo 时也不再留下。
* `--once`、`--bake` 和命令行不盯文件，每次都读最新的。

# 页面

一个 HTML，样式和脚本内联，放在 `page.ts` 的模板字符串里：不用构建，`pnpm pack:app` 时跟着进单文件。脚本是不用框架的原生 JS，数据一律用 `textContent` 放进页面，不拼 HTML；回复里只认 `**加粗**`，拆成文字和 `strong` 节点。图标是内联的线条 SVG；聊天的回复和子任务的过程用 `fetch` 读流，一个事件一个事件地拆；往上翻的消息、小卡片都并进已加载的，重画时按高度差补回滚动位置；yoyo 的头像是 `assets/icon.png` 缩成 96×96 的 WebP，内联成 data URI（`src/web/avatar.ts`，CSP 只许 `img-src 'self' data: blob:`，`blob:` 给交付物的图片预览）。跟随系统的浅色、深色。窄窗口先收起聊天列表，再把左边一列缩成图标。[^page]

改页面时注意：脚本放在模板字符串里，不能写反引号和 `${`；CSP 不许写 `style` 属性，样式都放样式表，脚本要改样式就改 class 或 `node.style`。

# 还没做

* 设置页上只有开关是表单，别的要在整份配置里改 JSON。
* 联系人、日程的编辑（现在只能删了重加），日程的暂停。
* 记忆的「事实的来龙去脉」（命令行的 `memory history`）、笔记和整理。

[^server]: 管理页服务
[^api]: 管理页接口
[^page]: 页面
[^container]: 组装根
[^daemon]: 常驻循环
[^commands]: 领域表
[^settings]: 改配置
[^supervisor]: 换配置
[^harness]: 取文字增量
