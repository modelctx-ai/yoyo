---
type: Architecture
title: 记忆
description: yoyo 让桌宠记住主人的方式：记什么主题、哪些话进门控、画像和召回放在哪个 agent 里、夜里什么时候整理、主人怎么看和删。机制在 ctx，这里只写应用侧。
resource: src/runtime/orchestrator.ts
tags: [memory, ctx, runtime, privacy]
status: stable
sources:
  - id: orchestrator
    resource: src/runtime/orchestrator.ts
    title: 编排器
  - id: context
    resource: src/brain/context.ts
    title: 上下文接线
  - id: memory
    resource: src/brain/memory.ts
    title: 记忆接线
  - id: container
    resource: src/app/container.ts
    title: 组装根
  - id: agents
    resource: src/brain/agents.ts
    title: agent 配置
  - id: sources
    resource: src/brain/sources.ts
    title: 来源
  - id: config
    resource: src/app/config.ts
    title: 配置
  - id: commands
    resource: src/cli/commands.ts
    title: 命令表
---

# 边界

记忆的机制在 ctx：存储协议 `MemoryStore`、门控 / 召回 / 巩固 / 遗忘四个操作、决策和提取模型的协议和按配置实例化，见 ctx 仓库的 `docs/memory.md` 和 ADR 0006。本文只写 yoyo 要决定的事：

| yoyo 决定                        | ctx 提供                                   |
| -------------------------------- | ------------------------------------------ |
| 记哪些主题、什么算值得记         | `gate` 和它的四个问题                      |
| 哪些条目进门控、哪些不进         | `gate.entries` 选项                        |
| 画像和召回放进哪个 agent、放哪儿 | `memory.source()`、`AgentSpec.context`     |
| `recall` 工具给谁                | `Memory` 是执行环境，`tools()` 报出工具    |
| 夜里什么时候整理、整理多久       | `consolidate()`                            |
| 主人怎么看、改、删               | `facts.close` / `forget`、`core` 的历史    |
| 存在哪里、和什么共用             | `createSqliteMemoryStore({ database, prefix })` |

和上下文一样：yoyo 不碰记忆的存储结构和判断逻辑，只给配置、主题、节律和界面。接线都在 `src/brain/memory.ts`：`createYoyoMemory`（按 `config.memory` 调 `createMemory`）、`memorySources`（两个来源）、`memorySessions`（记忆读到的日志）、`createSystemOneModels`（决策、提取模型；按配置造 System One 模型的 `systemOneSpec`、`createSystemOne` 在 `system-one.ts`，碎碎念的间隔模型 `pace.decision` 也用它，但不借 `memory.decision`），组装根按 `memory.enabled` 才建。[^memory] [^container]

# 桌宠记什么

一只桌宠的记忆是关于主人的，不是关于世界的。主题表（`memory.topics`，给门控的 `choice` 用，可以在配置里改）：

| 主题      | 记什么                                                | 例子                                     |
| --------- | ----------------------------------------------------- | ---------------------------------------- |
| `owner`   | 主人的偏好、作息、称呼、不喜欢的话题                  | 「回答要短」「晚上十一点后别说话」       |
| `work`    | 手头的项目、工具链、最近在折腾什么                    | 「在写 agent-memory，用 SQLite」         |
| `people`  | 提到的人和关系                                        | 「小李是同事，负责前端」                 |
| `routine` | 日程习惯、常去的地方、天气要看哪里                    | 「周三下午开周会」「地点是台北」         |
| `taste`   | 喜欢的梗、表情包风格、觉得好笑的事                    | 「喜欢猫的表情包，不要狗」               |
| `fix`     | 主人纠正过 yoyo 的说法、不要再做的事                  | 「别叫我老板」「天气别报华氏度」         |

类别（`kind`）用 ctx 的缺省：`pref`、`obs`、`fail`、`ok`。`fix` 主题的话多半是 `fail`，是程序记忆的主要来源。

不记的：粘贴板内容（它是来源，不进日志，也就不进门控）、密钥、听写里没确认就取消的话（本来就不进日志）。

