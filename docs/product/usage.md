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

要花时间、要好几步的事，直接跟 yoyo 说就行（「帮我把这周的周报整理一下」）。它会派成一个子任务在后台做，先回你一句；做完了把结果带回主聊天，桌宠也会说一声。你一直只和 yoyo 说话。

子任务做的时候会先拆成一条条 todo，做完一条勾一条；派的时候 yoyo 会写下验收标准，交结果前逐条对过。想看进度，在工作台的聊天列表里点开它：目标、验收标准、todo、结果，还有它一步步做了什么。在做的能取消。

一次做一件，其余的排队。要回复时用工具（`llm.tools`）打开，yoyo 才能派；`tasks.enabled` 关掉就不做子任务，`tasks.notify` 关掉桌宠就不说。

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
pnpm yoyo task show 3          # 目标、验收标准、todo、结果
pnpm yoyo task log 3           # 它一步步做了什么
pnpm yoyo task add --title 整理周报 --goal "本周三个项目的进展" --criteria "三个项目都有；每项三行内"
pnpm yoyo task cancel 3
```

常驻进程在跑才会去做。

## 本地任务

写一份 `~/.yoyo/tasks.json`：

```json
{ "items": ["写周报"] }
```

yoyo 下次打开数据时把它导进去，再改名成 `tasks.json.migrated`；要加新的就再写一份。碎碎念和回复会带上前 5 条任务，桌宠工作状态里的任务也算。
