---
type: Architecture Decision
title: 命令原则
description: yoyo 命令按层展开，默认输出短，新功能从同一张领域表里被发现。
resource: src/cli/commands.ts
tags: [cli, discovery]
generated: { by: okf-docs-organizer/v0.2, at: 2026-10-23T13:00:00Z }
status: stable
sources:
  - id: registry
    resource: src/cli/commands.ts
    title: 领域表
  - id: dispatch
    resource: src/cli/registry.ts
    title: 分层输出
  - id: runner
    resource: src/app/cli.ts
    title: agent 跑命令行
  - id: tool
    resource: src/brain/tools.ts
    title: yoyo 工具
  - id: search
    resource: src/cli/search.ts
    title: 搜索
---

# 原则

命令会越来越多。默认只给下一层需要的那几行，不把整本手册一次打出来。[^dispatch]

1. **渐进式发现。** `yoyo` 只列领域。`yoyo alarm` 只列这个领域的动作。参数和一句说明只在 `yoyo inspect alarm` 出现。
2. **默认输出要短。** 一行一个领域或动作，名字对齐，后面一句摘要。不要在顶层打印 `--title` 这类参数。
3. **动态发现。** 领域和动作都写在 `src/cli/commands.ts` 的 `buildDomains()` 这一张表里。`find` 和 `inspect` 读这张表，不另维护一份帮助文本。[^registry]
4. **检索只返回命中的领域。** `yoyo find 粘贴` 按领域名、别名、摘要、说明和动作匹配。没有命中就一行「没有」。
5. **看用法才展开一个领域。** `inspect` 一次只讲一个领域：每个动作一行，参数紧跟在该动作下面。
6. **只有一个动作的领域可以直接跑。** `listen` 和 `whisper` 的动作叫 `now`，所以 `yoyo listen` 就是开始听，不必再写 `now`。有多个动作的领域，光写领域名只列动作。
7. **别名指向正式名字。** `contract` 打开的是 `contact`。正式名字只有一个，别名只为了少打错。
8. **导演在跑时，听和说交给它。** `yoyo listen` 和 `yoyo whisper` 发现已有导演进程，就把请求放进收件队列，不另开进程抢桌宠。
9. **用到什么才打开什么。** 库、配置、桌宠和语音都从 `CommandEnv` 按需拿。只读写本地库的命令不读配置，也不碰桌宠和语音。
10. **领域后面不是动作，交给 `fallback`。** `search` 的 `fallback` 是 `all`，所以 `yoyo search 周报` 就是 `yoyo search all 周报`。
11. **人和 agent 用同一套命令。** yoyo 的数据（子任务、日程、联系人、记忆、对话）怎么查，都做成命令；agent 不另做一套查询工具，见下一节。

# 给 agent 用

命令行是 yoyo 对外的能力层：按 yoyo 自己的数据模型封装好，主人在终端里敲、yoyo 自己的 agent、别的 agent（Claude Code 之类）调的都是这同一个程序。

* **标了 `agent` 的动作才给 agent。** 只读：不改东西、不碰桌宠和麦克风、不打出密钥。环境变量 `YOYO_AGENT=1` 时，`yoyo`、`find`、`inspect` 只列这部分，别的动作当作没有。[^dispatch]
* **yoyo 自己的 agent 经 `yoyo` 工具调。** 工具只收一行 `command`（`yoyo` 后面的部分），另起一个 Node 进程跑命令行，设好 `YOYO_AGENT=1`，最多 20 秒，输出最多 8000 字，出错的那句也原样交回。主线程和子 agent 都有，`research`、`writer` 两种子 agent 的清单里也有。[^tool] [^runner]
* **工具说明不列全部命令。** 说明里只给几个例子和「先跑空的、再看领域、`inspect` 看参数」，和人一样一层层问下去。命令加了、改了，工具不用跟着改。
* **安装包里也一样。** 启动脚本给 `YOYO_CLI` 指到包里的 `cli.mjs`，用包里的 Node 跑。

现在给 agent 的：

| 命令 | 查什么 |
| --- | --- |
| `alarm list`、`contact list` | 日程（行尾带编号，暂停的标「暂停中」）、联系人 |
| `context tail` | 最近的对话 |
| `memory core`、`facts`、`history <id>`、`rules` | 画像、记住的事、一条事实的来源、归纳出的程序 |
| `task list [--state …]`、`show <编号>`、`log <编号>`、`agents` | 子任务和子 agent 类型 |
| `approval list [--state …]`、`show <编号>` | 要批准的事（读写文件、跑命令的开关写成 `ask`）和它们的完整参数；批准、拒绝（`approve`、`deny`）改东西，不开给 agent，模型批不了自己的请求 |
| `artifact list [--task <编号>]`、`show <编号>` | 子任务交的文件：列出来、打出文本的内容 |
| `search <词>... [--in chat,tasks,files,facts,alarms,contacts] [--limit N]` | 在对话、子任务、交付物（按文件名）、记住的事、日程、联系人里一起找，几个词都要有，每类新的在前；一行开头是哪一类，带着能接着查的编号 [^search] |
| `log tail` | 最近做过的事 |

改东西（加、改、暂停日程，派子任务，取消）还走各自的工具：`alarm edit`、`pause`、`resume` 不开给 agent，主线程改日程用 `update_alarm`：参数有结构，规则不让做的能原样交回模型。

# 加一条命令时

在领域表加一条记录即可。记录里要有 `name`、`summary`，动作还要有 `run`。需要参数就写 `flags`，在 `run(flags)` 里用 `flagText` 读。需要别名就写 `aliases`。只读、agent 也该能查的，写 `agent: true`。不要在 README 或 `docs/product/` 里再抄一份完整帮助，那里只放几个例子。

# 不这样做

* 不在 `yoyo` 不带参数时展开所有领域的所有参数。
* 不把 `inspect` 做成一次打印全部领域。
* 不写一套和领域表各写各的帮助。

[^registry]: 领域表
[^dispatch]: 分层输出
[^runner]: agent 跑命令行
[^tool]: yoyo 工具
[^search]: 搜索
