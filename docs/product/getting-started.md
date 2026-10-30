---
type: Guide
title: 安装与运行
description: 下载安装包解压就能用，或者从源码运行；填配置、接上桌宠、关掉不想要的功能。
tags: [product, setup]
status: stable
---

# 两种装法

|          | 安装包                          | 从源码                                                                 |
| -------- | ------------------------------- | ---------------------------------------------------------------------- |
| 适合     | 只想用                          | 要改 yoyo                                                              |
| 系统     | macOS，Apple 芯片               | macOS。别的系统只能用[控制台模式](#不接桌宠试一试)                     |
| 另外要装 | 不用                            | Node ≥22.18、pnpm 10、ctx；听写还要 `ffmpeg` 和 `whisper-cli` |
| 配置在   | `~/.yoyo/config.json`           | yoyo 目录的 `config.json`                                              |
| 命令     | `./yoyo start`、`./yoyo <领域>` | `pnpm start`、`pnpm yoyo <领域>`                                       |

两种都要 Fish Audio 的密钥和声音 ID。想让模型现写碎碎念、回复你，再准备一个模型（OpenAI 兼容接口或 Anthropic）；想让它提问前先搜一下，再准备本机的 anysearch。

# 安装包

包里带着 yoyo、桌宠 dsh-pet（独立模式和它用的 Electron）、Node、录音的 ffmpeg、听写的 whisper-cli 和模型、按键助手。不用克隆仓库，也不用装 Node、pnpm 或 Homebrew。

1. 到 [Releases](https://github.com/modelctx-ai/yoyo/releases) 下载 `yoyo-<版本>-macos-arm64.zip`，解压到你想放的地方，例如 `~/Applications/yoyo`。
2. 打开终端，进到这个目录，运行 `./yoyo start`。第一次会把示例配置放到 `~/.yoyo/config.json`，然后停下。
3. 在 `~/.yoyo/config.json` 里填上 `speech.apiKey` 和 `speech.referenceId`。想让模型现写，再填 `llm` 的 `baseUrl`、`apiKey`、`model`。
4. 再运行 `./yoyo start`：桌宠没开就先开桌宠，yoyo 接着常驻。Control+C 一起停下。

| 命令                   | 作用                                                          |
| ---------------------- | ------------------------------------------------------------- |
| `./yoyo start`         | 桌宠没开就先开，再常驻：马上说一句，之后按 `intervalSec` 重复 |
| `./yoyo once`          | 只说一句                                                      |
| `./yoyo bake`          | 把固定台词预先合成好，之后开口更快                            |
| `./yoyo pet`           | 只开桌宠；`./yoyo pet --check` 看桌宠的环境                   |
| `./yoyo <领域> [动作]` | 命令行，见[日常使用](usage.md)                                |

* 桌宠已经开着（例如你自己用独立模式开的）就直接用，停下时也不关它。`./yoyo start` 开的桌宠，输出记在 `~/.yoyo/pet.log`。
* 浏览器下载的文件带隔离属性，包里有些程序没经过 Apple 公证，会被系统拦下。`./yoyo` 启动时清掉这个目录里的隔离属性。要在终端里运行，从「访达」双击打不开。
* 第一次听你说话时，系统会问终端能不能用麦克风；第一次按 Control+Option+Y 时，会要终端的「辅助功能」权限。
* 换新版本：先停掉 `./yoyo start`，下载新的压缩包，解压后替换整个目录。配置和数据在 `~/.yoyo`，不受影响。

# 从源码运行

## 安装

ctx 还没发到 npm，先把它克隆到 yoyo 旁边并构建，再装 yoyo 的依赖：

```sh
git clone https://github.com/modelctx-ai/ctx ../ctx
pnpm -C ../ctx install && pnpm -C ../ctx build
pnpm install
```

听写要 `ffmpeg` 和 whisper.cpp 的 `whisper-cli`，模型第一次用时下载；不打开听写可以不装。

## 配置

```sh
cp config.example.json config.json
```

至少填上 `speech.apiKey` 和 `speech.referenceId`。想让模型写碎碎念、回复你，再填 `llm` 的 `baseUrl`、`apiKey`、`model`。`config.json` 不进版本库。

## 启动桌宠

另开一个终端：

```sh
pnpm pet
```

桌宠是 npm 上的 dsh-pet，`pnpm install` 时已经装好，跑的是它的独立模式；第一次开会下载它用的 Electron。右键菜单按 `config.json` 的 `pet.menu` 排，见[配置](configuration.md#右键菜单)。

## 运行

| 命令         | 作用                                                     |
| ------------ | -------------------------------------------------------- |
| `pnpm start` | 常驻：马上说一句，之后按 `intervalSec` 重复，默认 5 分钟 |
| `pnpm once`  | 只说一句                                                 |
| `pnpm bake`  | 把固定台词预先合成好，之后开口更快                       |
| `pnpm yoyo`  | 命令行，见[日常使用](usage.md)                           |

第一次用按键 Control+Option+Y 时，系统会要求给终端「辅助功能」权限。按键助手第一次启动时用 `swiftc` 编译，要装 Xcode 命令行工具。

# 开关

说完要不要听你回应、报不报天气、配不配表情包和音效，都是 `config.json` 里的开关，写 `true` 或 `false`，存好一两秒内生效，不用重启；右键「管理」打开的管理页里也能直接点。示例配置里听写（`listen.enabled`）是打开的，不想说完就听就改成 `false`。全部开关见[配置](configuration.md#开关)。

# 不接桌宠试一试

在 `config.json` 里写 `"stage": "console"`，台词就打印成 `[动作] 文字`，不需要桌宠，也不需要配语音。没有右键菜单和右键对话；不在 macOS 上没有声音、按键和粘贴板。

用一个单独的数据目录和配置，就不会碰到平时的数据：

```sh
YOYO_HOME=/tmp/yoyo-dev YOYO_CONFIG=/tmp/yoyo-dev/config.json pnpm once
```

安装包里同样可以：`YOYO_HOME=/tmp/yoyo-dev ./yoyo once`。