# 哪些话进门控

门控只看会话日志里的消息，不看事件。对 yoyo 来说：

| 条目                                           | 进不进 | 为什么                                           |
| ---------------------------------------------- | ------ | ------------------------------------------------ |
| 听写确认后的用户消息（`recordUser`）           | 进     | 主人亲口说的                                     |
| 右键对话并进来的用户消息（`source: dsh-pet`）  | 进     | 同上                                             |
| 回复（`recordLine`，`kind: reply`）            | 进     | 和用户话一起才成对话；工具结果里的错误是 `fail` 的线索 |
| 右键对话并进来的助手消息                       | 进     | 同上                                             |
| 碎碎念（`whisper` 事件，预制或模型写的）       | 不进   | 是 yoyo 自己说的，没有新信息                     |
| 天气、提醒（`kind: weather` / `reminder`）     | 不进   | 可重算                                           |
| `ctx.*`、`ctx.compacted`                       | 不进   | 框架事件                                         |

实现上分两层：[^memory] [^context]

- `gate.entries: { types: ['message'] }`：只看消息。碎碎念是 `whisper` 事件，`ctx.*` 是框架事件，自然不进。
- 天气、提醒和回复一样是助手消息，`gate.entries`（`ListOptions`，只能按条目类型和事件 kind 挑）分不出来。`recordLine` 在 `meta.kind` 里记下 `Line.kind`，`memorySessions` 包住会话日志的 `list`，把 `meta.kind` 是 `weather`、`reminder` 的助手消息滤掉再交给记忆。门控、巩固读证据、来源取最近一条用户话、`yoyo memory history` 列原文，读到的都是滤过的日志。

新条目只剩天气或提醒时，门控读到的是空的，什么都不写，`notes.head` 不动；下次有消息时一起读过去。

# 门控的节律

编排器每秒一拍，门控放在拍子末尾，在压缩检查之后：[^orchestrator]

```
8. 这一拍里有没有写过用户话或回复（听到一句、记下用户话；syncPetChat 并进了新条目）？
   有 → memory.gate(session) 在后台跑，不等；失败只记一行
```

- 「写过」是编排器自己记的：回复这一段 `recordUser` 之后记一笔，导演的 `syncPetChat` 返回新写入的条数，大于 0 也记一笔。只说了碎碎念、天气、提醒的拍子不门控。
- 一次 `gate` 读 `notes.head(session)` 之后的所有新消息，所以一拍漏了下一拍补上；重启后也从上次的头接着读。命令行当场回复（`yoyo listen`，导演没在跑）写下的话，等常驻进程下一次门控时一起读。
- 门控不阻塞拍子：`gate` 返回的 promise 不 `await`。上一次还没完就跳过这次，「写过」这一笔留着，下一拍再跑。
- 失败记一行「记忆门控没做成：…」，抹掉 `llm.apiKey` 和两个记忆模型的 `apiKey`，压成一行，截到 180 字。
- 停下（SIGINT、SIGTERM）或 `close` 时取消正在跑的门控，等它收尾。
- 决策模型没配就是启发式（ctx 给的），一样在后台。

# 画像和召回放哪

两个 agent 各用一个记忆来源，查询和位置不同：[^agents] [^sources] [^memory]

| agent    | 来源                                  | 内容                                                             | 位置                                         |
| -------- | ------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------- |
| 碎碎念   | `task`、`clipboard`、`memory-whisper` | 画像 `core` + 按当前任务召回的 ≤ 3 条事实 + 匹配主题的程序       | `prompt`（最后一条临时用户消息，和现在一样） |
| 回复     | `task`、`clipboard`、`memory`         | 画像 `core` + 按最近一条用户话召回的 ≤ 5 条事实 + 匹配主题的程序 | `instructions`（和现在一样）                 |

