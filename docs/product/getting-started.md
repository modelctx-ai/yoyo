---
type: Guide
title: 安装与运行
description: 准备环境、装好 yoyo 和 ctx、填配置、接上桌宠。
tags: [product, setup]
status: stable
---

# 要求

| 项       | 要求                                                                                   |
| -------- | -------------------------------------------------------------------------------------- |
| 系统     | macOS。别的系统只能用[控制台模式](#不接桌宠试一试)                                     |
| Node     | ≥22.18                                                                                 |
| pnpm     | 10                                                                                     |
| ctx      | 克隆在 yoyo 旁边，见下一节                                                             |
| 桌宠     | dsh-pet，以独立模式运行                                                                |
| 语音     | Fish Audio 的密钥和声音 ID                                                             |
| 听写     | `ffmpeg` 和 whisper.cpp 的 `whisper-cli`；不打开听写可以不装                           |
| 可选     | 一个模型（OpenAI 兼容接口或 Anthropic），让它现写碎碎念和回复；本机 anysearch，用来搜索 |

# 安装

ctx 还没发到 npm，先把它克隆到 yoyo 旁边并构建，再装 yoyo 的依赖：

```sh
git clone https://github.com/modelctx-ai/ctx ../ctx
pnpm -C ../ctx install && pnpm -C ../ctx build
pnpm install
```

# 配置

```sh
cp config.example.json config.json
```

至少填上 `speech.apiKey` 和 `speech.referenceId`。想让模型写碎碎念、回复你，再填 `llm` 的 `baseUrl`、`apiKey`、`model`。示例里打开了听写（`listen.enabled`），不想说完就听就改成 `false`。

`config.json` 不进版本库。所有选项见[配置](configuration.md)。

# 启动桌宠

用 dsh-pet 的官方独立模式启动：

```sh
cd /path/to/dsh-pet/dsh-pet
npm run build && npm run standalone
```

# 运行

| 命令          | 作用                                                    |
| ------------- | ------------------------------------------------------- |
| `pnpm start`  | 常驻：马上说一句，之后按 `intervalSec` 重复，默认 5 分钟 |
| `pnpm once`   | 只说一句                                                |
| `pnpm bake`   | 把固定台词预先合成好，之后开口更快                      |
| `pnpm yoyo`   | 命令行，见[日常使用](usage.md)                          |

第一次用按键 Control+Option+Y 时，系统会要求给终端「辅助功能」权限。

# 不接桌宠试一试

在 `config.json` 里写 `"stage": "console"`，台词就打印成 `[动作] 文字`，不需要桌宠，也不需要配语音。没有右键菜单和右键对话；不在 macOS 上没有声音、按键和粘贴板。

用一个单独的数据目录和配置，就不会碰到平时的数据：

```sh
YOYO_HOME=/tmp/yoyo-dev YOYO_CONFIG=/tmp/yoyo-dev/config.json pnpm once
```
