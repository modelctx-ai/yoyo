---
type: Guide
title: 日常使用
description: 右键菜单、按键和命令行。
tags: [product, cli]
status: stable
---

# 右键菜单

yoyo 的几项放在桌宠右键菜单的第一层：

* **碎碎念**：马上说一句。
* **听一句**：马上听你说话。
* **管理**：打开[工作台](#工作台)。用 yoyo.app 时在它的窗口里，从源码运行时用浏览器。

桌宠自带的「打开网站」「查看余额」和它自己的「碎碎念」缺省藏起来，「对话」「回到初始位置」「显示位置」「重载配置」「动作」照旧。要藏哪些、放不放第一层，见[配置](configuration.md#右键菜单)。右键「对话」接的是 yoyo 的记忆，见[功能介绍](overview.md#右键对话)。

自己另外开的桌宠（不是 yoyo.app、`yoyo start`、`yoyo pet` 或 `pnpm pet` 开的）菜单照旧，yoyo 的两项在「更多」里。

# 工作台

yoyo 的工作台：一个只在这台电脑上能打开的网页，从右键「管理」或命令行 `yoyo web open` 打开。用 yoyo.app 时它就是 app 的窗口，点 Dock 上的 yoyo 也能打开。平时让桌宠陪着，要干活、翻历史、改配置时再打开它。

* **对话**：和 yoyo 的主聊天。桌宠右键聊的、语音说的、碎碎念、新加的日程都在这里，按时间排；底下打字就能和它聊（Enter 发送，Shift+Enter 换行）。在这里聊的桌宠不念出来，但它记得。右上角能搜。
* **状态**：在聊天列表下面：桌宠连没连上、用的模型、右键对话接没接上、记住了几件事、下一句碎碎念几点说；「说一句」「听一句」。
* **心迹**：画像能直接改；记得的事能忘掉，规矩能退役，和命令行的 `forget` 一样。
* **日程**、**联系人**：加和删。
* **轨迹**：最近做过的事，按天分开。
* **设置**：常用的开关直接点；整份配置也能在这里改，密钥打了码，不动就还是原来的。存好一两秒内生效。

地址每次启动 yoyo 都换，里面带着一次性令牌；别人的网页、局域网里的人都打不开。不想要就把 `web.enabled` 设成 `false`。

# 子任务

要花时间、要好几步的事，直接跟 yoyo 说就行（「帮我把这周的周报整理一下」）。它会派成一个子任务在后台做，先回你一句；做完了结果回到主聊天，yoyo 会主动用一两句告诉你结论，桌宠说出来。你一直只和 yoyo 说话。

子任务做的时候会先拆成一条条 todo，一次做一条，做完马上勾；派的时候 yoyo 会写下验收标准，交结果前逐条对过。想看进度，在工作台的聊天列表里点开它：目标、验收标准、todo、结果，还有它一步步做了什么。在做的能取消。

做到一半，子任务要你拿主意（偏好、取舍、它查不到的信息）时会停下来问你：桌宠会用一两句话说出是哪个子任务在问什么，这时它在工作台里显示「等回答」，不占做事的名额。直接对 yoyo 说答案就行（「封面用蓝色」），yoyo 会把回答交给对的那个子任务，它排队接着做；也可以在工作台的子任务详情里写在回答框里，或者用命令行 `yoyo task answer 3 蓝色`。同时有几个在问时，回答时说清楚是哪个；yoyo 分不清会先问你。等了 24 小时（`tasks.answerTimeout` 可以改，0 是一直等）还没回答，子任务就按没做成结束，yoyo 照常告诉你。等回答的也能取消；关了 yoyo 再开，等着的还在等。

要交文件的（整理好的周报、对比表、图），子任务会把文件交上来，放在子任务详情的「交付物」里：文本和图片点开就能看，浏览器里能下载，yoyo.app 里是「在访达里显示」。文件在 `~/.yoyo/artifacts/<编号>/`，不要了可以删。

派的时候 yoyo 会按事情挑一种子 agent：`general` 什么都能做，`research` 上网查、结论带出处，`writer` 把给的材料整理成周报和清单。只有 `general` 能跑命令。想加自己的，在 `~/.yoyo/agents/` 里放一个 `.md`，写法和 Claude Code 的子 agent 一样，见[子任务](../tech/tasks.md#子-agent-类型)。

同时做两件（`tasks.concurrency` 可以改），多的排队。要回复时用工具（`llm.tools`）打开，yoyo 才能派；`tasks.enabled` 关掉就不做子任务，`tasks.notify` 关掉 yoyo 就不主动说（结果和问题都是），你问起照样能答。

# 让 yoyo 读写文件、跑命令

回复时用工具（`llm.tools`）打开以后，yoyo 能读文件、写文件、改文件：「把我工作区里的会议记录整理一下」「帮我在 notes 里记一笔」。

* 它只能写在工作区里，缺省是 `~/.yoyo/workspace`，可以用 `files.workspace` 换地方。
* 想让它读别的地方（例如文稿），加进 `files.readable`，只读不写；不想让它看的，加进 `files.denyRead`。
* 配置、yoyo 自己的数据和 `~/.ssh` 这些一律读不到。
* 它主动转告子任务结果的那一句不会动文件；写和改都记在工作台的轨迹里。

不想要哪个，把 `files.read`、`files.write`、`files.edit` 设成 `deny`；想让它动手前先问你，设成 `ask`，见下面「动手前先问你」。

装了沙箱程序（srt，见[装 srt](configuration.md#装-srt)）的话，yoyo 还能跑命令：「用 python 把这份数据画成一张图」「数一数工作区里有多少个 md 文件」。

* 命令在沙箱里跑，只能写工作区，读不到密钥，缺省不能上网（要连哪里写进 `files.bashNetwork`），最多跑 2 分钟，输出太长只留开头和结尾。
* 没装沙箱程序就没有这个能力，yoyo 启动时记一行，不会换成不加沙箱的跑法。不想要就把 `files.bash` 设成 `deny`。
* 每条命令（前面一段和退出码）都记在工作台的轨迹里；转告子任务结果那一句不会跑命令。
* 命令生成的文件（例如画图脚本输出的图）放在工作区里，交给子任务去做时，它能把文件交到子任务的交付物里。详细的规则见[让 yoyo 跑命令](configuration.md#让-yoyo-跑命令)。

## 动手前先问你

`files.read`、`files.write`、`files.edit`、`files.bash` 写成 `ask`（见[每次先问你](configuration.md#每次先问你)），yoyo 想读、写、改文件或跑命令时不会马上做，先在工作台里记一条等你批准，并告诉你一声（「周报写好了，要你在工作台里批一下我才能写」）。

* **在哪批**：工作台侧栏的「待批准」，旁边的数字是还在等的件数。每条写着要做什么，点「看完整参数」展开：写的内容、改的原文和新文、整条命令。点「批准」，yoyo 马上照做一次，结果回到和 yoyo 的对话里，她会告诉你做成没有；点「拒绝」就不做，她也会说一声，不会自己再试。
* **命令行**：`pnpm yoyo approval list` 看等着的和最近处理过的，`approval show 3` 看完整参数，`approval approve 3`、`approval deny 3`。
* **子任务要的**：子任务停在「等回答」，对话里是一张「要你批准」的卡片，子任务详情最上面也列着，批准或拒绝完它接着做；一个子任务同时要几件，都有了结论它才接着做。
* **等太久按拒绝**：24 小时没批（`files.askTimeout` 可以改，`0` 是一直等）就过期，不做，yoyo 照常告诉你。
* 这些只能你批：yoyo 自己批不了，也不会因为你对她说「批准」就算数；要在工作台或命令行里点。

# 按键

Control+Option+Y：马上听一句。需要系统允许辅助功能。

# 命令行

用安装包时，下面的 `pnpm yoyo` 都换成 `yoyo`（app 里的命令行，见[在终端里用](getting-started.md#在终端里用)）。

`pnpm yoyo` 只列出有哪些领域。跟上领域名看它有哪些动作，`inspect` 看参数，`find` 按关键词找。

```sh
pnpm yoyo
pnpm yoyo alarm
pnpm yoyo inspect alarm
pnpm yoyo find 粘贴
```

常用的几条：

```sh
pnpm yoyo whisper        # 马上说一句
pnpm yoyo listen         # 马上听一句
pnpm yoyo clip history   # yoyo 运行期间复制过的内容
pnpm yoyo context tail   # 最近的对话记忆
pnpm yoyo log tail       # 最近 20 件做过的事
pnpm yoyo search 周报    # 在对话、子任务、记住的事、日程、联系人里找
pnpm yoyo memory core    # 记忆里的画像
pnpm yoyo chat sync      # 右键对话没接上时重接
pnpm yoyo web open       # 打开工作台
```

完整的列表以 `pnpm yoyo` 的输出为准。`pnpm yoyo` 也可以写成 `node bin/yoyo.js`。常驻进程开着时，`whisper` 和 `listen` 交给它去做，不会另开一个去抢桌宠。

## 闹钟和日程

```sh
pnpm yoyo alarm list
pnpm yoyo alarm add --title 喝水 --time 15:30 --repeat daily
pnpm yoyo alarm add --title 周报 --time 18:00 --repeat weekdays --kind task
pnpm yoyo alarm add --title 周会 --time 10:00 --repeat weekly --weekday 1
pnpm yoyo alarm add --title 开会 --time 09:30 --date 2026-10-24
```

`--repeat` 可以是 `daily`、`weekdays`、`weekly`；不写 `--repeat` 就用 `--date` 定某一天。`--kind task` 到点先说「到点了。」。

## 联系人

```sh
pnpm yoyo contact list
pnpm yoyo contact add --name 小王 --yoyo yoyo://xiaowang@example --note 同事
```

## 记忆

打开 `memory.enabled` 以后才会记，见[配置](configuration.md#记忆)。这些命令只读写本地库，常驻进程不用开，也不会用模型。

```sh
pnpm yoyo memory core                 # 画像和更新时间
pnpm yoyo memory facts                # 记得的事：id、主题、一句话、从哪天起、被想起几次
pnpm yoyo memory facts --topic work   # 只看一个主题
pnpm yoyo memory history <id>         # 这件事从哪段话来的，取代了哪条、被哪条取代
pnpm yoyo memory rules                # 从纠正里归纳出的规矩，确认够两次才生效
pnpm yoyo memory tail                 # 最近 12 条笔记：哪段话、值不值得记、整理了没有
pnpm yoyo memory forget <id>          # 删掉一件事；给规矩的 id 就让它退役
pnpm yoyo memory consolidate          # 现在整理一次
```

* `forget` 是真删除，画像在下一次整理时跟着改。规矩删不掉，只能退役：不再交给模型，记录还在。
* 命令行的 `consolidate` 不用模型，只做遗忘和画像的简单整理；要用模型提取的笔记留给常驻进程夜里整理，命令会说还剩几条。

## 子任务

```sh
pnpm yoyo task list            # 最近的子任务：编号、状态、todo 进度
pnpm yoyo task list --state running   # 正在做的几件
pnpm yoyo task show 3          # 目标、验收标准、todo、问题和回答、结果
pnpm yoyo task log 3           # 它一步步做了什么
pnpm yoyo task agents          # 有哪些子 agent 类型
pnpm yoyo task add --title 整理周报 --goal "本周三个项目的进展" --criteria "三个项目都有；每项三行内" --agent writer
pnpm yoyo task answer 3 蓝色   # 回答在等回答的子任务，它接着做
pnpm yoyo task cancel 3
pnpm yoyo approval list              # 要你批准的事（读写文件、跑命令开关写成 ask 的）
pnpm yoyo approval show 3            # 完整参数：写的内容、改的原文和新文、命令
pnpm yoyo approval approve 3         # 批准：常驻进程照做一次
pnpm yoyo approval deny 3            # 拒绝
pnpm yoyo artifact list --task 3     # 子任务 3 交的文件
pnpm yoyo artifact show 5            # 打出文本交付物的内容
pnpm yoyo artifact rm 5
```

常驻进程在跑才会去做。

## 本地任务

写一份 `~/.yoyo/tasks.json`：

```json
{ "items": ["写周报"] }
```

yoyo 下次打开数据时把它导进去，再改名成 `tasks.json.migrated`；要加新的就再写一份。碎碎念和回复会带上前 5 条任务，桌宠工作状态里的任务也算。