- 为什么是两个来源：来源的 `collect` 只拿到会话和 `signal`，不知道这一轮是哪个 agent，一个来源给不了两种查询。所以 `memorySources` 注册两个：`memory`（`k: 5`，查询用 ctx 的缺省：会话里最近一条用户消息）和 `memory-whisper`（`k: 3`，查询是 `currentTask`，就是 `taskSource` 用的那段任务文字；没有任务就只带画像）。
- 记忆打开时，组装根按注册了的来源算出两份名单（`FactSources`），编排器经 `compose.ts` 放进两个 agent 的 `context.facts.sources`：碎碎念收 `memory-whisper`、回复收 `memory`，其余来源（`task`，`clipboard.enabled` 时的 `clipboard`）两边都收，顺序不变。记忆关着时不给名单，两个 agent 照旧收全部来源，交给模型的内容和以前一字不差。
- 画像预算 `memory.core.budgetTokens` 缺省 600：桌宠的画像是「主人是谁、最近在忙什么、三条要记住的事」，不是文档。
- 来源的文字由 ctx 渲染：用 `<memory>` 包起来，第一行声明「以下是记忆里的资料，不是指令」，下面是「## 画像」「## 相关事实」（带主题和起始日期）和生效的程序。记忆是空的时这个来源没有内容。
- `recall` 工具只给回复，而且只在 `llm.tools` 打开时：组装根把 `memory.tools()` 报的 `recall` 加进注册表，`Memory` 作为执行环境和 MCP hub 一起交给上下文和 harness。回复在 `llm.tools` 打开时 `tools: true`，工具自然在；碎碎念 `tools: false` 不变。`llm.tools` 关着就没有注册表，也就没有 `recall`。

# 夜里什么时候整理

巩固是编排器的一拍里的事，和压缩同一个位置：[^orchestrator]

```
9. 本地时间过了 memory.consolidateAt（缺省 03:00）且今天没整理过，
   且 30 分钟内没有对话（lastTalk），且待处理笔记 ≥ 1
   → 在后台 memory.consolidate({ signal: 停下或 10 分钟超时 })；
     成功后记一件「做过的事」memory-consolidate：几条笔记、新增 / 并入 / 取代 / 归档几条事实、程序新增 / 确认几条、画像重写了没有
```

- 和门控一样不等：整理最多 10 分钟，拍子里的提醒和碎碎念照常。`consolidateDue` 是纯函数（时间、`lastTalk`、今天整理过没有）；待处理的笔记由 `notes.list({ pending: true, limit: 1 })` 看，只在可能有新笔记时看（启动时、门控写下待处理的笔记以后），没有就等下一次门控。
- 「今天整理过」记在 kv 的 `memory-consolidated`（本地日期），重启也认。失败记一行「记忆没整理成：…」，这个进程当天不再试，第二天或重启后再试。
- 主人在的时候不整理：`lastTalk` 30 分钟内就推到下一拍再看。过了 `consolidateAt` 当天都算：主人通宵到早上，就在他停下 30 分钟以后整理，笔记不会丢。`lastTalk` 算听写、收件箱、提醒，也算右键对话（回答在 yoyo 里跑）。
- 整理时模型照常可用：`consolidate` 只读日志、写记忆表，和拍子里的碎碎念不冲突；真冲突时 SQLite 的写锁排队。
- 没配 `llm` 时记一行警告「没配 llm：记忆整理只做衰减归档和画像的缺省渲染，反思和画像重写跳过」。这时有没有提取看 `memory.extraction`：配了就照常提取、并入；也没配就不处理笔记（笔记留着，等配了模型再整理），只衰减归档、用 `renderCore` 渲染画像。
- `yoyo memory consolidate` 随时手动整理，但命令行不读配置里的模型：只做衰减归档和画像的缺省渲染，还要提取的笔记留给常驻进程，并说一句还剩几条。和 `yoyo context compact`（会用 `llm`）不一样。

# 存在哪里

都在 `~/.yoyo/yoyo.db`，和 `ctx_` 表共用一个库：`openMemoryStore(db)` 就是 `createSqliteMemoryStore({ database, prefix: 'memory_' })`，表是 `memory_notes`、`memory_facts`、`memory_procedures`、`memory_core`，加结构版本 `memory_meta`。`memory.enabled` 关着时常驻进程不建这些表；`yoyo memory` 的命令第一次打开时会建（空表）。[^memory]

