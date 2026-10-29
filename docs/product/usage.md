---
type: Guide
title: 日常使用
description: 右键菜单、按键和命令行。
tags: [product, cli]
status: stable
---

# 右键菜单

yoyo 的两项放在桌宠右键菜单的第一层：

* **碎碎念**：马上说一句。
* **听一句**：马上听你说话。

桌宠自带的「打开网站」「查看余额」和它自己的「碎碎念」缺省藏起来，「对话」「回到初始位置」「显示位置」「重载配置」「动作」照旧。要藏哪些、放不放第一层，见[配置](configuration.md#右键菜单)。右键「对话」接的是 yoyo 的记忆，见[功能介绍](overview.md#右键对话)。

自己另外开的桌宠（不是 `./yoyo start`、`./yoyo pet` 或 `pnpm pet` 开的）菜单照旧，yoyo 的两项在「更多」里。

# 按键

Control+Option+Y：马上听一句。需要系统允许辅助功能。

# 命令行

用安装包时，下面的 `pnpm yoyo` 都换成包目录里的 `./yoyo`。

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

## 本地任务

写一份 `~/.yoyo/tasks.json`：

```json
{ "items": ["写周报"] }
```

yoyo 下次打开数据时把它导进去，再改名成 `tasks.json.migrated`；要加新的就再写一份。碎碎念和回复会带上前 5 条任务，桌宠工作状态里的任务也算。