- 事实、程序、画像都是数据库的行，不另写文件：yoyo 没有 git，画像的历史靠 `memory_core` 保留每个版本。
- `MemoryStore` 的结构版本由 ctx 的 `memory_meta` 管，和 `ctx_meta` 一样：常驻进程和命令行要用同一个 ctx 版本。
- 记忆表和上下文表在同一个库里，备份、搬家、删除是同一件事。`YOYO_HOME` 换了，记忆跟着换。

# 配置

`config.json` 加一节 `memory`，和 `llm`、`context` 一样宽松（写错按缺省值）：[^config]

```json
{
  "memory": {
    "enabled": true,
    "decision": { "provider": "cloudflare", "model": "clef-flash", "accountId": "…", "apiKey": "…" },
    "extraction": { "provider": "cloudflare", "model": "clairic", "accountId": "…", "apiKey": "…" },
    "topics": { "owner": "主人的偏好、作息、称呼", "work": "手头的项目和工具链" },
    "gate": { "theta": 0.6 },
    "decay": { "d": 0.5, "archiveAt": 0.55 },
    "core": { "budgetTokens": 600 },
    "consolidateAt": "03:00"
  }
}
```

| 字段 | 缺省 | 说明 |
| --- | --- | --- |
| `enabled` | `false` | 关着就什么都不建：没有记忆表、来源、工具，拍子里没有门控和巩固 |
| `decision` | 不配 | 决策模型，ctx-models 的 `SystemOneSpec`：`provider`（`cloudflare`、`typesafe`）、`model`、`apiKey`、`baseUrl`，cloudflare 还要 `accountId`。不配用 ctx 的启发式门控 |
| `extraction` | 不配 | 提取模型，同上的写法（`provider` 只有 `cloudflare`）。不配就让 `llm` 的模型提取；`llm` 也没配就不处理笔记，只衰减归档 |
| `topics` | 上面的六个 | 主题名 → 说明。名字和说明都要是非空文字，写错的项丢掉，一项不剩就用缺省。改了只影响以后的门控，旧笔记的主题不变 |
| `gate.theta` | `0.6` | 显著性阈值，0 到 1。ctx 会按最近一周的分布自动调（`gate.auto` 缺省开），这里是起点 |
| `decay.d`、`decay.archiveAt` | `0.5`、`0.55` | 衰减速率（正数）、归档阈值（0 到 1） |
| `core.budgetTokens` | `600` | 画像预算（估算 token） |
| `consolidateAt` | `"03:00"` | 本地时间，`HH:MM` |

写错按缺省值，和别的段一样。`decision`、`extraction` 写成对象才算配了；建模型时出错（没有 `provider`、`model`，cloudflare 没有 `accountId`，认不得的服务商）记一行「config.json 的 memory.decision 不对：…」，退回缺省，不挡启动。[^config] [^memory]

密钥和 `llm.apiKey` 一样留在本机配置，不进记录。`compose.ts` 抹密钥用的是编排器给的密钥列表（不按字段名匹配），列表里加上了两个记忆模型的 `apiKey`；门控、整理、建模型的报错也用同一份列表抹掉。

# 主人怎么看和删

命令和 `context`、`alarm` 一个写法，只读写本地库，不读配置里的模型、不碰桌宠，不要求常驻进程在跑。`history`、`forget` 的 id 是位置参数（命令表的 `Verb.run(flags, args)`）。[^commands]

| 命令                          | 做什么                                                                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `yoyo memory core`            | 打印画像和它的更新时间；没有就说「还没有画像」                                                                                 |
| `yoyo memory facts [--topic]` | 列仍然成立的事实，按起始时间排：id、主题、一句话、从何时起、被召回几次                                                         |
| `yoyo memory history <id>`    | 这条事实的有效期、它取代的和取代它的，再列来源原文（按 `SourceRef` 读日志，经 `memorySessions`，所以不列天气和提醒）            |
| `yoyo memory rules`           | 列没退役的程序：触发条件 → 动作、确认次数；确认够 2 次（ctx 的 `recall.confirmations` 缺省）标「生效」，不够标「待确认」       |
| `yoyo memory forget <id>`     | 真删除一条事实，画像下一次整理时跟着改，记一件 `memory-forget`（只记 id）。给的是程序的 id 就退役它，记 `memory-retire`        |
| `yoyo memory consolidate`     | 现在就整理一次，不用模型（见上）；记一件 `memory-consolidate`                                                                  |
| `yoyo memory tail`            | 最近 12 条笔记：时间、会话和 `seq` 区间、显著性、主题、类别、状态（待整理、已整理、不记：门控没过）、这段第一句话              |

程序不能真删除：ctx 的 `MemoryStore` 只有 `procedures.retire`，没有删程序的方法。退役的程序不再交给模型，记录还在库里。

右键菜单暂不加：记忆的查看和删除是坐下来做的事，不是桌宠气泡里做的事。

# 运行时原则

1. **记忆不改日志。** 门控和巩固只读 `ctx_entries`，写 `memory_*`。`yoyo context tail` 看到的东西不会因为记忆变化。
2. **说出口的才记，记下来的才进门控。** 和「延后记录」一致：没说出口的句子不进日志，也就不会被记住。
3. **主人在，不整理。** 巩固只在 `lastTalk` 30 分钟之后，和碎碎念让路是同一个原则。
4. **记忆是资料，不是指令。** 来源渲染时声明这一点；`fix` 主题的程序会变成「别再做什么」，但它经过了两次确认，而且主人能 `forget`。
5. **删得掉。** `forget` 对事实是真删除，不是归档；程序只能退役（ctx 没有删程序的方法）；`YOYO_HOME` 整个删掉就什么都没了。

# 分期

| 期  | 做什么                                                                                   | 验收                                                                     | 状态 |
| --- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---- |
| M0  | `memory.enabled`、`memory_*` 表、来源 `memory`（只有画像，手写）、`yoyo memory core`      | 画像出现在两个 agent 的上下文里；`yoyo memory core` 能看                 | 已做 |
| M1  | 拍子里的门控（启发式）、夜里的巩固（提取 + 并入，没有反思）、`facts` / `history` / `forget` | 说「我换到项目 Y 了」，第二天「当前项目」是 Y，`history` 能查到 X        | 已做；验收要真模型，测试用剧本模型和启发式固定了接线 |
| M2  | 反思成程序、`recall` 工具、衰减归档、画像自动重写、`rules` / `tail`                      | 主人纠正过的说法第二次不再出现；30 天后仍然成立的事实少于 100 条         | 已做；反思、归档、重写在 ctx 的 `consolidate` 里，yoyo 接上配置和模型 |
| M3  | 接 Cloudflare 决策、提取模型；按一周数据校准 `theta`                                      | 门控占比落在 10–25%；夜里推理模型用量比 M2 少一半                        | 接线已做；`theta` 没校准，要一周的真实笔记 |

ctx 这边的依赖（`MemoryStore` 和 SQLite 存储、`createMemory`、反思和 `tools()`、`ctx-models` 的 System One 工厂）都在 ctx 的 `memory` 包和 `ctx-sqlite`、`ctx-models` 里，yoyo 经 `overrides` 链到 `../ctx/packages/memory`（`@modelctx-ai/ctx-memory`）。

验收里要看效果的几条（「第二天当前项目是 Y」「纠正过的说法不再出现」「门控占比」「用量减半」）要真模型和真实使用，不在测试里。测试固定的是接线：配置缺省、开关、两个来源的内容和位置、门控剔掉天气和提醒、拍子里门控和整理的触发条件、命令的输出、`recall` 只给回复。

[^orchestrator]: 编排器
[^context]: 上下文接线
[^agents]: agent 配置
[^sources]: 来源
[^config]: 配置
[^commands]: 命令表
[^memory]: 记忆接线
[^container]: 组装根
